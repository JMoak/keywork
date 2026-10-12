import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  addUsage,
  type BotDefinition,
  type Checkpoints,
  type ContextReading,
  type CostRollup,
  compactionDue,
  type EffortLevel,
  estimateConversationTokens,
  formatReference,
  isEffortLevel,
  type JournalTap,
  type Message,
  type MessageEntry,
  type ModelChangeEntry,
  mergeCostRollups,
  modelReferenceOf,
  type PermissionLedger,
  type PermissionResolver,
  type PromptOrigin,
  type Provider,
  readContext,
  type SendBehavior,
  type SendOptions,
  SessionStore,
  ShellSession,
  scopeContains,
  type ToolGuard,
  type ToolScope,
  type TurnSettlement,
  tapJournal,
  type Usage,
} from "@keywork/engine";
import {
  AskQueue,
  ChangesFeed,
  type ChangesSource,
  type CompactionReport,
  type CostReport,
  changesPortOver,
  EventLog,
  type ExportOutcome,
  type ExportScope,
  issueToken,
  type LeafOutcome,
  listen,
  type ModelSpend,
  type ModelSwitch,
  type PresetHost,
  type PresetOutcome,
  type RedoReport,
  readServerTicket,
  removeServerTicket,
  type ServerTicket,
  SessionBusyError,
  type SessionDetail,
  type SessionHost,
  type SessionInference,
  type SessionSettlement,
  type SessionState,
  type SessionSummary,
  type UndoReport,
  type WorkspaceInfo,
  writeServerTicket,
} from "@keywork/server";
import {
  type KeyworkConfig,
  type LspConfig,
  type McpServerConfig,
  type ModelCapabilitiesConfig,
  type PresetName,
  type PromptsConfig,
  requiresConfirmation,
  resolveAnchor,
} from "@keywork/shared";
import { persistNewMessages } from "./chat.ts";
import { defaultSessionDir, keyworkHome, workspaceIdentity } from "./paths.ts";
import { checkpointChanges } from "./serve-changes.ts";
import { servedLifecycle } from "./serve-lifecycle.ts";
import { servedMemory } from "./serve-memory.ts";
import { type ServedSession, surfacePorts } from "./serve-surfaces.ts";
import { servedTree } from "./serve-tree.ts";
import { composeServedWorkspace, type ServedWorkspace } from "./serve-workspace.ts";
import {
  budgetOf,
  compactSessionNow,
  type SessionFlushes,
  type SettlingSession,
  settleSessionTurn,
} from "./session-settle.ts";
import { exportSession } from "./sessions/export.ts";
import { sessionHtml } from "./sessions/export-html.ts";
import { forkOrigin } from "./sessions/lifecycle.ts";
import { moveLeaf, rewindBefore } from "./sessions/ports.ts";
import {
  findSession,
  newSessionFileName,
  type SessionSummary as StoredSummary,
  scanSessions,
  summarize,
} from "./sessions/store.ts";
import { keyworkVersion } from "./version.ts";
import { workspacePermissions } from "./workspace-permissions.ts";

export interface ServeOptions extends HostOptions {
  port?: number | undefined;
  ticketFile?: string | undefined;
  fetch?: typeof fetch | undefined;
  signal: AbortSignal;
  print: (line: string) => void;
  printError: (line: string) => void;
}

export interface HostOptions {
  cwd: string;
  projectTrusted: boolean;
  provider: Provider;
  permissions: PermissionResolver;
  inference?: SessionInference | undefined;
  presets?: PresetHost | undefined;
  checkpoints?: "on" | "off" | undefined;
  checkpointsGitDir?: string | undefined;
  askTimeoutMs?: number | undefined;
  workspaceSlug?: string | undefined;
  sessionDir?: string | undefined;
  userRoot?: string | undefined;
  prompts?: PromptsConfig | undefined;
  mcpServers?: Record<string, McpServerConfig> | undefined;
  repoMap?: "auto" | "off" | undefined;
  lsp?: LspConfig | undefined;
  sandbox?: KeyworkConfig["sandbox"] | undefined;
  models?: ModelCapabilitiesConfig | undefined;
  thinking?: KeyworkConfig["thinking"] | undefined;
  theme?: string | undefined;
  closingProvider?: Provider | undefined;
  notice?: ((text: string) => void) | undefined;
}

export function serverTicketFile(userRoot?: string): string {
  return join(keyworkHome(userRoot), "server.json");
}

export function workspaceTicketFile(cwd: string, slug?: string, userRoot?: string): string {
  return join(keyworkHome(userRoot), "workspaces", workspaceIdentity(cwd, slug), "server.json");
}

