import type { PromiseEvidence, PromiseState, RepairEpisode } from "./types.ts";

export function stateOf(
  evidence: readonly PromiseEvidence[],
  repairs: readonly RepairEpisode[],
): PromiseState {
  if (repairs.some((repair) => repair.outcome === "failed")) return "broken";
  if (repairs.some((repair) => repair.outcome === "repairing")) return "repairing";
  if (evidence.some((found) => found.ok === false)) return "broken";
  return evidence.some((found) => found.ok === true) ? "kept" : "unknown";
}
