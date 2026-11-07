import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { backoffMs } from "../backoff.ts";
import { hourMs, minuteMs } from "./clock.ts";
import { grantDigest, type RoutineInput } from "./routine.ts";
import type { RunRow } from "./run.ts";
import { defaultSchedulerSettings, waitingOnAnswer } from "./scheduler.ts";
import type { RoutineView } from "./service.ts";
import {
  type HarnessOptions,
  heldOnGrants,
  parkedRun,
  RoutineHarness,
  routineInput,
} from "./testing.ts";

const t0 = Date.parse("2026-11-05T08:00:00Z");
const at = (iso: string) => Date.parse(iso);

let harness: RoutineHarness;

afterEach(async () => {
  await harness.close();
});

async function started(
  input: RoutineInput = routineInput(),
  options: Partial<HarnessOptions> = {},
): Promise<RoutineHarness> {
  harness = await RoutineHarness.create({ start: t0, ...options });
  await harness.writeRoutine(input);
  await harness.service.start();
  return harness;
}

function runsOf(id = "triage"): RunRow[] {
  return harness.store.runs("wren", id, 500);
}

async function view(id = "triage"): Promise<RoutineView> {
  const read = await harness.service.read("wren", id);
  if (typeof read === "string") throw new Error(read);
  return read;
}

describe("a scheduled run", () => {
  it("fires at its slot plus a stagger, with scheduled and actual time in the prompt", async () => {
    await started();
    const next = Date.parse((await view()).schedule.nextRunAt ?? "");
    expect(next).toBeGreaterThanOrEqual(at("2026-11-05T09:00:00Z"));
    expect(next).toBeLessThan(at("2026-11-05T09:01:00Z"));
    await harness.advanceTo(at("2026-11-05T08:59:00Z"));
    expect(harness.runner.started).toHaveLength(0);
    await harness.advanceTo(at("2026-11-05T09:02:00Z"));
    const [run] = harness.runner.started;
    expect(run?.request.prompt).toContain("Read the inbox. Tell me only what needs me today.");
    expect(run?.request.prompt).toContain(
      "Scheduled for 2026-11-05 09:00 UTC; started 2026-11-05 09:00 UTC (on time).",
    );
    expect(runsOf()[0]).toMatchObject({ status: "running", sessionId: "session-1" });
    expect(harness.eventsOf("routine.fired")[0]).toMatchObject({
      routineId: "triage",
      sessionId: "session-1",
      firedAt: "2026-11-05T09:00:00.000Z",
    });
  });

  it("records process, delivery and verification apart and saves the output beside the journal", async () => {
    await started();
    await harness.advanceTo(at("2026-11-05T09:02:00Z"));
    harness.runner.last().finish();
    await harness.service.drain();
    const [run] = runsOf();
    expect(run).toMatchObject({
      status: "ended",
      process: "completed",
      delivery: "delivered",
      verified: null,
      usage: { inputTokens: 1200, outputTokens: 80 },
      cost: { usd: 0.02 },
      notify: { tier: "log", at: null },
    });
    expect(await readFile(run?.output ?? "", "utf8")).toBe("Nothing needs you today.\n");
    expect(harness.deliverer.delivered).toHaveLength(1);
    expect(harness.eventsOf("routine.finished")[0]?.run.runId).toBe(run?.runId);
    expect((await view()).schedule.nextRunAt?.startsWith("2026-11-06T09:00")).toBe(true);
  });

  it("keeps a run whose delivery failed apart from its process outcome and rings the keeper", async () => {
    await started();
    harness.deliverer.failWith = "the conversation is gone";
    await harness.advanceTo(at("2026-11-05T09:02:00Z"));
    harness.runner.last().finish();
    await harness.service.drain();
    expect(runsOf()[0]).toMatchObject({
      process: "completed",
      delivery: "failed",
      notify: { tier: "interrupt" },
    });
    expect(harness.service.needsYou()).toEqual([expect.objectContaining({ kind: "run" })]);
  });

  it("fails a run the runner cannot start, with the reason", async () => {
    await started();
    harness.runner.refuseWith = "no provider is configured";
    await harness.advanceTo(at("2026-11-05T09:02:00Z"));
    expect(runsOf()[0]).toMatchObject({
      process: "failed",
      reason: "the run could not start: no provider is configured",
    });
  });
});

