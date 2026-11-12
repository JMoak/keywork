import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CampaignArtifacts,
  CampaignPricingError,
  CampaignService,
  type CampaignSnapshot,
  CampaignStore,
  MockProvider,
} from "@keywork/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "./events.ts";
import { createKeyworkServer } from "./server.ts";
import { memorySessionHost, type SseReader, sseReader } from "./testing.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("campaign HTTP and SSE integration", () => {
  it("authenticates campaign endpoints and reports unavailable hosts explicitly", async () => {
    const world = await harness();
    for (const path of [
      "/campaigns",
      "/campaigns/missing",
      "/campaigns/missing/events",
      "/campaigns/missing/artifacts/one",
    ])
      expect((await world.server.fetch(new Request(`http://test${path}`))).status).toBe(401);
    const log = new EventLog();
    const unavailable = createKeyworkServer({
      token,
      log,
      version: "test",
      host: memorySessionHost({ log, provider: new MockProvider([]) }),
    });
    cleanups.push(() => unavailable.close());
    expect(
      (
        await unavailable.fetch(
          new Request("http://test/campaigns", { headers: { authorization: `Bearer ${token}` } }),
        )
      ).status,
    ).toBe(501);
  });

  it.each(["app-improvement", "project-development", "research-refinement"])(
    "creates %s without dispatch and keeps a durable cursor, stale-revision checks, and inert previews",
    async (workload) => {
      const world = await harness();
      const response = await world.call("/campaigns", post(createRequest(workload)));
      expect(response.status).toBe(201);
      const created = (await response.json()) as CampaignSnapshot;
      expect(created.sequence).toBeGreaterThan(created.campaign.revision);
      expect(created.campaign.status).toBe("ready");
      expect(world.executions()).toBe(0);
      const listed = await (await world.call("/campaigns")).json();
      expect(listed).toMatchObject({
        campaigns: [
          { id: created.campaign.id, settledMicros: 0, pendingMicros: 0, latestAchievement: null },
        ],
      });
      const stale = await world.call(
        `/campaigns/${created.campaign.id}/commands`,
        post({ expectedRevision: 0, command: { type: "start" } }),
      );
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "conflict" });
      const preview = await world.call(
        `/campaigns/${created.campaign.id}/artifacts/${created.campaign.baselineArtifactId}`,
      );
      expect(preview.headers.get("content-type")).toContain("application/json");
      expect(await preview.json()).toMatchObject({
        content: "<script>notExecutable()</script>",
        truncated: false,
      });
      expect(
        (
          await world.call(
            `/campaigns/${created.campaign.id}/artifacts/${created.campaign.baselineArtifactId}?path=..%2Fsecret`,
          )
        ).status,
      ).not.toBe(200);
      expect(world.executions()).toBe(0);
    },
  );

  it("replays durable events then snapshots, streams later decisions once, and resumes from the cursor", async () => {
    const world = await harness();
    const created = (await (
      await world.call("/campaigns", post(createRequest()))
    ).json()) as CampaignSnapshot;
    const response = await world.call(`/campaigns/${created.campaign.id}/events`, {
      headers: { "last-event-id": "1" },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = sseReader(response);
    cleanups.push(() => reader.close());
    const replay = await throughSnapshot(reader);
    expect(replay.events.map((event) => event.sequence)).toEqual([created.sequence]);
    expect(replay.snapshot).toEqual(created);
    const changedResponse = await world.call(
      `/campaigns/${created.campaign.id}/commands`,
      post({
        expectedRevision: created.campaign.revision,
        command: { type: "redirect", objective: "A revised outcome", reason: "New evidence" },
      }),
    );
    expect(changedResponse.status).toBe(200);
    const changed = (await changedResponse.json()) as CampaignSnapshot;
    const live = await reader.next();
    expect(live.event).toBe("campaign");
    expect(JSON.parse(live.data)).toMatchObject({
      campaignId: created.campaign.id,
      sequence: changed.sequence,
    });
    await reader.close();
    const resumed = sseReader(
      await world.call(`/campaigns/${created.campaign.id}/events`, {
        headers: { "last-event-id": String(created.sequence) },
      }),
    );
    cleanups.push(() => resumed.close());
    const later = await throughSnapshot(resumed);
    expect(later.events.map((event) => event.sequence)).toEqual([changed.sequence]);
    expect(later.snapshot.campaign.purposes.at(-1)?.outcome).toBe("A revised outcome");
    expect(world.executions()).toBe(0);
    await world.server.close();
    await expect(resumed.next()).rejects.toThrow(/ended/);
  });

  it("replays a long history through its snapshot and releases the stream on cancellation", async () => {
    const world = await harness();
    let current = await world.service.create(createRequest());
    for (let index = 0; index < 140; index += 1)
      current = await world.service.command(current.campaign.id, {
        expectedRevision: current.campaign.revision,
        command: { type: "select-model", model: { provider: "fixture", model: "fixture" } },
      });
    vi.useFakeTimers();
    const reader = sseReader(await world.call(`/campaigns/${current.campaign.id}/events`));
    cleanups.push(() => reader.close());
    const replay = await throughSnapshot(reader);
    expect(replay.events).toHaveLength(142);
    expect(replay.snapshot).toEqual(current);
    expect(vi.getTimerCount()).toBe(1);
    await reader.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up a slow campaign stream when its bounded queue closes", async () => {
    const world = await harness();
    let current = await world.service.create(createRequest());
    const subscribed = world.service.subscribe.bind(world.service);
    const released = vi.fn();
    vi.spyOn(world.service, "subscribe").mockImplementation((id, listener) => {
      const unsubscribe = subscribed(id, listener);
      return () => {
        unsubscribe();
        released();
      };
    });
    vi.useFakeTimers();
    const response = await world.call(`/campaigns/${current.campaign.id}/events`);
    expect(vi.getTimerCount()).toBe(1);
    for (let index = 0; index < 140; index += 1)
      current = await world.service.command(current.campaign.id, {
        expectedRevision: current.campaign.revision,
        command: { type: "select-model", model: { provider: "fixture", model: "fixture" } },
      });
    expect(released).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await response.text();
    await world.server.close();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed cursors and actor injection instead of treating the request as authority", async () => {
    const world = await harness();
    const created = (await (
      await world.call("/campaigns", post(createRequest()))
    ).json()) as CampaignSnapshot;
    for (const cursor of ["-1", "1.5", "9007199254740992"])
      expect(
        (await world.call(`/campaigns/${created.campaign.id}/events?after=${cursor}`)).status,
      ).toBe(400);
    expect(
      (
        await world.call(
          `/campaigns/${created.campaign.id}/commands`,
          post({
            expectedRevision: created.campaign.revision,
            actor: { role: "controller" },
            command: { type: "start" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await world.call(
          `/campaigns/${created.campaign.id}/commands`,
          post({
            expectedRevision: created.campaign.revision,
            command: { type: "record-usage", receipt: {} },
          }),
        )
      ).status,
    ).toBe(422);
    expect(world.executions()).toBe(0);
  });

  it("refuses to start a model campaigns can't admit with a 422 and records nothing", async () => {
    const world = await harness({
      preflight: async () => {
        throw new CampaignPricingError("This model needs a verified admission contract");
      },
    });
    const created = await world.service.create(createRequest());
    const response = await world.call(
      `/campaigns/${created.campaign.id}/commands`,
      post({ expectedRevision: created.campaign.revision, command: { type: "start" } }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "unadmitted",
      error: "This model needs a verified admission contract",
    });
    expect(world.service.read(created.campaign.id)).toEqual(created);
    expect(world.executions()).toBe(0);
  });

  it("refuses untrusted writes before creating state", async () => {
    const world = await harness({ trusted: false });
    const response = await world.call("/campaigns", post(createRequest()));
    expect(response.status).toBe(403);
    expect(world.service.list().campaigns).toEqual([]);
    expect(world.executions()).toBe(0);
  });

  it("exports an immutable full version to a new confined directory and refuses overwrite or traversal", async () => {
    const world = await harness();
    const created = (await (
      await world.call("/campaigns", post(createRequest()))
    ).json()) as CampaignSnapshot;
    const path = `/campaigns/${created.campaign.id}/artifacts/${created.campaign.baselineArtifactId}/export`;
    const exported = await world.call(path, post({ destination: "exports/reviewed" }));
    expect(exported.status, await exported.clone().text()).toBe(200);
    expect(await exported.json()).toEqual({
      artifactId: created.campaign.baselineArtifactId,
      path: await realpath(join(world.root, "exports", "reviewed")),
    });
    expect(await readFile(join(world.root, "exports", "reviewed", "brief.md"), "utf8")).toBe(
      "<script>notExecutable()</script>",
    );
    expect((await world.call(path, post({ destination: "exports/reviewed" }))).status).toBe(422);
    expect((await world.call(path, post({ destination: "../outside" }))).status).toBe(422);
    expect(world.executions()).toBe(0);
    expect(world.service.read(created.campaign.id)?.campaign.currentBestArtifactId).toBe(
      created.campaign.baselineArtifactId,
    );
  });

  it.each(["content", "manifest"])(
    "reports a corrupt %s export as uncertain after a destination was created",
    async (corruption) => {
      const world = await harness();
      const created = await world.service.create(createRequest());
      const artifact = created.campaign.artifacts[0];
      if (artifact === undefined) throw new Error("Missing baseline fixture");
      await writeFile(
        join(
          world.root,
          "artifacts",
          artifact.storageRef,
          corruption === "content" ? "files/brief.md" : "manifest.json",
        ),
        corruption === "content" ? "damaged" : "{}",
      );
      const response = await world.call(
        `/campaigns/${created.campaign.id}/artifacts/${artifact.id}/export`,
        post({ destination: "exports/uncertain" }),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "unavailable" });
      expect((await stat(join(world.root, "exports", "uncertain"))).isDirectory()).toBe(true);
      expect(world.service.read(created.campaign.id)).toEqual(created);
      expect(world.executions()).toBe(0);
    },
  );

  it("requires attested human observations, verifies the current best, and records a later failed review without inference", async () => {
    const world = await harness();
    const created = (await (
      await world.call("/campaigns", post(createRequest()))
    ).json()) as CampaignSnapshot;
    const path = `/campaigns/${created.campaign.id}/commands`;
    const review = {
      type: "review-artifact",
      artifactId: created.campaign.baselineArtifactId,
      observations: [
        {
          criterionId: "criterion-1",
          verdict: "pass",
          summary: "I checked each claim against its cited source.",
        },
      ],
      reason: "Source inspection",
      adopt: false,
    };
    const refused = await world.call(
      path,
      post({ expectedRevision: created.campaign.revision, command: review }),
    );
    expect(refused.status).toBe(400);
    expect(world.service.read(created.campaign.id)).toEqual(created);
    const accepted = await world.call(
      path,
      post({ expectedRevision: created.campaign.revision, command: { ...review, attested: true } }),
    );
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const verified = (await accepted.json()) as CampaignSnapshot;
    expect(verified.campaign.verification).toBe("verified");
    expect(verified.campaign.evidence[0]).toMatchObject({
      kind: "human-review",
      producer: { id: "owner", role: "user" },
      verdict: "pass",
    });
    expect(verified.campaign.achievements[0]?.status).toBe("verified");
    const failed = await world.call(
      path,
      post({
        expectedRevision: verified.campaign.revision,
        command: {
          ...review,
          attested: true,
          observations: [
            {
              criterionId: "criterion-1",
              verdict: "fail",
              summary: "A source contradicts the main claim.",
            },
          ],
        },
      }),
    );
    expect(failed.status, await failed.clone().text()).toBe(200);
    const regressed = (await failed.json()) as CampaignSnapshot;
    expect(regressed.campaign.verification).toBe("failed");
    expect(regressed.campaign.achievements[0]?.status).toBe("regressed");
    expect(world.executions()).toBe(0);
  });
});

const token = "campaign-test-token-123456";

interface HarnessOptions {
  trusted?: boolean;
  preflight?: () => Promise<{ maximumCostMicros: number; maximumDurationMs: number }>;
}

async function harness({
  trusted = true,
  preflight = async () => ({ maximumCostMicros: 100, maximumDurationMs: 1 }),
}: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "keywork-campaign-http-"));
  const store = await CampaignStore.open(join(root, "campaigns.db"));
  let executions = 0;
  const service = new CampaignService({
    store,
    artifacts: new CampaignArtifacts(join(root, "artifacts")),
    workspace: root,
    ownerScope: "owner",
    trusted: () => trusted,
    executor: {
      preflight,
      execute: async () => {
        executions += 1;
        return {
          artifact: null,
          evidence: [],
          evaluation: null,
          finishProposed: true,
          summary: "No improvement",
        };
      },
    },
  });
  const log = new EventLog();
  const host = memorySessionHost({ log, provider: new MockProvider([]) });
  let closed = false;
  const server = createKeyworkServer({
    token,
    log,
    version: "test",
    host: {
      ...host,
      campaigns: service,
      close: async () => {
        if (closed) return;
        closed = true;
        await service.close();
        await host.close();
      },
    },
  });
  cleanups.push(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = (path: string, init: RequestInit = {}) =>
    server.fetch(
      new Request(`http://test${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
      }),
    );
  return { root, service, server, call, executions: () => executions };
}

function createRequest(workload = "research-refinement") {
  return {
    title: "A useful report",
    workload,
    objective: "Supported conclusions",
    criteria: ["Claims have evidence"],
    references: [],
    model: { provider: "fixture", model: "fixture" },
    budgetMicros: 1_000_000,
    persistenceProfile: "focused",
    text: "<script>notExecutable()</script>",
  };
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function throughSnapshot(reader: SseReader) {
  const events: { sequence: number }[] = [];
  for (let remaining = 1000; remaining > 0; remaining -= 1) {
    const frame = await reader.next();
    if (frame.event === "snapshot")
      return { events, snapshot: JSON.parse(frame.data) as CampaignSnapshot };
    if (frame.event === "campaign") events.push(JSON.parse(frame.data) as { sequence: number });
  }
  throw new Error("Campaign stream did not send a snapshot");
}