export function ticketFilesFor(cwd: string, slug?: string, userRoot?: string): string[] {
  return [workspaceTicketFile(cwd, slug, userRoot), serverTicketFile(userRoot)];
}

export const alreadyServingExit = 2;

export async function serve(options: ServeOptions): Promise<number> {
  const ticketFiles =
    options.ticketFile === undefined
      ? ticketFilesFor(options.cwd, options.workspaceSlug, options.userRoot)
      : [options.ticketFile];
  const running = await runningServerAmong(ticketFiles, options.fetch ?? fetch);
  if (running !== undefined) {
    options.printError(
      `keywork serve: a keywork server for this workspace is already listening at ${running.url} · attach to it, or stop it first`,
    );
    return alreadyServingExit;
  }
  const log = new EventLog();
  const host = await servedHost({ ...options, log, notice: options.printError });
  const token = issueToken();
  let server: Awaited<ReturnType<typeof listen>>;
  try {
    server = await listen({
      token,
      host,
      log,
      version: keyworkVersion,
      port: options.port,
      workspace: workspaceInfoOf(options.cwd, options.workspaceSlug),
    });
  } catch (cause) {
    options.printError(`keywork serve: ${cause instanceof Error ? cause.message : String(cause)}`);
    await host.close();
    return 1;
  }
  for (const file of ticketFiles) writeServerTicket(file, { url: server.url, token });
  options.print(`listening on ${server.url}`);
  options.print(`token ${token}`);
  for (const file of ticketFiles) options.print(`ticket ${file}`);
  await untilAborted(options.signal);
  await server.close();
  for (const file of ticketFiles) removeServerTicket(file);
  return 0;
}

export function workspaceInfoOf(cwd: string, slug?: string): WorkspaceInfo {
  return { anchor: resolveAnchor(cwd).root, identity: workspaceIdentity(cwd, slug) };
}

export async function runningServerAmong(
  ticketFiles: readonly string[],
  fetcher: typeof fetch,
): Promise<ServerTicket | undefined> {
  for (const file of ticketFiles) {
    const ticket = readServerTicket(file);
    if (ticket === undefined) continue;
    if (await answersAsKeywork(ticket, fetcher)) return ticket;
    removeServerTicket(file);
  }
  return undefined;
}

export async function answersAsKeywork(
  ticket: ServerTicket,
  fetcher: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(`${ticket.url}/doc`, {
      signal: AbortSignal.timeout(healthCheckTimeoutMs),
    });
    if (!response.ok) return false;
    const document = (await response.json()) as { info?: { title?: unknown } };
    return document.info?.title === "keywork";
  } catch {
    return false;
  }
}

const healthCheckTimeoutMs = 1500;

export function fileSessionHost(options: HostOptions & { log: EventLog }): SessionHost {
  const gate = servedGate(options);
  return sessionVerbsHost(new LiveSessions(options, gate), gate);
}

export async function servedHost(options: HostOptions & { log: EventLog }): Promise<SessionHost> {
  const gate = servedGate(options);
  const sessions = new LiveSessions(options, gate);
  const { composition, arcs, bots } = await sessions.composed();
  const sessionDir = options.sessionDir ?? defaultSessionDir(options.cwd, options.workspaceSlug);
  return {
    ...sessionVerbsHost(sessions, gate),
    ...surfacePorts({
      ...options,
      sessionDir,
      arcs,
      composition: () => Promise.resolve(composition),
      session: (id) => sessions.bound(id),
    }),
    memory: servedMemory({ memory: composition.memory, arcs, bots }),
  };
}

interface ServedGate {
  asks: AskQueue;
  ledger: PermissionLedger;
}

function servedGate(options: HostOptions): ServedGate {
  const ledger = workspacePermissions({ ...options, user: options.permissions });
  const asks = new AskQueue({
    grants: ledger,
    ...(options.askTimeoutMs !== undefined && { timeoutMs: options.askTimeoutMs }),
  });
  return { asks, ledger };
}