describe("catch-up on start", () => {
  async function downUntil(instant: number): Promise<void> {
    harness.service.stop();
    await harness.clock.advanceTo(instant, async () => {});
    await harness.restart();
  }

  it("runs only the most recent missed slot, paced after startup, and records the rest skipped", async () => {
    await started(routineInput({ trigger: { kind: "cron", expr: "0 * * * *", tz: "UTC" } }));
    await downUntil(at("2026-11-05T13:10:00Z"));
    expect(harness.runner.started).toHaveLength(0);
    const skipped = runsOf().filter((run) => run.status === "skipped");
    expect(skipped.map((run) => run.firedAt)).toEqual([
      "2026-11-05T12:00:00.000Z",
      "2026-11-05T11:00:00.000Z",
      "2026-11-05T10:00:00.000Z",
      "2026-11-05T09:00:00.000Z",
    ]);
    expect(skipped.every((run) => run.reason?.includes("only the most recent slot"))).toBe(true);
    expect((await view()).schedule.nextRunAt).toBe("2026-11-05T13:10:30.000Z");
    await harness.advance(30_000);
    const [run] = harness.runner.started;
    expect(run?.request.prompt).toContain("a catch-up for a run missed while the node was down");
    expect(run?.request.prompt).toContain("(10 min late)");
    expect(run?.request.prompt).toContain("It is running late");
    expect(runsOf()[0]).toMatchObject({ firedAt: "2026-11-05T13:00:00.000Z", catchUp: true });
  });

  it("skips slots older than the catch-up window and paces catch-ups across routines", async () => {
    harness = await RoutineHarness.create({ start: t0 });
    await harness.writeRoutine(
      routineInput({ id: "a", trigger: { kind: "cron", expr: "0 * * * *", tz: "UTC" } }),
    );
    await harness.writeRoutine(
      routineInput({ id: "b", trigger: { kind: "cron", expr: "30 * * * *", tz: "UTC" } }),
    );
    await harness.service.start();
    await downUntil(t0 + 30 * hourMs);
    const windowed = runsOf("a").filter((run) => run.reason?.includes("catch-up window"));
    expect(windowed).toHaveLength(1);
    expect(windowed[0]?.firedAt).toBe("2026-11-05T09:00:00.000Z");
    const starts = [(await view("a")).schedule.nextRunAt, (await view("b")).schedule.nextRunAt];
    expect(new Set(starts)).toEqual(
      new Set(["2026-11-06T14:00:30.000Z", "2026-11-06T14:01:00.000Z"]),
    );
  });
});

describe("waking from sleep", () => {
  it("paces overdue runs after a late timer instead of running them all at wake", async () => {
    harness = await RoutineHarness.create({ start: t0 });
    await harness.writeRoutine(
      routineInput({ id: "a", trigger: { kind: "cron", expr: "0 * * * *", tz: "UTC" } }),
    );
    await harness.writeRoutine(
      routineInput({ id: "b", trigger: { kind: "cron", expr: "30 * * * *", tz: "UTC" } }),
    );
    await harness.service.start();
    await harness.sleepUntil(at("2026-11-05T11:45:00Z"));
    expect(harness.runner.started).toHaveLength(0);
    expect(runsOf("a").map((run) => [run.firedAt, run.status])).toEqual([
      ["2026-11-05T10:00:00.000Z", "skipped"],
      ["2026-11-05T09:00:00.000Z", "skipped"],
    ]);
    const starts = [(await view("a")).schedule.nextRunAt, (await view("b")).schedule.nextRunAt];
    expect(new Set(starts)).toEqual(
      new Set(["2026-11-05T11:45:30.000Z", "2026-11-05T11:46:00.000Z"]),
    );
    await harness.advance(minuteMs);
    expect(harness.runner.started.map((run) => run.request.routine.id).sort()).toEqual(["a", "b"]);
    expect(harness.runner.started.every((run) => run.request.prompt.includes("catch-up"))).toBe(
      true,
    );
  });
});

