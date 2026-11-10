import { type CampaignCommand, campaignCommandSchema } from "./commands.ts";
import {
  type Achievement,
  type ArtifactManifest,
  type Campaign,
  type CampaignActor,
  type CampaignDecision,
  type CampaignEvent,
  type CreateCampaignInput,
  campaignActorSchema,
  campaignEventSchema,
  campaignSchema,
  createCampaignInputSchema,
  type Evaluation,
  type EvidenceItem,
  type PersistenceLimits,
  type PurposeRevision,
} from "./contracts.ts";

export type CampaignErrorCode =
  | "stale-revision"
  | "stale-time"
  | "forbidden"
  | "invalid-state"
  | "invalid-value"
  | "missing-record"
  | "duplicate-record"
  | "critical-failure"
  | "unverified"
  | "allowance-exhausted";

export class CampaignError extends Error {
  readonly code: CampaignErrorCode;

  constructor(code: CampaignErrorCode, message: string) {
    super(message);
    this.name = "CampaignError";
    this.code = code;
  }
}

export type CampaignTransition = { campaign: Campaign; event: CampaignEvent };

export function createCampaign(input: CreateCampaignInput): Campaign {
  const value = createCampaignInputSchema.parse(input);
  ensure(
    value.purpose.revision === 1,
    "invalid-value",
    "The initial purpose revision must be one.",
  );
  validatePurpose(value.purpose);
  validateLimits(value.persistence, value.budget);
  ensure(
    value.purpose.createdAt <= value.createdAt,
    "invalid-value",
    "The purpose cannot postdate creation.",
  );
  if (value.baseline) {
    ensure(value.baseline.ownerScope === value.ownerScope, "forbidden", "Baseline scope differs.");
    ensure(
      value.baseline.producerAttemptId === null,
      "invalid-value",
      "The baseline cannot refer to a future attempt.",
    );
  }
  return campaignSchema.parse({
    schemaVersion: 1,
    id: value.id,
    ownerScope: value.ownerScope,
    title: value.title,
    workload: value.workload,
    model: value.model,
    createdAt: value.createdAt,
    updatedAt: value.createdAt,
    revision: 0,
    status: "draft",
    controlRequested: null,
    waitingReason: null,
    statusReason: null,
    purposeRevision: 1,
    purposes: [value.purpose],
    baselineArtifactId: value.baseline?.id ?? null,
    currentBestArtifactId: value.baseline?.id ?? null,
    latestArtifactId: value.baseline?.id ?? null,
    alternativeArtifactIds: [],
    artifacts: value.baseline ? [value.baseline] : [],
    attempts: [],
    evidence: [],
    evaluations: [],
    achievements: [],
    budget: value.budget,
    persistence: {
      ...value.persistence,
      probesUsed: 0,
      spentMicros: 0,
      reservedMicros: 0,
      elapsedMs: 0,
      consecutiveWithoutImprovement: 0,
      active: false,
      openedAt: null,
      terminationReason: null,
    },
    cartridges: [],
    contexts: [],
    usage: [],
    decisions: [],
    handoff: null,
    delivery: value.baseline ? "available" : "pending",
    verification: "unverified",
  });
}

export function transitionCampaign(
  campaign: Campaign,
  input: CampaignCommand,
  trustedActor: CampaignActor,
): CampaignTransition {
  const command = campaignCommandSchema.parse(input);
  const actor = campaignActorSchema.parse(trustedActor);
  ensure(
    command.expectedRevision === campaign.revision,
    "stale-revision",
    "The campaign changed; refresh before applying the command.",
  );
  ensure(
    command.at >= campaign.updatedAt,
    "stale-time",
    "A command cannot precede the latest campaign event.",
  );
  authorize(command, actor);
  const next = campaignSchema.parse(campaign);
  applyCommand(next, command, actor);
  next.revision += 1;
  next.updatedAt = command.at;
  return {
    campaign: next,
    event: campaignEventSchema.parse({
      schemaVersion: 1,
      id: command.id,
      campaignId: next.id,
      sequence: next.revision,
      commandId: command.id,
      kind: `campaign.${command.type}`,
      at: command.at,
      actor,
      summary: "reason" in command ? command.reason : command.type,
      refs: eventRefs(command),
    }),
  };
}

