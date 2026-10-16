import type { EngineEvents, EventBus } from "@keywork/engine";
import type { ChangesUpdate } from "./changes.ts";
import type { SessionSettlement, SessionState } from "./host.ts";
import type { SurfaceKind } from "./routes/answers.ts";
import type { InboxTally } from "./routes/memory.ts";
import type { TreeChange } from "./routes/tree.ts";

export type EngineEventType = keyof EngineEvents;

export interface ServerEvents {
  "memory.inbox": InboxTally;
  "session.state": SessionState;
  "surface.changed": { kind: SurfaceKind };
  "session.tree": TreeChange;
  "changes.updated": ChangesUpdate;
  "session.removed": { sessionId: string };
  "session.restored": { sessionId: string };
  "session.settled": SessionSettlement;
}

export const serverEventTypes = [
  "memory.inbox",
  "session.state",
  "surface.changed",
  "session.tree",
  "changes.updated",
  "session.removed",
  "session.restored",
  "session.settled",
] as const satisfies readonly (keyof ServerEvents)[];

export type ServerEventType = (typeof serverEventTypes)[number];

type UnlistedServerEventType = Exclude<keyof ServerEvents, ServerEventType>;

export const serverVocabularyIsComplete: [UnlistedServerEventType] extends [never] ? true : never =
  true;

export type WireEvents = EngineEvents & ServerEvents;

export type WireEventType = keyof WireEvents;

export type WirePayload<Type extends WireEventType> = WireEvents[Type];

export interface BusEnvelope {
  id: number;
  ts: string;
  sessionId: string;
  type: WireEventType;
  payload: unknown;
}

export const engineEventTypes = [
  "turn.started",
  "turn.delta",
  "turn.completed",
  "turn.interrupted",
  "queue.changed",
  "tool.started",
  "tool.output",
  "tool.finished",
  "gate.ask",
  "gate.permission",
  "gate.preset",
  "session.mode",
  "context.injected",
  "memory.decided",
  "child.started",
  "child.finished",
  "diagnostics.published",
  "shell.reset",
  "extension.notice",
  "engine.error",
] as const satisfies readonly EngineEventType[];

type UnlistedEventType = Exclude<EngineEventType, (typeof engineEventTypes)[number]>;

export const vocabularyIsComplete: [UnlistedEventType] extends [never] ? true : never = true;

export type EnvelopeListener = (envelope: BusEnvelope) => void;

export interface EventLogOptions {
  capacity?: number;
  now?: () => Date;
}

export class EventLog {
  private readonly retained: BusEnvelope[] = [];
  private readonly listeners = new Set<EnvelopeListener>();
  private readonly capacity: number;
  private readonly now: () => Date;
  private nextId = 1;

  constructor(options: EventLogOptions = {}) {
    this.capacity = options.capacity ?? 1000;
    this.now = options.now ?? (() => new Date());
  }

  record<Type extends WireEventType>(
    sessionId: string,
    type: Type,
    payload: WirePayload<Type>,
  ): BusEnvelope {
    const envelope: BusEnvelope = {
      id: this.nextId++,
      ts: this.now().toISOString(),
      sessionId,
      type,
      payload,
    };
    this.retained.push(envelope);
    if (this.retained.length > this.capacity) this.retained.shift();
    for (const listener of [...this.listeners]) listener(envelope);
    return envelope;
  }

  attach(bus: EventBus<EngineEvents>, sessionId: string): () => void {
    const detachers = engineEventTypes.map((type) =>
      bus.on(type, (payload) => this.record(sessionId, type, payload)),
    );
    return () => {
      for (const detach of detachers) detach();
    };
  }

  since(lastId: number): readonly BusEnvelope[] {
    return this.retained.filter((envelope) => envelope.id > lastId);
  }

  oldestRetainedId(): number | undefined {
    return this.retained[0]?.id;
  }

  latestId(): number {
    return this.nextId - 1;
  }

  subscribe(listener: EnvelopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
