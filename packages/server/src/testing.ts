import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  type EffortLevel,
  type Message,
  type MessageEntry,
  memoryGrants,
  messageText,
  modelReferenceOf,
  PermissionLedger,
  type PromptOrigin,
  type Provider,
  parseReference,
  type SendBehavior,
  SessionStore,
  type Tool,
  type ToolGuard,
  UsageLedger,
} from "@keywork/engine";
import { type ActivePreset, requiresConfirmation } from "@keywork/shared";
import { AskQueue } from "./asks.ts";
import { announceChanges, type ChangeSource, changedFileOf, changedFilesOf } from "./changes.ts";
import { type EventLog, processLevelSessionId } from "./events.ts";
import type {
  BoundModel,
  ChangesOutcome,
  SessionDetail,
  SessionHost,
  SessionInference,
  SessionState,
  SessionSummary,
} from "./host.ts";
import { type MemoryWorkspace, memoryHost } from "./memory.ts";
import { contextReportOf, costReportOf } from "./reports.ts";
import { spillSliceOf } from "./spills.ts";
import {
  type MemorySurfaceOptions,
  memorySurfaces,
  type SessionBindings,
  type SessionStatus,
} from "./testing-surfaces.ts";
import { entriesOf, moveLeafOf, treeChange } from "./tree.ts";

export {
  arcsUnavailable,
  type MemorySurfaceOptions,
  type SessionBindings,
  type SessionStatus,
} from "./testing-surfaces.ts";

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

export function inferenceOver(models: Readonly<Record<string, Provider>>): SessionInference {
  const known = Object.keys(models);
  return {
    bind: (selection): BoundModel => {
      if (selection === undefined) {
        const [first] = known;
        const provider = first === undefined ? undefined : models[first];
        return provider === undefined
          ? { ok: false, failure: { code: "unconfigured", message: "no models", available: [] } }
          : { ok: true, provider, reference: first ?? "" };
      }
      const reference = known.find(
        (candidate) => candidate === selection || parseReference(candidate)?.model === selection,
      );
      const provider = reference === undefined ? undefined : models[reference];
      if (reference === undefined || provider === undefined) {
        return {
          ok: false,
          failure: {
            code: "unknown-model",
            message: `no model matches ${selection}`,
            reference: selection,
            provider: parseReference(selection)?.provider,
            known,
          },
        };
      }
      return { ok: true, provider, reference };
    },
  };
}

export interface MemoryHostOptions {
  log: EventLog;
  provider: Provider;
  tools?: readonly Tool[];
  now?: () => Date;
  asks?: "queue" | "headless";
  askTimeoutMs?: number;
  changes?: ChangeSource | "untrusted";
  surfaces?: Omit<MemorySurfaceOptions, "log">;
  memory?: () => Promise<MemoryWorkspace | undefined>;
  inference?: SessionInference;
  preset?: ActivePreset;
  trusted?: boolean;
}

