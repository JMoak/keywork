import type { Message, ToolCallPart, Usage } from "./messages.ts";
import type { TurnDelta } from "./provider.ts";

interface LiveEvents {
  "turn.started": { userText: string };
  "turn.delta": { delta: TurnDelta };
  "turn.completed": { message: Message; usage: Usage };
  "turn.interrupted": { message: Message };
  "tool.started": { call: ToolCallPart };
  "tool.finished": { callId: string; output: string; isError: boolean };
  "engine.error": { error: Error };
}

export type EngineEvents = {
  [K in keyof LiveEvents]: LiveEvents[K] & { replay?: boolean };
};

type Listener<T> = (payload: T) => void;

export class EventBus<Events = EngineEvents> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener as Listener<never>);
    this.listeners.set(type, existing);
    return () => existing.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as Listener<Events[K]>)(payload);
    }
  }
}
