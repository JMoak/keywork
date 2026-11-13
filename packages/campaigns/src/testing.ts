import type { CampaignCommand, CommandBody } from "./commands.ts";
import { persistenceLimits } from "./continuation.ts";
import type {
  Achievement,
  ArtifactManifest,
  Attempt,
  Campaign,
  CampaignActor,
  CampaignWorkload,
  CreateCampaignInput,
  Evaluation,
  EvidenceItem,
  PersistenceProfile,
  UsageReceipt,
} from "./contracts.ts";
import { createCampaign, transitionCampaign } from "./state.ts";

export const fixtureController: CampaignActor = { id: "controller", role: "controller" };
export const fixtureUser: CampaignActor = { id: "owner", role: "user" };
export const fixtureWorker: CampaignActor = { id: "builder", role: "worker" };

export function campaignFixtureInput(
  workload: CampaignWorkload = "research-refinement",
  profile: PersistenceProfile = "persistent",
): CreateCampaignInput {
  return {
    id: `campaign-${workload}`,
    ownerScope: "owner",
    title: titles[workload],
    workload,
    model: { modelId: "fixture/strong", providerId: "fixture", connectionId: null, effort: null },
    createdAt: 1_000,
    purpose: {
      revision: 1,
      outcome: titles[workload],
      audience: "The intended user",
      scope:
        workload === "research-refinement"
          ? ["supplied source collection"]
          : ["isolated workspace"],
      references: workload === "research-refinement" ? ["source:original"] : [],
      criteria: [
        {
          id: "preserve",
          description: "Preserve protected behavior and source accuracy",
          critical: true,
        },
        {
          id: "useful",
          description: "Demonstrate a material improvement for the audience",
          critical: false,
        },
      ],
      invariants: ["Do not mutate the starting material."],
      sufficientDelivery: "An inspectable artifact and evidence of its purpose.",
      createdAt: 1_000,
    },
    budget: {
      currency: "USD",
      limitMicros: 1_000_000,
      evaluationReserveMicros: 100_000,
      deliveryReserveMicros: 100_000,
    },
    persistence: persistenceLimits(profile, 500_000, 60_000),
    baseline: workload === "project-development" ? null : fixtureArtifact("baseline", null, 1_000),
  };
}

export function fixtureCommand(
  campaign: Campaign,
  body: CommandBody,
  at = campaign.updatedAt + 1,
): CampaignCommand {
  return {
    ...body,
    id: `command-${campaign.revision + 1}`,
    expectedRevision: campaign.revision,
    at,
  };
}

export function applyFixtureCommand(
  campaign: Campaign,
  body: CommandBody,
  actor: CampaignActor = fixtureController,
): Campaign {
  return transitionCampaign(campaign, fixtureCommand(campaign, body), actor).campaign;
}

export function runningFixture(profile: PersistenceProfile = "persistent"): Campaign {
  let campaign = createCampaign(campaignFixtureInput("research-refinement", profile));
  campaign = applyFixtureCommand(campaign, { type: "ready", reason: "Fixture is ready." });
  return applyFixtureCommand(campaign, { type: "start", reason: "Run the fixture." });
}

export function fixtureArtifact(
  id: string,
  producerAttemptId: string | null,
  createdAt: number,
): ArtifactManifest {
  return {
    schemaVersion: 1,
    id,
    kind: "report",
    title: id,
    digest: `digest-${id}`,
    parentIds: [],
    storageRef: `artifact:${id}`,
    ownerScope: "owner",
    producerAttemptId,
    createdAt,
    entries: [
      { path: "report.md", digest: `digest-${id}`, sizeBytes: 42, mediaType: "text/markdown" },
    ],
    capabilities: ["inspect", "export", "diff"],
  };
}

export function fixtureAttempt(campaign: Campaign, id: string, probe = false): Attempt {
  return {
    id,
    operationId: `operation-${id}`,
    purposeRevision: campaign.purposeRevision,
    parentArtifactId: campaign.currentBestArtifactId,
    branch: "main",
    hypothesis: "A focused inspection may uncover a worthwhile improvement.",
    method: "Inspect the complete artifact.",
    expectedBenefit: "A clearer and supported result.",
    model: campaign.model,
    probe,
    status: "running",
    startedAt: campaign.updatedAt + 1,
    finishedAt: null,
    candidateArtifactId: null,
    failure: null,
  };
}