function sessionVerbsHost(sessions: LiveSessions, { asks, ledger }: ServedGate): SessionHost {
  const onLive = async <T>(
    id: string,
    act: (live: LiveSession) => T | Promise<T>,
  ): Promise<T | "missing"> => {
    const live = await sessions.open(id);
    return live === undefined ? "missing" : act(live);
  };
  return {
    list: () => sessions.list(),
    read: (id) => sessions.read(id),
    create: () => sessions.create(),
    prompt: (id, text, behavior) => onLive(id, (live) => live.run(text, { behavior })),
    inject: (id, text, origin) => onLive(id, (live) => live.run(text, { origin })),
    abort: async (id) => {
      const live = sessions.liveOnly(id);
      if (live !== undefined) return live.interrupt();
      return (await sessions.stored(id)) === undefined ? "missing" : "idle";
    },
    setModel: (id, reference) => onLive(id, (live) => live.switchModel(reference)),
    setThinking: (id, on) => onLive(id, (live) => live.setThinking(on)),
    setEffort: (id, level) => onLive(id, (live) => live.setEffort(level)),
    compact: (id, focus) => onLive(id, (live) => live.compact(focus)),
    undo: (id) => onLive(id, (live) => live.undo()),
    redo: (id) => onLive(id, (live) => live.redo()),
    context: (id) => onLive(id, (live) => live.context()),
    cost: (id) => onLive(id, (live) => live.cost()),
    exportHtml: (id, scope, out) => onLive(id, (live) => live.exportHtml(scope, out)),
    rename: (id, title) => onLive(id, (live) => live.rename(title)),
    applyPreset: (name, confirmed) => sessions.applyPreset(name, confirmed),
    tree: servedTree({
      sessionDir: sessions.sessionDir,
      bound: (id) => sessions.bound(id),
      moveLeaf: (id, entryId) => onLive(id, (live) => live.moveLeaf(entryId)),
    }),
    changes: changesPortOver({ has: async (id) => (await sessions.bound(id)) !== undefined }, () =>
      sessions.changesSource(),
    ),
    lifecycle: servedLifecycle({
      sessionDir: sessions.sessionDir,
      bound: (id) => sessions.bound(id),
      release: (id) => sessions.release(id),
      summaryOf: storedSummary,
    }),
    asks: async () => asks.list(),
    answerAsk: async (callId, verdict, scope) => asks.answer(callId, verdict, scope),
    permissions: async () => ledger.view(),
    revokeWorkspaceGrant: async (rule) => ledger.revokeWorkspace(rule),
    revokeSessionGrant: async (sessionId, rule) => ledger.revokeSession(sessionId, rule),
    close: async () => {
      asks.close();
      await sessions.close();
    },
  };
}

interface SessionRuntime {
  log: EventLog;
  cwd: string;
  scope: ToolScope;
  checkpoints: Checkpoints | undefined;
  changes: ChangesFeed;
  inference: SessionInference | undefined;
  fallback: Provider;
  flushes: SessionFlushes;
  notice(text: string): void;
  forge(provider: Provider, history: readonly Message[]): Agent;
  botNamed(name: string | undefined): BotDefinition | undefined;
}

class LiveSessions {
  readonly sessionDir: string;
  private readonly live = new Map<string, LiveSession>();
  private readonly changes: ChangesFeed;
  private workspace: Promise<ServedWorkspace> | undefined;

  constructor(
    private readonly options: HostOptions & { log: EventLog },
    private readonly gate: ServedGate,
  ) {
    this.sessionDir = options.sessionDir ?? defaultSessionDir(options.cwd, options.workspaceSlug);
    this.changes = new ChangesFeed(options.log, () => this.changesSource());
  }

  async list(): Promise<SessionSummary[]> {
    const { stores } = await scanSessions(this.sessionDir);
    const summarized = await Promise.all(stores.map((store) => this.summaryOf(store)));
    const listed = summarized
      .sort((a, b) => b.stored.modifiedAt.getTime() - a.stored.modifiedAt.getTime())
      .map(({ summary }) => summary);
    const unlisted = [...this.live.values()]
      .filter((live) => !listed.some((summary) => summary.id === live.id))
      .map((live) => live.summary());
    return [...unlisted, ...listed];
  }

  async read(id: string): Promise<SessionDetail | undefined> {
    const live = this.liveOnly(id);
    if (live !== undefined) return this.withForkOrigin(live.detail(this.options.log.latestId()));
    const store = await this.stored(id);
    if (store === undefined) return undefined;
    return this.withForkOrigin({
      ...storedSummary(await summarize(store), store),
      cwd: store.header.cwd,
      live: false,
      messages: store.messages(),
      asOf: this.options.log.latestId(),
      ...parentSessionOf(store),
    });
  }

  async release(id: string): Promise<void> {
    const live = this.live.get(id);
    if (live === undefined) return;
    this.live.delete(id);
    await live.close();
    await (await this.composed()).released(id);
  }

  private async withForkOrigin(detail: SessionDetail): Promise<SessionDetail> {
    const forkedFrom = await forkOrigin(this.sessionDir, detail.parentSession);
    return forkedFrom === undefined ? detail : { ...detail, forkedFrom };
  }

