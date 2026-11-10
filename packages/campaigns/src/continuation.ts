import { z } from "zod";
import {
  type Campaign,
  microsSchema,
  type PersistenceLimits,
  type PersistenceProfile,
  timestampSchema,
} from "./contracts.ts";
import { unresolvedAttempts } from "./state.ts";

export const persistenceProbeLimits: Readonly<Record<PersistenceProfile, number>> = {
  focused: 2,
  persistent: 8,
  deep: 12,
};

export const continuationAdmissionSchema = z.strictObject({
  now: timestampSchema,
  availableMicros: microsSchema,
  maximumCostMicros: microsSchema,
  maximumDurationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  authority: z.enum(["allowed", "denied", "needs-user"]),
  safetyAllowed: z.boolean(),
  userStopped: z.boolean(),
  unresolvedEffect: z.boolean(),
});

export type ContinuationAdmission = z.infer<typeof continuationAdmissionSchema>;
export type ContinuationDecision = {
  action: "continue" | "probe" | "finish" | "wait" | "stop";
  reason: string;
  boundary: "exhausted" | "budget" | "time" | "scope" | "safety" | "user" | "sufficient" | null;
  remainingProbes: number;
};

export function persistenceLimits(
  profile: PersistenceProfile,
  spendLimitMicros: number,
  timeLimitMs: number,
): PersistenceLimits {
  return {
    profile,
    probeLimit: persistenceProbeLimits[profile],
    spendLimitMicros,
    timeLimitMs,
  };
}

export function planContinuation(
  campaign: Campaign,
  input: ContinuationAdmission,
): ContinuationDecision {
  const admission = continuationAdmissionSchema.parse(input);
  const remainingProbes = Math.max(
    0,
    campaign.persistence.probeLimit - campaign.persistence.probesUsed,
  );
  const decision = (
    action: ContinuationDecision["action"],
    reason: string,
    boundary: ContinuationDecision["boundary"] = null,
  ): ContinuationDecision => ({ action, reason, boundary, remainingProbes });
  if (
    admission.userStopped ||
    campaign.status === "cancelled" ||
    campaign.controlRequested === "cancel"
  )
    return decision("stop", "The user stopped further dispatch.", "user");
  if (!admission.safetyAllowed)
    return decision("stop", "A safety boundary prevents this operation.", "safety");
  if (admission.authority === "denied")
    return decision("stop", "The operation is outside granted authority.", "scope");
  if (admission.authority === "needs-user")
    return decision("wait", "The operation needs an authority decision.", "scope");
  if (admission.unresolvedEffect || unresolvedAttempts(campaign))
    return decision("wait", "An outstanding operation must complete or be reconciled.");
  if (campaign.controlRequested === "pause" || campaign.status === "paused")
    return decision("wait", "The campaign is paused.");
  if (campaign.status === "completed" || campaign.status === "failed")
    return decision("stop", "The campaign is terminal.", "sufficient");
  if (campaign.status !== "running") return decision("wait", "The campaign is not running.");
  const protectedMicros =
    campaign.budget.evaluationReserveMicros + campaign.budget.deliveryReserveMicros;
  const neededMicros = admission.maximumCostMicros + protectedMicros;
  if (!Number.isSafeInteger(neededMicros) || neededMicros > admission.availableMicros)
    return decision(
      "finish",
      "The next operation cannot preserve evaluation and delivery capacity.",
      "budget",
    );
  if (!campaign.persistence.active)
    return decision("continue", "Continue the current refinement approach.");
  const allowance = campaign.persistence;
  if (remainingProbes === 0)
    return decision("finish", "The authorized persistence window is exhausted.", "exhausted");
  const exposure = allowance.spentMicros + allowance.reservedMicros + admission.maximumCostMicros;
  if (!Number.isSafeInteger(exposure) || exposure > allowance.spendLimitMicros)
    return decision(
      "finish",
      "The next probe exceeds the persistence spending allowance.",
      "budget",
    );
  const elapsed = allowance.elapsedMs + admission.maximumDurationMs;
  if (!Number.isSafeInteger(elapsed) || elapsed > allowance.timeLimitMs)
    return decision("finish", "The next probe exceeds the persistence time allowance.", "time");
  return decision("probe", "Explore beyond the finish proposal within the remaining allowance.");
}