export function memorySessionHost(options: MemoryHostOptions): SessionHost {
  const now = options.now ?? (() => new Date());
  const sessions = new MemorySessions({ ...options, now }, (id) => surfaces.bindingsOf(id));
  const surfaces = memorySurfaces({ log: options.log, now, ...options.surfaces }, (id) =>
    sessions.status(id),
  );
  let preset: ActivePreset = options.preset ?? "standard";
  const session = (id: string): MemorySession | undefined => sessions.get(id);
  return {
    ...surfaces.host,
    list: async () => sessions.list(),
    read: async (id) => sessions.read(id),
    create: async () => sessions.create(),
    prompt: async (id, text, behavior) => session(id)?.run(text, behavior) ?? "missing",
    inject: async (id, text, origin) => session(id)?.run(text, "queue", origin) ?? "missing",
    abort: async (id) => session(id)?.interrupt() ?? "missing",
    entries: async (id) => {
      const live = session(id);
      return live === undefined ? undefined : { ...entriesOf(live.store), sessionId: id };
    },
    fork: (id, entryId) => sessions.fork(id, entryId),
    label: async (id, entryId, label) => (await session(id)?.label(entryId, label)) ?? "missing",
    moveLeaf: async (id, entryId) => (await session(id)?.moveLeaf(entryId)) ?? "missing",
    changes: async (id) => sessions.changes(id, changedFilesOf),
    changedFile: async (id, path) => sessions.changes(id, (source) => changedFileOf(source, path)),
    spill: async (id, spillId, range) => {
      const live = session(id);
      return live === undefined ? "missing" : spillSliceOf(live.store.spills(), spillId, range);
    },
    setModel: async (id, reference) => {
      const live = session(id);
      if (live === undefined) return "missing";
      if (options.inference === undefined) {
        return {
          ok: false,
          failure: { code: "unconfigured", message: "this host has no inference", available: [] },
        };
      }
      return live.setModel(options.inference.bind(reference));
    },
    setThinking: async (id, on) => session(id)?.setThinking(on) ?? "missing",
    setEffort: async (id, level) => session(id)?.setEffort(level) ?? "missing",
    compact: async (id) => session(id)?.compact() ?? "missing",
    undo: async (id) => (await session(id)?.undo()) ?? "missing",
    redo: async (id) => (await session(id)?.redo()) ?? "missing",
    context: async (id) => session(id)?.context() ?? "missing",
    cost: async (id) => session(id)?.cost() ?? "missing",
    export: async (id, request) => session(id)?.export(request.out) ?? "missing",
    rename: async (id, title) => session(id)?.rename(title) ?? "missing",
    checkpointsOf: async (id) => (session(id) === undefined ? "missing" : "off"),
    setPreset: async (name, confirmed) => {
      const from = preset;
      if (from !== name && requiresConfirmation(from, name) && !confirmed)
        return "needs-confirmation";
      preset = name;
      if (from !== name)
        options.log.record(processLevelSessionId, "gate.preset", { from, to: name });
      return { from, to: name };
    },
    asks: async () => sessions.asks.list(),
    answerAsk: async (callId, verdict, scope) => sessions.asks.answer(callId, verdict, scope),
    permissions: async () => sessions.ledger.view(),
    revokeWorkspaceGrant: async (rule) => sessions.ledger.revokeWorkspace(rule),
    memory: memoryHost({
      log: options.log,
      workspace: options.memory ?? (async () => undefined),
    }),
    close: () => sessions.close(),
  };
}

class MemorySessions {
  readonly asks: AskQueue;
  readonly ledger: PermissionLedger;
  private readonly sessions = new Map<string, MemorySession>();
  private readonly now: () => Date;
  private readonly dir = mkdtempSync(join(tmpdir(), "keywork-memory-host-"));
  private created = 0;

  constructor(
    private readonly options: MemoryHostOptions,
    private readonly bindingsOf: (id: string) => SessionBindings,
  ) {
    this.now = options.now ?? (() => new Date());
    this.ledger = new PermissionLedger({
      trusted: options.trusted ?? false,
      workspace: memoryGrants(),
      root: "/memory",
    });
    this.asks = new AskQueue({
      now: this.now,
      grants: this.ledger,
      ...(options.askTimeoutMs !== undefined && { timeoutMs: options.askTimeoutMs }),
    });
  }

  get(id: string): MemorySession | undefined {
    return this.sessions.get(id);
  }

  status(id: string): SessionStatus {
    const session = this.sessions.get(id);
    if (session === undefined) return "missing";
    return session.busy() ? "busy" : "idle";
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((session) => this.summaryOf(session));
  }

  read(id: string): SessionDetail | undefined {
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    return {
      ...this.summaryOf(session),
      cwd: "/memory",
      live: true,
      messages: session.messages(),
      asOf: this.options.log.latestId(),
    };
  }

  async create(): Promise<SessionSummary> {
    const id = this.nextId();
    const store = await SessionStore.create(join(this.dir, `${id}.jsonl`), "/memory");
    return this.summaryOf(this.adopt(id, store));
  }

  async fork(id: string, entryId: string) {
    const session = this.sessions.get(id);
    if (session === undefined) return "missing" as const;
    if (session.store.entry(entryId) === undefined) return "unknown-entry" as const;
    const forkId = this.nextId();
    const clone = await session.store.clone(join(this.dir, `${forkId}.jsonl`), entryId);
    const forked = this.adopt(forkId, clone);
    this.options.log.record(id, "session.tree", {
      ...treeChange(session.store, "fork", { entryId, forkedTo: forkId }),
      sessionId: id,
    });
    return this.summaryOf(forked);
  }

  async changes<Reading>(
    id: string,
    read: (source: ChangeSource) => Promise<Reading>,
  ): Promise<ChangesOutcome<Reading>> {
    if (!this.sessions.has(id)) return "missing";
    const { changes } = this.options;
    if (changes === undefined) return "no-baseline";
    if (changes === "untrusted") return "untrusted";
    return read(changes);
  }

  async close(): Promise<void> {
    this.asks.close();
    for (const session of this.sessions.values()) await session.close();
    this.sessions.clear();
    await rm(this.dir, { recursive: true, force: true });
  }

