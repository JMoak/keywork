import type { EngineEvents, EventBus } from "./bus.ts";

export const mutatingToolNames: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

export function followMutations(bus: EventBus<EngineEvents>, onMutated: () => void): () => void {
  const mutating = new Set<string>();
  const stops = [
    bus.on("tool.started", ({ call }) => {
      if (mutatingToolNames.has(call.name)) mutating.add(call.callId);
    }),
    bus.on("tool.finished", ({ callId }) => {
      if (mutating.delete(callId)) onMutated();
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
