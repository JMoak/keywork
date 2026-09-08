import {
  Agent,
  type EngineEvents,
  type EventBus,
  type Message,
  type MessageEntry,
  messageText,
  type Provider,
  type SessionTreeNode,
  type ToolCallPart,
  type TurnDelegate,
  toolCalls,
  type Usage,
} from "@keywork/engine";
import type {
  BusEnvelope,
  EngineEventType,
  KeyworkClient,
  SessionDetail,
  SessionSummary,
} from "@keywork/server";
import type {
  AgentFactory,
  SessionAttachment,
  SessionOverviewItem,
  SessionPort,
  SessionTreePort,
  SessionTreeView,
} from "@keywork/tui";

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
      const detail = await client.session(id);
      return detail === undefined ? undefined : attachmentOf(detail, detail.messages);
    },
    create: async () => attachmentOf(await client.createSession(), []),
  };
}

export function remoteSessionTreePort(client: KeyworkClient, feed: ServerFeed): SessionTreePort {
  return {
    overview: async () => (await client.sessions()).map(overviewItemOf),
    load: async (sessionId) => {
      const detail = await client.session(sessionId);
      return detail === undefined ? undefined : treeViewOf(detail);
    },
    setLabel: async () => {
      throw new Error("labels stay on the server · not available while attached");
    },
    fork: async () => {
      throw new Error("forking stays on the server · not available while attached");
    },
    subscribe: (listener) =>
      feed.subscribe((envelope) => {
        if (envelope.type === "turn.completed" || envelope.type === "turn.interrupted") {
          listener(envelope.sessionId);
        }
      }),
  };
}

export function replayMessages(messages: readonly Message[], bus: EventBus<EngineEvents>): void {
  const pendingCalls = new Map<string, ToolCallPart>();
  for (const message of messages) {
    if (message.role === "user") {
      bus.emit("turn.started", { userText: messageText(message), replay: true });
    } else if (message.role === "assistant") {
      replayAssistant(message, bus, pendingCalls);
    } else if (message.role === "tool") {
      replayToolResults(message, bus, pendingCalls);
    }
  }
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
  if (locallyOwnedEvents.has(envelope.type)) return;
  if (envelope.type === "engine.error") {
    bus.emit("engine.error", { error: errorFromWire(envelope.payload) });
    return;
  }
  bus.emit(envelope.type, envelope.payload as EngineEvents[typeof envelope.type]);
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

function attachmentOf(summary: SessionSummary, history: readonly Message[]): SessionAttachment {
  return {
    id: summary.id,
    ...(summary.title !== untitledPlaceholder && { name: summary.title }),
    arc: summary.arc,
    bot: summary.bot,
    history,
    replay: (bus) => replayMessages(history, bus),
    append: async () => undefined,
  };
}

function overviewItemOf(summary: SessionSummary): SessionOverviewItem {
  return {
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

function treeViewOf(detail: SessionDetail): SessionTreeView {
  const roots: SessionTreeNode[] = [];
  let parent: SessionTreeNode | undefined;
  detail.messages.forEach((message, index) => {
    const entry: MessageEntry = {
      type: "message",
      id: `${detail.id}#${index + 1}`,
      parentId: parent?.entry.id ?? null,
      timestamp: detail.lastActivityAt,
      message,
    };
    const node: SessionTreeNode = { entry, children: [], onActivePath: true };
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    parent = node;
  });
  return {
    sessionId: detail.id,
    roots,
    ...(detail.title !== untitledPlaceholder && { name: detail.title }),
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
