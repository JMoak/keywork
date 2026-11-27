import { afterEach, describe, expect, it } from "vitest";
import { RoutineHarness, routineInput } from "./testing.ts";

const at = (iso: string) => Date.parse(iso);

let harness: RoutineHarness;

afterEach(async () => {
  await harness.close();
});

describe("a chore's check", () => {
  it("makes no run and no notice when it exits 0, and wakes the model when it does not", async () => {
    harness = await RoutineHarness.create({ start: at("2026-11-05T08:00:00Z") });
    await harness.writeRoutine(routineInput({ check: { command: "exit 0" } }));
    await harness.service.start();
    await acceptWhatTheKeeperReads();
    await harness.advanceTo(at("2026-11-05T09:02:00Z"));

    expect(harness.eventsOf("routine.checked")).toEqual([
      expect.objectContaining({
        check: expect.objectContaining({ verdict: "quiet", exitCode: 0 }),
      }),
    ]);
    expect(harness.runner.started).toHaveLength(0);
    expect(harness.store.runs("wren", "triage", 10)).toEqual([]);
    expect(harness.eventsOf("routine.finished")).toEqual([]);
    expect(harness.service.needsYou()).toEqual([]);

    await harness.writeRoutine(routineInput({ check: { command: "exit 3" } }));
    await harness.service.list("wren");
    expect(harness.service.needsYou()).toEqual([
      expect.objectContaining({
        kind: "grants",
        reason: "asks to check for work by running exit 3",
      }),
    ]);
    await acceptWhatTheKeeperReads();
    await harness.advanceTo(at("2026-11-06T09:02:00Z"));

    expect(harness.runner.started).toHaveLength(1);
    expect(harness.runner.last().request.prompt).toContain(
      "Its check `exit 3` exited 3, so there is something to do",
    );
    expect(harness.runner.last().request.payload).toBeDefined();
  });
});

async function acceptWhatTheKeeperReads(): Promise<void> {
  const read = await harness.service.read("wren", "triage");
  if (typeof read === "string" || read.grants === null)
    throw new Error("the chore is not readable");
  await harness.service.accept("wren", "triage", read.grants.digest);
}
