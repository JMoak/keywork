import type { EngineEvents, EventBus } from "@keywork/engine";

export type EngineEventType = keyof EngineEvents;

export interface BusEnvelope {
  id: number;
  ts: string;
  sessionId: string;
  type: EngineEventType;
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
  "gate.permission",
  "gate.preset",
  "session.mode",
  "context.injected",
  "diagnostics.published",
  "shell.reset",
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

  record(sessionId: string, type: EngineEventType, payload: unknown): BusEnvelope {
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
