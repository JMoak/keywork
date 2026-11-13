import { z } from "zod";
import {
  achievementSchema,
  artifactManifestSchema,
  attemptSchema,
  campaignIdSchema,
  cartridgeLockSchema,
  contextManifestSchema,
  evaluationSchema,
  evidenceItemSchema,
  handoffSchema,
  modelSelectionSchema,
  persistenceLimitsSchema,
  purposeRevisionSchema,
  timestampSchema,
  usageReceiptSchema,
} from "./contracts.ts";

const envelope = {
  id: campaignIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  at: timestampSchema,
};
const reason = z.string().trim().min(1).max(16_000);

export const campaignCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("ready"), reason }),
  z.strictObject({ ...envelope, type: z.literal("start"), reason }),
  z.strictObject({ ...envelope, type: z.literal("pause"), reason }),
  z.strictObject({ ...envelope, type: z.literal("resume"), reason }),
  z.strictObject({ ...envelope, type: z.literal("cancel"), reason }),
  z.strictObject({ ...envelope, type: z.literal("fail"), reason }),
  z.strictObject({
    ...envelope,
    type: z.literal("wait"),
    reason,
    waitingReason: z.enum(["person", "dependency", "reconciliation"]),
  }),
  z.strictObject({ ...envelope, type: z.literal("begin-attempt"), attempt: attemptSchema }),
  z.strictObject({
    ...envelope,
    type: z.literal("settle-attempt"),
    attemptId: campaignIdSchema,
    status: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
    candidateArtifactId: campaignIdSchema.nullable(),
    failure: z.string().max(8_000).nullable(),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("record-artifact"),
    artifact: artifactManifestSchema,
    baseline: z.boolean().optional(),
  }),
  z.strictObject({ ...envelope, type: z.literal("record-evidence"), evidence: evidenceItemSchema }),
  z.strictObject({
    ...envelope,
    type: z.literal("record-evaluation"),
    evaluation: evaluationSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("adopt"),
    artifactId: campaignIdSchema,
    evaluationId: campaignIdSchema,
    reason,
  }),
  z.strictObject({ ...envelope, type: z.literal("retain"), artifactId: campaignIdSchema, reason }),
  z.strictObject({ ...envelope, type: z.literal("branch"), artifactId: campaignIdSchema, reason }),
  z.strictObject({ ...envelope, type: z.literal("propose-finish"), reason }),
  z.strictObject({
    ...envelope,
    type: z.literal("finish"),
    reason,
    handoff: handoffSchema.nullable(),
    delivery: z.enum(["pending", "available", "delivered"]),
    verification: z.enum(["unverified", "partial", "verified", "failed"]),
    boundary: z
      .enum(["exhausted", "budget", "time", "scope", "safety", "user", "sufficient"])
      .optional(),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("revise-purpose"),
    purpose: purposeRevisionSchema,
    reason,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("select-model"),
    model: modelSelectionSchema,
    reason,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("renew-persistence"),
    limits: persistenceLimitsSchema,
    reason,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("record-achievement"),
    achievement: achievementSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("invalidate-achievement"),
    achievementId: campaignIdSchema,
    status: z.enum(["regressed", "superseded"]),
    evidenceIds: z.array(campaignIdSchema).max(128),
    reason,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("set-cartridges"),
    cartridges: z.array(cartridgeLockSchema).max(128),
    reason,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("record-context"),
    context: contextManifestSchema,
  }),
  z.strictObject({ ...envelope, type: z.literal("record-usage"), receipt: usageReceiptSchema }),
  z.strictObject({ ...envelope, type: z.literal("set-handoff"), handoff: handoffSchema }),
]);

export type CampaignCommand = z.infer<typeof campaignCommandSchema>;
type WithoutEnvelope<T> = T extends CampaignCommand
  ? Omit<T, "id" | "expectedRevision" | "at">
  : never;
export type CommandBody = WithoutEnvelope<CampaignCommand>;
