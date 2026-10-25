import {
  Agent,
  type EngineEvents,
  type EventBus,
  type FlushMark,
  isPromptEntry,
  type Message,
  type MessageEntry,
  messageText,
  type Provider,
  type SessionEntry,
  type SessionTreeNode,
  type ToolCallPart,
  type TurnDelegate,
  toolCalls,
  type Usage,
} from "@keywork/engine";
import {
  type BusEnvelope,
  type EngineEventType,
  engineEventTypes,
  type KeyworkClient,
  type SessionDetail,
  type SessionEntries,
  type SessionRow,
  type SessionSummary,
  type WireEventType,
} from "@keywork/server";
import type {
  AgentFactory,
  PermissionsPort,
  ReplayedSummary,
  ServedRewind,
  SessionAttachment,
  SessionOverviewItem,
  SessionPort,
  SessionRemoval,
  SessionTreePort,
  SessionTreeView,
} from "@keywork/tui";
import { turnRecordsOf } from "./sessions/turns.ts";

export interface ServerFeed {
  open(): Promise<void>;
  subscribe(listener: (envelope: BusEnvelope) => void): () => void;
  whenLost(listener: (reason: Error) => void): () => void;
  close(): void;
}

export function serverFeed(client: KeyworkClient): ServerFeed {
  const listeners = new Set<(envelope: BusEnvelope) => void>();
  const lossListeners = new Set<(reason: Error) => void>();
  const stops = new AbortController();
  let lost: Error | undefined;
  let opened: Promise<void> | undefined;
  const open = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const events = client.events({ signal: stops.signal, onOpen: resolve });
      pumpEvents(events, (envelope) => {
        for (const listener of [...listeners]) listener(envelope);
      })
        .then(() => reject(new Error("the event stream closed")))
        .catch((cause: unknown) => {
          lost = cause instanceof Error ? cause : new Error(String(cause));
          for (const listener of [...lossListeners]) listener(lost);
          reject(lost);
        });
    });
  return {
    open: () => {
      opened ??= open();
      return opened;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      opened ??= open();
      opened.catch(() => undefined);
      return () => listeners.delete(listener);
    },
    whenLost: (listener) => {
      if (lost !== undefined) listener(lost);
      lossListeners.add(listener);
      return () => lossListeners.delete(listener);
    },
    close: () => stops.abort(),
  };
}

export const attachedProviderName = "attached";

export function remoteAgentFactory(client: KeyworkClient, feed: ServerFeed): AgentFactory {
  return (_guard, history, seams) =>
    new Agent({
      provider: attachedProvider(client.url),
      turns: remoteTurns(client, feed, () => seams?.sessionId()),
      ...(history !== undefined && { history }),
      ...(seams?.bus !== undefined && { bus: seams.bus }),
    });
}

export function remoteTurns(
  client: KeyworkClient,
  feed: ServerFeed,
  boundSession: () => string | undefined,
): TurnDelegate {
  return async ({ userText, signal, bus }) => {
    const sessionId = boundSession();
    if (sessionId === undefined) throw new Error("this pane has no server session yet");
    const turn = followTurn(client, feed, sessionId, bus, signal);
    try {
      const outcome = await client.prompt(sessionId, userText);
      if (outcome === "missing") throw new Error(`the server has no session ${sessionId}`);
      const settled = await turn.settled;
      const detail = await client.session(sessionId);
      return { ...settled, ...(detail !== undefined && { history: detail.messages }) };
    } finally {
      turn.stop();
    }
  };
}

export function remoteSessionPort(client: KeyworkClient): SessionPort {
  return {
    open: async (id) => {
      const [detail, listed, permissions] = await Promise.all([
        client.session(id),
        client.entries(id),
        client.listPermissions().catch(() => undefined),
      ]);
      if (detail === undefined) return undefined;
      const quiet = permissions?.quiet.includes(id) === true;
      const replayed = {
        messages: detail.messages,
        prompts: promptsOf(listed),
        flushes: detail.flushes,
      };
      return {
        ...attachmentOf(client, detail, replayed),
        quiet,
        summaries: summariesOf(detail),
      };
    },
    create: async () => attachmentOf(client, await client.createSession(), nothingReplayed),
  };
}

