import { join, resolve } from "node:path";
import {
  Agent,
  ArcExistsError,
  ArcNotActiveError,
  contextBudgetFor,
  declaredContextWindow,
  type EffortLevel,
  estimateConversationTokens,
  McpServerNotFoundError,
  MemoryGraph,
  MemorySearch,
  MemoryStore,
  type Message,
  MissingArcError,
  memoryGrants,
  modelReferenceOf,
  type Note,
  PermissionLedger,
  type Provider,
  parseReference,
  readContext,
  type SessionBinding,
  type SessionEntry,
  type Tool,
  type ToolGuard,
  titleKey,
  toolScope,
} from "@keywork/engine";
import { type CompleteTheme, requiresConfirmation, type TrustDecision } from "@keywork/shared";
import { AskQueue } from "./asks.ts";
import { ChangesFeed, type ChangesSource, changesPortOver } from "./changes.ts";
import type { EventLog } from "./events.ts";
import { workspaceFiles } from "./files.ts";
import {
  type ArcAirlockPort,
  type ArcSummary,
  type BotEntry,
  type BotSummary,
  type CompactionReport,
  type CostReport,
  type ExportOutcome,
  type LabelOutcome,
  type LeafOutcome,
  type McpPort,
  type MemoryNoteRecord,
  type MemoryPort,
  type ModelSwitch,
  type NoteRelation,
  type PresetHost,
  type RedoReport,
  SessionBusyError,
  type SessionDetail,
  type SessionEntries,
  type SessionHost,
  type SessionLifecyclePort,
  type SessionState,
  type SessionSummary,
  SurfaceUnavailableError,
  TrustRefusedError,
  type UndonePrompt,
  type UndoReport,
  type WorkspaceChoice,
  type WorkspaceReadiness,
} from "./host.ts";

export interface SseFrame {
  id: string | undefined;
  event: string | undefined;
  data: string;
}

export interface SseReader {
  next(): Promise<SseFrame>;
  raw(): string;
  close(): Promise<void>;
}

export function sseReader(response: Response): SseReader {
  const body = response.body;
  if (body === null) throw new Error("the response has no body to read");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let seen = "";
  const nextChunk = async (): Promise<boolean> => {
    const { value, done } = await reader.read();
    if (done) return false;
    const text = decoder.decode(value, { stream: true });
    buffered += text;
    seen += text;
    return true;
  };
  return {
    next: async () => {
      for (;;) {
        const frame = takeFrame();
        if (frame !== undefined) return frame;
        if (!(await nextChunk())) throw new Error("the event stream ended before the next frame");
      }
    },
    raw: () => seen,
    close: () => reader.cancel(),
  };

  function takeFrame(): SseFrame | undefined {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end === -1) return undefined;
      const block = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const frame = parseFrame(block);
      if (frame !== undefined) return frame;
    }
  }
}

export const headlessGuard: ToolGuard = { confirm: async () => false, gate: "headless" };

export interface MemoryHostOptions {
  log: EventLog;
  provider: Provider;
  tools?: readonly Tool[];
  now?: () => Date;
  asks?: "queue" | "headless";
  askTimeoutMs?: number;
  memory?: MemoryPort;
  models?: Readonly<Record<string, Provider>>;
  presets?: PresetHost;
  surfaces?: MemorySurfaceOptions;
  changes?: ChangesSource;
  trusted?: boolean;
}

export interface MemorySurfaceOptions {
  root: string;
  identity?: string;
  trust?: TrustDecision;
  mcp?: McpPort;
  themes?: readonly CompleteTheme[];
}

interface MemorySession {
  agent: Agent;
  title: string;
  detach: () => void;
  staged: { prompt: UndonePrompt; cancel(): void } | undefined;
  labels: Map<string, string>;
  parent?: string;
}