  async create(): Promise<SessionSummary> {
    const store = await SessionStore.create(
      join(this.sessionDir, newSessionFileName()),
      this.options.cwd,
    );
    return (await this.adopt(store)).summary();
  }

  async open(id: string): Promise<LiveSession | undefined> {
    const live = this.liveOnly(id);
    if (live !== undefined) return live;
    const store = await this.stored(id);
    return store === undefined ? undefined : this.adopt(store);
  }

  liveOnly(id: string): LiveSession | undefined {
    return this.live.get(id);
  }

  stored(id: string): Promise<SessionStore | undefined> {
    return findSession(this.sessionDir, id);
  }

  async changesSource(): Promise<ChangesSource | undefined> {
    const { composition } = await this.composed();
    const { checkpoints } = composition;
    return checkpoints === undefined
      ? undefined
      : checkpointChanges(checkpoints, composition.scope);
  }

  async bound(id: string): Promise<ServedSession | undefined> {
    const live = this.liveOnly(id);
    if (live !== undefined) return live.served();
    const store = await this.stored(id);
    return store === undefined ? undefined : { store, busy: () => false };
  }

  async applyPreset(name: PresetName, confirmed: boolean): Promise<PresetOutcome> {
    const presets = this.options.presets;
    if (presets === undefined) return "unavailable";
    const from = presets.active();
    if (from === name) return { from, to: name };
    if (requiresConfirmation(from, name) && !confirmed) return "needs-confirmation";
    await presets.apply(name);
    for (const live of this.live.values()) live.announcePreset(from, name);
    return { from, to: name };
  }

  async close(): Promise<void> {
    for (const live of this.live.values()) await live.close();
    await this.changes.settled();
    if (this.workspace !== undefined) await (await this.workspace).close();
    this.live.clear();
  }

  private async summaryOf(
    store: SessionStore,
  ): Promise<{ stored: StoredSummary; summary: SessionSummary }> {
    const stored = await summarize(store);
    const summary = this.liveOnly(store.header.id)?.summary() ?? storedSummary(stored, store);
    return { stored, summary };
  }

  private async adopt(store: SessionStore): Promise<LiveSession> {
    const workspace = await this.composed();
    const { composition, agents } = workspace;
    const { options } = this;
    const id = store.header.id;
    const shell = new ShellSession(options.cwd);
    const guard = checkpointingGuard(this.gate.asks.guardFor(id), composition.checkpoints);
    const runtime: SessionRuntime = {
      log: options.log,
      cwd: composition.scope.cwd,
      scope: composition.scope,
      checkpoints: composition.checkpoints,
      changes: this.changes,
      inference: options.inference,
      fallback: options.provider,
      flushes: agents,
      notice: (text) => options.notice?.(`keywork serve: ${text}`),
      forge: (provider, history) =>
        agents.build({
          provider,
          guard,
          shell,
          history,
          sessionId: id,
          spills: store.spills(),
          permissions: this.gate.ledger.resolverFor(id),
          bot: workspace.botNamed(store.botBinding()),
        }),
      botNamed: workspace.botNamed,
    };
    const live = new LiveSession(store, shell, runtime);
    this.live.set(id, live);
    await workspace.attached(store);
    return live;
  }

  composed(): Promise<ServedWorkspace> {
    this.workspace ??= this.compose();
    return this.workspace;
  }

  private compose(): Promise<ServedWorkspace> {
    const { options } = this;
    return composeServedWorkspace({
      cwd: options.cwd,
      projectTrusted: options.projectTrusted,
      workspaceSlug: options.workspaceSlug,
      sessionDir: this.sessionDir,
      userRoot: options.userRoot ?? homedir(),
      provider: options.provider,
      closingProvider: options.closingProvider,
      permissions: options.permissions,
      thinking: options.thinking === "on",
      prompts: options.prompts,
      mcpServers: options.mcpServers,
      repoMap: options.repoMap,
      models: options.models,
      lsp: options.lsp,
      sandbox: options.sandbox,
      checkpoints: options.checkpoints ?? "on",
      checkpointsGitDir: options.checkpointsGitDir,
      notice: (text) => options.notice?.(`keywork serve: ${text}`),
      storeOf: (id) => this.live.get(id)?.served().store,
      liveStores: () => [...this.live.values()].map((live) => live.served().store),
      onReleased: (id) => void this.live.get(id)?.adoptBinding(),
    });
  }
}

