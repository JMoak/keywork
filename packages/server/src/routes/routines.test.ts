import { MockProvider } from "@keywork/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  heldOnGrants,
  parkedRun,
  RoutineHarness,
  routineInput,
} from "../../../engine/src/routines/testing.ts";
import { fixtureDocument } from "../contract-fixtures.ts";
import { EventLog } from "../events.ts";
import { operationOf, routes } from "../openapi.ts";
import { memorySessionHost } from "../testing.ts";
import type { RouteHandler, RouteParams } from "./family.ts";
import { registerRoutineRoutes, routineHookRoutes, routineRoutes } from "./routines.ts";

const origin = "http://127.0.0.1:4770";

let harness: RoutineHarness;

beforeEach(async () => {
  harness = await RoutineHarness.create({ start: Date.parse("2026-11-05T08:00:00Z") });
  await harness.service.start();
});

afterEach(async () => {
  await harness.close();
});

function handlers(served = true) {
  const log = new EventLog();
  const base = memorySessionHost({ log, provider: new MockProvider([]) });
  const host = served ? { ...base, routines: harness.service } : base;
  return registerRoutineRoutes((context) => context.host.routines).handlers({
    host,
    log,
    streams: { add: () => () => undefined },
    describe: fixtureDocument,
  });
}

async function call(
  handler: RouteHandler,
  method: string,
  path: string,
  params: RouteParams = {},
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`${origin}${path}`, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    }),
    params,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const triage = { slug: "wren", id: "triage" };