export function remotePermissionsPort(client: KeyworkClient): PermissionsPort {
  return {
    seat: "attached",
    view: () => client.listPermissions(),
    revokeWorkspace: async (rule) => (await client.revokeWorkspaceGrant(rule)) === "revoked",
    sessionGrants: (sessionId) => ({
      rules: async () => (await client.listPermissions()).session[sessionId] ?? [],
      forget: async (rule) => (await client.revokeSessionGrant(sessionId, rule)) === "revoked",
    }),
  };
}

export function remoteSessionTreePort(client: KeyworkClient, feed: ServerFeed): SessionTreePort {
  return {
    overview: async () => (await client.sessions()).map(overviewItemOf),
    load: async (sessionId) => {
      const listed = await client.entries(sessionId);
      return listed === undefined ? undefined : treeViewOf(listed);
    },
    setLabel: async (sessionId, entryId, label) => {
      await client.labelEntry(sessionId, entryId, label ?? null);
    },
    fork: async (sessionId, entryId) => (await client.fork(sessionId, entryId))?.sessionId,
    remove: (sessionId) => client.removeSession(sessionId).then(removalOf),
    trash: async () => (await client.trash()).map(overviewItemOf),
    restore: async (sessionId) => {
      const restored = await client.restoreSession(sessionId);
      return restored === undefined ? undefined : overviewItemOf(restored);
    },
    discard: (sessionId) => client.discardTrashedSession(sessionId),
    purgeTrash: async () => (await client.purgeTrash()).purged,
    subscribe: (listener) =>
      feed.subscribe((envelope) => {
        if (treeMoves.has(envelope.type)) listener(envelope.sessionId);
      }),
  };
}

const treeMoves: ReadonlySet<WireEventType> = new Set([
  "turn.completed",
  "turn.interrupted",
  "session.tree",
  "session.removed",
  "session.restored",
  "session.state",
]);

function removalOf(answer: SessionSummary | "missing" | "busy"): SessionRemoval {
  return typeof answer === "string" ? answer : "removed";
}

export function replayMessages(
  messages: readonly Message[],
  bus: EventBus<EngineEvents>,
  prompts: readonly MessageEntry[] = [],
  flushes: readonly FlushMark[] = [],
): void {
  const pendingCalls = new Map<string, ToolCallPart>();
  const promptIds = promptIdsAlong(messages, prompts);
  const flushed = flushedIndices(messages, flushes);
  messages.forEach((message, at) => {
    if (flushed.has(at)) return;
    if (message.role === "user") {
      const entryId = promptIds.get(at);
      bus.emit("turn.started", {
        userText: messageText(message),
        replay: true,
        ...(entryId !== undefined && { entryId }),
      });
    } else if (message.role === "assistant") {
      replayAssistant(message, bus, pendingCalls);
    } else if (message.role === "tool") {
      replayToolResults(message, bus, pendingCalls);
    }
  });
}

interface SettledTurn {
  message: Message;
  usage: Usage;
  interrupted: boolean;
}

interface FollowedTurn {
  settled: Promise<SettledTurn>;
  stop(): void;
}

const locallyOwnedEvents: ReadonlySet<EngineEventType> = new Set(["turn.started", "queue.changed"]);

function followTurn(
  client: KeyworkClient,
  feed: ServerFeed,
  sessionId: string,
  bus: EventBus<EngineEvents>,
  signal: AbortSignal,
): FollowedTurn {
  const teardown: Array<() => void> = [];
  const settled = new Promise<SettledTurn>((resolve, reject) => {
    teardown.push(
      feed.subscribe((envelope) => {
        if (envelope.sessionId !== sessionId) return;
        const outcome = turnOutcomeOf(envelope);
        if (outcome !== undefined) resolve(outcome);
        else relay(envelope, bus);
      }),
    );
    teardown.push(feed.whenLost(reject));
    const abortRemotely = (): void => {
      void client
        .abort(sessionId)
        .then((outcome) => outcome === "aborted" || resolve(interruptedBeforeReply()), reject);
    };
    signal.addEventListener("abort", abortRemotely, { once: true });
    teardown.push(() => signal.removeEventListener("abort", abortRemotely));
  });
  return {
    settled,
    stop: () => {
      for (const step of teardown.splice(0)) step();
    },
  };
}