interface BoundAgent {
  agent: Agent;
  bot: string | undefined;
  journal: JournalTap;
  detach: () => void;
}

interface StagedUndo {
  cancel(): Promise<void>;
}

interface StagedFiles {
  note: string;
  restore(): Promise<void>;
}

const untouchedFiles: StagedFiles = { note: "files untouched", restore: async () => {} };

class LiveSession {
  readonly id: string;
  private bound: BoundAgent;
  private persisted: number;
  private settled: Promise<void> = Promise.resolve();
  private staged: StagedUndo | undefined;
  private readonly spend = new SpendLedger();

  constructor(
    private readonly store: SessionStore,
    private readonly shell: ShellSession,
    private readonly runtime: SessionRuntime,
  ) {
    this.id = store.header.id;
    this.bound = this.bind(runtime.forge(this.storedProvider(), store.messages()));
    this.adoptStoredSettings();
    this.persisted = this.agent.history().length;
  }

  private get agent(): Agent {
    return this.bound.agent;
  }

  run(
    text: string,
    options: { behavior?: SendBehavior | undefined; origin?: PromptOrigin | undefined },
  ): "started" | "queued" {
    const outcome = this.agent.busy() ? "queued" : "started";
    this.staged = undefined;
    const turn = this.agent.send(text, sendOptionsOf(options)).then(
      () => undefined,
      () => undefined,
    );
    this.settled = this.settled.then(() => turn);
    this.announce();
    return outcome;
  }

  interrupt(): "aborted" | "idle" {
    if (!this.agent.busy()) return "idle";
    this.agent.interrupt();
    return "aborted";
  }

  async switchModel(reference: string): Promise<ModelSwitch | "busy"> {
    const { inference } = this.runtime;
    if (inference === undefined) {
      return { failure: { code: "unconfigured", message: noRegistry, available: [] } };
    }
    const bound = inference.bind(reference);
    if (!bound.ok) return { failure: bound.failure };
    if (!(await this.idle())) return "busy";
    const model = bound.binding.reference;
    await this.swap(this.runtime.forge(inference.provider(bound.binding), this.agent.history()));
    if (!sameSelection(this.store.modelSelection(), model)) {
      await this.store.appendModelChange(model.provider, model.model);
    }
    this.announce();
    return { model, notice: `model → ${formatReference(model)}` };
  }

  async setThinking(on: boolean): Promise<{ thinking: boolean }> {
    this.agent.setThinking(on);
    const level = on ? "on" : "off";
    if (this.store.thinkingLevel() !== level) await this.store.appendThinkingLevelChange(level);
    this.announce();
    return { thinking: on };
  }

  async setEffort(level: EffortLevel | null): Promise<{ effort: EffortLevel | null } | "busy"> {
    if (level === null) {
      if (!(await this.idle())) return "busy";
      await this.swap(this.runtime.forge(this.agent.provider, this.agent.history()), null);
      const recorded = this.store.effort();
      if (recorded !== undefined && isEffortLevel(recorded)) {
        await this.store.appendEffortChange(providerDefaultEffort);
      }
    } else {
      this.agent.setEffort(level);
      if (this.store.effort() !== level) await this.store.appendEffortChange(level);
    }
    this.announce();
    return { effort: level };
  }

  async compact(focus?: string): Promise<CompactionReport | "busy"> {
    if (!(await this.idle())) return "busy";
    const settlement = await compactSessionNow(this.settling(), focus, this.runtime.flushes);
    this.reportSettlement("requested", settlement);
    if (settlement.history !== undefined) {
      await this.swap(this.runtime.forge(this.agent.provider, settlement.history));
    }
    this.announce();
    return { compacted: settlement.compacted ?? null, notices: settlement.notices };
  }

  async undo(): Promise<UndoReport | "busy" | "nothing"> {
    if (!(await this.idle())) return "busy";
    this.staged = undefined;
    const prompt = lastPromptOnPath(this.store);
    if (prompt === undefined) return this.undoFilesOnly();
    const rewound = rewindBefore(this.store, prompt.id);
    if (rewound === undefined) return "nothing";
    const { provider } = this.agent;
    await this.swap(this.runtime.forge(provider, rewound.history));
    const files = await this.stageFiles(rewound.checkpoint);
    this.staged = {
      cancel: async () => {
        await files.restore();
        await this.swap(this.runtime.forge(provider, rewound.restore()));
      },
    };
    this.announce();
    return {
      prompt: { entryId: prompt.id, text: textOf(prompt.message) },
      filesNote: files.note,
      ...this.travel(),
    };
  }

