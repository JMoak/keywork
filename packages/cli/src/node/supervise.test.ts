import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../../engine/src/routines/testing.ts";
import { defaultNodeConfig } from "./config.ts";
import { nodeStoppedItem, readStoppedItem, writeStoppedItem } from "./desk.ts";
import { type NodeFile, nodeFileStore } from "./node-file.ts";
import { type NodePaths, nodePaths } from "./paths.ts";
import { type SuperviseOptions, superviseNode } from "./supervise.ts";
import { FakeProcesses, settle } from "./testing.ts";
import { coreUnit, type WorkspaceUnit } from "./units.ts";

const t0 = Date.parse("2026-11-05T09:00:00Z");
const machine = { id: "6f1c0e1e-0000-4000-8000-000000000001", name: "MOAK-MAIN" };
const launch = { program: "bun", args: ["/src/keywork/packages/cli/src/main.ts"] };

let root: string;
let paths: NodePaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keywork-node-supervise-"));
  paths = nodePaths(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const steadWorkspace: WorkspaceUnit = {
  workspace: { cwd: "/src/stead", slug: null },
  identity: "abc123def456",
  ticket: "/home/keeper/.keywork/workspaces/abc123def456/server.json",
  spec: {
    name: "workspace:abc123def456",
    argv: ["bun", "main.ts", "serve", "--port", "0"],
    cwd: "/src/stead",
  },
};

interface Rig {
  clock: FakeClock;
  processes: FakeProcesses;
  said: string[];
  stop: AbortController;
  exit: Promise<number>;
}

function supervising(overrides: Partial<SuperviseOptions> = {}): Rig {
  const clock = new FakeClock(t0);
  const processes = new FakeProcesses();
  const said: string[] = [];
  const stop = new AbortController();
  const exit = superviseNode({
    paths,
    config: { ...defaultNodeConfig(), workspaces: [steadWorkspace.workspace] },
    core: coreUnit(launch, paths.state, 999),
    workspaces: [steadWorkspace],
    machine,
    version: "0.2.0",
    pid: 999,
    clock,
    spawn: processes.spawn,
    isAlive: () => false,
    signal: stop.signal,
    say: (line) => said.push(line),
    ...overrides,
  });
  return { clock, processes, said, stop, exit };
}

function jsonLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("the node supervisor", () => {
  it("publishes node.json for the console while it runs and marks it stopped when asked to stop", async () => {
    const rig = supervising();
    await settle();
    rig.processes.latest("workspace:abc123def456").say("listening on http://127.0.0.1:53111");
    const running = nodeFileStore(paths.nodeFile).read();
    expect(running).toMatchObject({
      schema: 1,
      state: "running",
      version: "0.2.0",
      machine,
      pid: 999,
      ports: { mesh: 47800, screenUdp: { first: 47810, last: 47829 } },
      core: { state: "running", pid: 4100, restarts: 0 },
      logs: { node: paths.nodeLog, lifecycle: paths.lifecycleLog },
      stopped: null,
    });
    expect(running?.workspaces).toEqual([
      {
        cwd: "/src/stead",
        slug: null,
        identity: "abc123def456",
        ticket: steadWorkspace.ticket,
        url: "http://127.0.0.1:53111",
        state: "running",
        pid: 4101,
        restarts: 0,
        since: "2026-11-05T09:00:00.000Z",
      },
    ]);
    rig.stop.abort();
    expect(await rig.exit).toBe(0);
    expect(nodeFileStore(paths.nodeFile).read()).toMatchObject({
      state: "stopped",
      pid: null,
      stopped: { reason: "asked to stop", item: null },
    });
  });

  it("logs every child line as JSONL with its unit, and the lifecycle apart", async () => {
    const rig = supervising();
    await settle();
    rig.processes.latest("core").say("node core: running");
    rig.processes.latest("workspace:abc123def456").say("token abcdef0123456789");
    rig.processes.latest("core").say("mesh: refused", "stderr");
    rig.stop.abort();
    await rig.exit;
    expect(
      jsonLines(paths.nodeLog).map(({ unit, stream, line }) => ({ unit, stream, line })),
    ).toEqual([
      { unit: "core", stream: "stdout", line: "node core: running" },
      { unit: "workspace:abc123def456", stream: "stdout", line: "token [redacted]" },
      { unit: "core", stream: "stderr", line: "mesh: refused" },
    ]);
    expect(jsonLines(paths.lifecycleLog).map((record) => record.event)).toEqual([
      "supervisor.started",
      "unit.started",
      "unit.started",
      "supervisor.stopping",
      "supervisor.stopped",
    ]);
  });

  it("stops after a crash loop and leaves a desk item with the log tail", async () => {
    const rig = supervising();
    await settle();
    for (let crash = 1; crash <= 3; crash += 1) {
      const core = rig.processes.latest("core");
      core.say(`node core: starting (try ${crash})`);
      core.say("mesh: the tailnet listener did not start: Funnel is on", "stderr");
      core.crash(1);
      await settle();
      await rig.clock.advanceTo(rig.clock.now() + 30_000, () => settle());
    }
    expect(await rig.exit).toBe(0);
    const item = readStoppedItem(paths.stoppedItem);
    expect(item).toMatchObject({
      kind: "node.stopped",
      title: "the node on MOAK-MAIN stopped",
      reason: "three crashes in five minutes",
      crashes: [
        { unit: "core", code: 1 },
        { unit: "core", code: 1 },
        { unit: "core", code: 1 },
      ],
    });
    expect(item?.logTail.at(-1)).toContain("Funnel is on");
    expect(item?.logTail.filter((line) => line.includes("try 3"))).toHaveLength(1);
    expect(nodeFileStore(paths.nodeFile).read()).toMatchObject({
      state: "stopped",
      stopped: { reason: "three crashes in five minutes", item: paths.stoppedItem },
    });
    expect(rig.processes.live()).toEqual([]);
    expect(jsonLines(paths.lifecycleLog).map((record) => record.event)).toContain(
      "supervisor.desk-item",
    );
    expect(rig.said.at(-1)).toContain("keywork node reset");
  });

  it("stays stopped while the crash-loop item is on the desk", async () => {
    writeStoppedItem(
      paths.stoppedItem,
      nodeStoppedItem({
        machine,
        at: t0,
        reason: "three crashes in five minutes",
        crashes: [],
        logTail: [],
      }),
    );
    const rig = supervising();
    expect(await rig.exit).toBe(0);
    expect(rig.processes.spawned).toEqual([]);
    expect(rig.said).toEqual([
      "the node on MOAK-MAIN stopped at 2026-11-05T09:00:00.000Z (three crashes in five minutes); keywork node reset starts it again",
    ]);
    expect(jsonLines(paths.lifecycleLog)[0]).toMatchObject({ event: "supervisor.held" });
  });

  it("refuses to start a second supervisor while one is alive", async () => {
    const first = supervising();
    await settle();
    const second = supervising({ pid: 1234, isAlive: (pid) => pid === 999 });
    expect(await second.exit).toBe(1);
    expect(second.processes.spawned).toEqual([]);
    expect(second.said).toEqual([
      "a node is already running here as pid 999; keywork node status shows it",
    ]);
    first.stop.abort();
    await first.exit;
  });

  it("judges a recorded node by the same pid-and-port probe as node status", async () => {
    nodeFileStore(paths.nodeFile).write(recordedNode(4242));
    mkdirSync(join(paths.nodeLog, ".."), { recursive: true });
    writeFileSync(
      paths.nodeLog,
      `${boundLine("100.124.48.125")}
`,
    );
    const probed: string[] = [];

    const answering = supervising({
      pid: 1234,
      isAlive: (pid) => pid === 4242,
      answers: async (host, port) => {
        probed.push(`${host}:${port}`);
        return true;
      },
    });
    expect(await answering.exit).toBe(1);
    expect(answering.said).toEqual([
      "a node is already running here as pid 4242; keywork node status shows it",
    ]);

    const recycled = supervising({
      pid: 1234,
      isAlive: (pid) => pid === 4242,
      answers: async () => false,
    });
    await settle();
    expect(recycled.processes.spawned.length).toBeGreaterThan(0);
    expect(probed).toEqual(["100.124.48.125:47800"]);
    recycled.stop.abort();
    expect(await recycled.exit).toBe(0);
  });
});

function recordedNode(pid: number): NodeFile {
  return {
    schema: 1,
    state: "running",
    version: "0.2.0",
    machine,
    pid,
    startedAt: "2026-11-05T08:00:00.000Z",
    updatedAt: "2026-11-05T08:00:00.000Z",
    ports: { mesh: 47800, screenUdp: null },
    workspaces: [],
    core: { state: "running", pid: 4243, restarts: 0, since: null },
    logs: { node: "node.log", lifecycle: "lifecycle.log" },
    stopped: null,
  };
}

function boundLine(address: string): string {
  return JSON.stringify({
    at: "2026-11-05T08:00:01.000Z",
    unit: "core",
    stream: "stdout",
    line: `mesh: ${JSON.stringify({ type: "mesh.listener.bound", address, port: 47800 })}`,
  });
}