  private adopt(id: string, store: SessionStore): MemorySession {
    const { options } = this;
    const agentOver: Rebuild = (provider, history, bus) =>
      new Agent({
        provider,
        guard: options.asks === "queue" ? this.asks.guardFor(id) : headlessGuard,
        permissions: this.ledger.resolverFor(id),
        history,
        spills: store.spills(),
        ...(bus !== undefined && { bus }),
        ...(options.tools !== undefined && { tools: options.tools }),
      });
    const session = new MemorySession(id, store, agentOver(options.provider, store.messages()), {
      log: options.log,
      changes: options.changes,
      rebuild: agentOver,
    });
    this.sessions.set(id, session);
    return session;
  }

  private summaryOf(session: MemorySession): SessionSummary {
    const { arc, bot } = this.bindingsOf(session.id);
    return {
      ...session.summary(this.now()),
      ...(arc !== undefined && { arc }),
      ...(bot !== undefined && { bot }),
    };
  }

  private nextId(): string {
    this.created += 1;
    return `s${this.created}`;
  }
}

type Rebuild = (provider: Provider, history: readonly Message[], bus?: Agent["bus"]) => Agent;

interface MemorySessionSeams {
  log: EventLog;
  changes: ChangeSource | "untrusted" | undefined;
  rebuild: Rebuild;
}

class MemorySession {
  private agent: Agent;
  private title: string | undefined;
  private stagedLeaf: string | null | undefined;
  private persisted: number;
  private settledTurns: Promise<void> = Promise.resolve();
  private readonly ledger = new UsageLedger();
  private readonly stops: readonly (() => unknown)[];

  constructor(
    readonly id: string,
    readonly store: SessionStore,
    agent: Agent,
    private readonly seams: MemorySessionSeams,
  ) {
    this.agent = agent;
    this.persisted = agent.history().length;
    this.stops = [seams.log.attach(agent.bus, id), this.announceChangesOn(agent.bus)];
  }

  busy(): boolean {
    return this.agent.busy();
  }

  messages(): readonly Message[] {
    return this.agent.history();
  }

  run(text: string, behavior: SendBehavior, origin?: PromptOrigin): "started" | "queued" {
    const outcome = this.agent.busy() ? "queued" : "started";
    this.stagedLeaf = undefined;
    const sent = this.agent
      .send(text, { behavior, ...(origin !== undefined && { origin }) })
      .catch(() => undefined);
    this.settledTurns = this.settledTurns.then(() => sent).then(() => this.persist());
    return outcome;
  }

  interrupt(): "aborted" | "idle" {
    if (!this.agent.busy()) return "idle";
    this.agent.interrupt();
    return "aborted";
  }

  async label(entryId: string, label: string | undefined) {
    if (this.store.entry(entryId) === undefined) return "unknown-entry" as const;
    await this.store.setLabel(entryId, label);
    this.announceTree("label", { entryId });
    return "labelled" as const;
  }

  async moveLeaf(entryId: string | null) {
    if (this.agent.busy()) return "busy" as const;
    await this.settledTurns;
    if (!moveLeafOf(this.store, entryId)) return "unknown-entry" as const;
    this.stagedLeaf = undefined;
    this.rebuildFromStore();
    this.announceTree("leaf", entryId === null ? {} : { entryId });
    this.announceState();
    return { leafId: this.store.leafId() };
  }

  setModel(bound: BoundModel): Exclude<Awaited<ReturnType<SessionHost["setModel"]>>, "missing"> {
    if (this.agent.busy()) return "busy";
    if (!bound.ok) return bound;
    this.swap(this.seams.rebuild(bound.provider, this.agent.history(), this.agent.bus));
    this.announceState();
    const model = parseReference(bound.reference) ?? {
      provider: bound.provider.name,
      model: bound.reference,
    };
    return { ok: true, model, notice: `model → ${bound.reference}` };
  }

  setThinking(on: boolean): { thinking: boolean } {
    this.agent.setThinking(on);
    this.announceState();
    return { thinking: on };
  }

  setEffort(level: EffortLevel | null): { effort: EffortLevel | null } {
    this.agent.setEffort(level ?? undefined);
    this.announceState();
    return { effort: level };
  }

  compact(): Exclude<Awaited<ReturnType<SessionHost["compact"]>>, "missing"> {
    if (this.agent.busy()) return "busy";
    this.announceState();
    return { compacted: null, notices: ["nothing to compact · this host never compacts"] };
  }