  async redo(): Promise<RedoReport | "busy" | "nothing"> {
    if (!(await this.idle())) return "busy";
    const staged = this.staged;
    if (staged !== undefined) {
      this.staged = undefined;
      await staged.cancel();
    } else if (!(await this.redoFilesOnly())) {
      return "nothing";
    }
    this.announce();
    return { restored: true, ...this.travel() };
  }

  context(): ContextReading {
    return readContext(estimateConversationTokens(this.agent.history()), budgetOf(this.agent));
  }

  cost(): CostReport {
    return this.spend.report(this.agent);
  }

  async exportHtml(scope: ExportScope, out?: string): Promise<ExportOutcome> {
    await this.settled;
    if (out === undefined) return { html: sessionHtml(this.store, scope) };
    if (!scopeContains(this.runtime.scope, out)) return "outside-scope";
    return { file: await exportSession(this.store, { scope, out, cwd: this.runtime.cwd }) };
  }

  async moveLeaf(entryId: string | null): Promise<LeafOutcome | "busy" | "unknown-entry"> {
    if (entryId !== null && this.store.entry(entryId) === undefined) return "unknown-entry";
    if (!(await this.idle())) return "busy";
    this.staged = undefined;
    moveLeaf(this.store, entryId);
    await this.swap(this.runtime.forge(this.agent.provider, this.store.messages()));
    this.announce();
    return { leafId: this.store.leafId() };
  }

  async rename(title: string): Promise<{ title: string }> {
    await this.store.setName(title, true);
    this.announce();
    return { title };
  }

  announcePreset(from: string, to: string): void {
    this.agent.bus.emit("gate.preset", { from, to });
  }

  summary(): SessionSummary {
    const stats = this.store.stats();
    const { model, thinking, effort } = this.state();
    return {
      id: this.id,
      title: this.title(),
      createdAt: this.store.header.timestamp,
      lastActivityAt: stats.lastActivityAt,
      messageCount: this.agent.history().length,
      ...this.store.binding(),
      ...(model !== undefined && { model }),
      thinking,
      ...(effort !== undefined && { effort }),
    };
  }

  detail(asOf: number): SessionDetail {
    return {
      ...this.summary(),
      cwd: this.store.header.cwd,
      live: true,
      messages: this.agent.history(),
      asOf,
      ...parentSessionOf(this.store),
    };
  }

  state(): SessionState {
    const model = this.modelReference();
    const effort = this.agent.effort();
    return {
      ...(model !== undefined && { model }),
      thinking: this.agent.thinking(),
      ...(effort !== undefined && { effort }),
      title: this.title(),
      leafId: this.store.leafId(),
      ...this.store.binding(),
      ...this.travel(),
    };
  }

  async close(): Promise<void> {
    this.agent.interrupt();
    await this.settled;
    await this.release(this.bound);
    await this.shell.close();
  }

  served(): ServedSession {
    return {
      store: this.store,
      busy: () => this.agent.busy(),
      adoptBinding: () => this.adoptBinding(),
    };
  }

  async adoptBinding(): Promise<void> {
    const bot = this.store.botBinding();
    if (bot !== this.bound.bot) {
      if (!(await this.idle())) throw new SessionBusyError();
      const provider = await this.providerSeededBy(this.runtime.botNamed(bot));
      await this.swap(this.runtime.forge(provider, this.agent.history()));
    }
    this.announce();
  }

  private title(): string {
    return this.store.name() ?? "(untitled session)";
  }

  private modelReference(): string | undefined {
    const live = modelReferenceOf(this.agent.provider);
    if (live !== undefined) return live;
    const selection = this.store.modelSelection();
    return selection === undefined ? undefined : referenceOf(selection);
  }

  private travel(): { undoable: boolean; redoable: boolean } {
    const { checkpoints } = this.runtime;
    return {
      undoable: lastPromptOnPath(this.store) !== undefined || checkpoints?.canUndo() === true,
      redoable: this.staged !== undefined || checkpoints?.canRedo() === true,
    };
  }

  private announce(): void {
    this.runtime.log.record(this.id, "session.state", this.state());
  }

  private async idle(): Promise<boolean> {
    if (this.agent.busy()) return false;
    await this.settled;
    return true;
  }

  private async afterTurn(): Promise<void> {
    await this.persistTurn(this.agent.history());
    const settlement = await settleSessionTurn(
      this.settling(),
      this.agent.history(),
      "after-turn",
      this.runtime.flushes,
    );
    this.reportSettlement("after-turn", settlement);
    if (settlement.history !== undefined) {
      await this.swap(this.runtime.forge(this.agent.provider, settlement.history));
    }
    this.announce();
  }

