import { describe, expect, it } from "vitest";
import { type ContinuationAdmission, persistenceLimits, planContinuation } from "./continuation.ts";
import { type Campaign, type CampaignWorkload, campaignSchema } from "./contracts.ts";
import { CampaignError, createCampaign, currentPurpose, transitionCampaign } from "./state.ts";
import {
  applyFixtureCommand as apply,
  campaignFixtureInput,
  fixtureAchievement,
  fixtureArtifact,
  fixtureAttempt,
  fixtureCommand,
  fixtureController,
  fixtureEvaluation,
  fixtureEvidence,
  fixtureReceipt,
  fixtureUser,
  fixtureWorker,
  runCampaignFixture,
  runningFixture,
} from "./testing.ts";

describe("campaign workload contracts", () => {
  it.each<CampaignWorkload>(["app-improvement", "project-development", "research-refinement"])(
    "takes %s through the same evidence-backed delivery lifecycle",
    (workload) => {
      const campaign = runCampaignFixture(workload);
      expect(campaignSchema.parse(JSON.parse(JSON.stringify(campaign)))).toEqual(campaign);
      expect(campaign.status).toBe("completed");
      expect(campaign.currentBestArtifactId).toBe("candidate");
      expect(campaign.latestArtifactId).toBe("candidate");
      expect(campaign.verification).toBe("verified");
      expect(campaign.achievements[0]?.status).toBe("verified");
      expect(campaign.achievements[0]?.adoptedAt).not.toBeNull();
      expect(campaign.usage[0]?.costMicros).toBe(800);
      expect(campaign.handoff?.currentBestArtifactId).toBe("candidate");
    },
  );

  it("creates research without a repository or evidence service", () => {
    const input = campaignFixtureInput();
    expect(input.purpose.scope).toEqual(["supplied source collection"]);
    const campaign = createCampaign(input);
    input.purpose.outcome = "Changed later";
    expect(campaign.purposes[0]?.outcome).not.toBe(input.purpose.outcome);
    expect(JSON.stringify(campaign)).not.toContain("Relly");
  });

  it("keeps complete accepted objectives and long source references", () => {
    const input = campaignFixtureInput();
    const objective = "A".repeat(16_000);
    const reference = `https://example.test/source?query=${"q".repeat(4_000)}`;
    input.purpose.outcome = objective;
    input.purpose.sufficientDelivery = objective;
    input.purpose.references = [reference];
    const campaign = createCampaign(input);
    expect(currentPurpose(campaign)).toMatchObject({
      outcome: objective,
      sufficientDelivery: objective,
      references: [reference],
    });
    input.purpose.references = ["x".repeat(4_097)];
    expect(() => createCampaign(input)).toThrow();
  });

  it("preserves old snapshots and refuses stale revision writes", () => {
    const before = createCampaign(campaignFixtureInput());
    const command = fixtureCommand(before, { type: "ready", reason: "Ready." });
    const transition = transitionCampaign(before, command, fixtureController);
    expect(before.status).toBe("draft");
    expect(before.revision).toBe(0);
    expect(transition.campaign.revision).toBe(1);
    expect(transition.event.sequence).toBe(1);
    expect(transition.event.commandId).toBe(command.id);
    expect(() => transitionCampaign(transition.campaign, command, fixtureController)).toThrowError(
      expect.objectContaining({ code: "stale-revision" }),
    );
  });

  it("requires distinct criteria and preserves protected spending", () => {
    const input = campaignFixtureInput();
    input.purpose.criteria.push({
      id: "preserve",
      description: "Duplicate criterion",
      critical: true,
    });
    expect(() => createCampaign(input)).toThrow(CampaignError);
    const overdrawn = campaignFixtureInput();
    overdrawn.persistence.spendLimitMicros = overdrawn.budget.limitMicros;
    expect(() => createCampaign(overdrawn)).toThrowError(
      expect.objectContaining({ code: "invalid-value" }),
    );
  });

  it("does not let workers attest evidence, change purpose, or grant more probes", () => {
    const campaign = runningFixture();
    expect(() =>
      apply(
        campaign,
        {
          type: "renew-persistence",
          limits: persistenceLimits("deep", 500_000, 60_000),
          reason: "More.",
        },
        fixtureWorker,
      ),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(() =>
      apply(
        campaign,
        { type: "record-evidence", evidence: fixtureEvidence(campaign, "baseline") },
        fixtureUser,
      ),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(
      apply(campaign, { type: "propose-finish", reason: "No further ideas." }, fixtureWorker)
        .persistence.active,
    ).toBe(true);
  });
});

describe("artifact and evidence decisions", () => {
  it("keeps the baseline and current best when a newer candidate is not adopted", () => {
    const campaign = candidateFixture();
    expect(campaign.latestArtifactId).toBe("candidate");
    expect(campaign.currentBestArtifactId).toBe("baseline");
    const retained = apply(
      campaign,
      { type: "retain", artifactId: "candidate", reason: "Keep the alternative." },
      fixtureUser,
    );
    expect(retained.alternativeArtifactIds).toContain("candidate");
    expect(retained.baselineArtifactId).toBe("baseline");
  });

  it("does not let a favorable evaluation outvote critical failure evidence", () => {
    let campaign = evaluatedCandidate();
    const failure = {
      ...fixtureEvidence(campaign, "candidate", "failure"),
      verdict: "fail" as const,
    };
    campaign = apply(campaign, { type: "record-evidence", evidence: failure });
    expect(() =>
      apply(campaign, {
        type: "adopt",
        artifactId: "candidate",
        evaluationId: "evaluation",
        reason: "The critic likes it.",
      }),
    ).toThrowError(expect.objectContaining({ code: "critical-failure" }));
    expect(campaign.currentBestArtifactId).toBe("baseline");
  });

  it("requires observations beyond model claims", () => {
    let campaign = candidateFixture();
    campaign = apply(campaign, {
      type: "record-evidence",
      evidence: { ...fixtureEvidence(campaign, "candidate"), kind: "claim" },
    });
    campaign = apply(campaign, {
      type: "record-evaluation",
      evaluation: fixtureEvaluation(campaign, "candidate"),
    });
    expect(() =>
      apply(campaign, {
        type: "adopt",
        artifactId: "candidate",
        evaluationId: "evaluation",
        reason: "The builder claims success.",
      }),
    ).toThrowError(expect.objectContaining({ code: "unverified" }));
    expect(() =>
      apply(campaign, {
        type: "record-achievement",
        achievement: fixtureAchievement(campaign, "candidate"),
      }),
    ).toThrowError(expect.objectContaining({ code: "unverified" }));
  });

  it("rejects evidence from another artifact and evaluations from earlier purposes", () => {
    let campaign = candidateFixture();
    campaign = apply(campaign, {
      type: "record-evidence",
      evidence: fixtureEvidence(campaign, "baseline"),
    });
    expect(() =>
      apply(campaign, {
        type: "record-evaluation",
        evaluation: fixtureEvaluation(campaign, "candidate"),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
    campaign = evaluatedCandidate();
    const priorPurpose = currentPurpose(campaign);
    campaign = apply(
      campaign,
      {
        type: "revise-purpose",
        purpose: {
          ...priorPurpose,
          revision: 2,
          createdAt: campaign.updatedAt + 1,
          outcome: "A different intended outcome.",
        },
        reason: "Revise the purpose.",
      },
      fixtureUser,
    );
    expect(campaign.purposes[0]).toEqual(priorPurpose);
    expect(campaign.purposes).toHaveLength(2);
    expect(() =>
      apply(campaign, {
        type: "adopt",
        artifactId: "candidate",
        evaluationId: "evaluation",
        reason: "Use the stale evaluation.",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
  });

  it("adopts a useful critique without certifying checks that were never performed", () => {
    let campaign = candidateFixture();
    campaign = apply(campaign, {
      type: "record-evidence",
      evidence: {
        ...fixtureEvidence(campaign, "candidate"),
        kind: "critique",
        summary: "The reviewer asserts all runtime checks passed after reading the code.",
      },
    });
    campaign = apply(campaign, {
      type: "record-evaluation",
      evaluation: fixtureEvaluation(campaign, "candidate"),
    });
    campaign = apply(campaign, {
      type: "adopt",
      artifactId: "candidate",
      evaluationId: "evaluation",
      reason: "Useful independently reviewed artifact.",
    });
    expect(campaign.currentBestArtifactId).toBe("candidate");
    expect(campaign.verification).toBe("partial");
    expect(() =>
      apply(campaign, {
        type: "record-achievement",
        achievement: fixtureAchievement(campaign, "candidate"),
      }),
    ).toThrowError(expect.objectContaining({ code: "unverified" }));
    campaign = apply(campaign, {
      type: "record-achievement",
      achievement: { ...fixtureAchievement(campaign, "candidate"), status: "observed" },
    });
    expect(campaign.achievements[0]).toMatchObject({ status: "observed", verifiedBy: null });
    expect(() =>
      apply(campaign, {
        type: "finish",
        reason: "Claim completion.",
        handoff: null,
        delivery: "available",
        verification: "verified",
      }),
    ).toThrowError(expect.objectContaining({ code: "unverified" }));
  });

  it("requires observed evidence for each critical criterion, even with other real checks", () => {
    let campaign = candidateFixture();
    campaign = apply(campaign, {
      type: "record-evidence",
      evidence: { ...fixtureEvidence(campaign, "candidate"), kind: "critique" },
    });
    campaign = apply(campaign, {
      type: "record-evidence",
      evidence: {
        ...fixtureEvidence(campaign, "candidate", "real-check"),
        kind: "test",
        criterionIds: ["useful"],
      },
    });
    const evaluation = fixtureEvaluation(campaign, "candidate");
    const useful = evaluation.observations.find((item) => item.criterionId === "useful");
    if (useful === undefined) throw new Error("Missing criterion fixture.");
    useful.evidenceIds.push("real-check");
    campaign = apply(campaign, { type: "record-evaluation", evaluation });
    campaign = apply(campaign, {
      type: "adopt",
      artifactId: "candidate",
      evaluationId: "evaluation",
      reason: "Accept a partially verified improvement.",
    });
    expect(campaign.verification).toBe("partial");
  });

  it("does not promote a worker assertion merely because its kind is test", () => {
    let campaign = candidateFixture();
    campaign = apply(campaign, {
      type: "record-evidence",
      evidence: {
        ...fixtureEvidence(campaign, "candidate"),
        kind: "test",
        producer: fixtureWorker,
      },
    });
    campaign = apply(campaign, {
      type: "record-evaluation",
      evaluation: fixtureEvaluation(campaign, "candidate"),
    });
    campaign = apply(campaign, {
      type: "adopt",
      artifactId: "candidate",
      evaluationId: "evaluation",
      reason: "Retain for independent checks.",
    });
    expect(campaign.verification).toBe("partial");
    expect(() =>
      apply(campaign, {
        type: "record-achievement",
        achievement: fixtureAchievement(campaign, "candidate"),
      }),
    ).toThrowError(expect.objectContaining({ code: "unverified" }));
  });

  it("keeps verification separate from adoption and preserves regression history", () => {
    let campaign = evaluatedCandidate();
    campaign = apply(campaign, {
      type: "record-achievement",
      achievement: fixtureAchievement(campaign, "candidate"),
    });
    expect(campaign.achievements[0]?.status).toBe("verified");
    expect(campaign.achievements[0]?.adoptedAt).toBeNull();
    campaign = apply(campaign, {
      type: "adopt",
      artifactId: "candidate",
      evaluationId: "evaluation",
      reason: "Adopt the verified gain.",
    });
    expect(campaign.alternativeArtifactIds).toContain("baseline");
    expect(campaign.achievements[0]?.adoptedAt).not.toBeNull();
    campaign = apply(campaign, {
      type: "record-evidence",
      evidence: { ...fixtureEvidence(campaign, "candidate", "regression"), verdict: "fail" },
    });
    campaign = apply(campaign, {
      type: "invalidate-achievement",
      achievementId: "achievement-candidate",
      status: "regressed",
      evidenceIds: ["regression"],
      reason: "A later observation contradicts it.",
    });
    expect(campaign.achievements[0]?.history.map((item) => item.status)).toEqual([
      "verified",
      "regressed",
    ]);
    expect(campaign.currentBestArtifactId).toBe("candidate");
  });

  it("cannot label an unevaluated result verified merely by finishing", () => {
    expect(() =>
      apply(runningFixture(), {
        type: "finish",
        reason: "Done.",
        handoff: null,
        delivery: "available",
        verification: "verified",
      }),
    ).toThrowError(expect.objectContaining({ code: "unverified" }));
  });

  it("verifies a human-reviewed baseline without inventing improvement or adoption", () => {
    let campaign = runningFixture();
    campaign = apply(campaign, {
      type: "record-evidence",
      evidence: {
        ...fixtureEvidence(campaign, "baseline"),
        kind: "human-review",
        producer: fixtureUser,
      },
    });
    campaign = apply(campaign, {
      type: "record-evaluation",
      evaluation: {
        ...fixtureEvaluation(campaign, "baseline"),
        materialImprovement: false,
        evaluator: fixtureUser,
      },
    });
    expect(campaign.verification).toBe("verified");
    expect(campaign.currentBestArtifactId).toBe("baseline");
    expect(campaign.attempts).toEqual([]);
    expect(campaign.decisions.some((decision) => decision.kind === "adopt")).toBe(false);
  });

  it.each([
    { criterionId: "preserve", verification: "failed" },
    { criterionId: "useful", verification: "partial" },
  ] as const)(
    "records observed regression of $criterionId without deleting the best or its achievement history",
    ({ criterionId, verification }) => {
      let campaign = evaluatedCandidate();
      campaign = apply(campaign, {
        type: "adopt",
        artifactId: "candidate",
        evaluationId: "evaluation",
        reason: "Accept observed gain.",
      });
      campaign = apply(campaign, {
        type: "record-achievement",
        achievement: { ...fixtureAchievement(campaign, "candidate"), criterionId },
      });
      campaign = apply(campaign, {
        type: "record-evidence",
        evidence: {
          ...fixtureEvidence(campaign, "candidate", "failure"),
          kind: "human-review",
          producer: fixtureUser,
          verdict: "fail",
          criterionIds: [criterionId],
        },
      });
      const evaluation = fixtureEvaluation(campaign, "candidate", "evidence", "human-review");
      evaluation.materialImprovement = false;
      evaluation.evaluator = fixtureUser;
      evaluation.observations = evaluation.observations.map((observation) =>
        observation.criterionId === criterionId
          ? { ...observation, verdict: "fail", evidenceIds: ["failure"] }
          : observation,
      );
      campaign = apply(campaign, { type: "record-evaluation", evaluation });
      expect(campaign.verification).toBe(verification);
      expect(campaign.currentBestArtifactId).toBe("candidate");
      expect(campaign.achievements[0]?.history.map((entry) => entry.status)).toEqual([
        "verified",
        "regressed",
      ]);
      expect(campaign.achievements[0]?.history.at(-1)?.evidenceIds).toEqual(["failure"]);
      const subsequent = {
        ...fixtureEvaluation(campaign, "candidate", "evidence", "later-review"),
        materialImprovement: false,
        evaluator: fixtureWorker,
        model: campaign.model,
      };
      campaign = apply(campaign, { type: "record-evaluation", evaluation: subsequent });
      expect(campaign.verification).toBe(verification);
      expect(campaign.achievements[0]?.history).toHaveLength(2);
      expect(() =>
        apply(campaign, {
          type: "record-achievement",
          achievement: {
            ...fixtureAchievement(campaign, "candidate"),
            id: "later-positive-claim",
            criterionId,
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "unverified" }));
    },
  );

  it("does not let later model critique erase stronger observed verification", () => {
    let campaign = evaluatedCandidate();
    campaign = apply(campaign, {
      type: "adopt",
      artifactId: "candidate",
      evaluationId: "evaluation",
      reason: "Accept observed gain.",
    });
    campaign = apply(campaign, {
      type: "record-evidence",
      evidence: {
        ...fixtureEvidence(campaign, "candidate", "opinion"),
        kind: "critique",
        verdict: "fail",
      },
    });
    const evaluation = fixtureEvaluation(campaign, "candidate", "opinion", "critique-review");
    evaluation.materialImprovement = false;
    evaluation.observations = evaluation.observations.map((observation) => ({
      ...observation,
      verdict: "fail",
    }));
    campaign = apply(campaign, { type: "record-evaluation", evaluation });
    expect(campaign.verification).toBe("verified");
  });

  it("requires complete observed criterion coverage before verifying a current artifact", () => {
    let campaign = runningFixture();
    campaign = apply(campaign, {
      type: "record-evidence",
      evidence: fixtureEvidence(campaign, "baseline"),
    });
    const evaluation = fixtureEvaluation(campaign, "baseline");
    evaluation.materialImprovement = false;
    evaluation.observations = evaluation.observations.slice(0, 1);
    campaign = apply(campaign, { type: "record-evaluation", evaluation });
    expect(campaign.verification).toBe("partial");
  });
});

describe("bounded persistence", () => {
  it.each([
    ["focused", 2],
    ["persistent", 8],
    ["deep", 12],
  ] as const)("defines provisional %s capacity", (profile, count) => {
    expect(persistenceLimits(profile, 100, 1_000).probeLimit).toBe(count);
  });

  it.each([
    [5, "persistent"],
    [10, "deep"],
  ] as const)("finds a useful next probe after %i empty probes", (emptyCount, profile) => {
    let campaign = emptyProbes(emptyCount, profile);
    expect(planContinuation(campaign, admission(campaign)).action).toBe("probe");
    const consumed = campaign.persistence.probesUsed;
    campaign = candidateFixture(campaign, true);
    campaign = evaluatedCandidate(campaign);
    campaign = apply(campaign, {
      type: "adopt",
      artifactId: "candidate",
      evaluationId: "evaluation",
      reason: "A material gain finally emerged.",
    });
    expect(campaign.currentBestArtifactId).toBe("candidate");
    expect(campaign.persistence.probesUsed).toBe(consumed + 1);
    expect(campaign.persistence.consecutiveWithoutImprovement).toBe(0);
    expect(campaign.persistence.active).toBe(false);
  });

  it("exhausts a window without forcing an edit or resetting on another finish proposal", () => {
    let campaign = emptyProbes(12, "deep");
    campaign = apply(
      campaign,
      { type: "propose-finish", reason: "Still no worthwhile change." },
      fixtureWorker,
    );
    expect(planContinuation(campaign, admission(campaign))).toMatchObject({
      action: "finish",
      boundary: "exhausted",
      remainingProbes: 0,
    });
    expect(() =>
      apply(campaign, {
        type: "begin-attempt",
        attempt: fixtureAttempt(campaign, "thirteenth", true),
      }),
    ).toThrowError(expect.objectContaining({ code: "allowance-exhausted" }));
    const finished = apply(campaign, {
      type: "finish",
      reason: "The authorized exploration found no gain.",
      handoff: null,
      delivery: "available",
      verification: "unverified",
      boundary: "exhausted",
    });
    expect(finished.currentBestArtifactId).toBe("baseline");
    expect(finished.achievements).toEqual([]);
  });

  it("does not let an early controller finish silently skip remaining patience", () => {
    const campaign = emptyProbes(1, "persistent");
    expect(() =>
      apply(campaign, {
        type: "finish",
        reason: "The model said done.",
        handoff: null,
        delivery: "available",
        verification: "unverified",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-state" }));
  });

  it("preserves counters through restart, branching, purpose changes, and explicit renewal", () => {
    let campaign = campaignSchema.parse(JSON.parse(JSON.stringify(emptyProbes(5, "persistent"))));
    const used = {
      probes: campaign.persistence.probesUsed,
      spent: campaign.persistence.spentMicros,
      elapsed: campaign.persistence.elapsedMs,
    };
    campaign = apply(
      campaign,
      { type: "branch", artifactId: "baseline", reason: "Try a different direction." },
      fixtureUser,
    );
    campaign = apply(
      campaign,
      {
        type: "revise-purpose",
        purpose: { ...currentPurpose(campaign), revision: 2, createdAt: campaign.updatedAt + 1 },
        reason: "Clarify the audience.",
      },
      fixtureUser,
    );
    campaign = apply(
      campaign,
      {
        type: "renew-persistence",
        limits: persistenceLimits("deep", 500_000, 90_000),
        reason: "Explicitly authorize a larger finite window.",
      },
      fixtureUser,
    );
    expect(campaign.persistence).toMatchObject({
      probesUsed: used.probes,
      spentMicros: used.spent,
      elapsedMs: used.elapsed,
      probeLimit: 12,
    });
  });

  it.each([
    [{ userStopped: true }, "stop", "user"],
    [{ authority: "denied" }, "stop", "scope"],
    [{ safetyAllowed: false }, "stop", "safety"],
    [{ availableMicros: 100 }, "finish", "budget"],
    [{ maximumDurationMs: 60_001 }, "finish", "time"],
    [{ unresolvedEffect: true }, "wait", null],
  ] as const)(
    "honors a mandatory boundary before using remaining probes",
    (override, action, boundary) => {
      const campaign = emptyProbes(1, "deep");
      expect(planContinuation(campaign, { ...admission(campaign), ...override })).toMatchObject({
        action,
        boundary,
      });
      expect(campaign.persistence.probesUsed).toBe(1);
    },
  );
});

describe("execution and usage reconciliation", () => {
  it("keeps pending controls distinct from quiescence", () => {
    let campaign = runningFixture();
    campaign = apply(campaign, {
      type: "begin-attempt",
      attempt: fixtureAttempt(campaign, "running"),
    });
    campaign = apply(
      campaign,
      { type: "pause", reason: "Pause at the next safe boundary." },
      fixtureUser,
    );
    expect(campaign).toMatchObject({ status: "running", controlRequested: "pause" });
    expect(() =>
      apply(campaign, { type: "begin-attempt", attempt: fixtureAttempt(campaign, "blocked") }),
    ).toThrowError(expect.objectContaining({ code: "invalid-state" }));
    campaign = apply(campaign, {
      type: "settle-attempt",
      attemptId: "running",
      status: "succeeded",
      candidateArtifactId: null,
      failure: null,
    });
    expect(campaign).toMatchObject({ status: "paused", controlRequested: null });
  });

  it("retains unknown outcomes across cancellation and reconciliation", () => {
    let campaign = runningFixture();
    campaign = apply(campaign, {
      type: "begin-attempt",
      attempt: fixtureAttempt(campaign, "unknown"),
    });
    campaign = apply(campaign, {
      type: "settle-attempt",
      attemptId: "unknown",
      status: "unknown",
      candidateArtifactId: null,
      failure: "Lost response after dispatch.",
    });
    campaign = campaignSchema.parse(JSON.parse(JSON.stringify(campaign)));
    campaign = apply(campaign, { type: "cancel", reason: "Stop further work." }, fixtureUser);
    expect(campaign).toMatchObject({
      status: "waiting",
      waitingReason: "reconciliation",
      controlRequested: "cancel",
    });
    expect(() => apply(campaign, { type: "resume", reason: "Retry." }, fixtureUser)).toThrowError(
      expect.objectContaining({ code: "invalid-state" }),
    );
    campaign = apply(campaign, {
      type: "settle-attempt",
      attemptId: "unknown",
      status: "failed",
      candidateArtifactId: null,
      failure: "Provider confirmed failure.",
    });
    expect(campaign).toMatchObject({ status: "cancelled", controlRequested: null });
  });

  it("does not double count a late or repeated usage receipt", () => {
    let campaign = runningFixture();
    campaign = apply(campaign, { type: "propose-finish", reason: "No more ideas." }, fixtureWorker);
    campaign = apply(campaign, {
      type: "begin-attempt",
      attempt: fixtureAttempt(campaign, "paid", true),
    });
    const unknown = {
      ...fixtureReceipt(campaign, "paid"),
      costMicros: null,
      state: "unknown" as const,
    };
    campaign = apply(campaign, { type: "record-usage", receipt: unknown });
    expect(campaign.persistence).toMatchObject({ reservedMicros: 1_000, spentMicros: 0 });
    const reconciled = fixtureReceipt(campaign, "paid");
    campaign = apply(campaign, { type: "record-usage", receipt: reconciled });
    campaign = apply(campaign, { type: "record-usage", receipt: reconciled });
    expect(campaign.usage).toHaveLength(1);
    expect(campaign.persistence).toMatchObject({ reservedMicros: 0, spentMicros: 800 });
    expect(() =>
      apply(campaign, {
        type: "record-usage",
        receipt: { ...unknown, recordedAt: campaign.updatedAt + 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-state" }));
  });
});

function candidateFixture(initial = runningFixture(), probe = false): Campaign {
  let campaign = apply(initial, {
    type: "begin-attempt",
    attempt: fixtureAttempt(initial, "candidate-attempt", probe),
  });
  campaign = apply(campaign, {
    type: "record-artifact",
    artifact: fixtureArtifact("candidate", "candidate-attempt", campaign.updatedAt + 1),
  });
  return apply(campaign, {
    type: "settle-attempt",
    attemptId: "candidate-attempt",
    status: "succeeded",
    candidateArtifactId: "candidate",
    failure: null,
  });
}

function evaluatedCandidate(initial = candidateFixture()): Campaign {
  let campaign = apply(initial, {
    type: "record-evidence",
    evidence: fixtureEvidence(initial, "candidate"),
  });
  campaign = apply(campaign, {
    type: "record-evaluation",
    evaluation: fixtureEvaluation(campaign, "candidate"),
  });
  return campaign;
}

function emptyProbes(count: number, profile: "persistent" | "deep"): Campaign {
  let campaign = apply(
    runningFixture(profile),
    { type: "propose-finish", reason: "Nothing obvious remains." },
    fixtureWorker,
  );
  for (let index = 0; index < count; index += 1) {
    const id = `probe-${index}`;
    campaign = apply(campaign, {
      type: "begin-attempt",
      attempt: fixtureAttempt(campaign, id, true),
    });
    campaign = apply(campaign, {
      type: "settle-attempt",
      attemptId: id,
      status: "succeeded",
      candidateArtifactId: null,
      failure: null,
    });
    campaign = apply(campaign, { type: "record-usage", receipt: fixtureReceipt(campaign, id) });
  }
  return campaign;
}

function admission(campaign: Campaign): ContinuationAdmission {
  return {
    now: campaign.updatedAt + 1,
    availableMicros: 900_000,
    maximumCostMicros: 1_000,
    maximumDurationMs: 10,
    authority: "allowed",
    safetyAllowed: true,
    userStopped: false,
    unresolvedEffect: false,
  };
}