  async undo(): Promise<Exclude<Awaited<ReturnType<SessionHost["undo"]>>, "missing">> {
    if (this.agent.busy()) return "busy";
    await this.settledTurns;
    if (this.stagedLeaf !== undefined) return "staged";
    const prompt = lastPromptOf(this.store);
    if (prompt === undefined) return "nothing";
    this.stagedLeaf = this.store.leafId();
    moveLeafOf(this.store, prompt.parentId);
    this.rebuildFromStore();
    this.announceState();
    return {
      prompt: { entryId: prompt.id, text: messageText(prompt.message) },
      filesNote: "files untouched",
      undoable: this.undoable(),
      redoable: true,
    };
  }

  async redo(): Promise<Exclude<Awaited<ReturnType<SessionHost["redo"]>>, "missing">> {
    if (this.agent.busy()) return "busy";
    const staged = this.stagedLeaf;
    if (staged === undefined) return "nothing";
    this.stagedLeaf = undefined;
    moveLeafOf(this.store, staged);
    this.rebuildFromStore();
    this.announceState();
    return { restored: true, undoable: this.undoable(), redoable: false };
  }

  context(): ReturnType<typeof contextReportOf> {
    return contextReportOf(this.agent);
  }

  cost(): ReturnType<typeof costReportOf> {
    return costReportOf(this.agent, this.ledger);
  }

  export(out: string | undefined): { html: string } | { refused: string } {
    if (out !== undefined)
      return { refused: "this host keeps sessions in memory and writes no files" };
    const lines = this.agent
      .history()
      .map((message) => `<p class="${message.role}">${escapeHtml(messageText(message))}</p>`);
    return {
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(this.titled())}</title></head><body>${lines.join("")}</body></html>`,
    };
  }

  rename(title: string): { title: string } {
    this.title = title;
    this.announceState();
    return { title };
  }

  summary(at: Date): SessionSummary {
    const model = modelReferenceOf(this.agent.provider);
    const effort = this.agent.effort();
    return {
      id: this.id,
      title: this.titled(),
      createdAt: at.toISOString(),
      lastActivityAt: at.toISOString(),
      messageCount: this.agent.history().length,
      ...(model !== undefined && { model }),
      thinking: this.agent.thinking(),
      ...(effort !== undefined && { effort }),
    };
  }

  async close(): Promise<void> {
    this.agent.interrupt();
    await this.settledTurns;
    for (const stop of this.stops) await stop();
  }

  private async persist(): Promise<void> {
    const history = this.agent.history();
    const fresh = history.slice(this.persisted);
    if (fresh.length === 0) return;
    for (const message of fresh) await this.store.append(message);
    this.persisted = history.length;
    this.announceTree("entry", {});
  }

  private rebuildFromStore(): void {
    this.swap(this.seams.rebuild(this.agent.provider, this.store.messages(), this.agent.bus));
  }

  private swap(next: Agent): void {
    const previous = this.agent;
    this.ledger.retire(previous);
    next.setThinking(previous.thinking());
    next.setEffort(previous.effort());
    this.agent = next;
    this.persisted = next.history().length;
    next.adoptQueue(previous);
  }

  private titled(): string {
    return this.title ?? `session ${this.id}`;
  }

  private undoable(): boolean {
    return lastPromptOf(this.store) !== undefined;
  }

  private announceChangesOn(bus: Agent["bus"]): () => unknown {
    const { changes, log } = this.seams;
    if (changes === undefined || changes === "untrusted") return () => undefined;
    return announceChanges(bus, changes, (paths) =>
      log.record(this.id, "changes.updated", { sessionId: this.id, paths }),
    );
  }

  private announceTree(
    reason: Parameters<typeof treeChange>[1],
    detail: Parameters<typeof treeChange>[2],
  ): void {
    this.seams.log.record(this.id, "session.tree", {
      ...treeChange(this.store, reason, detail),
      sessionId: this.id,
    });
  }

  private announceState(): void {
    const model = modelReferenceOf(this.agent.provider);
    const effort = this.agent.effort();
    const state: SessionState = {
      ...(model !== undefined && { model }),
      thinking: this.agent.thinking(),
      ...(effort !== undefined && { effort }),
      title: this.titled(),
      leafId: this.store.leafId(),
      undoable: this.undoable(),
      redoable: this.stagedLeaf !== undefined,
    };
    this.seams.log.record(this.id, "session.state", state);
  }
}

function lastPromptOf(store: SessionStore): MessageEntry | undefined {
  return store
    .activePath()
    .findLast(
      (entry): entry is MessageEntry => entry.type === "message" && entry.message.role === "user",
    );
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => htmlEscapes[character] ?? character);
}

const htmlEscapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

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
