import type { Message, SpillReference, ToolCallPart, Usage } from "./messages.ts";
import type { TurnDelta } from "./provider.ts";
import type { ContextInjection, PermissionDecision } from "./session/journal.ts";

export type SendBehavior = "steer" | "queue";

export interface QueuedPrompt {
  id: string;
  text: string;
  behavior: SendBehavior;
}

interface LiveEvents {
  "turn.started": { userText: string; entryId?: string };
  "turn.delta": { delta: TurnDelta };
  "turn.completed": { message: Message; usage: Usage };
  "turn.interrupted": { message: Message };
  "queue.changed": { queued: readonly QueuedPrompt[] };
  "tool.started": { call: ToolCallPart };
  "tool.output": { chunk: string; callId?: string };
  "tool.finished": { callId: string; output: string; isError: boolean; spill?: SpillReference };
  "gate.permission": { decision: PermissionDecision };
  "gate.preset": { from: string; to: string };
  "session.mode": { mode: string };
  "context.injected": { injection: ContextInjection };
  "diagnostics.published": { path: string; count: number };
  "shell.reset": Record<never, never>;
  "engine.error": { error: Error };
}

export type EngineEvents = {
  [K in keyof LiveEvents]: LiveEvents[K] & { replay?: boolean };
};

type Listener<T> = (payload: T) => void;

const failureEvent = "engine.error";

interface ReportsFailures {
  [failureEvent]: { error: Error };
}

interface Registration {
  listener: Listener<never>;
}

export class EventBus<Events extends ReportsFailures = EngineEvents> {
  private readonly registrations = new Map<keyof Events, Registration[]>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    const registration: Registration = { listener: listener as Listener<never> };
    const existing = this.registrations.get(type) ?? [];
    existing.push(registration);
    this.registrations.set(type, existing);
    return () => this.forget(type, registration);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    for (const { listener } of [...(this.registrations.get(type) ?? [])]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (cause) {
        this.reportListenerFailure(type, cause);
      }
    }
  }

  listenerCount(type?: keyof Events): number {
    if (type !== undefined) return this.registrations.get(type)?.length ?? 0;
    let total = 0;
    for (const registrations of this.registrations.values()) total += registrations.length;
    return total;
  }

  private forget(type: keyof Events, registration: Registration): void {
    const existing = this.registrations.get(type);
    const index = existing?.indexOf(registration) ?? -1;
    if (existing === undefined || index === -1) return;
    existing.splice(index, 1);
  }

  private reportListenerFailure(type: keyof Events, cause: unknown): void {
    if (type === failureEvent) return;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.emit(failureEvent, { error });
  }
}
