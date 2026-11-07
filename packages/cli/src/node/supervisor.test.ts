import { backoffMs } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../engine/src/routines/testing.ts";
import {
  Supervisor,
  type SupervisorEvent,
  type SupervisorOutcome,
  supervisionPolicy,
  type UnitSpec,
} from "./supervisor.ts";
import { FakeProcesses, settle } from "./testing.ts";

const t0 = Date.parse("2026-11-05T09:00:00Z");
const minute = 60_000;

const core: UnitSpec = { name: "core", argv: ["bun", "main.ts", "node", "run"], cwd: "/state" };
const workspace: UnitSpec = {
  name: "workspace:abc123",
  argv: ["bun", "main.ts", "serve", "--port", "0"],
  cwd: "/src/stead",
};

interface Rig {
  clock: FakeClock;
  processes: FakeProcesses;
  supervisor: Supervisor;
  events: SupervisorEvent[];
  lines: string[];
  stop: AbortController;
  outcome: Promise<SupervisorOutcome>;
  advance(ms: number): Promise<void>;
}

async function supervising(units: readonly UnitSpec[] = [core, workspace]): Promise<Rig> {
  const clock = new FakeClock(t0);
  const processes = new FakeProcesses();
  const events: SupervisorEvent[] = [];
  const lines: string[] = [];
  const supervisor = new Supervisor({
    units,
    spawn: processes.spawn,
    clock,
    onEvent: (event) => events.push(event),
    onLine: (unit, stream, line) => lines.push(`${unit} ${stream} ${line}`),
  });
  const stop = new AbortController();
  const outcome = supervisor.run(stop.signal);
  await settle();
  return {
    clock,
    processes,
    supervisor,
    events,
    lines,
    stop,
    outcome,
    advance: (ms) => clock.advanceTo(clock.now() + ms, () => settle()),
  };
}