export function memorySessionHost(options: MemoryHostOptions): SessionHost {
  const sessions = new Map<string, MemorySession>();
  const trashed = new Map<string, MemorySession>();
  const now = options.now ?? (() => new Date());
  const ledger = new PermissionLedger({
    trusted: options.trusted ?? false,
    workspace: memoryGrants(),
    root: "/memory",
  });
  const asks = new AskQueue({
    now,
    grants: ledger,
    ...(options.askTimeoutMs !== undefined && { timeoutMs: options.askTimeoutMs }),
  });
  const buildAgent = (id: string, provider: Provider, history?: readonly Message[]): Agent =>
    new Agent({
      provider,
      guard: options.asks === "queue" ? asks.guardFor(id) : headlessGuard,
      permissions: ledger.resolverFor(id),
      ...(options.tools !== undefined && { tools: options.tools }),
      ...(history !== undefined && { history }),
    });
  const changes = new ChangesFeed(options.log, async () => options.changes);
  const attach = (id: string, agent: Agent): (() => void) => {
    const detach = options.log.attach(agent.bus, id);
    const unfollow = changes.follow(agent.bus, id);
    return () => {
      detach();
      unfollow();
    };
  };
  const swap = (
    id: string,
    session: MemorySession,
    next: Agent,
    effort: EffortLevel | null = session.agent.effort() ?? null,
  ): void => {
    next.setThinking(session.agent.thinking());
    if (effort !== null) next.setEffort(effort);
    session.detach();
    session.agent = next;
    session.detach = attach(id, next);
  };
  const stateOf = (session: MemorySession): SessionState => {
    const { agent } = session;
    const model = modelReferenceOf(agent.provider);
    const effort = agent.effort();
    const history = agent.history();
    return {
      ...(model !== undefined && { model }),
      thinking: agent.thinking(),
      ...(effort !== undefined && { effort }),
      title: session.title,
      leafId: history.length === 0 ? null : `m${history.length - 1}`,
      undoable: lastPromptIndex(history) !== -1,
      redoable: session.staged !== undefined,
    };
  };
  const announce = (id: string, session: MemorySession): void => {
    options.log.record(id, "session.state", stateOf(session));
  };
  const summaryOf = (id: string, session: MemorySession): SessionSummary => {
    const { model, thinking, effort } = stateOf(session);
    return {
      id,
      title: session.title,
      createdAt: now().toISOString(),
      lastActivityAt: now().toISOString(),
      messageCount: session.agent.history().length,
      ...(model !== undefined && { model }),
      thinking,
      ...(effort !== undefined && { effort }),
    };
  };
  const verb = async <T>(
    id: string,
    act: (session: MemorySession) => T | Promise<T>,
  ): Promise<T | "missing"> => {
    const session = sessions.get(id);
    return session === undefined ? "missing" : act(session);
  };
  return {
    list: async () => [...sessions].map(([id, session]) => summaryOf(id, session)),
    read: async (id) => {
      const session = sessions.get(id);
      if (session === undefined) return undefined;
      const detail: SessionDetail = {
        ...summaryOf(id, session),
        cwd: "/memory",
        live: true,
        messages: session.agent.history(),
        asOf: options.log.latestId(),
        ...(session.parent !== undefined && { parentSession: session.parent }),
      };
      return detail;
    },
    create: async () => {
      const id = `s${sessions.size + 1}`;
      const agent = buildAgent(id, options.provider);
      const session: MemorySession = {
        agent,
        title: `session ${id}`,
        detach: attach(id, agent),
        staged: undefined,
        labels: new Map(),
      };
      sessions.set(id, session);
      return summaryOf(id, session);
    },
    prompt: (id, text, behavior) =>
      verb(id, (session) => {
        const outcome = session.agent.busy() ? "queued" : "started";
        session.staged = undefined;
        session.agent
          .send(text, { ...(behavior !== undefined && { behavior }) })
          .catch(() => undefined)
          .then(() => announce(id, session));
        announce(id, session);
        return outcome;
      }),
    inject: (id, text, origin) =>
      verb(id, (session) => {
        const outcome = session.agent.busy() ? "queued" : "started";
        session.agent.send(text, { origin }).catch(() => undefined);
        return outcome;
      }),
    abort: (id) =>
      verb(id, (session) => {
        if (!session.agent.busy()) return "idle";
        session.agent.interrupt();
        return "aborted";
      }),
    setModel: (id, reference) =>
      verb(id, (session): ModelSwitch | "busy" => {
        const provider = options.models?.[reference];
        if (provider === undefined) {
          return {
            failure: {
              code: "unknown-model",
              message: `no model matches ${reference}`,
              reference,
              provider: undefined,
              known: Object.keys(options.models ?? {}),
            },
          };
        }
        if (session.agent.busy()) return "busy";
        swap(id, session, buildAgent(id, provider, session.agent.history()));
        announce(id, session);
        const model = parseReference(reference) ?? { provider: provider.name, model: reference };
        return { model, notice: `model → ${reference}` };
      }),
    setThinking: (id, on) =>
      verb(id, (session) => {
        session.agent.setThinking(on);
        announce(id, session);
        return { thinking: on };
      }),
    setEffort: (id, level) =>
      verb(id, (session): { effort: EffortLevel | null } | "busy" => {
        if (level === null) {
          if (session.agent.busy()) return "busy";
          swap(id, session, buildAgent(id, session.agent.provider, session.agent.history()), null);
        } else {
          session.agent.setEffort(level);
        }
        announce(id, session);
        return { effort: level };
      }),
    compact: (id) =>
      verb(id, (session): CompactionReport | "busy" => {
        if (session.agent.busy()) return "busy";
        announce(id, session);
        return { compacted: null, notices: [nothingToCompact] };
      }),
    undo: (id) =>
      verb(id, (session): UndoReport | "busy" | "nothing" => {
        if (session.agent.busy()) return "busy";
        session.staged = undefined;
        const history = session.agent.history();
        const index = lastPromptIndex(history);
        const prompt = history[index];
        if (prompt === undefined) return "nothing";
        swap(id, session, buildAgent(id, session.agent.provider, history.slice(0, index)));
        const staged = {
          prompt: { entryId: `m${index}`, text: textOf(prompt) },
          cancel: () => swap(id, session, buildAgent(id, session.agent.provider, history)),
        };
        session.staged = staged;
        announce(id, session);
        const { undoable, redoable } = stateOf(session);
        return { prompt: staged.prompt, filesNote: "files untouched", undoable, redoable };
      }),
    redo: (id) =>
      verb(id, (session): RedoReport | "busy" | "nothing" => {
        const { staged } = session;
        if (staged === undefined) return "nothing";
        if (session.agent.busy()) return "busy";
        session.staged = undefined;
        staged.cancel();
        announce(id, session);
        const { undoable, redoable } = stateOf(session);
        return { restored: true, undoable, redoable };
      }),
    context: (id) =>
      verb(id, ({ agent }) =>
        readContext(
          estimateConversationTokens(agent.history()),
          contextBudgetFor(declaredContextWindow(agent.provider)),
        ),
      ),
    cost: (id) =>
      verb(id, ({ agent }): CostReport => {
        const rollup = agent.cost();
        const usage = agent.usage();
        const cacheMiss = agent.cacheMiss();
        const modelId = agent.modelId();
        return {
          rollup,
          usage,
          ...(modelId !== undefined && { modelId }),
          ...(cacheMiss !== undefined && { cacheMiss }),
          models: [
            {
              reference: modelReferenceOf(agent.provider) ?? agent.provider.name,
              turns: rollup.pricedTurns + rollup.unpricedTurns,
              usage,
              rollup,
            },
          ],
        };
      }),
    exportHtml: (id, _scope, out) =>
      verb(
        id,
        (session): ExportOutcome =>
          out === undefined ? { html: transcriptPage(session) } : "outside-scope",
      ),
    rename: (id, title) =>
      verb(id, (session) => {
        session.title = title;
        announce(id, session);
        return { title };
      }),
    applyPreset: async (name, confirmed) => {
      const presets = options.presets;
      if (presets === undefined) return "unavailable";
      const from = presets.active();
      if (from === name) return { from, to: name };
      if (requiresConfirmation(from, name) && !confirmed) return "needs-confirmation";
      await presets.apply(name);
      for (const { agent } of sessions.values()) agent.bus.emit("gate.preset", { from, to: name });
      return { from, to: name };
    },
    tree: {
      entries: (id) => verb(id, (session) => entriesOf(id, session)),
      fork: (id, entryId) =>
        verb(id, (session): { sessionId: string } | "unknown-entry" => {
          const index = entryIndexOf(session, entryId);
          if (index === undefined) return "unknown-entry";
          const forkedId = `s${sessions.size + 1}`;
          const agent = buildAgent(
            forkedId,
            session.agent.provider,
            session.agent.history().slice(0, index + 1),
          );
          sessions.set(forkedId, {
            agent,
            title: `session ${forkedId}`,
            detach: attach(forkedId, agent),
            staged: undefined,
            labels: new Map(),
            parent: id,
          });
          return { sessionId: forkedId };
        }),
      label: (id, entryId, label) =>
        verb(id, (session): LabelOutcome | "unknown-entry" => {
          if (entryIndexOf(session, entryId) === undefined) return "unknown-entry";
          if (label === null) session.labels.delete(entryId);
          else session.labels.set(entryId, label);
          return { entryId, label };
        }),
      moveLeaf: (id, entryId) =>
        verb(id, (session): LeafOutcome | "busy" | "unknown-entry" => {
          const index = entryId === null ? -1 : entryIndexOf(session, entryId);
          if (index === undefined) return "unknown-entry";
          if (session.agent.busy()) return "busy";
          session.staged = undefined;
          const history = session.agent.history().slice(0, index + 1);
          swap(id, session, buildAgent(id, session.agent.provider, history));
          announce(id, session);
          return { leafId: stateOf(session).leafId };
        }),
    },
    changes: changesPortOver({ has: async (id) => sessions.has(id) }, async () => options.changes),
    lifecycle: memoryTrash(sessions, trashed, summaryOf),
    asks: async () => asks.list(),
    answerAsk: async (callId, verdict, scope) => asks.answer(callId, verdict, scope),
    permissions: async () => ledger.view(),
    revokeWorkspaceGrant: async (rule) => ledger.revokeWorkspace(rule),
    close: async () => {
      asks.close();
      for (const session of sessions.values()) {
        session.agent.interrupt();
        session.detach();
      }
      sessions.clear();
    },
    ...(options.memory !== undefined && { memory: options.memory }),
    ...(options.surfaces !== undefined &&
      memorySurfacePorts(options.surfaces, {
        has: (id) => sessions.has(id),
        busy: (id) => sessions.get(id)?.agent.busy() ?? false,
        now,
      })),
  };
}

