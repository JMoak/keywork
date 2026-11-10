import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attempt, Campaign, CommandBody, Evaluation, EvidenceItem } from "@keywork/campaigns";
import { afterEach, describe, expect, it } from "vitest";
import { CampaignArtifacts } from "./artifacts.ts";
import {
  type CampaignExecutionContext,
  type CampaignExecutionResult,
  type CampaignExecutor,
  CampaignService,
} from "./service.ts";
import { type CampaignLease, CampaignStore } from "./store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("campaign service integration", () => {
  it.each([
    { empty: 5, profile: "persistent" },
    { empty: 10, profile: "deep" },
  ] as const)(
    "finds and verifies a real artifact after $empty empty attempts with $profile persistence",
    async ({ empty, profile }) => {
      let operations = 0;
      const world = await environment({
        execute: async (context) => {
          operations += 1;
          charge(context, 10);
          if (operations !== empty + 1) return emptyResult();
          return improved(context, world.artifacts);
        },
      });
      const created = await world.service.create(createRequest(profile));
      await start(world.service, created.campaign.id);
      await world.service.settled(created.campaign.id);
      const final = required(world.service, created.campaign.id);
      expect(final.status, `${final.statusReason}; ${world.notices.join("; ")}`).toBe("completed");
      expect(final.attempts[empty]?.candidateArtifactId).toBe(final.currentBestArtifactId);
      expect(final.currentBestArtifactId).not.toBe(created.campaign.baselineArtifactId);
      expect(final.achievements).toHaveLength(1);
      expect(final.achievements[0]).toMatchObject({
        status: "verified",
        artifactId: final.currentBestArtifactId,
      });
      expect(final.persistence.probesUsed).toBe(profile === "persistent" ? 8 : 12);
      expect(world.store.spending(final.id).settledMicros).toBe(operations * 10);
      expect(final.usage).toHaveLength(operations);
      expect(
        (await world.service.artifact(final.id, final.currentBestArtifactId ?? "")).content,
      ).toContain("Checked improvement");
      expect(world.notices).toEqual([]);
    },
  );

  it("executes an accepted long objective while preserving its complete purpose", async () => {
    const objective = `${"A".repeat(15_999)}Z`;
    const executed: CampaignExecutionContext[] = [];
    const world = await environment({
      execute: async (context) => {
        executed.push(context);
        return emptyResult();
      },
    });
    const created = await world.service.create({ ...createRequest(), objective });
    await start(world.service, created.campaign.id);
    await world.service.settled(created.campaign.id);
    expect(executed.length).toBeGreaterThan(0);
    expect(executed[0]?.campaign.purposes[0]?.outcome).toBe(objective);
    expect(executed[0]?.campaign.purposes[0]?.sufficientDelivery).toBe(objective);
    expect(executed[0]?.attempt.hypothesis.length).toBeLessThanOrEqual(8_000);
    expect(required(world.service, created.campaign.id).status).toBe("completed");
    expect(world.notices).toEqual([]);
  });

  it("distinguishes requested pause from its execution boundary and preserves the completed receipt", async () => {
    const entered = deferred<CampaignExecutionContext>();
    const release = deferred<void>();
    let operations = 0;
    const world = await environment({
      execute: async (context) => {
        operations += 1;
        const operation = reserve(context);
        entered.resolve(context);
        await release.promise;
        context.store.settle(
          operation.id,
          { ...operation.receipt, state: "reported", costMicros: 23, recordedAt: Date.now() },
          context.lease,
        );
        return emptyResult();
      },
    });
    cleanups.push(async () => release.resolve());
    const created = await world.service.create(createRequest());
    await start(world.service, created.campaign.id);
    const context = await entered.promise;
    const pending = await command(world.service, created.campaign.id, {
      type: "pause",
      reason: "Inspect output",
    });
    expect(pending.campaign).toMatchObject({ status: "running", controlRequested: "pause" });
    expect(context.signal.aborted).toBe(false);
    release.resolve();
    await world.service.settled(created.campaign.id);
    expect(required(world.service, created.campaign.id)).toMatchObject({
      status: "paused",
      controlRequested: null,
    });
    expect(world.store.spending(created.campaign.id).settledMicros).toBe(23);
    expect(operations).toBe(1);
  });

  it("cancels further dispatch while retaining a charge that arrives after cancellation", async () => {
    const entered = deferred<CampaignExecutionContext>();
    const release = deferred<void>();
    let operations = 0;
    const world = await environment({
      execute: async (context) => {
        operations += 1;
        const operation = reserve(context);
        entered.resolve(context);
        await release.promise;
        context.store.settle(
          operation.id,
          { ...operation.receipt, state: "reported", costMicros: 37, recordedAt: Date.now() },
          context.lease,
        );
        return emptyResult();
      },
    });
    cleanups.push(async () => release.resolve());
    const created = await world.service.create(createRequest());
    await start(world.service, created.campaign.id);
    const context = await entered.promise;
    await command(world.service, created.campaign.id, { type: "cancel", reason: "Stop" });
    expect(context.signal.aborted).toBe(true);
    release.resolve();
    await world.service.settled(created.campaign.id);
    expect(required(world.service, created.campaign.id).status).toBe("cancelled");
    expect(world.store.spending(created.campaign.id)).toMatchObject({
      settledMicros: 37,
      reservedMicros: 0,
    });
    expect(operations).toBe(1);
  });

  it("waits for an expired execution lease, recovers unknown effects, and never repeats dispatch", async () => {
    let calls = 0;
    let now = Date.now();
    const world = await environment(
      {
        execute: async () => {
          calls += 1;
          return emptyResult();
        },
      },
      () => now,
    );
    const created = await world.service.create(createRequest());
    const id = created.campaign.id;
    apply(world.store, id, { type: "start", reason: "Approved" }, now);
    const campaign = required(world.service, id);
    const attempt = attemptFor(campaign, now);
    apply(world.store, id, { type: "begin-attempt", attempt }, now);
    const lease = world.store.claim(id, "lost-controller", 1_000) as CampaignLease;
    const operation = world.store.reserve(
      {
        id: attempt.operationId,
        campaignId: id,
        attemptId: attempt.id,
        stage: "building",
        model: campaign.model,
        maximumMicros: 100,
        pricing: "fixture",
        pricingAt: now,
        request: { objective: "Refine" },
      },
      lease,
    );
    world.store.dispatch(operation.id, lease);
    const reopened = await CampaignStore.open(world.file, () => now);
    const recovered = world.makeService(reopened, "owner", () => true);
    cleanups.push(() => recovered.close());
    recovered.recover();
    expect(reopened.operation(operation.id)?.state).toBe("dispatched");
    now += 2_000;
    recovered.recover();
    expect(required(recovered, id)).toMatchObject({
      status: "waiting",
      waitingReason: "reconciliation",
    });
    expect(reopened.operation(operation.id)?.state).toBe("unknown");
    expect(reopened.spending(id).reservedMicros).toBe(100);
    expect(calls).toBe(0);
    const reconciled = await command(recovered, id, {
      type: "reconcile",
      operationId: operation.id,
      costMicros: 41,
      reference: "provider-receipt",
      reason: "Checked total",
    });
    expect(reconciled.campaign.status).toBe("paused");
    expect(reconciled.campaign.attempts[0]?.status).toBe("failed");
    expect(reopened.spending(id)).toMatchObject({ settledMicros: 41, reservedMicros: 0 });
    expect(calls).toBe(0);
  });

  it("keeps owner scope and trusted authority outside request data", async () => {
    const world = await environment();
    const created = await world.service.create(createRequest());
    const outsider = world.makeService(world.store, "someone-else", () => true);
    expect(outsider.list().campaigns).toEqual([]);
    expect(outsider.read(created.campaign.id)).toBeUndefined();
    expect(() => outsider.events(created.campaign.id, 0)).toThrow(/accessible/);
    await expect(
      outsider.command(created.campaign.id, {
        expectedRevision: created.campaign.revision,
        command: { type: "start" },
      }),
    ).rejects.toThrow(/accessible/);
    const untrusted = world.makeService(world.store, "owner", () => false);
    await expect(untrusted.create(createRequest())).rejects.toThrow(/trusted/);
    await expect(
      untrusted.artifact(created.campaign.id, created.campaign.baselineArtifactId ?? ""),
    ).rejects.toThrow(/trusted/);
    await expect(
      command(world.service, created.campaign.id, {
        type: "record-usage",
        actor: { role: "controller" },
      }),
    ).rejects.toThrow(/unsupported/);
    await expect(
      world.service.command(created.campaign.id, {
        expectedRevision: created.campaign.revision,
        actor: { role: "controller" },
        command: { type: "start" },
      }),
    ).rejects.toThrow();
  });

  it("rejects a stale start after asynchronous admission without dispatching the old purpose", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const world = await environment({
      preflight: async () => {
        entered.resolve();
        await release.promise;
        return bound;
      },
      execute: async () => {
        calls += 1;
        return emptyResult();
      },
    });
    const created = await world.service.create(createRequest());
    const starting = start(world.service, created.campaign.id);
    await entered.promise;
    await command(world.service, created.campaign.id, {
      type: "redirect",
      objective: "A revised outcome",
      reason: "New information",
    });
    release.resolve();
    await expect(starting).rejects.toThrow(/changed|stale|revision/);
    expect(calls).toBe(0);
    expect(required(world.service, created.campaign.id).purposes.at(-1)?.outcome).toBe(
      "A revised outcome",
    );
  });

  it("captures a workspace-relative source without changing the source file", async () => {
    const world = await environment();
    await writeFile(join(world.root, "source.md"), "Original source");
    const created = await world.service.create({ ...createRequest(), artifactPath: "source.md" });
    expect(
      (await world.service.artifact(created.campaign.id, created.campaign.baselineArtifactId ?? ""))
        .content,
    ).toBe("Original source");
  });

  it.each([false, true])(
    "replans model steering during controller preflight with unaffordable=%s",
    async (unaffordable) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const admitted: string[] = [];
      const executed: CampaignExecutionContext[] = [];
      const world = await environment({
        preflight: async (campaign) => {
          admitted.push(campaign.model.modelId);
          if (admitted.length === 2) {
            entered.resolve();
            await release.promise;
          }
          return {
            ...bound,
            maximumCostMicros:
              campaign.model.modelId === "replacement" && unaffordable
                ? 2_000_000
                : bound.maximumCostMicros,
          };
        },
        execute: async (context) => {
          executed.push(context);
          return emptyResult();
        },
      });
      cleanups.push(async () => release.resolve());
      const created = await world.service.create(createRequest());
      await start(world.service, created.campaign.id);
      await entered.promise;
      await command(world.service, created.campaign.id, {
        type: "select-model",
        model: { provider: "fixture", model: "replacement" },
        reason: "Use the revised model choice",
      });
      release.resolve();
      await world.service.settled(created.campaign.id);
      expect(admitted.slice(0, 3)).toEqual(["fixture", "fixture", "replacement"]);
      const final = required(world.service, created.campaign.id);
      if (unaffordable) {
        expect(executed).toEqual([]);
        expect(final.attempts).toEqual([]);
        expect(final.status).toBe("completed");
        expect(final.statusReason).toContain("cannot preserve evaluation and delivery capacity");
      } else {
        expect(executed.length).toBeGreaterThan(0);
        expect(
          executed.every(
            ({ campaign, attempt }) =>
              campaign.model.modelId === "replacement" && attempt.model?.modelId === "replacement",
          ),
        ).toBe(true);
        expect(final.attempts.every((attempt) => attempt.model?.modelId === "replacement")).toBe(
          true,
        );
      }
      expect(world.notices).toEqual([]);
    },
  );

  it("rolls back every review observation when alternate adoption is refused for a terminal campaign", async () => {
    const world = await environment();
    const created = await world.service.create(createRequest());
    const artifact = await world.artifacts.write({
      files: { "report.md": "An alternate report" },
      ownerScope: "owner",
      kind: "report",
      title: "Alternate",
      parentIds: [created.campaign.baselineArtifactId ?? ""],
      producerAttemptId: null,
    });
    apply(world.store, created.campaign.id, { type: "record-artifact", artifact }, Date.now());
    await command(world.service, created.campaign.id, {
      type: "finish",
      reason: "Delivered baseline",
    });
    const before = world.service.read(created.campaign.id);
    await expect(
      command(world.service, created.campaign.id, {
        type: "review-artifact",
        artifactId: artifact.id,
        attested: true,
        adopt: true,
        reason: "Inspected alternate",
        observations: [
          {
            criterionId: "criterion-1",
            verdict: "pass",
            summary: "Every claim has checked support",
          },
        ],
      }),
    ).rejects.toThrow();
    expect(world.service.read(created.campaign.id)).toEqual(before);
    expect(world.store.events(created.campaign.id, before?.sequence ?? 0)).toEqual([]);
  });

  it("builds a current uncertainty handoff when the user finishes before automatic completion", async () => {
    const world = await environment();
    const created = await world.service.create(createRequest());
    const id = created.campaign.id;
    const artifactId = created.campaign.baselineArtifactId;
    if (artifactId === null) throw new Error("Missing baseline fixture");
    const unresolved = "A human must confirm the source permission before publication.";
    apply(
      world.store,
      id,
      {
        type: "record-evidence",
        evidence: {
          id: randomUUID(),
          artifactId,
          purposeRevision: created.campaign.purposeRevision,
          criterionIds: [],
          kind: "claim",
          verdict: "uncertain",
          summary: unresolved,
          sourceRefs: ["session:worker-fixture"],
          methodId: "worker-handoff",
          methodVersion: "1",
          observedAt: Date.now(),
          producer: { id: "worker-fixture", role: "worker" },
        },
      },
      Date.now(),
    );
    expect(required(world.service, id).handoff).toBeNull();
    const finished = await command(world.service, id, { type: "finish", reason: "Inspect now" });
    expect(finished.campaign).toMatchObject({ status: "completed", verification: "unverified" });
    expect(finished.campaign.handoff).toMatchObject({
      summary: "Inspect now",
      currentBestArtifactId: artifactId,
      unresolved: expect.arrayContaining([unresolved, "Evidence supports each claim"]),
    });
    expect(finished.campaign.attempts).toEqual([]);
  });
});