describe("the per-routine lock", () => {
  it("refuses an overlapping run and records it as skipped", async () => {
    await started(routineInput({ trigger: { kind: "interval", minutes: 5 } }));
    await harness.advance(6 * minuteMs);
    expect(harness.runner.started).toHaveLength(1);
    await harness.advance(5 * minuteMs);
    expect(harness.runner.started).toHaveLength(1);
    const skipped = runsOf().find((run) => run.status === "skipped");
    expect(skipped?.reason).toBe(`the previous run ${runsOf().at(-1)?.runId} is still active`);
    const byHand = await harness.service.run("wren", "triage");
    expect(byHand).toMatchObject({ status: "skipped", trigger: "manual" });
    harness.runner.last().finish();
    await harness.service.drain();
    await harness.advance(5 * minuteMs);
    expect(harness.runner.started).toHaveLength(2);
  });
});

describe("backoff and auto-disable", () => {
  it("retries from 30 s doubling to 5 min, then disables the routine and tells the keeper why", async () => {
    await started(routineInput({ trigger: { kind: "interval", minutes: 60 } }));
    harness.runner.finishAtOnce = { ended: "failed", reason: "provider unavailable" };
    await harness.advance(61 * minuteMs);
    for (let index = 0; index < 4; index++) await harness.advance(5 * minuteMs);
    const starts = runsOf()
      .filter((run) => run.status === "ended")
      .map((run) => Date.parse(run.startedAt ?? ""))
      .sort((a, b) => a - b);
    const gaps = starts.slice(1).map((start, index) => start - (starts[index] ?? 0));
    expect(gaps).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(runsOf().map((run) => run.attempt)).toEqual([5, 4, 3, 2, 1]);
    const routine = await view();
    expect(routine.schedule.disabled?.reason).toBe(
      "disabled after 5 failed runs in a row; the last: provider unavailable",
    );
    expect(harness.eventsOf("routine.finished").at(-1)?.disabled).toBe(
      routine.schedule.disabled?.reason,
    );
    expect(harness.service.needsYou()).toEqual([
      expect.objectContaining({ kind: "disabled", routineId: "triage" }),
    ]);
    await harness.advance(3 * hourMs);
    expect(harness.runner.started).toHaveLength(5);
  });

  it("caps the backoff at five minutes", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, defaultSchedulerSettings))).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
  });

  it("reinstates a disabled routine when the keeper puts it back", async () => {
    await started(routineInput({ trigger: { kind: "interval", minutes: 60 } }), {
      settings: { disableAfterErrors: 1 },
    });
    harness.runner.finishAtOnce = { ended: "failed", reason: "boom" };
    await harness.advance(61 * minuteMs);
    expect((await view()).schedule.disabled).not.toBeNull();
    const put = await harness.service.put(
      "wren",
      "triage",
      routineInput({ trigger: { kind: "interval", minutes: 60 } }),
    );
    expect(put).toMatchObject({ routine: { schedule: { disabled: null, consecutiveErrors: 0 } } });
  });
});

describe("hourly caps", () => {
  it("drops fires beyond the per-trigger cap with a visible record", async () => {
    await started(routineInput({ trigger: { kind: "interval", minutes: 10 } }), {
      settings: { hourlyCapPerTrigger: 3 },
    });
    harness.runner.finishAtOnce = {};
    await harness.advance(61 * minuteMs);
    const runs = runsOf().reverse();
    expect(runs.map((run) => run.status)).toEqual([
      "ended",
      "ended",
      "ended",
      "dropped",
      "dropped",
      "dropped",
    ]);
    expect(runs[3]?.reason).toBe(
      "dropped: this chore already ran 3 times in the last hour (cap 3)",
    );
  });

  it("drops fires beyond the per-creature cap across routines", async () => {
    harness = await RoutineHarness.create({ start: t0, settings: { hourlyCapPerCreature: 4 } });
    await harness.writeRoutine(
      routineInput({ id: "a", trigger: { kind: "interval", minutes: 10 } }),
    );
    await harness.writeRoutine(
      routineInput({ id: "b", trigger: { kind: "interval", minutes: 10 } }),
    );
    harness.runner.finishAtOnce = {};
    await harness.service.start();
    await harness.advance(31 * minuteMs);
    expect(harness.runner.started).toHaveLength(4);
    const dropped = [...runsOf("a"), ...runsOf("b")].filter((run) => run.status === "dropped");
    expect(dropped.map((run) => run.reason)).toEqual([
      "dropped: wren already ran 4 chores in the last hour (cap 4)",
      "dropped: wren already ran 4 chores in the last hour (cap 4)",
    ]);
  });
});