function memoryTrash(
  sessions: Map<string, MemorySession>,
  trashed: Map<string, MemorySession>,
  summaryOf: (id: string, session: MemorySession) => SessionSummary,
): SessionLifecyclePort {
  return {
    remove: async (id) => {
      const session = sessions.get(id);
      if (session === undefined) return "missing";
      if (session.agent.busy()) return "busy";
      session.detach();
      sessions.delete(id);
      trashed.set(id, session);
      return summaryOf(id, session);
    },
    trash: async () => [...trashed].map(([id, session]) => summaryOf(id, session)),
    restore: async (id) => {
      const session = trashed.get(id);
      if (session === undefined) return undefined;
      trashed.delete(id);
      sessions.set(id, session);
      return summaryOf(id, session);
    },
    discard: async (id) => {
      const session = trashed.get(id);
      if (session === undefined) return undefined;
      trashed.delete(id);
      return summaryOf(id, session);
    },
    purge: async () => {
      const count = trashed.size;
      trashed.clear();
      return count;
    },
  };
}

export interface SurfaceSessions {
  has(id: string): boolean;
  busy(id: string): boolean;
  now(): Date;
}

export type MemorySurfacePorts = Required<
  Pick<SessionHost, "workspace" | "mcp" | "arcs" | "bots" | "workspaces" | "themes">
