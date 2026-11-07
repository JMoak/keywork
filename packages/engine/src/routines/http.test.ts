import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { minuteMs } from "./clock.ts";
import { type RoutineOperationId, type RoutineReply, routineOperations } from "./http.ts";
import { routineJsonSchema } from "./routine.ts";
import { RoutineHarness, routineInput } from "./testing.ts";

let harness: RoutineHarness;

beforeEach(async () => {
  harness = await RoutineHarness.create({ start: Date.parse("2026-11-05T08:00:00Z") });
  await harness.service.start();
});

afterEach(async () => {
  await harness.close();
});

function call(
  operation: RoutineOperationId,
  params: Record<string, string>,
  body?: unknown,
  query = "",
): Promise<RoutineReply> {
  return routineOperations[operation](harness.service, {
    params,
    query: new URLSearchParams(query),
    body,
  });
}

const triage = { slug: "wren", id: "triage" };

describe("routine operations", () => {
  it("creates with PUT, then replaces, and lists what the creature has", async () => {
    expect((await call("putRoutine", triage, routineInput())).status).toBe(201);
    const replaced = await call("putRoutine", triage, { ...routineInput(), title: "Triage" });
    expect(replaced).toMatchObject({ status: 200, body: { created: false } });
    expect(await call("listRoutines", { slug: "wren" })).toMatchObject({
      status: 200,
      body: { routines: [{ id: "triage", routine: { title: "Triage" } }] },
    });
  });

  it("takes the id from the path and refuses a body that names another", async () => {
    const { id: _id, ...withoutId } = routineInput();
    expect((await call("putRoutine", triage, withoutId)).status).toBe(201);
    expect(await call("putRoutine", triage, { ...routineInput(), id: "other" })).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("the body's id") },
    });
  });

  it("answers 400 for an invalid routine and 404 for an unknown creature or chore", async () => {
    expect((await call("putRoutine", triage, { title: "x" })).status).toBe(400);
    expect((await call("listRoutines", { slug: "nobody" })).status).toBe(404);
    expect((await call("readRoutine", { slug: "wren", id: "nope" })).status).toBe(404);
    expect((await call("listRoutineRuns", { slug: "wren", id: "nope" })).status).toBe(404);
  });

  it("starts a run with 202, refuses an overlapping one with 409, and cancels", async () => {
    await call("putRoutine", triage, routineInput());
    expect(await call("runRoutine", triage)).toMatchObject({
      status: 202,
      body: { run: { status: "running" } },
    });
    await harness.advance(minuteMs);
    expect(await call("runRoutine", triage)).toMatchObject({
      status: 409,
      body: { run: { status: "skipped" } },
    });
    expect((await call("cancelRoutine", triage)).status).toBe(202);
    await harness.service.drain();
    expect((await call("cancelRoutine", triage)).status).toBe(409);
    expect(await call("listRoutineRuns", triage, undefined, "limit=1")).toMatchObject({
      status: 200,
      body: { runs: [{ status: "skipped" }] },
    });
    expect((await call("listRoutineRuns", triage, undefined, "limit=0")).status).toBe(400);
  });

  it("accepts a grant set only by its current digest", async () => {
    const writer = routineInput({
      tools: "act",
      grants: [{ action: "bash", resource: "git push *" }],
    });
    const put = await call("putRoutine", triage, writer);
    const digest = (put.body as { routine: { grants: { digest: string } } }).routine.grants.digest;
    expect((await call("acceptRoutineGrants", triage, {})).status).toBe(400);
    expect((await call("acceptRoutineGrants", triage, { digest: "stale" })).status).toBe(400);
    expect(await call("acceptRoutineGrants", triage, { digest })).toMatchObject({
      status: 200,
      body: { routine: { grants: { accepted: true } } },
    });
  });

  it("deletes the file and the index row but keeps the run journal", async () => {
    await call("putRoutine", triage, routineInput());
    harness.runner.finishAtOnce = {};
    await call("runRoutine", triage);
    await harness.service.drain();
    expect((await call("deleteRoutine", triage)).status).toBe(200);
    expect((await call("readRoutine", triage)).status).toBe(404);
    expect(harness.store.runs("wren", "triage", 10)).toHaveLength(1);
  });

  it("publishes the routine file as a JSON schema for the PUT body", () => {
    expect(routineJsonSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["id", "title", "instructions", "trigger"]),
      properties: { tools: { enum: ["read-only", "write", "act"] } },
    });
  });
});