const bound = { maximumCostMicros: 100, maximumDurationMs: 1 };

async function environment(executor: Partial<CampaignExecutor> = {}, now = Date.now) {
  const root = await mkdtemp(join(tmpdir(), "keywork-campaign-service-"));
  const file = join(root, "campaigns.db");
  const store = await CampaignStore.open(file, now);
  const artifacts = new CampaignArtifacts(join(root, "artifacts"));
  const notices: string[] = [];
  const makeService = (storage: CampaignStore, ownerScope: string, trusted: () => boolean) =>
    new CampaignService({
      store: storage,
      artifacts,
      workspace: root,
      ownerScope,
      trusted,
      now,
      notice: (message) => notices.push(message),
      executor: { preflight: async () => bound, execute: async () => emptyResult(), ...executor },
    });
  const service = makeService(store, "owner", () => true);
  cleanups.push(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, file, store, service, artifacts, notices, makeService };
}

function createRequest(profile = "focused") {
  return {
    title: "Refine a report",
    workload: "research-refinement",
    objective: "A supported, useful report",
    criteria: ["Evidence supports each claim"],
    references: [],
    model: { provider: "fixture", model: "fixture" },
    budgetMicros: 1_000_000,
    persistenceProfile: profile,
    text: "Original brief",
  };
}

