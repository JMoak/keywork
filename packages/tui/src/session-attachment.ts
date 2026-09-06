import {
  type Agent,
  type Message,
  modelReferenceOf,
  type ToolGuard,
  type TurnSettlement,
} from "@keywork/engine";
import type { Titler } from "./conversation-model.ts";
import type { ConversationPane } from "./conversation-pane.ts";
import type { SessionTreePort } from "./session-tree-pane.ts";

export interface AppendReceipt {
  entryId: string;
}

export interface SessionAttachment {
  id: string;
  name?: string;
  modelReference?: string;
  arc?: string | undefined;
  bot?: string | undefined;
  history: readonly Message[];
  replay(bus: Agent["bus"]): void;
  append(message: Message): Promise<AppendReceipt | undefined>;
  rename?(name: string): Promise<void>;
  recordModel?(reference: string): Promise<void>;
  bindArc?(slug: string | undefined): Promise<void>;
  bindBot?(name: string | undefined): Promise<void>;
}

export interface SessionPort {
  open(id: string): Promise<SessionAttachment | undefined>;
  create(): Promise<SessionAttachment | undefined>;
  release?(sessionId: string): void;
}

export interface AgentSeams {
  sessionId(): string | undefined;
  discloseRetrieval(text: string): void;
  bus?: Agent["bus"];
  modelReference?: string;
}

export type AgentFactory = (
  guard: ToolGuard,
  history?: readonly Message[],
  seams?: AgentSeams,
  botName?: string,
) => Agent;

export interface SessionTurn {
  sessionId: string;
  history: readonly Message[];
  agent: Agent;
}

export type AfterTurn = (turn: SessionTurn) => Promise<TurnSettlement | undefined>;
export type Compactor = (turn: SessionTurn, instructions: string) => Promise<TurnSettlement>;

export interface SessionEscrow {
  hold(sessionId: string, attachment: SessionAttachment): void;
  claim(sessionId: string): SessionAttachment | undefined;
  releaseAll(): void;
}

export function sessionEscrow(sessions: SessionPort | undefined): SessionEscrow {
  const held = new Map<string, SessionAttachment>();
  return {
    hold: (sessionId, attachment) => {
      if (held.has(sessionId)) sessions?.release?.(sessionId);
      held.set(sessionId, attachment);
    },
    claim: (sessionId) => {
      const attachment = held.get(sessionId);
      held.delete(sessionId);
      return attachment;
    },
    releaseAll: () => {
      for (const sessionId of held.keys()) sessions?.release?.(sessionId);
      held.clear();
    },
  };
}

export function attachOnFork(
  trees: SessionTreePort,
  sessions: SessionPort | undefined,
  escrow: SessionEscrow,
): SessionTreePort {
  const attach = async (sessionId: string): Promise<boolean> => {
    if (sessions === undefined) return false;
    const attachment = await sessions.open(sessionId);
    if (attachment === undefined) return false;
    escrow.hold(sessionId, attachment);
    return true;
  };
  return {
    ...trees,
    fork: async (sessionId, entryId) => {
      const forkedId = await trees.fork(sessionId, entryId);
      if (forkedId !== undefined) await attach(forkedId);
      return forkedId;
    },
    attach,
  };
}

export interface PaneSessionActivity {
  busy?(): boolean;
  waiting?(): boolean;
}

export interface PaneSessionIndex {
  bind(paneId: string, sessionId: () => string | undefined, activity?: PaneSessionActivity): void;
  closed(paneId: string): void;
  closeAll(): void;
  size(): number;
  paneFor(sessionId: string): string | undefined;
  busy(sessionId: string): boolean;
  waiting(sessionId: string): boolean;
}

interface PaneSessionBinding {
  sessionId: () => string | undefined;
  activity: PaneSessionActivity;
}