>;

export function memorySurfacePorts(
  options: MemorySurfaceOptions,
  sessions: SurfaceSessions,
): MemorySurfacePorts {
  const root = resolve(options.root);
  const composedTrusted = options.trust === "trusted";
  let trust: TrustDecision = options.trust ?? "undecided";
  const files = workspaceFiles(root, toolScope(root));
  const bindings = new Map<string, SessionBinding>();
  const arcs = new Map<string, ArcSummary>();
  const arcListeners = new Set<() => void>();
  const bots = new Map<string, BotSummary>();
  const namedWorkspaces = new Map<string, string[]>();
  const defaultFocusDirs: string[] = [];
  const arcsChanged = (): void => {
    for (const listener of [...arcListeners]) listener();
  };
  const requireArcs = (): void => {
    if (!composedTrusted) throw new SurfaceUnavailableError(arcsNeedTrust);
  };
  const requireArc = (slug: string): ArcSummary => {
    requireArcs();
    const arc = arcs.get(slug);
    if (arc === undefined) throw new MissingArcError(slug);
    return arc;
  };
  const archive = (slug: string): number => {
    const arc = requireArc(slug);
    if (arc.status !== "active") throw new ArcNotActiveError(slug, arc.status);
    arcs.set(slug, { ...arc, status: "archived" });
    let released = 0;
    for (const [id, binding] of bindings) {
      if (binding.arc !== slug) continue;
      bindings.set(id, bindingWith(id, { arc: undefined }));
      released += 1;
    }
    arcsChanged();
    return released;
  };
  const bindingOf = (id: string): SessionBinding => bindings.get(id) ?? {};
  const bindingWith = (
    id: string,
    patch: { arc?: string | undefined; bot?: string | undefined },
  ): SessionBinding => {
    const current = bindingOf(id);
    const arc = "arc" in patch ? patch.arc : current.arc;
    const bot = "bot" in patch ? patch.bot : current.bot;
    return { ...(arc !== undefined && { arc }), ...(bot !== undefined && { bot }) };
  };
  const boundTo = (slug: string): number =>
    [...bindings.values()].filter((binding) => binding.arc === slug).length;
  const focusDirsOf = (slug: string | undefined): string[] => {
    if (slug === undefined) return defaultFocusDirs;
    const dirs = namedWorkspaces.get(slug);
    if (dirs === undefined) throw new Error(`no workspace named ${slug}`);
    return dirs;
  };
  const choiceOf = (slug: string | undefined, focusDirs: readonly string[]): WorkspaceChoice => ({
    slug,
    name: slug ?? "default",
    declared: true,
    current: slug === undefined,
    notes: 0,
    focusDirs,
    sessions: 0,
    lastUsed: undefined,
  });
  return {
    workspace: {
      report: async () => ({
        anchor: { root, source: "launch" },
        identity: options.identity ?? "memory",
        declared: false,
        contextDirs: [],
        missingContextDirs: [],
        focusDirs: defaultFocusDirs,
        trust,
        readiness: readinessOf(trust),
      }),
      trust: async () => {
        if (trust === "untrusted") throw new TrustRefusedError(root);
        trust = "trusted";
        return {
          trusted: true,
          root,
          vault: join(root, ".keywork", "memory"),
          reopens: !composedTrusted,
        };
      },
      tree: files.tree,
      file: files.file,
    },
    mcp: options.mcp ?? noMcpRegistry,
    arcs: {
      list: async () => {
        requireArcs();
        return [...arcs.values()].map((arc) => ({ ...arc, sessions: boundTo(arc.slug) }));
      },
      create: async (slug) => {
        requireArcs();
        if (arcs.has(slug)) throw new ArcExistsError(slug);
        const arc: ArcSummary = {
          slug,
          status: "active",
          created: sessions.now().toISOString(),
          sessions: 0,
        };
        arcs.set(slug, arc);
        arcsChanged();
        return arc;
      },
      close: async (slug) => ({ kind: "closed", delivered: 0, released: archive(slug) }),
      abandon: async (slug) => {
        archive(slug);
      },
      bindSession: async (id, slug) => {
        if (!sessions.has(id)) return undefined;
        bindings.set(id, bindingWith(id, { arc: slug ?? undefined }));
        arcsChanged();
        return bindingOf(id);
      },
      subscribe: (listener) => {
        arcListeners.add(listener);
        return () => arcListeners.delete(listener);
      },
    },
    bots: {
      list: async () => [...bots.values()],
      create: async (draft) => {
        if (draft.scope === "project" && !composedTrusted) {
          throw new SurfaceUnavailableError(projectBotsNeedTrust);
        }
        if (bots.has(draft.slug)) throw new Error(`a bot named ${draft.slug} already exists`);
        const entry: BotEntry = {
          name: draft.slug,
          sigil: draft.slug.charAt(0).toUpperCase(),
          source: draft.scope,
          learning: "notes",
          ...(draft.purpose !== undefined && { description: draft.purpose }),
        };
        bots.set(draft.slug, { ...entry, sessions: 0 });
        return entry;
      },
      bindSession: async (id, name) => {
        if (!sessions.has(id)) return undefined;
        if (sessions.busy(id)) throw new SessionBusyError();
        if (name !== null && !bots.has(name)) throw new Error(`no bot named ${name}`);
        bindings.set(id, bindingWith(id, { bot: name ?? undefined }));
        return bindingOf(id);
      },
    },
    workspaces: {
      list: async () => [
        choiceOf(undefined, defaultFocusDirs),
        ...[...namedWorkspaces].map(([slug, dirs]) => choiceOf(slug, dirs)),
      ],
      create: async (slug) => {
        if (namedWorkspaces.has(slug)) throw new Error(`a workspace named ${slug} already exists`);
        namedWorkspaces.set(slug, []);
      },
      use: async (slug) => {
        focusDirsOf(slug);
      },
      linkFocusDir: async (slug, dir) => {
        const dirs = focusDirsOf(slug);
        if (dirs.includes(dir)) throw new Error(`${dir} is already a focus dir`);
        dirs.push(dir);
        return dir;
      },
      unlinkFocusDir: async (slug, dir) => {
        const dirs = focusDirsOf(slug);
        const at = dirs.indexOf(dir);
        if (at === -1) throw new Error(`${dir} isn't a focus dir here`);
        dirs.splice(at, 1);
      },
    },
    themes: {
      list: async () => ({
        themes: options.themes ?? [],
        active: options.themes?.[0]?.name ?? "keywork-night",
        placeholders: ["system"],
      }),
    },
  };
}

