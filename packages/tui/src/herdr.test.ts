import { describe, expect, it } from "vitest";
import { type HerdrSpawner, herdrReporter, herdrStateOf } from "./herdr.ts";

const herdrEnv = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "pane-7",
  HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
};

const idle = { working: false, blocked: false };
const working = { working: true, blocked: false };
const blocked = { working: true, blocked: true };

describe("herdrStateOf", () => {
  it("puts a pending ask ahead of running work", () => {
    expect(herdrStateOf(idle)).toBe("idle");
    expect(herdrStateOf(working)).toBe("working");
    expect(herdrStateOf(blocked)).toBe("blocked");
    expect(herdrStateOf({ working: false, blocked: true })).toBe("blocked");
  });
});

describe("herdrReporter", () => {
  it("reports state through the pane's herdr binary with the resume command", () => {
    const herdr = fakeHerdr();
    herdrReporter({ env: herdrEnv, spawn: herdr.spawn, clock: () => 1000 }).report(working);
    expect(herdr.calls).toEqual([
      {
        command: "/opt/herdr/bin/herdr",
        args: [
          "pane",
          "report-agent",
          "pane-7",
          "--source",
          "keywork",
          "--agent",
          "keywork",
          "--seq",
          "1000",
          "--state",
          "working",
          "--",
          "keywork",
        ],
      },
    ]);
  });

  it("does nothing outside herdr", () => {
    const herdr = fakeHerdr();
    for (const env of [
      {},
      { ...herdrEnv, HERDR_ENV: "0" },
      { ...herdrEnv, HERDR_PANE_ID: undefined },
      { ...herdrEnv, HERDR_BIN_PATH: "" },
    ]) {
      const reporter = herdrReporter({ env, spawn: herdr.spawn });
      reporter.report(working);
      reporter.release();
    }
    expect(herdr.calls).toEqual([]);
  });

  it("reports only when the state changes", async () => {
    const herdr = fakeHerdr();
    const reporter = herdrReporter({ env: herdrEnv, spawn: herdr.spawn });
    reporter.report(idle);
    await herdr.finishAll();
    reporter.report(idle);
    reporter.report(working);
    await herdr.finishAll();
    reporter.report(working);
    expect(herdr.states()).toEqual(["idle", "working"]);
  });

  it("sends only the latest state once the report in flight lands", async () => {
    const herdr = fakeHerdr();
    const reporter = herdrReporter({ env: herdrEnv, spawn: herdr.spawn });
    reporter.report(working);
    reporter.report(blocked);
    reporter.report(idle);
    reporter.report(blocked);
    expect(herdr.states()).toEqual(["working"]);
    await herdr.finishAll();
    expect(herdr.states()).toEqual(["working", "blocked"]);
  });

  it("drops a queued state that returns to what herdr already has", async () => {
    const herdr = fakeHerdr();
    const reporter = herdrReporter({ env: herdrEnv, spawn: herdr.spawn });
    reporter.report(working);
    reporter.report(idle);
    reporter.report(working);
    await herdr.finishAll();
    expect(herdr.states()).toEqual(["working"]);
  });

  it("keeps the sequence rising even when the clock stalls or steps back", async () => {
    const herdr = fakeHerdr();
    const times = [500, 500, 400];
    const reporter = herdrReporter({
      env: herdrEnv,
      spawn: herdr.spawn,
      clock: () => times.shift() ?? 0,
    });
    reporter.report(working);
    await herdr.finishAll();
    reporter.report(blocked);
    await herdr.finishAll();
    reporter.release();
    expect(herdr.seqs()).toEqual([500, 501, 502]);
  });

  it("releases the pane on quit and goes quiet after", async () => {
    const herdr = fakeHerdr();
    const reporter = herdrReporter({ env: herdrEnv, spawn: herdr.spawn, clock: () => 9 });
    reporter.report(working);
    reporter.release();
    await herdr.finishAll();
    reporter.report(idle);
    reporter.release();
    expect(herdr.calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["pane", "report-agent", "pane-7"],
      ["pane", "release-agent", "pane-7"],
    ]);
    expect(herdr.calls[1]?.args).toEqual([
      "pane",
      "release-agent",
      "pane-7",
      "--source",
      "keywork",
      "--agent",
      "keywork",
      "--seq",
      "10",
    ]);
  });

  it("stops trying once the binary is missing", async () => {
    const herdr = fakeHerdr();
    const reporter = herdrReporter({ env: herdrEnv, spawn: herdr.spawn });
    reporter.report(working);
    await herdr.failAll();
    reporter.report(idle);
    reporter.release();
    expect(herdr.calls).toHaveLength(1);
  });

  it("never throws when the spawner itself throws", () => {
    const reporter = herdrReporter({
      env: herdrEnv,
      spawn: () => {
        throw new Error("spawn EACCES");
      },
    });
    expect(() => {
      reporter.report(working);
      reporter.report(idle);
      reporter.release();
    }).not.toThrow();
  });
});

interface SpawnCall {
  command: string;
  args: readonly string[];
}

function fakeHerdr() {
  const calls: SpawnCall[] = [];
  let pending: { resolve: () => void; reject: (cause: Error) => void }[] = [];
  const spawn: HerdrSpawner = (command, args) => {
    calls.push({ command, args });
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  };
  const settleAll = async (settle: (entry: (typeof pending)[number]) => void): Promise<void> => {
    while (pending.length > 0) {
      const settling = pending;
      pending = [];
      for (const entry of settling) settle(entry);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const flag = (name: string) => (call: SpawnCall) => call.args[call.args.indexOf(name) + 1];
  return {
    calls,
    spawn,
    finishAll: () => settleAll((entry) => entry.resolve()),
    failAll: () => settleAll((entry) => entry.reject(new Error("spawn ENOENT"))),
    states: () => calls.filter((call) => call.args[1] === "report-agent").map(flag("--state")),
    seqs: () => calls.map(flag("--seq")).map(Number),
  };
}