function turnOutcomeOf(envelope: BusEnvelope): SettledTurn | undefined {
  if (envelope.type === "turn.completed") {
    const { message, usage } = envelope.payload as EngineEvents["turn.completed"];
    return { message, usage, interrupted: false };
  }
  if (envelope.type === "turn.interrupted") {
    const { message } = envelope.payload as EngineEvents["turn.interrupted"];
    return { message, usage: zeroUsage, interrupted: true };
  }
  return undefined;
}

function relay(envelope: BusEnvelope, bus: EventBus<EngineEvents>): void {
  const type = envelope.type;
  if (!isEngineEvent(type) || locallyOwnedEvents.has(type)) return;
  if (type === "engine.error") {
    bus.emit("engine.error", { error: errorFromWire(envelope.payload) });
    return;
  }
  bus.emit(type, envelope.payload as EngineEvents[typeof type]);
}

const engineEvents: ReadonlySet<string> = new Set(engineEventTypes);

function isEngineEvent(type: WireEventType): type is EngineEventType {
  return engineEvents.has(type);
}

function errorFromWire(payload: unknown): Error {
  const wire = (payload as { error?: { name?: unknown; message?: unknown } } | null)?.error;
  const error = new Error(typeof wire?.message === "string" ? wire.message : "server error");
  if (typeof wire?.name === "string") error.name = wire.name;
  return error;
}

const zeroUsage: Usage = { inputTokens: 0, outputTokens: 0 };

function interruptedBeforeReply(): SettledTurn {
  return { message: { role: "assistant", parts: [] }, usage: zeroUsage, interrupted: true };
}

function attachedProvider(url: string): Provider {
  return {
    name: attachedProviderName,
    stream: () => {
      throw new Error(`turns run on the server at ${url}`);
    },
  };
}

const untitledPlaceholder = "(untitled session)";

interface ReplayedHistory {
  messages: readonly Message[];
  prompts: readonly MessageEntry[];
  flushes: readonly FlushMark[];
}

const nothingReplayed: ReplayedHistory = { messages: [], prompts: [], flushes: [] };

function attachmentOf(
  client: KeyworkClient,
  summary: SessionSummary,
  replayed: ReplayedHistory,
): SessionAttachment {
  const id = summary.id;
  const path = async (): Promise<SessionEntry[]> => activePathOf(await client.entries(id));
  return {
    id,
    ...(summary.title !== untitledPlaceholder && { name: summary.title }),
    arc: summary.arc,
    bot: summary.bot,
    history: replayed.messages,
    replay: (bus) => replayMessages(replayed.messages, bus, replayed.prompts, replayed.flushes),
    append: async (message) => (message.role === "user" ? latestPrompt(await path()) : undefined),
    pinTitle: async (title) => {
      await client.rename(id, title);
    },
    recordQuiet: async (on) => {
      await client.setQuiet(id, on);
    },
    context: () => client.context(id),
    bindArc: async (slug) => {
      await client.bindSessionArc(id, slug ?? null);
    },
    bindBot: async (name) => {
      await client.bindSessionBot(id, name ?? null);
    },
    turns: async () => turnRecordsOf(await path()),
    rewindOnServer: async (promptId) => rewindOnServer(client, id, promptId, await path()),
  };
}

async function rewindOnServer(
  client: KeyworkClient,
  sessionId: string,
  promptId: string,
  path: readonly SessionEntry[],
): Promise<ServedRewind | undefined> {
  const turn = turnRecordsOf(path).find((record) => record.promptId === promptId)?.turn;
  if (turn === undefined) return undefined;
  const restored = await client.restoreTurn(sessionId, turn);
  if (typeof restored === "string") return undefined;
  return {
    history: await historyOf(client, sessionId),
    filesNote: restored.filesNote,
    cancel: async () => {
      await client.redo(sessionId);
      return historyOf(client, sessionId);
    },
  };
}

function summariesOf(detail: SessionDetail): ReplayedSummary[] {
  return detail.summaries.flatMap((mark) => {
    const message = detail.messages[mark.index];
    return message === undefined ? [] : [{ text: messageText(message), kind: mark.kind }];
  });
}

async function historyOf(client: KeyworkClient, sessionId: string): Promise<readonly Message[]> {
  return (await client.session(sessionId))?.messages ?? [];
}

function activePathOf(listed: SessionEntries | undefined): SessionEntry[] {
  if (listed === undefined) return [];
  const byId = new Map(listed.entries.map((entry) => [entry.id, entry]));
  return listed.activePath.flatMap((id) => byId.get(id) ?? []);
}