export function currentPurpose(campaign: Campaign): PurposeRevision {
  const purpose = campaign.purposes.find((item) => item.revision === campaign.purposeRevision);
  ensure(purpose, "missing-record", "The current purpose revision is missing.");
  return purpose;
}

export function unresolvedAttempts(campaign: Campaign): boolean {
  return campaign.attempts.some(
    (attempt) => attempt.status === "running" || attempt.status === "unknown",
  );
}

export function canAdopt(campaign: Campaign, artifactId: string, evaluationId: string): void {
  artifact(campaign, artifactId);
  const evaluation = record(campaign.evaluations, evaluationId, "evaluation");
  ensure(
    evaluation.artifactId === artifactId,
    "invalid-value",
    "The evaluation targets another artifact.",
  );
  ensure(
    evaluation.purposeRevision === campaign.purposeRevision,
    "invalid-value",
    "The evaluation belongs to an earlier purpose.",
  );
  ensure(
    evaluation.comparedToArtifactId === campaign.currentBestArtifactId,
    "invalid-value",
    "The evaluation does not compare against the current best.",
  );
  ensure(evaluation.materialImprovement, "unverified", "Adoption requires a material improvement.");
  const purpose = currentPurpose(campaign);
  for (const criterion of purpose.criteria.filter((item) => item.critical)) {
    const observation = evaluation.observations.find((item) => item.criterionId === criterion.id);
    ensure(
      observation?.verdict === "pass",
      "critical-failure",
      `A critical criterion has not passed: ${criterion.id}`,
    );
    const supporting = supportingEvidence(
      campaign,
      artifactId,
      evaluation.purposeRevision,
      criterion.id,
      observation.evidenceIds,
    );
    ensure(
      supporting.some((item) => item.kind !== "claim" && item.verdict === "pass"),
      "unverified",
      "A critical pass lacks supporting evidence.",
    );
    ensure(
      !campaign.evidence.some(
        (item) =>
          item.artifactId === artifactId &&
          item.purposeRevision === campaign.purposeRevision &&
          item.criterionIds.includes(criterion.id) &&
          item.kind !== "claim" &&
          item.verdict === "fail",
      ),
      "critical-failure",
      "Contradictory critical evidence requires resolution in another candidate.",
    );
  }
  ensure(
    evaluation.observations.some(
      (item) =>
        item.verdict === "pass" &&
        supportingEvidence(
          campaign,
          artifactId,
          evaluation.purposeRevision,
          item.criterionId,
          item.evidenceIds,
        ).some((evidence) => evidence.kind !== "claim" && evidence.verdict === "pass"),
    ),
    "unverified",
    "The improvement lacks an observed result.",
  );
}

export function hasVerifiedEvidence(evidence: readonly EvidenceItem[]): boolean {
  return (
    evidence.some((item) => observedIndependently(item) && item.verdict === "pass") &&
    !evidence.some((item) => item.kind !== "claim" && item.verdict === "fail")
  );
}

