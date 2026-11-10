import { z } from "zod";

export const campaignIdSchema = z.string().trim().min(1).max(256);
export const microsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const campaignWorkloadSchema = z.enum([
  "app-improvement",
  "project-development",
  "research-refinement",
]);
export const campaignStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "waiting",
  "paused",
  "completed",
  "cancelled",
  "failed",
]);
export const campaignActorSchema = z.strictObject({
  id: campaignIdSchema,
  role: z.enum(["user", "controller", "worker"]),
});
export const qualityCriterionSchema = z.strictObject({
  id: campaignIdSchema,
  description: z.string().trim().min(1).max(8_000),
  critical: z.boolean(),
});
export const purposeRevisionSchema = z.strictObject({
  revision: z.number().int().positive(),
  outcome: z.string().trim().min(1).max(16_000),
  audience: z.string().max(4_000),
  scope: z.array(z.string().max(4_000)).max(128),
  references: z.array(z.string().trim().min(1).max(4_096)).max(256),
  criteria: z.array(qualityCriterionSchema).min(1).max(128),
  invariants: z.array(z.string().max(4_000)).max(128),
  sufficientDelivery: z.string().trim().min(1).max(16_000),
  createdAt: timestampSchema,
});
export const artifactEntrySchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  digest: z.string().min(1).max(256),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().max(256),
});
export const artifactManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: campaignIdSchema,
  kind: z.enum(["file", "directory", "code", "report", "web-preview"]),
  title: z.string().trim().min(1).max(512),
  digest: z.string().min(1).max(256),
  parentIds: z.array(campaignIdSchema).max(32),
  storageRef: z.string().trim().min(1).max(4_096),
  ownerScope: campaignIdSchema,
  producerAttemptId: campaignIdSchema.nullable(),
  createdAt: timestampSchema,
  entries: z.array(artifactEntrySchema).max(20_000),
  capabilities: z.array(z.enum(["inspect", "export", "diff", "preview"])).max(4),
});
export const modelSelectionSchema = z.strictObject({
  modelId: z.string().trim().min(1).max(512),
  providerId: z.string().trim().min(1).max(256),
  connectionId: campaignIdSchema.nullable(),
  effort: z.string().max(128).nullable(),
});
export const attemptStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
export const attemptSchema = z.strictObject({
  id: campaignIdSchema,
  operationId: campaignIdSchema,
  purposeRevision: z.number().int().positive(),
  parentArtifactId: campaignIdSchema.nullable(),
  branch: z.string().trim().min(1).max(256),
  hypothesis: z.string().trim().min(1).max(8_000),
  method: z.string().trim().min(1).max(4_000),
  expectedBenefit: z.string().max(8_000),
  model: modelSelectionSchema,
  probe: z.boolean(),
  status: attemptStatusSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  candidateArtifactId: campaignIdSchema.nullable(),
  failure: z.string().max(8_000).nullable(),
});
export const evidenceItemSchema = z.strictObject({
  id: campaignIdSchema,
  artifactId: campaignIdSchema,
  purposeRevision: z.number().int().positive(),
  criterionIds: z.array(campaignIdSchema).max(128),
  kind: z.enum(["claim", "test", "observation", "source", "render", "human-review", "critique"]),
  verdict: z.enum(["pass", "fail", "uncertain"]),
  summary: z.string().trim().min(1).max(16_000),
  sourceRefs: z.array(z.string().min(1).max(4_096)).max(256),
  methodId: campaignIdSchema,
  methodVersion: z.string().min(1).max(256),
  observedAt: timestampSchema,
  producer: campaignActorSchema,
});
export const criterionObservationSchema = z.strictObject({
  criterionId: campaignIdSchema,
  verdict: z.enum(["pass", "fail", "uncertain"]),
  evidenceIds: z.array(campaignIdSchema).min(1).max(128),
  summary: z.string().max(8_000),
});
export const evaluationSchema = z.strictObject({
  id: campaignIdSchema,
  artifactId: campaignIdSchema,
  comparedToArtifactId: campaignIdSchema.nullable(),
  purposeRevision: z.number().int().positive(),
  observations: z.array(criterionObservationSchema).min(1).max(128),
  materialImprovement: z.boolean(),
  summary: z.string().trim().min(1).max(16_000),
  evaluator: campaignActorSchema,
  model: modelSelectionSchema.nullable(),
  createdAt: timestampSchema,
});
export const achievementStatusSchema = z.enum([
  "claimed",
  "observed",
  "verified",
  "regressed",
  "superseded",
]);
export const achievementSchema = z.strictObject({
  id: campaignIdSchema,
  criterionId: campaignIdSchema,
  artifactId: campaignIdSchema,
  purposeRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(512),
  summary: z.string().max(8_000),
  evidenceIds: z.array(campaignIdSchema).max(128),
  status: achievementStatusSchema,
  verifiedBy: campaignActorSchema.nullable(),
  adoptedAt: timestampSchema.nullable(),
  history: z.array(
    z.strictObject({
      status: achievementStatusSchema,
      at: timestampSchema,
      reason: z.string().trim().min(1).max(8_000),
      evidenceIds: z.array(campaignIdSchema).max(128),
    }),
  ),
});
export const campaignBudgetSchema = z.strictObject({
  currency: z.literal("USD"),
  limitMicros: microsSchema,
  evaluationReserveMicros: microsSchema,
  deliveryReserveMicros: microsSchema,
});
export const persistenceProfileSchema = z.enum(["focused", "persistent", "deep"]);
export const persistenceLimitsSchema = z.strictObject({
  profile: persistenceProfileSchema,
  probeLimit: z.number().int().nonnegative().max(1_000),
  spendLimitMicros: microsSchema,
  timeLimitMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const persistenceAllowanceSchema = persistenceLimitsSchema.extend({
  probesUsed: z.number().int().nonnegative(),
  spentMicros: microsSchema,
  reservedMicros: microsSchema,
  elapsedMs: z.number().int().nonnegative(),
  consecutiveWithoutImprovement: z.number().int().nonnegative(),
  active: z.boolean(),
  openedAt: timestampSchema.nullable(),
  terminationReason: z.string().max(8_000).nullable(),
});
export const usageReceiptSchema = z.strictObject({
  id: campaignIdSchema,
  operationId: campaignIdSchema,
  attemptId: campaignIdSchema.nullable(),
  providerRequestId: z.string().max(512).nullable(),
  stage: z.string().max(128),
  model: modelSelectionSchema.nullable(),
  currency: z.literal("USD"),
  reservedMicros: microsSchema,
  costMicros: microsSchema.nullable(),
  state: z.enum(["reserved", "estimated", "reported", "reconciled", "unknown", "released"]),
  costSource: z.string().max(512),
  pricingAt: timestampSchema,
  recordedAt: timestampSchema,
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cachedTokens: z.number().int().nonnegative().nullable(),
});
export const cartridgeLockSchema = z.strictObject({
  id: campaignIdSchema,
  version: z.string().min(1).max(256),
  digest: z.string().min(1).max(256),
  stage: z.string().min(1).max(128),
  status: z.enum(["active", "suspended", "retired"]),
  activatedAt: timestampSchema,
  obligations: z.array(z.string().max(4_000)).max(128),
});
export const contextManifestSchema = z.strictObject({
  id: campaignIdSchema,
  operationId: campaignIdSchema,
  purposeRevision: z.number().int().positive(),
  activeSkillDigests: z.array(z.string().min(1).max(256)).max(128),
  includedRefs: z.array(z.string().min(1).max(4_096)).max(2_048),
  omitted: z
    .array(z.strictObject({ ref: z.string().max(4_096), reason: z.string().max(512) }))
    .max(2_048),
  tools: z.array(z.string().max(256)).max(256),
  estimatedTokens: z.number().int().nonnegative(),
  reportedTokens: z.number().int().nonnegative().nullable(),
  createdAt: timestampSchema,
});
export const handoffSchema = z.strictObject({
  summary: z.string().trim().min(1).max(16_000),
  currentBestArtifactId: campaignIdSchema.nullable(),
  obligations: z.array(z.string().max(4_000)).max(128),
  unresolved: z.array(z.string().max(4_000)).max(128),
  options: z.array(z.string().max(4_000)).max(128),
  attemptedApproaches: z.array(z.string().max(4_000)).max(128),
  nextStep: z.string().max(8_000),
});
export const campaignDecisionSchema = z.strictObject({
  id: campaignIdSchema,
  kind: z.enum([
    "adopt",
    "retain",
    "branch",
    "investigate",
    "ask",
    "finish-proposed",
    "finish",
    "steer",
  ]),
  reason: z.string().trim().min(1).max(16_000),
  evidenceIds: z.array(campaignIdSchema).max(256),
  artifactId: campaignIdSchema.nullable(),
  purposeRevision: z.number().int().positive(),
  actor: campaignActorSchema,
  at: timestampSchema,
});
export const campaignSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: campaignIdSchema,
  ownerScope: campaignIdSchema,
  title: z.string().trim().min(1).max(512),
  workload: campaignWorkloadSchema,
  model: modelSelectionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  revision: z.number().int().nonnegative(),
  status: campaignStatusSchema,
  controlRequested: z.enum(["pause", "cancel"]).nullable(),
  waitingReason: z.enum(["person", "dependency", "reconciliation"]).nullable(),
  statusReason: z.string().max(8_000).nullable(),
  purposeRevision: z.number().int().positive(),
  purposes: z.array(purposeRevisionSchema).min(1),
  baselineArtifactId: campaignIdSchema.nullable(),
  currentBestArtifactId: campaignIdSchema.nullable(),
  latestArtifactId: campaignIdSchema.nullable(),
  alternativeArtifactIds: z.array(campaignIdSchema),
  artifacts: z.array(artifactManifestSchema),
  attempts: z.array(attemptSchema),
  evidence: z.array(evidenceItemSchema),
  evaluations: z.array(evaluationSchema),
  achievements: z.array(achievementSchema),
  budget: campaignBudgetSchema,
  persistence: persistenceAllowanceSchema,
  cartridges: z.array(cartridgeLockSchema),
  contexts: z.array(contextManifestSchema),
  usage: z.array(usageReceiptSchema),
  decisions: z.array(campaignDecisionSchema),
  handoff: handoffSchema.nullable(),
  delivery: z.enum(["pending", "available", "delivered"]),
  verification: z.enum(["unverified", "partial", "verified", "failed"]),
});
export const createCampaignInputSchema = z.strictObject({
  id: campaignIdSchema,
  ownerScope: campaignIdSchema,
  title: z.string().trim().min(1).max(512),
  workload: campaignWorkloadSchema,
  model: modelSelectionSchema,
  createdAt: timestampSchema,
  purpose: purposeRevisionSchema,
  budget: campaignBudgetSchema,
  persistence: persistenceLimitsSchema,
  baseline: artifactManifestSchema.nullable(),
});
export const campaignEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: campaignIdSchema,
  campaignId: campaignIdSchema,
  sequence: z.number().int().positive(),
  commandId: campaignIdSchema,
  kind: z.string().min(1).max(128),
  at: timestampSchema,
  actor: campaignActorSchema,
  summary: z.string().max(16_000),
  refs: z.array(campaignIdSchema).max(256),
});

export type Campaign = z.infer<typeof campaignSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignInputSchema>;
export type CampaignActor = z.infer<typeof campaignActorSchema>;
export type CampaignEvent = z.infer<typeof campaignEventSchema>;
export type CampaignWorkload = z.infer<typeof campaignWorkloadSchema>;
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;
export type PurposeRevision = z.infer<typeof purposeRevisionSchema>;
export type QualityCriterion = z.infer<typeof qualityCriterionSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;
export type Achievement = z.infer<typeof achievementSchema>;
export type PersistenceProfile = z.infer<typeof persistenceProfileSchema>;
export type PersistenceLimits = z.infer<typeof persistenceLimitsSchema>;
export type PersistenceAllowance = z.infer<typeof persistenceAllowanceSchema>;
export type CampaignBudget = z.infer<typeof campaignBudgetSchema>;
export type UsageReceipt = z.infer<typeof usageReceiptSchema>;
export type ContextManifest = z.infer<typeof contextManifestSchema>;
export type CartridgeLock = z.infer<typeof cartridgeLockSchema>;
export type Handoff = z.infer<typeof handoffSchema>;
export type CampaignDecision = z.infer<typeof campaignDecisionSchema>;