describe("the supervisor", () => {
  it("starts every unit and reports each as running with its pid", async () => {
    const rig = await supervising();
    expect(rig.processes.spawned.map((child) => child.unit.name)).toEqual([
      "core",
      "workspace:abc123",
    ]);
    expect(rig.supervisor.status().get("core")).toMatchObject({ state: "running", pid: 4100 });
    expect(rig.supervisor.status().get("workspace:abc123")).toMatchObject({
      state: "running",
      pid: 4101,
    });
  });

  it("learns a workspace URL from serve's listening line and never passes the token on", async () => {
    const rig = await supervising();
    const serve = rig.processes.latest("workspace:abc123");
    serve.say("listening on http://127.0.0.1:53111");
    serve.say("token 0123456789abcdef");
    expect(rig.supervisor.status().get("workspace:abc123")?.url).toBe("http://127.0.0.1:53111");
    expect(rig.lines).toContain("workspace:abc123 stdout token [redacted]");
    expect(rig.lines.join("\n")).not.toContain("0123456789abcdef");
  });

  it("restarts a crashed unit after a backoff that doubles", async () => {
    const rig = await supervising([core]);
    rig.processes.latest("core").crash(1);
    await settle();
    expect(rig.supervisor.status().get("core")).toMatchObject({
      state: "backing-off",
      restarts: 1,
    });
    await rig.advance(999);
    expect(rig.processes.of("core")).toHaveLength(1);
    await rig.advance(1);
    expect(rig.processes.of("core")).toHaveLength(2);
    rig.processes.latest("core").crash(1);
    await settle();
    expect(rig.events).toContainEqual({
      event: "unit.backoff",
      unit: "core",
      attempt: 2,
      delayMs: 2_000,
    });
  });

  it("stops every unit after three crashes in five minutes and reports the crash loop", async () => {
    const rig = await supervising();
    const healthy = rig.processes.latest("workspace:abc123");
    for (let crash = 1; crash <= 3; crash += 1) {
      rig.processes.latest("core").crash(3);
      await settle();
      if (crash < 3) await rig.advance(minute);
    }
    const outcome = await rig.outcome;
    expect(outcome).toMatchObject({ ended: "crash-loop", reason: "three crashes in five minutes" });
    expect(outcome.ended === "crash-loop" && outcome.crashes.map((crash) => crash.code)).toEqual([
      3, 3, 3,
    ]);
    expect(healthy.stopRequests).toBe(1);
    expect(rig.processes.live()).toEqual([]);
    expect(rig.processes.of("core")).toHaveLength(3);
    expect([...rig.supervisor.status().values()].every((unit) => unit.state === "stopped")).toBe(
      true,
    );
  });

  it("keeps restarting when the crashes are spread wider than the window", async () => {
    const rig = await supervising([core]);
    for (let crash = 1; crash <= 4; crash += 1) {
      rig.processes.latest("core").crash(1);
      await settle();
      await rig.advance(3 * minute);
    }
    expect(rig.processes.of("core")).toHaveLength(5);
    expect(rig.events.some((event) => event.event === "supervisor.crash-loop")).toBe(false);
  });

  it("starts the backoff over once a unit has stayed up past the crash window", async () => {
    const rig = await supervising([core]);
    rig.processes.latest("core").crash(1);
    await settle();
    await rig.advance(1_000);
    await rig.advance(6 * minute);
    rig.processes.latest("core").crash(1);
    await settle();
    expect(rig.events.filter((event) => event.event === "unit.backoff")).toEqual([
      { event: "unit.backoff", unit: "core", attempt: 1, delayMs: 1_000 },
      { event: "unit.backoff", unit: "core", attempt: 1, delayMs: 1_000 },
    ]);
  });

  it("counts a unit that cannot be spawned as a crash", async () => {
    const processes = new FakeProcesses();
    processes.refuse = "bun is not on PATH";
    const events: SupervisorEvent[] = [];
    const supervisor = new Supervisor({
      units: [core],
      spawn: processes.spawn,
      clock: new FakeClock(t0),
      onEvent: (event) => events.push(event),
    });
    void supervisor.run(new AbortController().signal);
    await settle();
    expect(events).toContainEqual({
      event: "unit.spawn-failed",
      unit: "core",
      error: "bun is not on PATH",
    });
    expect(supervisor.status().get("core")).toMatchObject({ state: "backing-off", restarts: 1 });
  });

  it("adopts a workspace another keywork already serves and takes over once it is gone", async () => {
    let elsewhere = true;
    const rig = await supervising([{ ...workspace, occupied: async () => elsewhere }]);
    expect(rig.processes.spawned).toEqual([]);
    expect(rig.supervisor.status().get("workspace:abc123")?.state).toBe("adopted");
    elsewhere = false;
    await rig.advance(supervisionPolicy.adoptRecheckMs);
    expect(rig.processes.of("workspace:abc123")).toHaveLength(1);
    expect(rig.supervisor.status().get("workspace:abc123")?.state).toBe("running");
  });

  it("stops every child when asked and resolves as stopped", async () => {
    const rig = await supervising();
    rig.stop.abort();
    expect(await rig.outcome).toEqual({ ended: "stopped" });
    expect(rig.processes.spawned.every((child) => child.stopRequests === 1 && !child.killed)).toBe(
      true,
    );
    expect(rig.events.at(-1)).toEqual({ event: "supervisor.stopped" });
  });

  it("kills a child that ignores the stop request once the grace runs out", async () => {
    const rig = await supervising([core]);
    const stubborn = rig.processes.latest("core");
    stubborn.exitsOnStop = false;
    rig.stop.abort();
    await settle();
    expect(stubborn.killed).toBe(false);
    await rig.advance(supervisionPolicy.stopGraceMs);
    expect(stubborn.killed).toBe(true);
    expect(await rig.outcome).toEqual({ ended: "stopped" });
  });

  it("never respawns a unit whose backoff was pending when it was asked to stop", async () => {
    const rig = await supervising([core]);
    rig.processes.latest("core").crash(1);
    await settle();
    rig.stop.abort();
    await rig.outcome;
    await rig.advance(10 * minute);
    expect(rig.processes.of("core")).toHaveLength(1);
  });
});

describe("backoffMs", () => {
  it("doubles from one second and caps at a minute", () => {
    expect([1, 2, 3, 6, 7, 12].map((attempt) => backoffMs(attempt, supervisionPolicy))).toEqual([
      1_000, 2_000, 4_000, 32_000, 60_000, 60_000,
    ]);
  });
});