function applyCommand(campaign: Campaign, command: CampaignCommand, actor: CampaignActor): void {
  switch (command.type) {
    case "ready":
      ensure(
        campaign.status === "draft",
        "invalid-state",
        "Only a draft campaign can become ready.",
      );
      setStatus(campaign, "ready", command.reason);
      return;
    case "start":
      ensure(campaign.status === "ready", "invalid-state", "Only a ready campaign can start.");
      ensure(
        !unresolvedAttempts(campaign),
        "invalid-state",
        "Resolve outstanding attempts before starting.",
      );
      setStatus(campaign, "running", command.reason);
      return;
    case "pause":
    case "cancel":
      requestControl(campaign, command.type, command.reason);
      return;
    case "resume":
      ensure(
        ["paused", "waiting", "completed", "cancelled", "failed"].includes(campaign.status),
        "invalid-state",
        "The campaign is not resumable.",
      );
      ensure(
        !unresolvedAttempts(campaign),
        "invalid-state",
        "Resolve outstanding attempts before resuming.",
      );
      if (["completed", "cancelled", "failed"].includes(campaign.status))
        ensure(actor.role === "user", "forbidden", "Only a user can reopen a terminal campaign.");
      setStatus(campaign, "running", command.reason);
      return;
    case "fail":
      ensure(
        !unresolvedAttempts(campaign),
        "invalid-state",
        "Resolve outstanding attempts before failing.",
      );
      setStatus(campaign, "failed", command.reason);
      return;
    case "wait":
      ensure(!terminal(campaign), "invalid-state", "A terminal campaign cannot wait.");
      campaign.status = "waiting";
      campaign.waitingReason = command.waitingReason;
      campaign.statusReason = command.reason;
      return;
    case "begin-attempt":
      beginAttempt(campaign, command);
      return;
    case "settle-attempt":
      settleAttempt(campaign, command);
      return;
    case "record-artifact":
      registerArtifact(campaign, command.artifact, command.baseline === true);
      return;
    case "record-evidence":
      validateEvidence(campaign, command.evidence);
      insert(campaign.evidence, command.evidence, "evidence");
      return;
    case "record-evaluation":
      validateEvaluation(campaign, command.evaluation);
      insert(campaign.evaluations, command.evaluation, "evaluation");
      reviewCurrentBest(campaign, command.evaluation, command.at);
      return;
    case "adopt":
      ensure(
        !terminal(campaign),
        "invalid-state",
        "Reopen the campaign before adopting a candidate.",
      );
      canAdopt(campaign, command.artifactId, command.evaluationId);
      adopt(campaign, command.artifactId, command.evaluationId, command.at);
      decide(campaign, command, actor, "adopt", command.artifactId);
      return;
    case "retain":
    case "branch":
      artifact(campaign, command.artifactId);
      if (
        command.artifactId !== campaign.currentBestArtifactId &&
        !campaign.alternativeArtifactIds.includes(command.artifactId)
      )
        campaign.alternativeArtifactIds.push(command.artifactId);
      decide(campaign, command, actor, command.type, command.artifactId);
      return;
    case "propose-finish":
      ensure(
        campaign.status === "running",
        "invalid-state",
        "Only a running campaign can propose finishing.",
      );
      campaign.persistence.active = true;
      campaign.persistence.openedAt ??= command.at;
      decide(campaign, command, actor, "finish-proposed", campaign.currentBestArtifactId);
      return;
    case "finish":
      finish(campaign, command, actor);
      return;
    case "revise-purpose":
      ensure(
        !unresolvedAttempts(campaign),
        "invalid-state",
        "Pause and resolve attempts before changing the purpose.",
      );
      validatePurpose(command.purpose);
      ensure(
        command.purpose.revision === campaign.purposeRevision + 1,
        "invalid-value",
        "Purpose revisions must advance by one.",
      );
      campaign.purposes.push(command.purpose);
      campaign.purposeRevision = command.purpose.revision;
      campaign.verification = "unverified";
      for (const achievement of campaign.achievements) {
        if (achievement.status === "verified" || achievement.status === "observed")
          invalidateAchievement(achievement, "superseded", command.at, command.reason, []);
      }
      decide(campaign, command, actor, "steer", campaign.currentBestArtifactId);
      return;
    case "select-model":
      ensure(
        !unresolvedAttempts(campaign),
        "invalid-state",
        "Resolve attempts before selecting a model.",
      );
      campaign.model = command.model;
      decide(campaign, command, actor, "steer", campaign.currentBestArtifactId);
      return;
    case "renew-persistence":
      validateLimits(command.limits, campaign.budget);
      ensure(
        command.limits.probeLimit >= campaign.persistence.probesUsed &&
          command.limits.spendLimitMicros >=
            campaign.persistence.spentMicros + campaign.persistence.reservedMicros &&
          command.limits.timeLimitMs >= campaign.persistence.elapsedMs,
        "invalid-value",
        "New limits cannot erase consumed allowance.",
      );
      Object.assign(campaign.persistence, command.limits);
      campaign.persistence.terminationReason = null;
      decide(campaign, command, actor, "steer", campaign.currentBestArtifactId);
      return;
    case "record-achievement":
      recordAchievement(campaign, command.achievement, actor, command.at);
      return;
    case "invalidate-achievement": {
      const achievement = record(campaign.achievements, command.achievementId, "achievement");
      for (const evidenceId of command.evidenceIds)
        record(campaign.evidence, evidenceId, "evidence");
      ensure(
        command.status !== "regressed" || command.evidenceIds.length > 0,
        "unverified",
        "Regression needs supporting evidence.",
      );
      invalidateAchievement(
        achievement,
        command.status,
        command.at,
        command.reason,
        command.evidenceIds,
      );
      return;
    }
    case "set-cartridges":
      ensure(
        !unresolvedAttempts(campaign),
        "invalid-state",
        "Resolve attempts before changing cartridges.",
      );
      ensure(
        new Set(command.cartridges.map((item) => item.id)).size === command.cartridges.length,
        "duplicate-record",
        "A cartridge appears more than once.",
      );
      campaign.cartridges = command.cartridges;
      return;
    case "record-context":
      ensure(
        command.context.purposeRevision === campaign.purposeRevision,
        "invalid-value",
        "Context targets an earlier purpose.",
      );
      insert(campaign.contexts, command.context, "context");
      return;
    case "record-usage":
      recordUsage(campaign, command);
      return;
    case "set-handoff":
      validateHandoff(campaign, command.handoff.currentBestArtifactId);
      campaign.handoff = command.handoff;
  }
}

