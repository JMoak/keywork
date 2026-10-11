import type { EngineEvents, EventBus } from "@keywork/engine";
import type { SessionState } from "./host.ts";

export type EngineEventType = keyof EngineEvents;

export type SurfaceKind = "mcp" | "arcs" | "bots" | "workspaces" | "workspace";

export interface ServerEvents {
  "surface.changed": { kind: SurfaceKind };
  "memory.inbox": { count: number; kinds: Record<string, number> };
  "session.state": SessionState;
}

export type ServerEventType = keyof ServerEvents;

export type EventType = EngineEventType | ServerEventType;

export const processLevelSessionId = "";

export interface BusEnvelope {
  id: number;
  ts: string;
  sessionId: string;
  type: EventType;
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
  "diagnostics.published",
  "shell.reset",
  "extension.notice",
  "session.tree",
  "changes.updated",
  "engine.error",
] as const satisfies readonly EngineEventType[];

export const serverEventTypes = [
  "surface.changed",
  "memory.inbox",
  "session.state",
] as const satisfies readonly ServerEventType[];

export const eventTypes = [...engineEventTypes, ...serverEventTypes] as const;

type UnlistedEventType = Exclude<EventType, (typeof eventTypes)[number]>;

export const vocabularyIsComplete: [UnlistedEventType] extends [never] ? true : never = true;

const engineVocabulary: ReadonlySet<string> = new Set(engineEventTypes);

export function isEngineEventType(type: EventType): type is EngineEventType {
  return engineVocabulary.has(type);
}

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

  record(sessionId: string, type: EventType, payload: unknown): BusEnvelope {
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

  announce<K extends ServerEventType>(type: K, payload: ServerEvents[K]): BusEnvelope {
    return this.record(processLevelSessionId, type, payload);
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