async function start(service: CampaignService, id: string) {
  return command(service, id, { type: "start", reason: "Approved execution" });
}

async function command(service: CampaignService, id: string, value: Record<string, unknown>) {
  return service.command(id, { expectedRevision: required(service, id).revision, command: value });
}

function required(service: CampaignService, id: string): Campaign {
  const snapshot = service.read(id);
  if (snapshot === undefined) throw new Error("Missing test campaign");
  return snapshot.campaign;
}

function reserve(context: CampaignExecutionContext) {
  const operation = context.store.reserve(
    {
      id: context.attempt.operationId,
      campaignId: context.campaign.id,
      attemptId: context.attempt.id,
      stage: context.attempt.probe ? "probe" : "building",
      model: context.attempt.model,
      maximumMicros: 100,
      pricing: "fixture",
      pricingAt: Date.now(),
      request: { objective: "Refine" },
    },
    context.lease,
  );
  context.store.dispatch(operation.id, context.lease);
  return operation;
}

function charge(context: CampaignExecutionContext, costMicros: number): void {
  const operation = reserve(context);
  context.store.settle(
    operation.id,
    { ...operation.receipt, state: "reported", costMicros, recordedAt: Date.now() },
    context.lease,
  );
}

function emptyResult(): CampaignExecutionResult {
  return {
    artifact: null,
    evidence: [],
    evaluation: null,
    finishProposed: true,
    summary: "No useful change found",
  };
}