describe("the consent invariant: a fired trigger cannot grant", () => {
  const writer = routineInput(heldOnGrants);

  it("parks a write routine its keeper has not accepted, on schedule and by hand, with no session", async () => {
    await started(writer);
    await harness.advanceTo(at("2026-11-05T09:02:00Z"));
    const [parked] = runsOf();
    expect(parked).toMatchObject({ ...parkedRun, notify: { tier: "interrupt" } });
    expect(parked?.reason).toContain("a fired trigger never does");
    expect(harness.runner.started).toHaveLength(0);
    expect(harness.eventsOf("routine.finished")).toEqual([]);
    expect(await harness.service.run("wren", "triage")).toMatchObject({
      status: "skipped",
      reason: `the run ${parked?.runId} is parked until the keeper accepts the grant set`,
    });
    expect(await view()).toMatchObject({
      activeRunId: parked?.runId,
      schedule: { nextRunAt: null },
    });
    expect(harness.service.needsYou()).toEqual([
      expect.objectContaining({ kind: "grants", runId: parked?.runId, since: parked?.firedAt }),
    ]);
  });

  it("raises one needs-you item for a chore held on its grants, carrying the accept action, and the parked run proceeds when the keeper accepts", async () => {
    await started({ ...writer, enabled: false });
    expect(harness.service.needsYou()).toEqual([]);
    expect(await harness.service.run("wren", "triage")).toMatchObject({ status: "parked" });
    const digest = (await view()).grants?.digest ?? "";
    expect(harness.service.needsYou()).toEqual([
      {
        creature: "wren",
        routineId: "triage",
        kind: "grants",
        reason: `accept the write grant set ${digest}`,
        runId: runsOf()[0]?.runId,
        since: runsOf()[0]?.firedAt,
        action: { verb: "accept", digest },
      },
    ]);
    const held = harness.eventsOf("routine.needs").at(-1);
    expect(held?.items.map((item) => [item.kind, item.action?.verb])).toEqual([
      ["grants", "accept"],
    ]);
    await harness.advance(5 * minuteMs);
    expect(await harness.service.accept("wren", "triage", digest)).toMatchObject({
      activeRunId: runsOf()[0]?.runId,
      lastRun: { status: "running", sessionId: "session-1", reason: null },
    });
    expect(harness.service.needsYou()).toEqual([]);
    expect(harness.eventsOf("routine.needs").at(-1)).toEqual({
      creature: "wren",
      routineId: "triage",
      items: [],
    });
    expect(harness.runner.last().request).toMatchObject({
      posture: heldOnGrants.tools,
      grants: heldOnGrants.grants,
    });
    expect(harness.runner.last().request.prompt).toContain("started 2026-11-05 08:05 UTC");
    expect(harness.eventsOf("routine.fired")[0]).toMatchObject({
      runId: runsOf()[0]?.runId,
      sessionId: "session-1",
    });
    harness.runner.last().finish();
    await harness.service.drain();
    expect(runsOf()[0]).toMatchObject({ status: "ended", process: "completed" });
  });

  it("keeps a parked run across a restart, and lets it go when its chore is removed or turned off", async () => {
    await started(writer);
    await harness.advanceTo(at("2026-11-05T09:02:00Z"));
    await harness.restart();
    expect(runsOf()[0]).toMatchObject(parkedRun);
    expect(harness.runner.started).toHaveLength(0);
    expect(harness.service.needsYou()).toEqual([
      expect.objectContaining({ kind: "grants", runId: runsOf()[0]?.runId }),
    ]);
    await harness.service.put("wren", "triage", { ...writer, enabled: false });
    expect(runsOf()[0]).toMatchObject({
      status: "ended",
      process: "cancelled",
      reason: "the chore was turned off while its run waited on the grant set",
    });
    expect(harness.eventsOf("routine.finished").at(-1)?.run.runId).toBe(runsOf()[0]?.runId);
    expect(harness.service.needsYou()).toEqual([]);

    expect(await harness.service.run("wren", "triage")).toMatchObject({ status: "parked" });
    await harness.service.put("wren", "triage", { ...writer, enabled: true });
    expect(runsOf()[0]?.status).toBe("parked");
    await harness.service.remove("wren", "triage");
    expect(runsOf()[0]).toMatchObject({
      status: "ended",
      process: "cancelled",
      reason: "the chore was removed while its run waited on the grant set",
    });
    expect(harness.service.needsYou()).toEqual([]);
  });

  it("cancels a parked run by hand", async () => {
    await started({ ...writer, enabled: false });
    const parked = await harness.service.run("wren", "triage");
    expect(await harness.service.cancel("wren", "triage")).toMatchObject({
      runId: (parked as RunRow).runId,
      status: "ended",
      process: "cancelled",
    });
    expect(harness.service.needsYou()).toEqual([]);
  });

  it("takes no acceptance from a routine body, a stale digest or a widened file", async () => {
    await started(writer);
    expect(await harness.service.put("wren", "triage", { ...writer, accepted: true })).toEqual({
      refusal: expect.stringContaining("accepted"),
    });
    expect(await harness.service.accept("wren", "triage", "0000000000000000")).toEqual({
      refusal: expect.stringContaining("the grant set changed"),
    });
    const digest = (await view()).grants?.digest ?? "";
    expect(digest).toBe(grantDigest(heldOnGrants));
    expect(await harness.service.accept("wren", "triage", digest)).toMatchObject({
      grants: { accepted: true },
    });
    await harness.service.run("wren", "triage");
    expect(harness.runner.last().request).toMatchObject({
      posture: heldOnGrants.tools,
      grants: heldOnGrants.grants,
    });
    harness.runner.last().finish();
    await harness.advance(minuteMs);
    await harness.writeRoutine({ ...writer, grants: [{ action: "write", resource: "**" }] });
    expect(await harness.service.run("wren", "triage")).toMatchObject(parkedRun);
    expect(harness.runner.started).toHaveLength(1);
  });

  it("runs a read-only routine with no grants at all", async () => {
    await started();
    await harness.service.run("wren", "triage");
    expect(harness.runner.last().request).toMatchObject({ posture: "read-only", grants: [] });
  });
});

