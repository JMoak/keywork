import { afterEach, describe, expect, it } from "vitest";
import { minuteMs } from "./clock.ts";
import type { RoutineInput } from "./routine.ts";
import type { RoutineView } from "./service.ts";
import { RoutineHarness, routineInput } from "./testing.ts";

const t0 = Date.parse("2026-11-06T08:00:00Z");

let harness: RoutineHarness;

afterEach(async () => {
  await harness.close();
});

async function started(...inputs: RoutineInput[]): Promise<RoutineHarness> {
  harness = await RoutineHarness.create({ start: t0 });
  for (const input of inputs) await harness.writeRoutine(input);
  await harness.service.start();
  return harness;
}

async function board(): Promise<string[]> {
  const listed = await harness.service.list("wren");
  if (typeof listed === "string") throw new Error(listed);
  return listed.map((view: RoutineView) => view.id);
}

const reminder = routineInput({
  id: "reminder",
  title: "Remind me about the build",
  trigger: { kind: "at", at: "2026-11-06T08:30:00.000Z" },
});

const poll = routineInput({
  id: "wake-poll",
  title: "Wake: poll the build",
  trigger: { kind: "interval", minutes: 50, until: "2026-11-06T10:00:00.000Z" },
  wake: { requestedAt: "2026-11-06T08:00:00.000Z" },
});

describe("a one-shot chore", () => {
  it("deletes itself once its run finished cleanly, keeping the run in the journal", async () => {
    await started(reminder);
    await harness.advanceTo(t0 + 31 * minuteMs);
    expect(harness.runner.started).toHaveLength(1);
    expect(await board()).toEqual(["reminder"]);
    harness.runner.last().finish();
    await harness.advance(1_000);
    expect(await board()).toEqual([]);
    expect(harness.store.runs("wren", "reminder", 5)).toMatchObject([{ process: "completed" }]);
  });

  it("stays on the board while its run needs the keeper, and after a run by hand", async () => {
    await started(reminder);
    await harness.service.run("wren", "reminder");
    harness.runner.last().finish();
    await harness.advance(1_000);
    expect(await board()).toEqual(["reminder"]);
    await harness.advanceTo(t0 + 31 * minuteMs);
    harness.runner.last().finish({ ended: "failed", output: "", reason: "the build is gone" });
    await harness.advance(1_000);
    expect(await board()).toEqual(["reminder"]);
  });
});

describe("an expiring wakeup", () => {
  it("wakes once more at its expiry, says so, then deletes itself", async () => {
    await started(poll);
    for (let minute = 51; minute <= 101; minute += 50) {
      await harness.advanceTo(t0 + minute * minuteMs);
      harness.runner.last().finish();
    }
    expect(harness.runner.started).toHaveLength(2);
    expect(harness.runner.last().request.prompt).not.toContain("last wake");
    await harness.advanceTo(t0 + 121 * minuteMs);
    expect(harness.runner.started).toHaveLength(3);
    expect(harness.runner.last().request.prompt).toContain(
      "This is the last wake of a self-paced wakeup that has expired",
    );
    expect(await board()).toEqual(["wake-poll"]);
    harness.runner.last().finish();
    await harness.advance(1_000);
    expect(await board()).toEqual([]);
    await harness.advanceTo(t0 + 24 * 60 * minuteMs);
    expect(harness.runner.started).toHaveLength(3);
  });

  it("keeps a keeper's interval with an end date when it ends", async () => {
    const { wake: _wake, ...keepers } = poll;
    await started({ ...keepers, id: "keepers" });
    await harness.advanceTo(t0 + 51 * minuteMs);
    harness.runner.last().finish();
    await harness.advanceTo(t0 + 101 * minuteMs);
    harness.runner.last().finish();
    await harness.advanceTo(t0 + 24 * 60 * minuteMs);
    expect(harness.runner.started).toHaveLength(2);
    expect(await board()).toEqual(["keepers"]);
  });
});
