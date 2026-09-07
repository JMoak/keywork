import type { EngineEvents } from "./bus.ts";

export type BusEvent = {
  [K in keyof EngineEvents]: { type: K; payload: EngineEvents[K] };
}[keyof EngineEvents];

export type EventSink = (event: BusEvent) => void;
export type TickScheduler = (flush: () => void) => void;

export interface DeltaCoalescer {
  push(event: BusEvent): void;
  flush(): void;
}

export const frameTickMs = 16;

export const frameTick: TickScheduler = (flush) => {
  setTimeout(flush, frameTickMs);
};

export function coalesceDeltas(sink: EventSink, tick: TickScheduler = frameTick): DeltaCoalescer {
  const pending: BusEvent[] = [];
  let armed = false;

  const flush = () => {
    armed = false;
    for (const event of pending.splice(0)) sink(event);
  };

  const arm = () => {
    if (armed) return;
    armed = true;
    tick(flush);
  };

  const push = (event: BusEvent) => {
    const target = mergeTargetOf(event);
    if (target === undefined) {
      flush();
      sink(event);
      return;
    }
    const last = pending.at(-1);
    if (last !== undefined && mergeTargetOf(last) === target)
      pending[pending.length - 1] = merged(last, event);
    else pending.push(event);
    arm();
  };

  return { push, flush };
}

function mergeTargetOf(event: BusEvent): string | undefined {
  const replay = event.payload.replay === true ? "replay" : "live";
  if (event.type === "tool.output") return `${replay}:tool:${event.payload.callId ?? ""}`;
  if (event.type !== "turn.delta") return undefined;
  const { delta } = event.payload;
  if (delta.type === "text") return `${replay}:text`;
  if (delta.type === "visible-thinking") return `${replay}:thinking`;
  return undefined;
}

function merged(earlier: BusEvent, later: BusEvent): BusEvent {
  if (earlier.type === "tool.output" && later.type === "tool.output") {
    return {
      type: "tool.output",
      payload: { ...earlier.payload, chunk: earlier.payload.chunk + later.payload.chunk },
    };
  }
  if (earlier.type === "turn.delta" && later.type === "turn.delta") {
    const { delta } = earlier.payload;
    const text = textOf(delta) + textOf(later.payload.delta);
    if (delta.type === "text" || delta.type === "visible-thinking") {
      return { type: "turn.delta", payload: { ...earlier.payload, delta: { ...delta, text } } };
    }
  }
  return later;
}

function textOf(delta: EngineEvents["turn.delta"]["delta"]): string {
  return delta.type === "text" || delta.type === "visible-thinking" ? delta.text : "";
}