export function paneSessionIndex(sessions: SessionPort | undefined): PaneSessionIndex {
  const bindings = new Map<string, PaneSessionBinding>();
  const paneFor = (sessionId: string): string | undefined => {
    for (const [paneId, binding] of bindings) {
      if (binding.sessionId() === sessionId) return paneId;
    }
    return undefined;
  };
  const activityOf = (sessionId: string): PaneSessionActivity => {
    const paneId = paneFor(sessionId);
    return paneId === undefined ? {} : (bindings.get(paneId)?.activity ?? {});
  };
  return {
    bind: (paneId, sessionId, activity = {}) => {
      bindings.set(paneId, { sessionId, activity });
    },
    closed: (paneId) => {
      const sessionId = bindings.get(paneId)?.sessionId();
      bindings.delete(paneId);
      if (sessionId !== undefined) sessions?.release?.(sessionId);
    },
    closeAll: () => {
      for (const binding of bindings.values()) {
        const sessionId = binding.sessionId();
        if (sessionId !== undefined) sessions?.release?.(sessionId);
      }
      bindings.clear();
    },
    size: () => bindings.size,
    paneFor,
    busy: (sessionId) => activityOf(sessionId).busy?.() ?? false,
    waiting: (sessionId) => activityOf(sessionId).waiting?.() ?? false,
  };
}

export function startFreshSession(
  sessions: SessionPort | undefined,
  notify: () => void,
  wire: (attachment: SessionAttachment) => void,
  live: () => boolean,
): void {
  if (sessions === undefined) return;
  void sessions
    .create()
    .then((created) => {
      if (created === undefined) return;
      if (!live()) {
        sessions.release?.(created.id);
        return;
      }
      wire(created);
      notify();
    })
    .catch(() => {});
}

export function adoptSession(
  pane: ConversationPane,
  agent: Agent | undefined,
  attachment: SessionAttachment,
): void {
  pane.sessionId = attachment.id;
  pane.arc = attachment.arc;
  pane.bot = attachment.bot;
  reconcileTitle(pane, attachment);
  if (agent === undefined) return;
  attachment.replay(agent.bus);
}

export function persistingTitler(
  titler: Titler | undefined,
  session: () => SessionAttachment | undefined,
): Titler | undefined {
  if (titler === undefined) return undefined;
  return async (conversation, agent) => {
    const title = await titler(conversation, agent);
    if (title !== undefined)
      void session()
        ?.rename?.(title)
        .catch(() => {});
    return title;
  };
}

export interface SessionLifecycleOptions {
  pane: ConversationPane;
  attachment: SessionAttachment;
  modelInForce?: () => string | undefined;
  afterTurn?: AfterTurn;
  compact?: Compactor;
  rebuild?: (history: readonly Message[], agent: Agent) => Agent | undefined;
}

export function bindSessionLifecycle(options: SessionLifecycleOptions): void {
  const { pane, attachment } = options;
  let persisted = attachment.history.length;
  let modelRecorded = attachment.modelReference !== undefined;
  const turnOf = (agent: Agent): SessionTurn => ({
    sessionId: attachment.id,
    history: agent.history(),
    agent,
  });
  const apply = (settlement: TurnSettlement | undefined, agent: Agent): void => {
    if (settlement === undefined || pane.disposed()) return;
    for (const notice of settlement.notices) pane.postNotice(notice);
    if (settlement.history === undefined) return;
    const next = options.rebuild?.(settlement.history, agent);
    if (next === undefined) return;
    persisted = next.history().length;
    pane.swapAgent(next);
  };
  const recordModelOnce = async (agent: Agent): Promise<void> => {
    if (modelRecorded) return;
    modelRecorded = true;
    const reference = modelReferenceOf(agent.provider) ?? options.modelInForce?.();
    if (reference !== undefined) await attachment.recordModel?.(reference);
  };
  pane.bindAfterTurn(async () => {
    const agent = pane.currentAgent();
    if (agent === undefined) return;
    const history = agent.history();
    if (history.length > persisted) await recordModelOnce(agent);
    while (persisted < history.length) {
      const message = history[persisted];
      if (message === undefined) break;
      const receipt = await attachment.append(message);
      persisted += 1;
      if (message.role === "user" && receipt !== undefined) pane.adoptPromptId(receipt.entryId);
    }
    apply(await options.afterTurn?.(turnOf(agent)), agent);
  });
  const compact = options.compact;
  if (compact === undefined) return;
  pane.bindCompaction(async (instructions) => {
    const agent = pane.currentAgent();
    if (agent === undefined) return;
    apply(await compact(turnOf(agent), instructions), agent);
  });
}

function reconcileTitle(pane: ConversationPane, attachment: SessionAttachment): void {
  if (attachment.name !== undefined) {
    pane.adoptTitle(attachment.name);
    return;
  }
  const settled = pane.titled();
  if (settled !== undefined) void attachment.rename?.(settled).catch(() => {});
}
