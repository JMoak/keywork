import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { minuteMs } from "./clock.ts";
import { crashEffectKey, crashEffectParams, crashFiredAt } from "./crash-child.ts";
import { performEffect } from "./effects.ts";
import { RoutineHarness, routineInput } from "./testing.ts";

const child = fileURLToPath(new URL("./crash-child.ts", import.meta.url));

let harness: RoutineHarness;

afterEach(async () => {
  await harness.close();
});

describe("crash recovery", () => {
  it("marks an effect killed between start and record as delivery unknown and never replays it", async () => {
    harness = await RoutineHarness.create({ start: crashFiredAt + 5 * minuteMs });
    const file = await harness.writeRoutine(routineInput());
    const killed = spawnSync("bun", [child, harness.databasePath, file], { encoding: "utf8" });
    expect(killed.stdout).toBe("effect started under bun\n");
    expect(killed.status === 0 && killed.signal === null).toBe(false);

    await harness.service.start();
    const [run] = harness.store.runs("wren", "triage", 10);
    expect(run).toMatchObject({
      status: "ended",
      process: "failed",
      delivery: "unknown",
      sessionId: "session-1",
      notify: { tier: "interrupt" },
    });
    expect(run?.reason).toContain("never replayed");
    expect(harness.service.needsYou()).toEqual([
      expect.objectContaining({ kind: "run", runId: run?.runId }),
    ]);

    let replayed = 0;
    const again = await performEffect(
      harness.store,
      harness.clock,
      { key: crashEffectKey, runId: "run-later", kind: "deliver", params: crashEffectParams },
      async () => {
        replayed += 1;
      },
    );
    expect(again).toEqual({ delivery: "unknown", since: crashFiredAt });
    expect(replayed).toBe(0);
    await harness.advance(30 * minuteMs);
    expect(harness.runner.started).toHaveLength(0);
  });

  it("gives a run interrupted before any effect one fresh retry, paced after startup", async () => {
    harness = await RoutineHarness.create({ start: crashFiredAt - 30 * minuteMs });
    await harness.writeRoutine(routineInput());
    await harness.service.start();
    await harness.advanceTo(crashFiredAt + minuteMs);
    expect(harness.runner.started).toHaveLength(1);

    await harness.restart();
    expect(harness.store.runs("wren", "triage", 10)[0]).toMatchObject({
      process: "failed",
      delivery: "none",
      reason: "the node stopped during the run",
    });
    expect(harness.runner.started).toHaveLength(1);
    await harness.advance(30_000);
    expect(harness.runner.started).toHaveLength(2);
    expect(harness.runner.last().request.prompt).toContain("retry 1 of a run that did not finish");
    harness.runner.last().finish({ ended: "failed", reason: "still broken" });
    await harness.service.drain();
    await harness.restart();
    await harness.advance(10 * minuteMs);
    expect(harness.runner.started).toHaveLength(3);
  });
});