async function improved(
  context: CampaignExecutionContext,
  artifacts: CampaignArtifacts,
): Promise<CampaignExecutionResult> {
  const artifact = await artifacts.write({
    files: { "report.md": "Checked improvement" },
    ownerScope: context.campaign.ownerScope,
    title: "Improved report",
    kind: "report",
    parentIds: context.attempt.parentArtifactId === null ? [] : [context.attempt.parentArtifactId],
    producerAttemptId: context.attempt.id,
  });
  const evidence: EvidenceItem = {
    id: randomUUID(),
    artifactId: artifact.id,
    purposeRevision: context.campaign.purposeRevision,
    criterionIds: ["criterion-1"],
    kind: "observation",
    verdict: "pass",
    summary: "The claim is supported by the source",
    sourceRefs: ["source:verified"],
    methodId: "independent-review",
    methodVersion: "1",
    observedAt: Date.now(),
    producer: { id: "reviewer", role: "controller" },
  };
  const evaluation: Evaluation = {
    id: randomUUID(),
    artifactId: artifact.id,
    comparedToArtifactId: context.campaign.currentBestArtifactId,
    purposeRevision: context.campaign.purposeRevision,
    observations: [
      {
        criterionId: "criterion-1",
        verdict: "pass",
        evidenceIds: [evidence.id],
        summary: "The claim is supported",
      },
    ],
    materialImprovement: true,
    summary: "A useful improvement was verified",
    evaluator: { id: "reviewer", role: "controller" },
    model: null,
    createdAt: Date.now(),
  };
  return {
    artifact,
    evidence: [evidence],
    evaluation,
    finishProposed: true,
    summary: "Improvement found",
  };
}

function apply(store: CampaignStore, id: string, body: CommandBody, at: number): void {
  const campaign = store.read(id);
  if (campaign === undefined) throw new Error("Missing test campaign");
  store.apply(
    id,
    { ...body, id: randomUUID(), expectedRevision: campaign.revision, at },
    { id: "owner", role: "controller" },
  );
}

function attemptFor(campaign: Campaign, at: number): Attempt {
  return {
    id: randomUUID(),
    operationId: randomUUID(),
    purposeRevision: campaign.purposeRevision,
    parentArtifactId: campaign.currentBestArtifactId,
    branch: "main",
    hypothesis: "Refine",
    method: "Review",
    expectedBenefit: "Supported claims",
    model: campaign.model,
    probe: false,
    status: "running",
    startedAt: at,
    finishedAt: null,
    candidateArtifactId: null,
    failure: null,
  };
}

function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((answer) => {
    resolve = answer;
  });
  return { promise, resolve };
}