function authorize(command: CampaignCommand, actor: CampaignActor): void {
  if (actor.role === "worker") {
    ensure(
      command.type === "propose-finish",
      "forbidden",
      "Workers propose results; the host applies authoritative transitions.",
    );
    return;
  }
  if (["revise-purpose", "select-model", "renew-persistence"].includes(command.type)) {
    ensure(actor.role === "user", "forbidden", "This change requires explicit user steering.");
  }
  if (actor.role === "user") {
    ensure(
      [
        "ready",
        "start",
        "pause",
        "resume",
        "cancel",
        "adopt",
        "retain",
        "branch",
        "finish",
        "revise-purpose",
        "select-model",
        "renew-persistence",
        "set-handoff",
      ].includes(command.type),
      "forbidden",
      "Only the host can attest execution records.",
    );
  }
}

function beginAttempt(
  campaign: Campaign,
  command: Extract<CampaignCommand, { type: "begin-attempt" }>,
): void {
  ensure(
    campaign.status === "running" && campaign.controlRequested === null,
    "invalid-state",
    "The campaign is not dispatchable.",
  );
  ensure(
    !unresolvedAttempts(campaign),
    "invalid-state",
    "An attempt is already running or needs reconciliation.",
  );
  const attempt = command.attempt;
  ensure(
    attempt.status === "running" &&
      attempt.finishedAt === null &&
      attempt.candidateArtifactId === null,
    "invalid-value",
    "A new attempt must be running without a result.",
  );
  ensure(
    attempt.purposeRevision === campaign.purposeRevision,
    "invalid-value",
    "The attempt targets an earlier purpose.",
  );
  ensure(
    attempt.startedAt === command.at,
    "invalid-value",
    "The attempt must start at its event time.",
  );
  if (attempt.parentArtifactId !== null) artifact(campaign, attempt.parentArtifactId);
  ensure(
    !campaign.attempts.some((item) => item.operationId === attempt.operationId),
    "duplicate-record",
    "The operation already has an attempt.",
  );
  if (attempt.probe) {
    const allowance = campaign.persistence;
    ensure(
      allowance.active && allowance.probesUsed < allowance.probeLimit,
      "allowance-exhausted",
      "No persistence probes remain.",
    );
    ensure(
      allowance.spentMicros + allowance.reservedMicros < allowance.spendLimitMicros,
      "allowance-exhausted",
      "The persistence spending allowance is exhausted.",
    );
    ensure(
      allowance.elapsedMs < allowance.timeLimitMs,
      "allowance-exhausted",
      "The persistence time allowance is exhausted.",
    );
    allowance.probesUsed += 1;
  }
  insert(campaign.attempts, attempt, "attempt");
}