describe("watchdogs and budgets", () => {
  it("ends a run past its minutes budget as blocked", async () => {
    await started(routineInput({ budget: { usd: 0.5, minutes: 10 } }));
    await harness.service.run("wren", "triage");
    await harness.advance(10 * minuteMs);
    expect(harness.runner.last().stops).toBe(1);
    expect(runsOf()[0]).toMatchObject({
      process: "blocked",
      reason: "ran past its 10-minute budget",
    });
  });

  it("ends a run past the agent watchdog as timed out", async () => {
    await started(
      routineInput({ trigger: { kind: "manual" }, budget: { usd: 0.5, minutes: 120 } }),
    );
    await harness.service.run("wren", "triage");
    await harness.advance(60 * minuteMs);
    expect(runsOf()[0]).toMatchObject({
      process: "timed-out",
      reason: "the 1 h watchdog for agent runs ended it",
    });
  });

  it("stops a run that spends past its dollar budget and never delivers an over-budget result", async () => {
    await started(routineInput({ budget: { usd: 0.5, minutes: 10 } }));
    await harness.service.run("wren", "triage");
    harness.runner.last().signals.spent(0.75);
    await harness.service.drain();
    expect(runsOf()[0]).toMatchObject({ process: "blocked", delivery: "none" });
    await harness.advance(minuteMs);
    await harness.service.run("wren", "triage");
    harness.runner.last().finish({ costUsd: 0.9 });
    await harness.service.drain();
    expect(runsOf()[0]).toMatchObject({
      process: "blocked",
      delivery: "none",
      reason: "spent past its $0.50 budget ($0.90)",
    });
    expect(harness.deliverer.delivered).toHaveLength(0);
  });

  it("cancels a run on the keeper's word and says stopping does not undo", async () => {
    await started();
    await harness.service.run("wren", "triage");
    expect(await harness.service.cancel("wren", "triage")).toMatchObject({ status: "running" });
    await harness.service.drain();
    expect(runsOf()[0]).toMatchObject({
      process: "cancelled",
      reason: "stopped by the keeper; stopping does not undo what already ran",
    });
    expect(await harness.service.cancel("wren", "triage")).toBe("idle");
  });
});

