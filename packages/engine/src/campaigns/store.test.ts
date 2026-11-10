import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateCampaignInput, UsageReceipt } from "@keywork/campaigns";
import { afterEach, describe, expect, it } from "vitest";
import { type CampaignLease, type CampaignOperationIntent, CampaignStore } from "./store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

describe("campaign durability and budget admission", () => {
  it("reopens the same projection and ordered event cursor, rejecting stale commands", async () => {
    const { store, file } = await world();
    start(store);
    const second = await CampaignStore.open(file);
    cleanups.push(async () => second.close());
    expect(second.snapshot("campaign")).toEqual(store.snapshot("campaign"));
    expect(() =>
      second.apply(
        "campaign",
        { id: "stale", expectedRevision: 0, at: 10, type: "pause", reason: "pause" },
        user,
      ),
    ).toThrow();
    expect(second.events("campaign", 1).map((event) => event.sequence)).toEqual([2, 3]);
    expect(second.events("campaign", 3)).toEqual([]);
  });

  it("reserves shared funds atomically and keeps review and delivery capacity", async () => {
    const { store, lease, file, clock } = await running();
    store.reserve(intent("one", 600), lease);
    const second = await CampaignStore.open(file, clock);
    cleanups.push(async () => second.close());
    expect(() => second.reserve(intent("two", 101), lease)).toThrow(/budget/);
    expect(store.operations("campaign")).toHaveLength(1);
    expect(store.spending("campaign").remainingMicros).toBe(400);
    expect(store.reserve(intent("review", 200, "evaluating"), lease).state).toBe("reserved");
    expect(() => store.reserve(intent("review-too-much", 101, "evaluating"), lease)).toThrow(
      /budget/,
    );
  });

  it("deduplicates operation identities and rejects parameter changes", async () => {
    const { store, lease } = await running();
    const first = store.reserve(intent("one", 100), lease);
    const sequence = store.snapshot("campaign")?.sequence;
    expect(store.reserve(intent("one", 100), lease)).toEqual(first);
    expect(store.snapshot("campaign")?.sequence).toBe(sequence);
    expect(() => store.reserve(intent("one", 101), lease)).toThrow(/reused/);
  });

  it("fences an expired owner even after it tries to release a new owner's lease", async () => {
    const { store, lease, advance } = await running();
    advance(2000);
    const next = store.claim("campaign", "next", 1000);
    expect(next).toBeDefined();
    expect(() => store.reserve(intent("old", 100), lease)).toThrow(/lease/);
    store.release(lease);
    expect(store.reserve(intent("new", 100), next as CampaignLease).state).toBe("reserved");
  });

  it("keeps an unknown dispatched effect reserved after restart without replay", async () => {
    const { store, lease, file, advance, clock } = await running();
    store.reserve(intent("sent", 200), lease);
    store.dispatch("sent", lease);
    store.reserve(intent("not-sent", 100), lease);
    advance(2000);
    const restarted = await CampaignStore.open(file, clock);
    cleanups.push(async () => restarted.close());
    const recovery = restarted.claim("campaign", "recovery", 1000) as CampaignLease;
    restarted.recover(recovery);
    expect(restarted.operation("sent")?.state).toBe("unknown");
    expect(restarted.operation("not-sent")?.state).toBe("released");
    expect(restarted.read("campaign")?.waitingReason).toBe("reconciliation");
    expect(restarted.spending("campaign")).toMatchObject({
      reservedMicros: 200,
      unresolvedOperations: 1,
    });
    expect(() => restarted.dispatch("sent", recovery)).toThrow();
  });

  it("does not turn an estimate into released spending capacity", async () => {
    const { store, lease } = await running();
    const operation = store.reserve(intent("call", 200), lease);
    store.dispatch("call", lease);
    store.settle(
      "call",
      { ...operation.receipt, state: "estimated", costMicros: 40, recordedAt: 5 },
      lease,
    );
    expect(store.spending("campaign")).toMatchObject({
      estimatedMicros: 40,
      reservedMicros: 200,
      remainingMicros: 800,
    });
  });

  it("deduplicates settled receipts and retains incurred charges after cancellation", async () => {
    const { store, lease } = await running();
    const operation = store.reserve(intent("call", 200), lease);
    store.dispatch("call", lease);
    const receipt: UsageReceipt = {
      ...operation.receipt,
      state: "reported",
      costMicros: 70,
      recordedAt: 5,
    };
    store.settle("call", receipt, lease);
    store.settle("call", receipt, lease);
    const snapshot = store.read("campaign");
    store.apply(
      "campaign",
      {
        id: "cancel",
        expectedRevision: snapshot?.revision ?? 0,
        at: 6,
        type: "cancel",
        reason: "user cancelled",
      },
      user,
    );
    expect(store.spending("campaign").settledMicros).toBe(70);
    expect(store.read("campaign")?.usage).toHaveLength(1);
  });

  it("checks cancellation again after reservation and before dispatch", async () => {
    const { store, lease } = await running();
    store.reserve(intent("call", 200), lease);
    store.apply(
      "campaign",
      {
        id: "cancel",
        expectedRevision: store.read("campaign")?.revision ?? 0,
        at: 8,
        type: "cancel",
        reason: "stop",
      },
      user,
    );
    expect(() => store.dispatch("call", lease)).toThrow(/dispatch stopped/);
    store.releaseReservation("call", lease);
    expect(store.spending("campaign").reservedMicros).toBe(0);
  });

  it("commits before notifying and isolates observer failures", async () => {
    const { store } = await world();
    const observed: number[] = [];
    store.subscribe(() => {
      throw new Error("closed client");
    });
    store.subscribe((event) => observed.push(store.snapshot(event.campaignId)?.sequence ?? 0));
    start(store);
    expect(observed).toEqual([2, 3]);
  });
});