export const arcsNeedTrust = "arcs need a trusted workspace with memory";

export const projectBotsNeedTrust = "project bots need a trusted workspace";

const noMcpRegistry: McpPort = {
  status: async () => [],
  restart: async (name) => {
    throw new McpServerNotFoundError(name);
  },
  setEnabled: async (name) => {
    throw new McpServerNotFoundError(name);
  },
  listTools: async (name) => {
    throw new McpServerNotFoundError(name);
  },
  subscribe: () => () => undefined,
};

function readinessOf(trust: TrustDecision): WorkspaceReadiness {
  if (trust === "untrusted") return "refused";
  return trust === "undecided" ? "undecided" : "undeclared";
}

const nothingToCompact = "nothing to compact yet · the recent turns are all that's here";

function entriesOf(id: string, session: MemorySession): SessionEntries {
  const entries = session.agent.history().map(
    (message, index): SessionEntry => ({
      type: "message",
      id: `m${index}`,
      parentId: index === 0 ? null : `m${index - 1}`,
      timestamp: "",
      message,
    }),
  );
  return {
    sessionId: id,
    name: session.title,
    leafId: entries.at(-1)?.id ?? null,
    entries,
    labels: Object.fromEntries(session.labels),
    activePath: entries.map((entry) => entry.id),
  };
}