export function fixtureEvidence(
  campaign: Campaign,
  artifactId: string,
  id = "evidence",
): EvidenceItem {
  return {
    id,
    artifactId,
    purposeRevision: campaign.purposeRevision,
    criterionIds: ["preserve", "useful"],
    kind: campaign.workload === "research-refinement" ? "source" : "observation",
    verdict: "pass",
    summary: "The intended outcome was observed and protected constraints held.",
    sourceRefs: [`observation:${artifactId}`],
    methodId: "fixture-review",
    methodVersion: "1",
    observedAt: campaign.updatedAt + 1,
    producer: fixtureController,
  };
}

export function fixtureEvaluation(
  campaign: Campaign,
  artifactId: string,
  evidenceId = "evidence",
  id = "evaluation",
): Evaluation {
  return {
    id,
    artifactId,
    comparedToArtifactId: campaign.currentBestArtifactId,
    purposeRevision: campaign.purposeRevision,
    observations: ["preserve", "useful"].map((criterionId) => ({
      criterionId,
      verdict: "pass",
      evidenceIds: [evidenceId],
      summary: "Observed against the agreed criterion.",
    })),
    materialImprovement: true,
    summary: "The candidate materially improves the intended outcome.",
    evaluator: fixtureController,
    model: null,
    createdAt: campaign.updatedAt + 1,
  };
}

export function fixtureAchievement(
  campaign: Campaign,
  artifactId: string,
  evidenceId = "evidence",
): Achievement {
  return {
    id: `achievement-${artifactId}`,
    criterionId: "useful",
    artifactId,
    purposeRevision: campaign.purposeRevision,
    title: "The intended outcome improved.",
    summary: "Observed and supported by the fixture evidence.",
    evidenceIds: [evidenceId],
    status: "verified",
    verifiedBy: null,
    adoptedAt: null,
    history: [],
  };
}

export function fixtureReceipt(campaign: Campaign, attemptId: string): UsageReceipt {
  const attempt = campaign.attempts.find((item) => item.id === attemptId);
  if (!attempt) throw new Error("Missing fixture attempt.");
  return {
    id: `receipt-${attemptId}`,
    operationId: attempt.operationId,
    attemptId,
    providerRequestId: `request-${attemptId}`,
    stage: "build",
    model: campaign.model,
    currency: "USD",
    reservedMicros: 1_000,
    costMicros: 800,
    state: "reconciled",
    costSource: "fixture",
    pricingAt: 1_000,
    recordedAt: campaign.updatedAt + 1,
    inputTokens: 100,
    outputTokens: 100,
    cachedTokens: 0,
  };
}

export function runCampaignFixture(workload: CampaignWorkload): Campaign {
  let campaign = createCampaign(campaignFixtureInput(workload));
  const apply = (body: CommandBody) => {
    campaign = applyFixtureCommand(campaign, body);
  };
  apply({ type: "ready", reason: "The fixture contract is ready." });
  apply({ type: "start", reason: "Run the workflow." });
  apply({ type: "begin-attempt", attempt: fixtureAttempt(campaign, "attempt") });
  apply({
    type: "record-artifact",
    artifact: fixtureArtifact("candidate", "attempt", campaign.updatedAt + 1),
  });
  apply({ type: "record-evidence", evidence: fixtureEvidence(campaign, "candidate") });
  apply({ type: "record-evaluation", evaluation: fixtureEvaluation(campaign, "candidate") });
  apply({ type: "record-achievement", achievement: fixtureAchievement(campaign, "candidate") });
  apply({
    type: "settle-attempt",
    attemptId: "attempt",
    status: "succeeded",
    candidateArtifactId: "candidate",
    failure: null,
  });
  apply({ type: "record-usage", receipt: fixtureReceipt(campaign, "attempt") });
  apply({
    type: "adopt",
    artifactId: "candidate",
    evaluationId: "evaluation",
    reason: "Accept the demonstrated improvement.",
  });
  apply({
    type: "finish",
    reason: "The agreed outcome is available.",
    delivery: "available",
    verification: "verified",
    handoff: {
      summary: "The selected candidate and its evidence are available.",
      currentBestArtifactId: "candidate",
      obligations: [],
      unresolved: [],
      options: [],
      attemptedApproaches: ["Inspect, create, compare, and verify."],
      nextStep: "Review the artifact.",
    },
  });
  return campaign;
}

const titles: Record<CampaignWorkload, string> = {
  "app-improvement": "Improve a working application's user journey",
  "project-development": "Develop a runnable prototype from a brief",
  "research-refinement": "Refine a report using supplied sources",
};