describe("approvals", () => {
  it("parks a run on an ask, pauses its clock, and denies an outbound ask at its deadline", async () => {
    await started(routineInput({ budget: { usd: 0.5, minutes: 10 } }));
    await harness.service.run("wren", "triage");
    harness.runner.last().signals.asked({ callId: "call-1", tool: "bash" });
    expect(runsOf()[0]?.status).toBe("parked");
    await harness.advance(29 * minuteMs);
    expect(harness.runner.last().denied).toEqual([]);
    await harness.advance(minuteMs);
    expect(harness.runner.last().denied).toEqual(["call-1"]);
    expect(runsOf()[0]?.status).toBe("running");
    await harness.advance(9 * minuteMs);
    expect(harness.runner.last().stops).toBe(0);
    await harness.advance(minuteMs);
    expect(runsOf()[0]?.process).toBe("blocked");
  });

  it("resumes a parked run when the keeper answers", async () => {
    await started();
    await harness.service.run("wren", "triage");
    harness.runner.last().signals.asked({ callId: "call-2", tool: "write" });
    harness.runner.last().signals.answered("call-2", "granted");
    expect(runsOf()[0]?.status).toBe("running");
    expect(harness.store.pendingApprovals()).toEqual([]);
  });
});

describe("notification tiers", () => {
  const quiet = {
    digest: ["08:30", "12:30"],
    quietHours: { start: "22:00", end: "07:00" },
    tz: "UTC",
  };

  it("holds an interrupt until quiet hours end, never the work", async () => {
    await started(routineInput({ trigger: { kind: "cron", expr: "0 23 * * *", tz: "UTC" } }), {
      notifications: quiet,
    });
    harness.runner.finishAtOnce = { ended: "failed", reason: "boom" };
    await harness.advanceTo(at("2026-11-05T23:02:00Z"));
    expect(runsOf()[0]?.notify).toEqual({ tier: "interrupt", at: "2026-11-06T07:00:00.000Z" });
  });

  it("puts a run that notifies always into the next digest", async () => {
    await started(routineInput({ notify: "always" }), { notifications: quiet });
    harness.runner.finishAtOnce = {};
    await harness.advanceTo(at("2026-11-05T09:02:00Z"));
    expect(runsOf()[0]?.notify).toEqual({ tier: "digest", at: "2026-11-05T12:30:00.000Z" });
  });
});

describe("routine files are the source", () => {
  it("follows edits, removals and broken files on disk", async () => {
    await started();
    await harness.writeRoutine(
      routineInput({ trigger: { kind: "cron", expr: "0 10 * * *", tz: "UTC" } }),
    );
    const listed = await harness.service.list("wren");
    expect(
      Array.isArray(listed) && listed[0]?.schedule.nextRunAt?.startsWith("2026-11-05T10:00"),
    ).toBe(true);
    await harness.writeRoutine(routineInput({ id: "broken", title: "" }));
    expect(await view("broken")).toMatchObject({
      routine: null,
      problem: expect.stringContaining("title"),
    });
    expect(harness.service.needsYou()).toEqual([
      expect.objectContaining({ kind: "invalid", routineId: "broken" }),
    ]);
    expect(await harness.service.remove("wren", "triage")).toMatchObject({ id: "triage" });
    expect(await harness.service.read("wren", "triage")).toBe("missing-routine");
    await harness.advanceTo(at("2026-11-05T11:00:00Z"));
    expect(harness.runner.started).toHaveLength(0);
  });
});

describe("an accepted parked run", () => {
  const writer = routineInput(heldOnGrants);

  it("reads running the moment its session starts, parked with the ask named while it waits on the keeper, and its outcome after", async () => {
    await started(writer);
    await harness.service.run("wren", "triage");
    const digest = (await view()).grants?.digest ?? "";

    await harness.service.accept("wren", "triage", digest);
    const running = runsOf()[0];
    harness.runner.last().signals.asked({ callId: "call-7", tool: "write" });
    const waiting = runsOf()[0];
    harness.runner.last().signals.answered("call-7", "granted");
    const answered = runsOf()[0];
    harness.runner.last().finish();
    await harness.service.drain();

    expect(running).toMatchObject({ status: "running", sessionId: "session-1", reason: null });
    expect(waiting).toMatchObject({
      status: "parked",
      sessionId: "session-1",
      reason: waitingOnAnswer("write"),
    });
    expect(answered).toMatchObject({ status: "running", reason: null });
    expect(runsOf()[0]).toMatchObject({ status: "ended", process: "completed" });
  });
});