function promptsOf(listed: SessionEntries | undefined): MessageEntry[] {
  return activePathOf(listed).filter(isPromptEntry);
}

function latestPrompt(path: readonly SessionEntry[]): { entryId: string } | undefined {
  const prompt = path.findLast(isPromptEntry);
  return prompt === undefined ? undefined : { entryId: prompt.id };
}

function flushedIndices(
  messages: readonly Message[],
  flushes: readonly FlushMark[],
): ReadonlySet<number> {
  return new Set(
    flushes.flatMap(({ index }) =>
      messages[index + 1]?.role === "assistant" ? [index, index + 1] : [index],
    ),
  );
}

function promptIdsAlong(
  messages: readonly Message[],
  prompts: readonly MessageEntry[],
): Map<number, string> {
  const ids = new Map<number, string>();
  let next = prompts.length - 1;
  for (let at = messages.length - 1; at >= 0 && next >= 0; at -= 1) {
    const message = messages[at];
    const prompt = prompts[next];
    if (message?.role !== "user" || prompt === undefined) continue;
    if (messageText(message) !== messageText(prompt.message)) continue;
    ids.set(at, prompt.id);
    next -= 1;
  }
  return ids;
}

function overviewItemOf(summary: SessionSummary | SessionRow): SessionOverviewItem {
  const desk = "working" in summary ? deskFactsOf(summary) : {};
  return {
    ...desk,
    id: summary.id,
    title: summary.title,
    createdAt: Date.parse(summary.createdAt),
    modifiedAt: Date.parse(summary.lastActivityAt),
    entryCount: summary.messageCount,
    branchCount: 0,
    labelCount: 0,
    ...(summary.costNanos !== undefined && { costNanos: summary.costNanos }),
    ...(summary.arc !== undefined && { arc: summary.arc }),
    ...(summary.bot !== undefined && { bot: summary.bot }),
  };
}

function deskFactsOf(
  row: SessionRow,
): Pick<SessionOverviewItem, "working" | "waiting" | "changes"> {
  return {
    working: row.working,
    waiting: row.waiting,
    ...(row.changes !== undefined && { changes: row.changes }),
  };
}

function treeViewOf(listed: SessionEntries): SessionTreeView {
  const active = new Set(listed.activePath);
  const nodes = new Map<string, SessionTreeNode>(
    listed.entries.map((entry) => {
      const label = listed.labels[entry.id];
      const node: SessionTreeNode = {
        entry,
        children: [],
        onActivePath: active.has(entry.id),
        ...(label !== undefined && { label }),
      };
      return [entry.id, node];
    }),
  );
  const roots: SessionTreeNode[] = [];
  for (const entry of listed.entries) {
    const node = nodes.get(entry.id);
    const parent = entry.parentId === null ? undefined : nodes.get(entry.parentId);
    if (node === undefined) continue;
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  return {
    sessionId: listed.sessionId,
    roots,
    ...(listed.name !== undefined && { name: listed.name }),
  };
}

function replayAssistant(
  message: Message,
  bus: EventBus<EngineEvents>,
  pendingCalls: Map<string, ToolCallPart>,
): void {
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "visible-thinking") {
      bus.emit("turn.delta", { delta: part, replay: true });
    }
    if (part.type === "tool-call") {
      bus.emit("turn.delta", { delta: { type: "tool-call", call: part }, replay: true });
      pendingCalls.set(part.callId, part);
    }
  }
  if (toolCalls(message).length === 0) {
    bus.emit("turn.completed", { message, usage: zeroUsage, replay: true });
  }
}

function replayToolResults(
  message: Message,
  bus: EventBus<EngineEvents>,
  pendingCalls: Map<string, ToolCallPart>,
): void {
  for (const part of message.parts) {
    if (part.type !== "tool-result") continue;
    const call = pendingCalls.get(part.callId);
    if (call !== undefined) {
      pendingCalls.delete(part.callId);
      bus.emit("tool.started", { call, replay: true });
    }
    bus.emit("tool.finished", {
      callId: part.callId,
      output: part.output,
      isError: part.isError,
      ...(part.spill !== undefined && { spill: part.spill }),
      replay: true,
    });
  }
}

async function pumpEvents(
  events: AsyncIterable<BusEnvelope>,
  deliver: (envelope: BusEnvelope) => void,
): Promise<void> {
  for await (const envelope of events) deliver(envelope);
}