function settleAttempt(
  campaign: Campaign,
  command: Extract<CampaignCommand, { type: "settle-attempt" }>,
): void {
  const attempt = record(campaign.attempts, command.attemptId, "attempt");
  ensure(
    attempt.status === "running" || attempt.status === "unknown",
    "invalid-state",
    "The attempt is already settled.",
  );
  ensure(command.at >= attempt.startedAt, "invalid-value", "Settlement cannot precede dispatch.");
  if (command.candidateArtifactId !== null) {
    const candidate = artifact(campaign, command.candidateArtifactId);
    ensure(
      candidate.producerAttemptId === attempt.id,
      "invalid-value",
      "The candidate was produced by another attempt.",
    );
  }
  attempt.status = command.status;
  attempt.failure = command.failure;
  attempt.candidateArtifactId = command.candidateArtifactId;
  if (command.status === "unknown") {
    campaign.status = "waiting";
    campaign.waitingReason = "reconciliation";
    campaign.statusReason = command.failure ?? "The operation outcome is unknown.";
    return;
  }
  attempt.finishedAt = command.at;
  if (command.candidateArtifactId !== null) campaign.latestArtifactId = command.candidateArtifactId;
  if (attempt.probe) {
    campaign.persistence.elapsedMs += command.at - attempt.startedAt;
    campaign.persistence.consecutiveWithoutImprovement += 1;
  }
  if (campaign.controlRequested !== null) {
    setStatus(
      campaign,
      campaign.controlRequested === "cancel" ? "cancelled" : "paused",
      campaign.statusReason ?? "Requested control reached a safe boundary.",
    );
  } else if (campaign.status === "waiting" && campaign.waitingReason === "reconciliation") {
    setStatus(campaign, "paused", "The operation was reconciled; resume to continue.");
  }
}

function registerArtifact(campaign: Campaign, manifest: ArtifactManifest, baseline: boolean): void {
  ensure(
    manifest.ownerScope === campaign.ownerScope,
    "forbidden",
    "The artifact belongs to another scope.",
  );
  for (const parentId of manifest.parentIds) artifact(campaign, parentId);
  if (manifest.producerAttemptId !== null)
    record(campaign.attempts, manifest.producerAttemptId, "attempt");
  if (baseline) {
    ensure(
      campaign.baselineArtifactId === null && campaign.attempts.length === 0,
      "invalid-state",
      "A baseline can only be captured before attempts.",
    );
    campaign.baselineArtifactId = manifest.id;
    campaign.currentBestArtifactId = manifest.id;
    campaign.latestArtifactId = manifest.id;
  }
  insert(campaign.artifacts, manifest, "artifact");
  campaign.delivery = "available";
}

function validatePurpose(purpose: PurposeRevision): void {
  ensure(
    new Set(purpose.criteria.map((item) => item.id)).size === purpose.criteria.length,
    "duplicate-record",
    "Purpose criterion IDs must be unique.",
  );
}

function validateLimits(limits: PersistenceLimits, budget: Campaign["budget"]): void {
  const protectedMicros = budget.evaluationReserveMicros + budget.deliveryReserveMicros;
  ensure(
    Number.isSafeInteger(protectedMicros) && protectedMicros <= budget.limitMicros,
    "invalid-value",
    "Evaluation and delivery reserves exceed the budget.",
  );
  ensure(
    limits.spendLimitMicros <= budget.limitMicros - protectedMicros,
    "invalid-value",
    "Persistence spending must preserve evaluation and delivery reserves.",
  );
}

function validateEvidence(campaign: Campaign, evidence: EvidenceItem): void {
  artifact(campaign, evidence.artifactId);
  const purpose = purposeAt(campaign, evidence.purposeRevision);
  for (const criterionId of evidence.criterionIds)
    ensure(
      purpose.criteria.some((item) => item.id === criterionId),
      "missing-record",
      "The evidence criterion does not exist.",
    );
}

function validateEvaluation(campaign: Campaign, evaluation: Evaluation): void {
  artifact(campaign, evaluation.artifactId);
  if (evaluation.comparedToArtifactId !== null) artifact(campaign, evaluation.comparedToArtifactId);
  const purpose = purposeAt(campaign, evaluation.purposeRevision);
  ensure(
    new Set(evaluation.observations.map((item) => item.criterionId)).size ===
      evaluation.observations.length,
    "duplicate-record",
    "An evaluation cannot repeat a criterion.",
  );
  for (const observation of evaluation.observations) {
    ensure(
      purpose.criteria.some((item) => item.id === observation.criterionId),
      "missing-record",
      "The evaluation criterion does not exist.",
    );
    supportingEvidence(
      campaign,
      evaluation.artifactId,
      evaluation.purposeRevision,
      observation.criterionId,
      observation.evidenceIds,
    );
  }
}