describe("the routine routes", () => {
  it("answer 503 on a host that serves no chores", async () => {
    const h = handlers(false);
    expect((await call(h.listRoutines, "GET", "/creatures/wren/routines", triage)).status).toBe(
      503,
    );
    expect(
      (await call(h.putRoutine, "PUT", "/creatures/wren/routines/triage", triage, routineInput()))
        .status,
    ).toBe(503);
  });

  it("write a chore with PUT, read it back, list it and remove it", async () => {
    const h = handlers();
    const put = await call(
      h.putRoutine,
      "PUT",
      "/creatures/wren/routines/triage",
      triage,
      routineInput(),
    );
    expect(put.status).toBe(201);
    expect(put.body).toMatchObject({ created: true, routine: { id: "triage" } });
    expect(
      await call(h.readRoutine, "GET", "/creatures/wren/routines/triage", triage),
    ).toMatchObject({ status: 200, body: { routine: { id: "triage", creature: "wren" } } });
    expect(
      await call(h.listRoutines, "GET", "/creatures/wren/routines", { slug: "wren" }),
    ).toMatchObject({ status: 200, body: { routines: [{ id: "triage" }] } });
    expect(
      (await call(h.deleteRoutine, "DELETE", "/creatures/wren/routines/triage", triage)).status,
    ).toBe(200);
    expect(
      (await call(h.readRoutine, "GET", "/creatures/wren/routines/triage", triage)).status,
    ).toBe(404);
  });

  it("serve every chore that needs the keeper from one route, cleared by the accept", async () => {
    const h = handlers();
    expect(await call(h.listNeedsYou, "GET", "/routines/needs-you")).toEqual({
      status: 200,
      body: { items: [] },
    });
    await call(
      h.putRoutine,
      "PUT",
      "/creatures/wren/routines/triage",
      triage,
      routineInput(heldOnGrants),
    );
    const run = await call(h.runRoutine, "POST", "/creatures/wren/routines/triage/run", triage);
    expect(run.body).toMatchObject({ run: parkedRun });
    const held = await call(h.listNeedsYou, "GET", "/routines/needs-you");
    expect(held.body).toMatchObject({
      items: [
        {
          creature: "wren",
          routineId: "triage",
          kind: "grants",
          runId: (run.body.run as { runId: string }).runId,
          action: { verb: "accept" },
        },
      ],
    });
    const digest = (held.body.items as { action: { digest: string } }[])[0]?.action.digest;
    await call(h.acceptRoutineGrants, "POST", "/creatures/wren/routines/triage/accept", triage, {
      digest,
    });
    expect((await call(h.listNeedsYou, "GET", "/routines/needs-you")).body).toEqual({
      items: [],
    });
  });

  it("answer 404 for an unknown creature and 400 for a body that is not a routine", async () => {
    const h = handlers();
    expect(
      (await call(h.listRoutines, "GET", "/creatures/nobody/routines", { slug: "nobody" })).status,
    ).toBe(404);
    expect(
      (
        await call(h.putRoutine, "PUT", "/creatures/wren/routines/triage", triage, {
          title: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(h.listRoutineRuns, "GET", "/creatures/wren/routines/triage/runs", triage)).status,
    ).toBe(404);
  });

  it("pass the runs limit through the query and refuse one out of range", async () => {
    const h = handlers();
    await call(h.putRoutine, "PUT", "/creatures/wren/routines/triage", triage, routineInput());
    expect(
      await call(h.listRoutineRuns, "GET", "/creatures/wren/routines/triage/runs", triage),
    ).toMatchObject({ status: 200, body: { runs: [] } });
    expect(
      (await call(h.listRoutineRuns, "GET", "/creatures/wren/routines/triage/runs?limit=0", triage))
        .status,
    ).toBe(400);
  });

  it("declare the chore routes under the creature, PUT included, each authenticated", () => {
    expect(routineRoutes.map((route) => [route.method, route.path, route.operationId])).toEqual([
      ["GET", "/creatures/{slug}/routines", "listRoutines"],
      ["GET", "/creatures/{slug}/routines/{id}", "readRoutine"],
      ["PUT", "/creatures/{slug}/routines/{id}", "putRoutine"],
      ["DELETE", "/creatures/{slug}/routines/{id}", "deleteRoutine"],
      ["POST", "/creatures/{slug}/routines/{id}/run", "runRoutine"],
      ["POST", "/creatures/{slug}/routines/{id}/cancel", "cancelRoutine"],
      ["POST", "/creatures/{slug}/routines/{id}/accept", "acceptRoutineGrants"],
      ["GET", "/creatures/{slug}/routines/{id}/runs", "listRoutineRuns"],
      ["GET", "/routines/needs-you", "listNeedsYou"],
    ]);
    expect(routineRoutes.every((route) => route.authenticated)).toBe(true);
    expect(operationOf(routineRoutes[2]).requestBody?.required).toBe(true);
    expect(operationOf(routineRoutes[6]).requestBody?.required).toBe(true);
    for (const route of routineRoutes) expect(routes).toContain(route);
  });
});

describe("the webhook routes", () => {
  const deploys = { slug: "wren", id: "deploys" };

  async function hooked(): Promise<string> {
    await harness.writeRoutine(
      routineInput({ id: "deploys", trigger: { kind: "webhook", maxBytes: 64 } }),
    );
    const minted = await call(
      handlers().mintRoutineHook,
      "POST",
      "/creatures/wren/routines/deploys/hook",
      deploys,
    );
    expect(minted).toMatchObject({ status: 200, body: { path: "/hooks/wren/deploys" } });
    return String(minted.body.token);
  }

  async function fire(token: string | undefined, body: string) {
    const response = await handlers().fireRoutineHook(
      new Request(`${origin}/hooks/wren/deploys`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          ...(token !== undefined && { authorization: `Bearer ${token}` }),
        },
      }),
      deploys,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("declare a keeper-authenticated mint and a token-bound fire", () => {
    expect(
      routineHookRoutes.map((route) => [route.method, route.path, route.authenticated]),
    ).toEqual([
      ["POST", "/creatures/{slug}/routines/{id}/hook", true],
      ["POST", "/hooks/{slug}/{id}", false],
    ]);
    for (const route of routineHookRoutes) expect(routes).toContain(route);
  });

  it("fire the chore for its own token only, and cap the body", async () => {
    const token = await hooked();
    expect((await fire(undefined, "{}")).status).toBe(401);
    expect((await fire("not-the-token", "{}")).status).toBe(401);
    expect((await fire(token, "x".repeat(65))).status).toBe(413);
    const fired = await fire(token, '{"ref":"main"}');
    expect(fired).toMatchObject({ status: 202, body: { status: "running" } });
    expect(harness.runner.last().request.payload?.file).toMatch(/\.trigger\.json$/);
  });

  it("refuse to mint a token for a chore that is not a webhook", async () => {
    await harness.writeRoutine(routineInput());
    const refused = await call(
      handlers().mintRoutineHook,
      "POST",
      "/creatures/wren/routines/triage/hook",
      triage,
    );
    expect(refused.status).toBe(400);
  });
});