  private async settleToolBatch(
    history: readonly Message[],
  ): Promise<readonly Message[] | undefined> {
    const reading = readContext(estimateConversationTokens(history), budgetOf(this.agent));
    if (!compactionDue(reading)) return undefined;
    await this.persistTurn(history);
    const settlement = await settleSessionTurn(
      this.settling(),
      history,
      "between-tool-batches",
      this.runtime.flushes,
    );
    this.reportSettlement("between-tool-batches", settlement);
    if (settlement.history !== undefined) this.persisted = settlement.history.length;
    return settlement.history;
  }

  private async persistTurn(history: readonly Message[]): Promise<void> {
    this.persisted = await persistNewMessages(
      this.store,
      history,
      this.persisted,
      this.runtime.checkpoints,
    );
  }

  private settling(): SettlingSession {
    return { sessionId: this.id, store: this.store, agent: this.agent };
  }

  private reportSettlement(
    phase: SessionSettlement["phase"],
    settlement: Pick<TurnSettlement, "flushed" | "compacted" | "notices">,
  ): void {
    const quiet =
      settlement.flushed.length === 0 &&
      settlement.compacted === undefined &&
      settlement.notices.length === 0;
    if (quiet) return;
    const report: SessionSettlement = {
      phase,
      flushed: settlement.flushed.length,
      compacted: settlement.compacted ?? null,
      notices: settlement.notices,
    };
    this.runtime.log.record(this.id, "session.settled", report);
  }

  private async providerSeededBy(bot: BotDefinition | undefined): Promise<Provider> {
    const { inference } = this.runtime;
    if (bot?.model === undefined || inference === undefined) return this.agent.provider;
    const bound = inference.bind(bot.model);
    if (!bound.ok) {
      this.runtime.notice(
        `bot ${bot.name} asks for ${bot.model} · ${bound.failure.message} · keeping the session's model`,
      );
      return this.agent.provider;
    }
    const model = bound.binding.reference;
    if (!sameSelection(this.store.modelSelection(), model)) {
      await this.store.appendModelChange(model.provider, model.model);
    }
    return inference.provider(bound.binding);
  }

  private storedProvider(): Provider {
    const selection = this.store.modelSelection();
    const { inference, fallback } = this.runtime;
    if (selection === undefined || inference === undefined) return fallback;
    const bound = inference.bind(referenceOf(selection));
    if (bound.ok) return inference.provider(bound.binding);
    this.runtime.notice(
      `session ${this.id.slice(0, 8)} asked for ${referenceOf(selection)} · ${bound.failure.message} · using the server's model`,
    );
    return fallback;
  }

  private adoptStoredSettings(): void {
    const thinking = this.store.thinkingLevel();
    if (thinking === "on" || thinking === "off") this.agent.setThinking(thinking === "on");
    const effort = this.store.effort();
    if (effort !== undefined && isEffortLevel(effort)) this.agent.setEffort(effort);
  }

  private bind(agent: Agent): BoundAgent {
    agent.settleTurnsWith(() => this.afterTurn());
    agent.settleToolBatchesWith((history) => this.settleToolBatch(history));
    const detach = this.runtime.log.attach(agent.bus, this.id);
    const unfollow = this.runtime.changes.follow(agent.bus, this.id);
    return {
      agent,
      bot: this.store.botBinding(),
      journal: tapJournal(agent.bus, this.store),
      detach: () => {
        detach();
        unfollow();
      },
    };
  }

  private async swap(
    next: Agent,
    effort: EffortLevel | null = this.agent.effort() ?? null,
  ): Promise<void> {
    const previous = this.bound;
    this.spend.retire(previous.agent);
    next.setThinking(previous.agent.thinking());
    if (effort !== null) next.setEffort(effort);
    await this.release(previous);
    this.bound = this.bind(next);
    this.persisted = next.history().length;
    next.adoptQueue(previous.agent);
  }

  private async release(bound: BoundAgent): Promise<void> {
    bound.agent.settleTurnsWith(undefined);
    bound.agent.settleToolBatchesWith(undefined);
    bound.journal.stop();
    await bound.journal.flush();
    bound.detach();
  }

  private async undoFilesOnly(): Promise<UndoReport | "nothing"> {
    const { checkpoints } = this.runtime;
    if (checkpoints === undefined || !(await checkpoints.undo())) return "nothing";
    await this.runtime.changes.announce(this.id);
    this.announce();
    return { prompt: null, filesNote: "files put back", ...this.travel() };
  }