const user = { id: "keeper", role: "user" } as const;
const model = { providerId: "test", modelId: "fixture", connectionId: null, effort: null };

function input(): CreateCampaignInput {
  return {
    id: "campaign",
    ownerScope: "workspace",
    title: "Research",
    workload: "research-refinement",
    createdAt: 1,
    model,
    purpose: {
      revision: 1,
      outcome: "Answer a research question",
      audience: "keeper",
      scope: [],
      references: [],
      criteria: [{ id: "correct", description: "Claims are supported", critical: true }],
      invariants: [],
      sufficientDelivery: "A supported report",
      createdAt: 1,
    },
    budget: {
      currency: "USD",
      limitMicros: 1000,
      evaluationReserveMicros: 200,
      deliveryReserveMicros: 100,
    },
    persistence: { profile: "deep", probeLimit: 12, spendLimitMicros: 500, timeLimitMs: 60_000 },
    baseline: null,
  };
}

async function world() {
  const root = await mkdtemp(join(tmpdir(), "keywork-campaign-"));
  const file = join(root, "campaigns.db");
  let at = 1;
  const clock = () => at;
  const store = await CampaignStore.open(file, clock);
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.create(input());
  return {
    store,
    file,
    clock,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

async function running() {
  const environment = await world();
  start(environment.store);
  const lease = environment.store.claim("campaign", "runner", 1000) as CampaignLease;
  return { ...environment, lease };
}

function start(store: CampaignStore): void {
  store.apply(
    "campaign",
    { id: "ready", expectedRevision: 0, at: 2, type: "ready", reason: "configured" },
    user,
  );
  store.apply(
    "campaign",
    { id: "start", expectedRevision: 1, at: 3, type: "start", reason: "start" },
    user,
  );
}

function intent(
  id: string,
  maximumMicros: number,
  stage: CampaignOperationIntent["stage"] = "building",
): CampaignOperationIntent {
  return {
    id,
    campaignId: "campaign",
    attemptId: null,
    stage,
    model,
    maximumMicros,
    pricing: "fixture",
    pricingAt: 1,
    request: { purpose: "research" },
  };
}
