import type { Clock } from "./clock.ts";
import type { RunDelivery } from "./run.ts";
import type { EffectRow, RoutineStore } from "./store.ts";

export interface EffectIntent {
  key: string;
  runId: string;
  kind: string;
  params: unknown;
}

export type EffectOutcome =
  | { delivery: "delivered"; result: unknown; replayed: boolean }
  | { delivery: "unknown"; since: number }
  | { delivery: "failed"; error: string };

export async function performEffect(
  store: RoutineStore,
  clock: Clock,
  intent: EffectIntent,
  act: () => Promise<unknown>,
): Promise<EffectOutcome> {
  const begun = store.beginEffect(
    intent.key,
    intent.runId,
    intent.kind,
    intent.params,
    clock.now(),
  );
  if (begun.kind === "done") return { delivery: "delivered", result: begun.result, replayed: true };
  if (begun.kind === "unknown") return { delivery: "unknown", since: begun.startedAt };
  try {
    const result = await act();
    store.completeEffect(intent.key, result, clock.now());
    return { delivery: "delivered", result, replayed: false };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    store.failEffect(intent.key, error, clock.now());
    return { delivery: "failed", error };
  }
}

export function deliveryOfEffects(effects: readonly EffectRow[]): RunDelivery {
  if (effects.some((effect) => effect.state === "pending")) return "unknown";
  if (effects.some((effect) => effect.state === "failed")) return "failed";
  return effects.length > 0 ? "delivered" : "none";
}
