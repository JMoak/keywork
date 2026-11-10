import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Achievement,
  type Campaign,
  createCampaign,
  type UsageReceipt,
} from "@keywork/engine";
import { writeServerTicket } from "@keywork/server";
import { afterEach, describe, expect, it } from "vitest";
import { type CampaignCommandOptions, campaignCommand } from "./campaign-command.ts";
import { dispatchCommand } from "./dispatch.ts";
import { workspaceIdentity } from "./paths.ts";
import { serverTicketFile, workspaceTicketFile } from "./serve.ts";

interface CapturedRequest {
  path: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("headless campaign commands", () => {
  it("dispatches without a terminal and creates without sending start", async () => {
    expect(dispatchCommand(["campaign", "list"], false)).toMatchObject({
      kind: "command",
      command: "campaign",
    });
    const fixture = await setup(() =>
      Response.json({ campaign: { id: "created", status: "ready" }, sequence: 1 }, { status: 201 }),
    );
    await fixture.file("create.json", createBody());
    expect(await fixture.run(["create"], { file: "create.json" })).toBe(0);
    expect(fixture.requests.filter((request) => request.method === "POST")).toMatchObject([
      { path: "/campaigns", body: createBody(), authorization: "Bearer fixture-secret" },
    ]);
    expect(fixture.requests.some((request) => request.path.includes("commands"))).toBe(false);
    expect(fixture.out.join("")).toContain("ready");
  });

  it("rejects malformed JSON and implicit revisions before contacting the runtime", async () => {
    const fixture = await setup(() => Response.json({}));
    await writeFile(join(fixture.root, "bad.json"), "{");
    expect(await fixture.run(["create"], { file: "bad.json" })).toBe(2);
    await fixture.file("missing.json", { command: { type: "start", reason: "start" } });
    expect(await fixture.run(["command", "campaign"], { file: "missing.json" })).toBe(2);
    expect(await fixture.run(["watch", "campaign"], { after: "-1" })).toBe(2);
    expect(fixture.requests).toHaveLength(0);
  });

  it("submits the exact explicit revision once and surfaces conflicts without retry", async () => {
    const fixture = await setup(() =>
      Response.json({ error: "campaign changed" }, { status: 409 }),
    );
    const body = { expectedRevision: 7, command: { type: "pause", reason: "review" } };
    await fixture.file("pause.json", body);
    expect(await fixture.run(["command", "campaign"], { file: "pause.json" })).toBe(3);
    expect(fixture.requests.filter((request) => request.method === "POST")).toMatchObject([
      { path: "/campaigns/campaign/commands", body },
    ]);
    expect(fixture.err.join("\n")).toContain("current revision");
  });

  it("surfaces authentication refusal and redacts the runtime token", async () => {
    const fixture = await setup(() =>
      Response.json({ error: "token fixture-secret refused" }, { status: 401 }),
    );
    expect(await fixture.run(["list"])).toBe(4);
    expect(fixture.err.join("\n")).toContain("401");
    expect(fixture.err.join("\n")).not.toContain("fixture-secret");
  });

  it("refuses a foreign fallback runtime before sending its authentication token", async () => {
    const fixture = await setup(() => Response.json({ campaigns: [] }), "other-workspace");
    expect(await fixture.run(["list"])).toBe(1);
    expect(
      fixture.requests.every(
        (request) => request.path === "/doc" && request.authorization === undefined,
      ),
    ).toBe(true);
    expect(fixture.err.join("\n")).toContain("another workspace");
  });

  it("exports through the owning runtime and resolves its destination against the workspace", async () => {
    const fixture = await setup(() => Response.json({ artifactId: "artifact", path: "exported" }));
    expect(await fixture.run(["export", "campaign", "artifact", "review-copy"])).toBe(0);
    expect(fixture.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/campaigns/campaign/artifacts/artifact/export",
      body: { destination: join(fixture.root, "review-copy") },
    });
  });

  it("prints durable activity, conservative costs, and verified achievements from SSE", async () => {
    const campaign = runningFixture();
    campaign.usage = [
      {
        ...fixtureReceipt(campaign, "attempt"),
        attemptId: null,
        state: "reported",
        costMicros: 1234,
      },
    ];
    campaign.achievements = [
      {
        ...fixtureAchievement(campaign, "baseline"),
        title: "Supported findings",
        status: "verified",
      },
    ];
    const event = {
      schemaVersion: 1,
      id: "event",
      campaignId: campaign.id,
      sequence: 4,
      commandId: "usage",
      kind: "usage.settled",
      at: 1000,
      actor: { id: "ledger", role: "controller" },
      summary: "Usage accounted",
      refs: [],
    };
    const fixture = await setup((request) =>
      request.path.includes("/events?")
        ? new Response(
            `id: 4\nevent: campaign\ndata: ${JSON.stringify(event)}\n\nid: 4\nevent: snapshot\ndata: ${JSON.stringify({ campaign, sequence: 4 })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        : Response.json({ campaign, sequence: 4 }),
    );
    expect(await fixture.run(["watch", campaign.id], { after: "3" })).toBe(3);
    expect(fixture.out.join("\n")).toContain("4 usage.settled: Usage accounted");
    expect(fixture.out.join("\n")).toContain("cost=$0.001234");
    expect(fixture.out.join("\n")).toContain("verified: Supported findings");
    expect(fixture.err.join("\n")).toContain("--after 4");
    expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("prints JSON watch records and completes a terminal snapshot", async () => {
    const campaign = { ...runningFixture(), status: "completed" };
    const fixture = await setup(
      () =>
        new Response(`event: snapshot\ndata: ${JSON.stringify({ campaign, sequence: 8 })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    expect(await fixture.run(["watch", campaign.id], { json: true })).toBe(0);
    expect(JSON.parse(fixture.out[0] ?? "{}")).toMatchObject({
      type: "snapshot",
      sequence: 8,
      campaign: { status: "completed" },
    });
  });

  it("treats an unreadable mutation response as unknown instead of successful", async () => {
    const fixture = await setup(() => new Response("truncated", { status: 200 }));
    await fixture.file("command.json", {
      expectedRevision: 1,
      command: { type: "start", reason: "start" },
    });
    expect(await fixture.run(["command", "campaign"], { file: "command.json" })).toBe(3);
    expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(fixture.err.join("\n")).toContain("before retrying");
  });
});

async function setup(handle: (request: CapturedRequest) => Response, scopeIdentity?: string) {
  const root = await mkdtemp(join(tmpdir(), "keywork-campaign-cli-"));
  const requests: CapturedRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const request = {
      path: incoming.url ?? "",
      method: incoming.method ?? "GET",
      authorization: incoming.headers.authorization,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
    requests.push(request);
    const response =
      request.path === "/doc"
        ? Response.json({
            info: {
              title: "keywork",
              workspace: { identity: scopeIdentity ?? workspaceIdentity(root) },
            },
          })
        : handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  const ticket = { url: `http://127.0.0.1:${address.port}`, token: "fixture-secret" };
  writeServerTicket(
    scopeIdentity === undefined
      ? workspaceTicketFile(root, undefined, root)
      : serverTicketFile(root),
    ticket,
  );
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    out,
    err,
    requests,
    file: (name: string, body: unknown) => writeFile(join(root, name), JSON.stringify(body)),
    run: (args: string[], options: Partial<CampaignCommandOptions> = {}) =>
      campaignCommand(
        args,
        { cwd: root, userRoot: root, ...options },
        { print: (line) => out.push(line), printError: (line) => err.push(line) },
      ),
  };
}

function createBody() {
  return {
    title: "Refine report",
    workload: "research-refinement",
    objective: "Improve supported conclusions",
    criteria: ["Claims retain evidence"],
    references: [],
    model: { provider: "openrouter", model: "openai/gpt-6.1-sol" },
    budgetMicros: 1_000_000,
    persistenceProfile: "persistent",
    text: "Baseline report",
  };
}

function runningFixture(): Campaign {
  return {
    ...createCampaign({
      id: "campaign",
      ownerScope: "workspace",
      title: "Report",
      workload: "project-development",
      createdAt: 1000,
      model: {
        providerId: "openrouter",
        modelId: "openai/gpt-6.1-sol",
        connectionId: null,
        effort: null,
      },
      purpose: {
        revision: 1,
        outcome: "Supported report",
        audience: "keeper",
        scope: [],
        references: [],
        criteria: [{ id: "correct", description: "Supported claims", critical: true }],
        invariants: [],
        sufficientDelivery: "Supported report",
        createdAt: 1000,
      },
      budget: {
        currency: "USD",
        limitMicros: 1_000_000,
        evaluationReserveMicros: 100_000,
        deliveryReserveMicros: 100_000,
      },
      persistence: {
        profile: "persistent",
        probeLimit: 8,
        spendLimitMicros: 100_000,
        timeLimitMs: 60_000,
      },
      baseline: null,
    }),
    status: "running",
  };
}

function fixtureReceipt(campaign: Campaign, attemptId: string): UsageReceipt {
  return {
    id: "usage",
    operationId: "operation",
    attemptId,
    providerRequestId: "request",
    stage: "building",
    model: campaign.model,
    currency: "USD",
    reservedMicros: 2000,
    costMicros: 1000,
    state: "reported",
    costSource: "fixture",
    pricingAt: 1000,
    recordedAt: 1000,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
  };
}

function fixtureAchievement(campaign: Campaign, artifactId: string): Achievement {
  return {
    id: "achievement",
    criterionId: "correct",
    artifactId,
    purposeRevision: campaign.purposeRevision,
    title: "Supported claims",
    summary: "Verified fixture",
    evidenceIds: [],
    status: "claimed",
    verifiedBy: null,
    adoptedAt: null,
    history: [],
  };
}