function supportingEvidence(
  campaign: Campaign,
  artifactId: string,
  purposeRevision: number,
  criterionId: string,
  evidenceIds: string[],
): EvidenceItem[] {
  return evidenceIds.map((id) => {
    const item = record(campaign.evidence, id, "evidence");
    ensure(
      item.artifactId === artifactId &&
        item.purposeRevision === purposeRevision &&
        item.criterionIds.includes(criterionId),
      "invalid-value",
      "Evidence does not support this artifact, purpose, and criterion.",
    );
    return item;
  });
}

function reviewCurrentBest(campaign: Campaign, evaluation: Evaluation, at: number): void {
  if (
    evaluation.artifactId !== campaign.currentBestArtifactId ||
    evaluation.purposeRevision !== campaign.purposeRevision
  )
    return;
  const purpose = currentPurpose(campaign);
  const criticalIds = new Set(
    purpose.criteria.filter((criterion) => criterion.critical).map((criterion) => criterion.id),
  );
  const failures = observedFailures(
    campaign,
    evaluation.artifactId,
    evaluation.purposeRevision,
    criticalIds,
  );
  if (failures.length > 0) {
    campaign.verification = "failed";
    for (const achievement of campaign.achievements) {
      const supporting = failures.filter((evidence) =>
        evidence.criterionIds.includes(achievement.criterionId),
      );
      if (
        achievement.artifactId === evaluation.artifactId &&
        achievement.purposeRevision === evaluation.purposeRevision &&
        ["observed", "verified"].includes(achievement.status) &&
        supporting.length > 0
      )
        invalidateAchievement(
          achievement,
          "regressed",
          at,
          evaluation.summary,
          supporting.map((evidence) => evidence.id),
        );
    }
    return;
  }
  const verified = purpose.criteria.every((criterion) => {
    const observation = evaluation.observations.find((item) => item.criterionId === criterion.id);
    return (
      observation?.verdict === "pass" &&
      hasVerifiedEvidence(
        supportingEvidence(
          campaign,
          evaluation.artifactId,
          evaluation.purposeRevision,
          criterion.id,
          observation.evidenceIds,
        ),
      )
    );
  });
  if (verified) campaign.verification = "verified";
  else if (campaign.verification === "unverified" && evaluation.observations.length > 0)
    campaign.verification = "partial";
}

function observedIndependently(evidence: EvidenceItem): boolean {
  return (
    evidence.kind !== "claim" &&
    evidence.kind !== "critique" &&
    (evidence.producer.role === "controller" ||
      (evidence.kind === "human-review" && evidence.producer.role === "user"))
  );
}

function observedFailures(
  campaign: Campaign,
  artifactId: string,
  purposeRevision: number,
  criterionIds: ReadonlySet<string>,
): EvidenceItem[] {
  return campaign.evidence.filter(
    (evidence) =>
      evidence.artifactId === artifactId &&
      evidence.purposeRevision === purposeRevision &&
      evidence.criterionIds.some((id) => criterionIds.has(id)) &&
      evidence.verdict === "fail" &&
      observedIndependently(evidence),
  );
}

function adopt(campaign: Campaign, artifactId: string, evaluationId: string, at: number): void {
  if (
    campaign.currentBestArtifactId !== null &&
    campaign.currentBestArtifactId !== artifactId &&
    !campaign.alternativeArtifactIds.includes(campaign.currentBestArtifactId)
  )
    campaign.alternativeArtifactIds.push(campaign.currentBestArtifactId);
  campaign.currentBestArtifactId = artifactId;
  campaign.alternativeArtifactIds = campaign.alternativeArtifactIds.filter(
    (id) => id !== artifactId,
  );
  const evaluation = record(campaign.evaluations, evaluationId, "evaluation");
  const verifiedCriteria = new Set(
    evaluation.observations
      .filter(
        (observation) =>
          observation.verdict === "pass" &&
          hasVerifiedEvidence(
            supportingEvidence(
              campaign,
              artifactId,
              evaluation.purposeRevision,
              observation.criterionId,
              observation.evidenceIds,
            ),
          ),
      )
      .map((observation) => observation.criterionId),
  );
  campaign.verification =
    verifiedCriteria.size > 0 &&
    currentPurpose(campaign)
      .criteria.filter((criterion) => criterion.critical)
      .every((criterion) => verifiedCriteria.has(criterion.id))
      ? "verified"
      : "partial";
  campaign.persistence.active = false;
  campaign.persistence.consecutiveWithoutImprovement = 0;
  for (const achievement of campaign.achievements)
    if (achievement.artifactId === artifactId && achievement.status === "verified")
      achievement.adoptedAt = at;
}

