import { afterEach, describe, expect, it } from "vitest";
import { minuteMs } from "../routines/clock.ts";
import type { RoutineView } from "../routines/service.ts";
import {
  type HarnessOptions,
  heldOnGrants,
  parkedRun,
  RoutineHarness,
  routineInput,
} from "../routines/testing.ts";
import type { Tool } from "../tools.ts";
import { toolScope } from "./confine.ts";
import { coreTools } from "./core.ts";
import { scheduleTool } from "./schedule.ts";

const t0 = Date.parse("2026-11-06T08:00:00Z");

let harness: RoutineHarness;

afterEach(async () => {
  await harness.close();
});

async function schedule(options: Partial<HarnessOptions> = {}): Promise<Tool> {
  harness = await RoutineHarness.create({ start: t0, ...options });
  await harness.service.start();
  return scheduleTool({ creature: "wren", wakes: harness.service });
}

async function wakes(): Promise<RoutineView[]> {
  const listed = await harness.service.list("wren");
  if (typeof listed === "string") throw new Error(listed);
  return listed.filter((view) => view.routine?.wake !== undefined);
}

describe("the schedule tool", () => {
  it("writes a one-shot wakeup the creature owns, on the board, that fires once read-only", async () => {
    const tool = await schedule();
    const said = await tool.execute({
      note: "Check whether the build went green.",
      in_minutes: 40,
    });
    expect(said).toContain("next wake 2026-11-06T08:40:00.000Z");
    expect(said).toContain("It runs read-only.");
    const [wake] = await wakes();
    expect(wake?.routine).toMatchObject({
      trigger: { kind: "at", at: "2026-11-06T08:40:00.000Z" },
      tools: "read-only",
      wake: { requestedAt: "2026-11-06T08:00:00.000Z" },
    });
    await harness.advanceTo(t0 + 39 * minuteMs);
    expect(harness.runner.started).toHaveLength(0);
    await harness.advanceTo(t0 + 41 * minuteMs);
    expect(harness.runner.started).toHaveLength(1);
    expect(harness.runner.last().request.prompt).toContain("Check whether the build went green.");
    expect(harness.runner.last().request.posture).toBe("read-only");
    harness.runner.last().finish();
    await harness.advanceTo(t0 + 24 * 60 * minuteMs);
    expect(harness.runner.started).toHaveLength(1);
  });

  it("is cancelled by the keeper removing the chore", async () => {
    const tool = await schedule();
    await tool.execute({ note: "Look again.", in_minutes: 10 });
    const [wake] = await wakes();
    await harness.service.remove("wren", wake?.id ?? "");
    await harness.advanceTo(t0 + 30 * minuteMs);
    expect(harness.runner.started).toHaveLength(0);
  });

  it("paces an every wakeup above the floor and lets it expire", async () => {
    const tool = await schedule({ wakes: { horizonMs: 2 * 60 * minuteMs } });
    expect(await tool.execute({ note: "Poll.", every_minutes: 5 })).toBe(
      "Not scheduled: every_minutes is at least 15.",
    );
    await tool.execute({ note: "Poll.", every_minutes: 30 });
    const [wake] = await wakes();
    expect(wake?.routine?.trigger).toEqual({
      kind: "interval",
      minutes: 30,
      until: "2026-11-06T10:00:00.000Z",
    });
    for (let minute = 31; minute <= 181; minute += 30) {
      await harness.advanceTo(t0 + minute * minuteMs);
      harness.runner.started.at(-1)?.finish();
    }
    expect(harness.runner.started).toHaveLength(4);
  });

  it("refuses an unclear or far wakeup", async () => {
    const tool = await schedule();
    expect(await tool.execute({ note: "Both.", in_minutes: 5, every_minutes: 30 })).toBe(
      "Not scheduled: name exactly one of in_minutes, at or every_minutes.",
    );
    expect(await tool.execute({ note: "Far.", at: "2026-11-20T08:00:00Z" })).toBe(
      "Not scheduled: a wakeup is at most 7 days away (RUN-048).",
    );
    expect(await tool.execute({ note: "Local.", at: "2026-11-06T09:00" })).toBe(
      "Not scheduled: at is not a date-time with an offset.",
    );
    expect(await wakes()).toEqual([]);
  });

  it("is rate-limited per creature", async () => {
    const tool = await schedule({ wakes: { perHour: 2 } });
    await tool.execute({ note: "One.", in_minutes: 30 });
    await harness.advance(1_000);
    await tool.execute({ note: "Two.", in_minutes: 30 });
    await harness.advance(1_000);
    expect(await tool.execute({ note: "Three.", in_minutes: 30 })).toBe(
      "Not scheduled: already asked for 2 wakeups in the last hour (cap 2); try again later.",
    );
    expect(await wakes()).toHaveLength(2);
  });
});

describe("a wakeup and the creature's grants", () => {
  const editor = routineInput({
    id: "editor",
    trigger: { kind: "manual" },
    tools: "write",
    grants: [
      { action: "write", resource: "notes/**" },
      { action: "edit", resource: "notes/**" },
    ],
  });

  async function accepted(): Promise<Tool> {
    const tool = await schedule();
    await harness.writeRoutine(editor);
    const read = await harness.service.read("wren", "editor");
    if (typeof read === "string") throw new Error(read);
    await harness.service.accept("wren", "editor", read.grants?.digest ?? "");
    return tool;
  }

  it("inherits a grant set the keeper already accepted, never more", async () => {
    const tool = await accepted();
    const said = await tool.execute({ note: "Tidy the notes.", in_minutes: 5, ...heldOnGrants });
    expect(said).toContain("under the grants you already hold (editor)");
    await harness.advanceTo(t0 + 6 * minuteMs);
    expect(harness.runner.last().request).toMatchObject({
      posture: heldOnGrants.tools,
      grants: heldOnGrants.grants,
    });
  });

  it("parks a wakeup that asks for more until the keeper accepts it", async () => {
    const tool = await accepted();
    const said = await tool.execute({
      note: "Send the digest.",
      in_minutes: 5,
      tools: "act",
      grants: [{ action: "send", resource: "mail" }],
    });
    expect(said).toContain("it will park until they do");
    await harness.advanceTo(t0 + 6 * minuteMs);
    expect(harness.runner.started).toHaveLength(0);
    const [wake] = await wakes();
    expect(wake?.lastRun).toMatchObject({ ...parkedRun, trigger: "at" });
    expect(harness.service.needsYou()).toEqual([
      expect.objectContaining({ kind: "grants", routineId: wake?.id }),
    ]);
  });
});

describe("the core tool set", () => {
  it("carries schedule only when a creature's wakeups are wired", async () => {
    harness = await RoutineHarness.create({ start: t0 });
    const scope = toolScope(harness.workspace);
    expect(coreTools(scope).map((tool) => tool.name)).not.toContain("schedule");
    const wired = coreTools(scope, { schedule: { creature: "wren", wakes: harness.service } });
    expect(wired.map((tool) => tool.name)).toContain("schedule");
  });
});