function entryIndexOf(session: MemorySession, entryId: string): number | undefined {
  const match = /^m(\d+)$/.exec(entryId);
  const index = match === null ? Number.NaN : Number(match[1]);
  return index < session.agent.history().length ? index : undefined;
}

function lastPromptIndex(history: readonly Message[]): number {
  return history.findLastIndex((message) => message.role === "user");
}

function textOf(message: Message): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function transcriptPage(session: MemorySession): string {
  const transcript = JSON.stringify(session.agent.history(), null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${session.title}</title></head><body><pre>${transcript}</pre></body></html>\n`;
}

export interface VaultMemoryOptions {
  vaultRoot: string;
  trusted: boolean;
  now?: () => Date;
  airlock?: ArcAirlockPort;
}

export interface VaultMemoryPort extends MemoryPort {
  readonly store: MemoryStore;
  changed(): void;
}

export const vaultBootstrapBudget = 4096;

export function vaultMemoryPort(options: VaultMemoryOptions): VaultMemoryPort {
  const store = new MemoryStore({
    vaultRoot: options.vaultRoot,
    trusted: options.trusted,
    ...(options.now !== undefined && { now: options.now }),
  });
  const search = new MemorySearch(store);
  const listeners = new Set<() => void>();
  const recordsOf = async (): Promise<MemoryNoteRecord[]> => {
    const notes = await store.listNotes();
    const selection = await store.bootstrap(vaultBootstrapBudget);
    const injected = new Set(selection.notes.map((note) => note.name));
    return notes.map((note) => ({
      ...note,
      layer: "workspace",
      file: join(store.vaultRoot, note.path),
      injected: injected.has(note.name),
      recalls: 0,
    }));
  };
  return {
    store,
    changed: () => {
      for (const listener of [...listeners]) listener();
    },
    trusted: () => store.trusted,
    overview: async () => ({
      layers: [
        {
          id: "workspace",
          kind: "workspace",
          label: "workspace",
          prompt: {
            budget: vaultBootstrapBudget,
            used: (await store.bootstrap(vaultBootstrapBudget)).tokens,
          },
        },
      ],
      inbox: await store.listStaged(),
      ledger: store.ledger(),
      audit: await store.readAudit(),
      gardener: { state: "idle" },
      airlocks: [],
    }),
    inbox: () => store.listStaged(),
    approve: (id) => store.approve(id),
    discard: (id) => store.discard(id),
    notes: recordsOf,
    note: async (name) => {
      const records = await recordsOf();
      const found = records.find((note) => titleKey(note.name) === titleKey(name));
      if (found === undefined) return undefined;
      return { ...found, relations: relationsOf(MemoryGraph.fromNotes(records), found) };
    },
    dailyDates: () => store.listDailyDates(),
    daily: (date) => store.readDaily(date),
    ledger: () => store.ledger(),
    revert: (ledgerId) => store.revert(ledgerId),
    query: async (text) => {
      const outcome = await search.search(text);
      return {
        hits: outcome.hits.map((hit) => ({
          note: hit.note.name,
          layer: "workspace",
          ranks: hit.ranks,
          superseded: hit.superseded,
        })),
        source: outcome.source.kind,
        ...(outcome.source.kind !== "lexical" && { embeddings: outcome.source.embeddings }),
      };
    },
    airlock: options.airlock ?? noAirlock,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const noAirlock: ArcAirlockPort = {
  digest: async () => undefined,
  triageCandidate: async (slug) => {
    throw new Error(`arc ${slug} has nothing at the airlock`);
  },
  triageQuestion: async (slug) => {
    throw new Error(`arc ${slug} has nothing at the airlock`);
  },
  deliverEligible: async () => 0,
  finish: async () => ({ kind: "undecided", items: [] }),
};

function relationsOf(graph: MemoryGraph, note: Note): NoteRelation[] {
  const key = titleKey(note.name);
  return graph.edges.flatMap((edge): NoteRelation[] => {
    if (titleKey(edge.subject) === key)
      return [{ name: edge.object, predicate: edge.predicate, direction: "out" }];
    if (titleKey(edge.object) === key)
      return [{ name: edge.subject, predicate: edge.predicate, direction: "in" }];
    return [];
  });
}

function parseFrame(block: string): SseFrame | undefined {
  const fields = block.split("\n").filter((line) => !line.startsWith(":"));
  if (fields.length === 0) return undefined;
  const frame: SseFrame = { id: undefined, event: undefined, data: "" };
  const data: string[] = [];
  for (const line of fields) {
    const separator = line.indexOf(":");
    const name = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (name === "id") frame.id = value;
    else if (name === "event") frame.event = value;
    else if (name === "data") data.push(value);
  }
  frame.data = data.join("\n");
  return frame;
}