function finish(
  campaign: Campaign,
  command: Extract<CampaignCommand, { type: "finish" }>,
  actor: CampaignActor,
): void {
  ensure(!terminal(campaign), "invalid-state", "The campaign is already terminal.");
  ensure(
    !unresolvedAttempts(campaign),
    "invalid-state",
    "Resolve outstanding attempts before finishing.",
  );
  if (
    actor.role !== "user" &&
    campaign.persistence.active &&
    campaign.persistence.probesUsed < campaign.persistence.probeLimit
  ) {
    ensure(
      command.boundary !== undefined &&
        ["budget", "time", "scope", "safety"].includes(command.boundary),
      "invalid-state",
      "Repeated finish proposals do not exhaust the persistence allowance.",
    );
  }
  if (command.verification === "verified")
    ensure(
      campaign.currentBestArtifactId !== null && campaign.verification === "verified",
      "unverified",
      "Completion cannot invent artifact verification.",
    );
  if (command.handoff !== null) validateHandoff(campaign, command.handoff.currentBestArtifactId);
  campaign.handoff = command.handoff;
  campaign.delivery = command.delivery;
  campaign.verification = command.verification;
  campaign.persistence.active = false;
  campaign.persistence.terminationReason = command.reason;
  setStatus(campaign, "completed", command.reason);
  decide(campaign, command, actor, "finish", campaign.currentBestArtifactId);
}

function recordAchievement(
  campaign: Campaign,
  achievement: Achievement,
  actor: CampaignActor,
  at: number,
): void {
  artifact(campaign, achievement.artifactId);
  const purpose = purposeAt(campaign, achievement.purposeRevision);
  ensure(
    purpose.criteria.some((item) => item.id === achievement.criterionId),
    "missing-record",
    "The achievement criterion does not exist.",
  );
  ensure(
    achievement.history.length === 0,
    "invalid-value",
    "New achievement history is recorded by the controller.",
  );
  const evidence = supportingEvidence(
    campaign,
    achievement.artifactId,
    achievement.purposeRevision,
    achievement.criterionId,
    achievement.evidenceIds,
  );
  if (achievement.status === "verified") {
    ensure(
      hasVerifiedEvidence(evidence) &&
        observedFailures(
          campaign,
          achievement.artifactId,
          achievement.purposeRevision,
          new Set([achievement.criterionId]),
        ).length === 0,
      "unverified",
      "Verified achievements need consistent observed evidence.",
    );
    achievement.verifiedBy = actor;
  } else achievement.verifiedBy = null;
  achievement.adoptedAt =
    achievement.status === "verified" && achievement.artifactId === campaign.currentBestArtifactId
      ? at
      : null;
  achievement.history = [
    {
      status: achievement.status,
      at,
      reason: achievement.summary || achievement.title,
      evidenceIds: [...achievement.evidenceIds],
    },
  ];
  insert(campaign.achievements, achievement, "achievement");
}

function invalidateAchievement(
  achievement: Achievement,
  status: "regressed" | "superseded",
  at: number,
  reason: string,
  evidenceIds: string[],
): void {
  achievement.status = status;
  achievement.history.push({ status, at, reason, evidenceIds });
}