  private async redoFilesOnly(): Promise<boolean> {
    const { checkpoints } = this.runtime;
    if (checkpoints === undefined || !(await checkpoints.redo())) return false;
    await this.runtime.changes.announce(this.id);
    return true;
  }

  private async stageFiles(checkpoint: string | undefined): Promise<StagedFiles> {
    const { checkpoints } = this.runtime;
    if (checkpoints === undefined || checkpoint === undefined) return untouchedFiles;
    const left = await checkpoints.snapshot();
    const travel = async (tree: string): Promise<void> => {
      await checkpoints.restoreTo(tree);
      await this.runtime.changes.announce(this.id);
    };
    await travel(checkpoint);
    return { note: "files put back", restore: () => travel(left) };
  }
}

const noRegistry = "this server was started without a model registry";

const providerDefaultEffort = "default";

interface ModelTotals {
  usage: Usage;
  rollup: CostRollup;
}

class SpendLedger {
  private readonly retired = new Map<string, ModelTotals>();

  retire(agent: Agent): void {
    const key = spendKeyOf(agent);
    this.retired.set(key, addTotals(this.retired.get(key), totalsOf(agent)));
  }

  report(agent: Agent): CostReport {
    const rows = new Map(this.retired);
    const key = spendKeyOf(agent);
    rows.set(key, addTotals(rows.get(key), totalsOf(agent)));
    const models: ModelSpend[] = [...rows].map(([reference, totals]) => ({
      reference,
      turns: totals.rollup.pricedTurns + totals.rollup.unpricedTurns,
      ...totals,
    }));
    const total = models.reduce<ModelTotals | undefined>(addTotals, undefined) ?? totalsOf(agent);
    const modelId = agent.modelId();
    const cacheMiss = agent.cacheMiss();
    return {
      rollup: total.rollup,
      usage: total.usage,
      ...(modelId !== undefined && { modelId }),
      ...(cacheMiss !== undefined && { cacheMiss }),
      models,
    };
  }
}

function totalsOf(agent: Agent): ModelTotals {
  return { usage: agent.usage(), rollup: agent.cost() };
}

function addTotals(left: ModelTotals | undefined, right: ModelTotals): ModelTotals {
  if (left === undefined) return right;
  return {
    usage: addUsage(left.usage, right.usage),
    rollup: mergeCostRollups(left.rollup, right.rollup),
  };
}

function spendKeyOf(agent: Agent): string {
  return modelReferenceOf(agent.provider) ?? agent.provider.name;
}

function checkpointingGuard(asks: ToolGuard, checkpoints: Checkpoints | undefined): ToolGuard {
  if (checkpoints === undefined) return asks;
  return {
    ...asks,
    beforeMutation: () => checkpoints.capture(),
    beforeTurn: () => checkpoints.beginTurn(),
  };
}

function sendOptionsOf(options: {
  behavior?: SendBehavior | undefined;
  origin?: PromptOrigin | undefined;
}): SendOptions {
  return {
    ...(options.behavior !== undefined && { behavior: options.behavior }),
    ...(options.origin !== undefined && { origin: options.origin }),
  };
}

function lastPromptOnPath(store: SessionStore): MessageEntry | undefined {
  return store
    .activePath()
    .findLast(
      (entry): entry is MessageEntry => entry.type === "message" && entry.message.role === "user",
    );
}

function textOf(message: Message): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function referenceOf(selection: ModelChangeEntry): string {
  return formatReference({ provider: selection.provider, model: selection.modelId });
}

function sameSelection(
  selection: ModelChangeEntry | undefined,
  model: { provider: string; model: string },
): boolean {
  return selection?.provider === model.provider && selection.modelId === model.model;
}

function parentSessionOf(store: SessionStore): { parentSession?: string } {
  const { parentSession } = store.header;
  return parentSession === undefined ? {} : { parentSession };
}

function storedSummary(summary: StoredSummary, store: SessionStore): SessionSummary {
  const selection = store.modelSelection();
  const thinking = store.thinkingLevel();
  const effort = store.effort();
  return {
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    lastActivityAt: summary.lastActivityAt,
    messageCount: summary.messageCount,
    ...(summary.costNanos !== undefined && { costNanos: summary.costNanos }),
    ...(summary.arc !== undefined && { arc: summary.arc }),
    ...(summary.bot !== undefined && { bot: summary.bot }),
    ...(selection !== undefined && { model: referenceOf(selection) }),
    ...((thinking === "on" || thinking === "off") && { thinking: thinking === "on" }),
    ...(effort !== undefined && isEffortLevel(effort) && { effort }),
  };
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