function recordUsage(
  campaign: Campaign,
  command: Extract<CampaignCommand, { type: "record-usage" }>,
): void {
  const receipt = command.receipt;
  if (receipt.attemptId !== null) record(campaign.attempts, receipt.attemptId, "attempt");
  const index = campaign.usage.findIndex((item) => item.operationId === receipt.operationId);
  const prior = campaign.usage[index];
  if (prior) {
    ensure(
      prior.id === receipt.id && prior.attemptId === receipt.attemptId,
      "invalid-value",
      "Receipt identity changed during reconciliation.",
    );
    ensure(
      receipt.recordedAt >= prior.recordedAt,
      "stale-time",
      "The usage update is older than the stored receipt.",
    );
    ensure(
      prior.state !== "reconciled" || receipt.state === "reconciled",
      "invalid-state",
      "Settled usage cannot return to an unresolved state.",
    );
    campaign.usage[index] = receipt;
  } else insert(campaign.usage, receipt, "usage receipt");
  let spentMicros = 0;
  let reservedMicros = 0;
  const probes = new Set(campaign.attempts.filter((item) => item.probe).map((item) => item.id));
  for (const item of campaign.usage) {
    if (item.attemptId === null || !probes.has(item.attemptId) || item.state === "released")
      continue;
    if (item.state === "reported" || item.state === "reconciled")
      spentMicros += item.costMicros ?? item.reservedMicros;
    else reservedMicros += Math.max(item.reservedMicros, item.costMicros ?? 0);
  }
  ensure(
    Number.isSafeInteger(spentMicros) && Number.isSafeInteger(reservedMicros),
    "invalid-value",
    "Usage exceeds safe integer accounting.",
  );
  campaign.persistence.spentMicros = spentMicros;
  campaign.persistence.reservedMicros = reservedMicros;
}

function requestControl(campaign: Campaign, type: "pause" | "cancel", reason: string): void {
  ensure(!terminal(campaign), "invalid-state", "The campaign is already terminal.");
  campaign.statusReason = reason;
  if (unresolvedAttempts(campaign)) {
    if (campaign.controlRequested !== "cancel") campaign.controlRequested = type;
    return;
  }
  setStatus(campaign, type === "cancel" ? "cancelled" : "paused", reason);
}

function setStatus(campaign: Campaign, status: Campaign["status"], reason: string): void {
  campaign.status = status;
  campaign.controlRequested = null;
  campaign.waitingReason = null;
  campaign.statusReason = reason;
}

function terminal(campaign: Campaign): boolean {
  return ["completed", "cancelled", "failed"].includes(campaign.status);
}

function decide(
  campaign: Campaign,
  command: CampaignCommand & { reason: string },
  actor: CampaignActor,
  kind: CampaignDecision["kind"],
  artifactId: string | null,
): void {
  campaign.decisions.push({
    id: command.id,
    kind,
    reason: command.reason,
    evidenceIds: [],
    artifactId,
    purposeRevision: campaign.purposeRevision,
    actor,
    at: command.at,
  });
}

function validateHandoff(campaign: Campaign, bestId: string | null): void {
  ensure(
    bestId === campaign.currentBestArtifactId,
    "invalid-value",
    "The handoff does not refer to the current best.",
  );
}

function purposeAt(campaign: Campaign, revision: number): PurposeRevision {
  const purpose = campaign.purposes.find((item) => item.revision === revision);
  ensure(purpose, "missing-record", "The purpose revision does not exist.");
  return purpose;
}

function artifact(campaign: Campaign, id: string): ArtifactManifest {
  return record(campaign.artifacts, id, "artifact");
}

function record<T extends { id: string }>(items: T[], id: string, kind: string): T {
  const item = items.find((value) => value.id === id);
  ensure(item, "missing-record", `Unknown ${kind}: ${id}`);
  return item;
}

function insert<T extends { id: string }>(items: T[], item: T, kind: string): void {
  ensure(
    !items.some((value) => value.id === item.id),
    "duplicate-record",
    `Duplicate ${kind}: ${item.id}`,
  );
  items.push(item);
}

function eventRefs(command: CampaignCommand): string[] {
  if ("artifactId" in command) return [command.artifactId];
  if ("attemptId" in command) return [command.attemptId];
  if ("artifact" in command) return [command.artifact.id];
  if ("attempt" in command) return [command.attempt.id];
  if ("evidence" in command) return [command.evidence.id];
  if ("evaluation" in command) return [command.evaluation.id];
  if ("achievement" in command) return [command.achievement.id];
  if ("context" in command) return [command.context.id];
  if ("receipt" in command) return [command.receipt.id];
  return [];
}

function ensure(condition: unknown, code: CampaignErrorCode, message: string): asserts condition {
  if (!condition) throw new CampaignError(code, message);
}
