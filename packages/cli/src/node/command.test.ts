import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../../engine/src/routines/testing.ts";
import { exitCodes } from "../dispatch.ts";
import { nodeCommand } from "./command.ts";
import { readNodeConfig } from "./config.ts";
import type { CoreServices } from "./core.ts";
import type { NodeCommandDeps } from "./deps.ts";
import { nodeStoppedItem, readStoppedItem, writeStoppedItem } from "./desk.ts";
import { defaultAgentLabel } from "./launchd.ts";
import { type NodeFile, nodeFileStore } from "./node-file.ts";
import { nodePaths } from "./paths.ts";
import { keeperUid, RecordedLaunchctl } from "./platform-fixtures.ts";
import type { ClaimDesk } from "./reconcile.ts";
import { nodeStatus, statusLines } from "./status.ts";
import { defaultUnitName } from "./systemd.ts";
import {
  FakeProcesses,
  FakeSchtasks,
  FakeSystemd,
  keeper,
  linuxKeeper,
  settle,
} from "./testing.ts";

let root: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keywork-node-command-"));
  workspace = join(root, "src", "stead");
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const t0 = Date.parse("2026-11-05T09:00:00Z");
const tailnetAddresses = ["100.124.48.125", "fd7a:115c:a1e0::6a01:3c7d", "192.168.4.58"];

interface Harness {
  schtasks: FakeSchtasks;
  processes: FakeProcesses;
  clock: FakeClock;
  stop: AbortController;
  out: string[];
  err: string[];
  terminated: number[];
  hidden: number;
  core: string[];
  run(args: readonly string[], overrides?: Partial<NodeCommandDeps>): Promise<number>;
}

function unclaimedDesk(): ClaimDesk & { issued: number } {
  const desk = {
    issued: 0,
    claimState: async () => "unclaimed" as const,
    live: async () =>
      desk.issued > 0 ? { code: "ABCDEFGHIJKL", expiresAt: "2026-11-05T09:15:00.000Z" } : null,
    issue: async () => {
      desk.issued += 1;
      return { code: "ABCD-EFGH-IJKL", expiresAt: "2026-11-05T09:15:00.000Z" };
    },
  };
  return desk;
}

function harness(base: Partial<NodeCommandDeps> = {}): Harness {
  const schtasks = new FakeSchtasks();
  const processes = new FakeProcesses();
  const clock = new FakeClock(t0);
  const stop = new AbortController();
  const desk = unclaimedDesk();
  const h: Harness = {
    schtasks,
    processes,
    clock,
    stop,
    out: [],
    err: [],
    terminated: [],
    hidden: 0,
    core: [],
    run: (args, overrides = {}) =>
      nodeCommand(
        args,
        {
          cwd: workspace,
          env: {},
          platform: "win32",
          userRoot: root,
          account: keeper,
          launch: {
            program: "C:\\bun\\bun.exe",
            args: ["C:\\keywork\\packages\\cli\\src\\main.ts"],
          },
          run: schtasks.run,
          spawn: processes.spawn,
          clock,
          fetch: (async () => {
            throw new Error("ECONNREFUSED");
          }) as unknown as typeof fetch,
          version: "0.2.0",
          hostname: "MOAK-MAIN",
          pid: 999,
          isAlive: () => false,
          terminate: (pid) => {
            h.terminated.push(pid);
            return true;
          },
          hideConsole: async () => {
            h.hidden += 1;
            return true;
          },
          addresses: () => tailnetAddresses,
          interrupts: () => ({ signal: stop.signal, dispose: () => {} }),
          composeCore: async (composition) => recordingCore(h, composition.workspaces.length),
          claimDesk: () => desk,
          workspaceProblem: (_cwd, slug) =>
            slug === "missing"
              ? 'no workspace named "missing" here · keywork workspace list shows what exists'
              : undefined,
          ...base,
          ...overrides,
        },
        { print: (line) => h.out.push(line), printError: (line) => h.err.push(line) },
      ),
  };
  return h;
}

function recordingCore(h: Harness, workspaces: number): CoreServices {
  h.core.push(`composed with ${workspaces} workspace(s)`);
  return {
    reconcile: { headless: false },
    activity: {
      start: () => h.core.push("activity.start"),
      stop: () => h.core.push("activity.stop"),
    },
  };
}

function recordedNode(
  pids: { supervisor: number; core: number; workspace: number },
  url = "http://127.0.0.1:53111",
): NodeFile {
  return {
    schema: 1,
    state: "running",
    version: "0.2.0",
    machine: { id: "m-1", name: "MOAK-MAIN" },
    pid: pids.supervisor,
    startedAt: "2026-11-05T08:00:00.000Z",
    updatedAt: "2026-11-05T08:00:00.000Z",
    ports: { mesh: 47800, screenUdp: { first: 47810, last: 47829 } },
    workspaces: [
      {
        cwd: workspace,
        slug: null,
        identity: "abc123def456",
        ticket: "server.json",
        url,
        state: "running",
        pid: pids.workspace,
        restarts: 0,
        since: null,
      },
    ],
    core: { state: "running", pid: pids.core, restarts: 0, since: null },
    logs: { node: "node.log", lifecycle: "lifecycle.log" },
    stopped: null,
  };
}

describe("keywork node install on Windows", () => {
  it("records the workspace, registers the logon task, starts it and prints the firewall script", async () => {
    const h = harness();
    expect(await h.run(["install"])).toBe(exitCodes.completed);
    const paths = nodePaths(root);
    expect(readNodeConfig(paths.config).workspaces).toEqual([{ cwd: workspace, slug: null }]);
    expect(h.schtasks.tasks.get("keywork node")?.state).toBe("Running");
    expect(h.schtasks.tasks.get("keywork node")?.xml).toContain(
      "<Arguments>C:\\keywork\\packages\\cli\\src\\main.ts node run --supervise --hidden</Arguments>",
    );
    expect(existsSync(paths.machineId)).toBe(true);
    expect(h.out).toContain(
      'installed: Windows logon task "keywork node" for MOAK-MAIN\\moakj (interactive token, least privilege)',
    );
    expect(h.out).toContain(`serves: ${workspace}`);
    expect(h.out.some((line) => line.includes("signing out stops your creatures"))).toBe(true);
    expect(h.out.some((line) => line.includes("needs autologon"))).toBe(true);
    const script = h.out.find((line) => line.startsWith("#Requires -RunAsAdministrator")) ?? "";
    expect(script).toContain("-Program 'C:\\bun\\bun.exe' -Protocol TCP -LocalPort 47800");
    expect(script).toContain("-Protocol UDP -LocalPort 47810-47829");
    expect(script).toContain("-LocalAddress '100.124.48.125','fd7a:115c:a1e0::6a01:3c7d'");
    expect(script).toContain("-RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48'");
    expect(script).not.toContain("192.168.4.58");
    expect(h.schtasks.calls.flat()).not.toContain("New-NetFirewallRule");
    const lifecycle = readFileSync(paths.lifecycleLog, "utf8");
    expect(JSON.parse(lifecycle.trim())).toMatchObject({
      event: "node.installed",
      ok: true,
      manager: "windows-task",
    });
  });

  it("explains instead of printing a script when Tailscale has no address yet", async () => {
    const h = harness({ addresses: () => ["192.168.4.58"] });
    await h.run(["install"]);
    expect(h.out).toContain(
      "firewall: this machine has no tailnet address yet; start Tailscale, then run keywork node firewall",
    );
  });

  it("adds each workspace once and keeps the ones installed before", async () => {
    const h = harness();
    await h.run(["install"]);
    await h.run(["install"]);
    await h.run(["install", "--workspace", "research"]);
    expect(readNodeConfig(nodePaths(root).config).workspaces).toEqual([
      { cwd: workspace, slug: null },
      { cwd: workspace, slug: "research" },
    ]);
  });

  it("refuses a workspace that does not exist", async () => {
    const h = harness();
    expect(await h.run(["install", "--workspace", "missing"])).toBe(exitCodes.usage);
    expect(h.err[0]).toContain('no workspace named "missing"');
    expect(h.schtasks.calls).toEqual([]);
  });

  it("stops a running node and its leftover processes before replacing it", async () => {
    const h = harness({ isAlive: (pid) => pid === 5001 || pid === 5002 || pid === 5003 });
    await h.run(["install"]);
    nodeFileStore(nodePaths(root).nodeFile).write(
      recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 }),
    );
    await h.run(["install"]);
    const changes = h.schtasks.verbs().filter((verb) => verb !== "/Query");
    expect(changes).toEqual(["/Create", "/Run", "/End", "/Create", "/Run"]);
    expect(h.terminated).toEqual([5001, 5002, 5003]);
  });

  it("prints a claim code for a headless host", async () => {
    const h = harness();
    await h.run(["install", "--headless"]);
    expect(readNodeConfig(nodePaths(root).config).headless).toBe(true);
    expect(h.out).toContain(
      "pairing: claim this headless node from your console with code ABCD-EFGH-IJKL (valid until 2026-11-05T09:15:00.000Z); keywork node status shows it again",
    );
  });

  it("registers without starting when asked", async () => {
    const h = harness();
    await h.run(["install", "--no-start"]);
    expect(h.schtasks.verbs()).toEqual(["/Create"]);
    expect(h.schtasks.tasks.get("keywork node")?.state).toBe("Ready");
  });
});

describe("the node never runs as SYSTEM or root", () => {
  it("refuses --system outright", async () => {
    const h = harness();
    expect(await h.run(["install", "--system"])).toBe(exitCodes.denied);
    expect(h.err[0]).toContain(
      "never runs as SYSTEM or root (adr.node-runs-as-the-logged-in-user)",
    );
    expect(h.schtasks.calls).toEqual([]);
  });

  it("refuses to install or run from a SYSTEM session", async () => {
    const h = harness({ account: { name: "SYSTEM", domain: "NT AUTHORITY", uid: null } });
    expect(await h.run(["install"])).toBe(exitCodes.denied);
    expect(await h.run(["run", "--supervise"])).toBe(exitCodes.denied);
    expect(h.err).toEqual([
      expect.stringContaining(
        "keywork node install: the node runs as the logged-in user and never as SYSTEM",
      ),
      expect.stringContaining(
        "keywork node run: the node runs as the logged-in user and never as SYSTEM",
      ),
    ]);
    expect(h.schtasks.calls).toEqual([]);
    expect(h.processes.spawned).toEqual([]);
  });

  it("refuses root on Linux", async () => {
    const h = harness({ platform: "linux", account: { name: "root", domain: null, uid: 0 } });
    expect(await h.run(["install"])).toBe(exitCodes.denied);
    expect(h.err[0]).toContain("never as root");
  });
});

describe("keywork node install on Linux", () => {
  it("writes the user unit and enables linger only when asked", async () => {
    const unitDir = join(root, ".config", "systemd", "user");
    const systemd = new FakeSystemd(unitDir);
    const h = harness({
      platform: "linux",
      account: linuxKeeper,
      run: systemd.run,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(await h.run(["install"])).toBe(exitCodes.completed);
    expect(readFileSync(join(unitDir, defaultUnitName), "utf8")).toContain(
      "Environment=PATH=/usr/bin:/bin",
    );
    expect(systemd.lingering.size).toBe(0);
    expect(h.out.at(-1)).toContain("keywork node install --linger keeps it running");
    await h.run(["install", "--linger"]);
    expect([...systemd.lingering]).toEqual(["keeper"]);
    expect(h.out.at(-1)).toBe("note: linger is on, so the node keeps running after you log out");
  });
});

describe("keywork node uninstall", () => {
  it("removes the task, stops what it recorded, forgets node.json and keeps the config and logs", async () => {
    const h = harness({ isAlive: (pid) => pid === 5002 });
    await h.run(["install"]);
    const paths = nodePaths(root);
    nodeFileStore(paths.nodeFile).write(
      recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 }),
    );
    expect(await h.run(["uninstall"])).toBe(exitCodes.completed);
    expect(h.schtasks.tasks.size).toBe(0);
    expect(h.terminated).toEqual([5002]);
    expect(existsSync(paths.nodeFile)).toBe(false);
    expect(existsSync(paths.config)).toBe(true);
    expect(h.out).toContain("did: stopped leftover node processes 5002");
    expect(h.out.at(-1)).toContain("kept: the node config");
  });
});

async function listening(): Promise<{ server: Server; url: string }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

function closing(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function meshLogLine(at: string, event: Record<string, unknown>): string {
  return JSON.stringify({
    at,
    unit: "core",
    stream: "stdout",
    line: `mesh: ${JSON.stringify(event)}`,
  });
}

describe("keywork node status", () => {
  it("shows the registration, the node, its workspaces and how to get it back after a crash loop", async () => {
    const h = harness({ isAlive: (pid) => pid === 5001 || pid === 5002 || pid === 5003 });
    await h.run(["install"]);
    const paths = nodePaths(root);
    const served = await listening();
    nodeFileStore(paths.nodeFile).write(
      recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 }, served.url),
    );
    h.out.length = 0;
    expect(await h.run(["status"])).toBe(exitCodes.completed);
    expect(h.out[0]).toBe(
      'registration: windows-task "keywork node" is Running · logon type InteractiveToken, run level LeastPrivilege',
    );
    expect(h.out[1]).toBe(
      "node: running as pid 5001 since 2026-11-05T08:00:00.000Z · keywork 0.2.0 · machine MOAK-MAIN (m-1)",
    );
    expect(h.out).toContain(
      `workspace: ${workspace} running as pid 5003 at ${served.url} · ticket server.json`,
    );
    await closing(served.server);
    expect(h.out).toContain("core: running as pid 5002 · mesh 47800/tcp, screen 47810-47829/udp");
    expect(h.out).toContain(
      "pairing: unclaimed; no claim code is live (a headless node prints one when it starts)",
    );

    writeStoppedItem(
      paths.stoppedItem,
      nodeStoppedItem({
        machine: { id: "m-1", name: "MOAK-MAIN" },
        at: t0,
        reason: "three crashes in five minutes",
        crashes: [],
        logTail: ['{"line":"keywork serve: no model is configured"}'],
      }),
    );
    h.out.length = 0;
    await h.run(["status"]);
    expect(h.out).toContain(
      "held: the node on MOAK-MAIN stopped at 2026-11-05T09:00:00.000Z after three crashes in five minutes; keywork node reset starts it again",
    );
    expect(h.out).toContain('  {"line":"keywork serve: no model is configured"}');
  });

  it("never claims a dead node is running", async () => {
    const h = harness({ isAlive: () => false });
    nodeFileStore(nodePaths(root).nodeFile).write(
      recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 }),
    );
    await h.run(["status"]);
    expect(h.out[1]).toBe("node: node.json says running as pid 5001, but that process is gone");
  });

  it("names the tailnet addresses the mesh listener is bound on since the core started", async () => {
    const paths = nodePaths(root);
    const node = recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 });
    nodeFileStore(paths.nodeFile).write(node);
    mkdirSync(join(paths.nodeLog, ".."), { recursive: true });
    writeFileSync(
      paths.nodeLog,
      [
        meshLogLine("2026-11-05T07:00:00.000Z", {
          type: "mesh.listener.bound",
          address: "100.64.0.9",
          port: 47800,
        }),
        meshLogLine("2026-11-05T08:00:01.000Z", {
          type: "mesh.listener.bound",
          address: "100.124.48.125",
          port: 47800,
        }),
        meshLogLine("2026-11-05T08:00:01.020Z", {
          type: "mesh.listener.bound",
          address: "fd7a:115c:a1e0::8928:307e",
          port: 47800,
        }),
        meshLogLine("2026-11-05T08:00:01.030Z", {
          type: "mesh.listener.bound",
          address: "100.99.1.1",
          port: 47800,
        }),
        meshLogLine("2026-11-05T08:30:00.000Z", {
          type: "mesh.listener.unbound",
          address: "100.99.1.1",
          reason: "address-gone",
        }),
        "",
      ].join("\n"),
    );
    const probed: string[] = [];
    const report = await nodeStatus({
      paths,
      manager: undefined,
      isAlive: () => true,
      claimDesk: unclaimedDesk(),
      answers: async (host, port) => {
        probed.push(`${host}:${port}`);
        return true;
      },
    });
    expect(report.mesh.addresses).toEqual(["100.124.48.125", "fd7a:115c:a1e0::8928:307e"]);
    expect(statusLines(report)).toContain(
      "core: running as pid 5002 · mesh 47800/tcp on 100.124.48.125:47800, [fd7a:115c:a1e0::8928:307e]:47800, screen 47810-47829/udp",
    );
    expect(probed).toEqual(
      expect.arrayContaining([
        "100.124.48.125:47800",
        "fd7a:115c:a1e0::8928:307e:47800",
        "127.0.0.1:53111",
      ]),
    );
  });

  it("says stopped (stale node.json) for each unit whose pid is gone, as the node line does", async () => {
    const h = harness({ isAlive: (pid) => pid === 5001 });
    nodeFileStore(nodePaths(root).nodeFile).write(
      recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 }),
    );
    await h.run(["status"]);
    expect(h.out).toContain(
      `workspace: ${workspace} stopped (stale node.json) · ticket server.json`,
    );
    expect(h.out).toContain(
      "core: stopped (stale node.json) · mesh 47800/tcp, screen 47810-47829/udp",
    );
    h.out.length = 0;
    await h.run(["status", "--json"]);
    expect(JSON.parse(h.out.join("\n")).units).toEqual({
      core: { recorded: "running", pidAlive: false, portAnswers: null, verdict: "stale" },
      workspaces: [{ recorded: "running", pidAlive: false, portAnswers: null, verdict: "stale" }],
    });
  });

  it("says stopped (stale node.json) when the pid is alive but the port never answers", async () => {
    const paths = nodePaths(root);
    nodeFileStore(paths.nodeFile).write(
      recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 }),
    );
    const report = await nodeStatus({
      paths,
      manager: undefined,
      isAlive: () => true,
      claimDesk: unclaimedDesk(),
      answers: async () => false,
    });
    expect(report.units.workspaces).toEqual([
      { recorded: "running", pidAlive: true, portAnswers: false, verdict: "stale" },
    ]);
    expect(statusLines(report)).toContain(
      `workspace: ${workspace} stopped (stale node.json) · ticket server.json`,
    );
  });

  it("says which workspace a folder opens when it resolves to another root", async () => {
    const paths = nodePaths(root);
    nodeFileStore(paths.nodeFile).write(
      recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 }),
    );
    const report = await nodeStatus({
      paths,
      manager: undefined,
      isAlive: () => true,
      claimDesk: unclaimedDesk(),
      answers: async () => false,
      anchorOf: (cwd, slug) => ({
        cwd,
        slug,
        anchor: { root: "C:/src/stead", source: "git" },
        identity: "94b5d29c334e",
      }),
    });
    expect(statusLines(report)).toContain(
      `workspace: ${workspace} stopped (stale node.json) · opens the workspace at C:/src/stead (its git root), identity 94b5d29c334e · ticket server.json`,
    );
  });

  it("prints the whole report as JSON for scripts", async () => {
    const h = harness();
    await h.run(["status", "--json"]);
    const report = JSON.parse(h.out.join("\n"));
    expect(report).toMatchObject({
      registration: { manager: "windows-task", name: "keywork node", installed: false },
      liveness: "absent",
      held: null,
      pairing: { state: "unclaimed", claim: null },
    });
  });
});

describe("keywork node reset", () => {
  it("clears the crash-loop item and starts the task again", async () => {
    const h = harness();
    await h.run(["install", "--no-start"]);
    const paths = nodePaths(root);
    writeStoppedItem(
      paths.stoppedItem,
      nodeStoppedItem({
        machine: { id: "m-1", name: "MOAK-MAIN" },
        at: t0,
        reason: "three crashes in five minutes",
        crashes: [],
        logTail: [],
      }),
    );
    expect(await h.run(["reset"])).toBe(exitCodes.completed);
    expect(readStoppedItem(paths.stoppedItem)).toBeUndefined();
    expect(h.schtasks.tasks.get("keywork node")?.state).toBe("Running");
    expect(h.out).toContain(
      "cleared: the node on MOAK-MAIN stopped (three crashes in five minutes)",
    );
  });
});

describe("keywork node install from the console or by hand", () => {
  it("registers no workspace with --no-workspace and says how one is added", async () => {
    const h = harness();
    expect(await h.run(["install", "--no-workspace"])).toBe(exitCodes.completed);
    expect(readNodeConfig(nodePaths(root).config).workspaces).toEqual([]);
    expect(h.out).toContain(
      "serves: no workspace yet; keywork node install run inside a folder adds that folder",
    );
    expect(h.schtasks.tasks.get("keywork node")?.state).toBe("Running");
  });

  it("keeps the workspaces installed before when a later install adds none", async () => {
    const h = harness();
    await h.run(["install"]);
    await h.run(["install", "--no-workspace"], { cwd: join(root, "elsewhere") });
    expect(readNodeConfig(nodePaths(root).config).workspaces).toEqual([
      { cwd: workspace, slug: null },
    ]);
    expect(h.out.filter((line) => line === `serves: ${workspace}`)).toHaveLength(2);
  });

  it("registers the folder it stands in when run without the flag, as a keeper in a terminal does", async () => {
    const opened = join(root, "src", "garden");
    mkdirSync(opened, { recursive: true });
    const h = harness();
    await h.run(["install"], { cwd: opened });
    expect(readNodeConfig(nodePaths(root).config).workspaces).toEqual([
      { cwd: opened, slug: null },
    ]);
  });

  it("refuses a workspace and no workspace together", async () => {
    const h = harness();
    expect(await h.run(["install", "--workspace", "research", "--no-workspace"])).toBe(
      exitCodes.usage,
    );
    expect(h.err[0]).toContain("--workspace and --no-workspace ask for opposite things");
    expect(h.schtasks.calls).toEqual([]);
  });

  it("names the program the registration runs in the JSON status, for the console to compare", async () => {
    const h = harness();
    await h.run(["install", "--no-start"]);
    h.out.length = 0;
    await h.run(["status", "--json"]);
    expect(JSON.parse(h.out.join("\n")).registration).toMatchObject({
      installed: true,
      program: "C:\\bun\\bun.exe",
    });
  });
});

describe("keywork node restart", () => {
  it("ends the running task, stops what it recorded and runs the same task again", async () => {
    const h = harness({ isAlive: (pid) => pid === 5001 || pid === 5002 || pid === 5003 });
    await h.run(["install"]);
    const paths = nodePaths(root);
    nodeFileStore(paths.nodeFile).write(
      recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 }),
    );
    const config = readFileSync(paths.config, "utf8");
    const task = h.schtasks.tasks.get("keywork node")?.xml;
    const before = h.schtasks.calls.length;
    h.out.length = 0;
    expect(await h.run(["restart"])).toBe(exitCodes.completed);
    const changes = h.schtasks.calls
      .slice(before)
      .map((call) => call[1])
      .filter((verb) => verb !== "/Query");
    expect(changes).toEqual(["/End", "/Run"]);
    expect(h.terminated).toEqual([5001, 5002, 5003]);
    expect(h.schtasks.tasks.get("keywork node")).toEqual({ xml: task, state: "Running" });
    expect(readFileSync(paths.config, "utf8")).toBe(config);
    expect(h.out).toEqual([
      'did: ended the running task "keywork node"',
      "did: stopped leftover node processes 5001, 5002, 5003",
      'did: started the task "keywork node"',
    ]);
    const notes = readFileSync(paths.lifecycleLog, "utf8").trim().split("\n");
    expect(JSON.parse(notes.at(-1) ?? "")).toMatchObject({
      event: "node.restarted",
      ok: true,
      manager: "windows-task",
      reaped: [5001, 5002, 5003],
    });
  });

  it("starts a registered node that was not running", async () => {
    const h = harness();
    await h.run(["install", "--no-start"]);
    expect(await h.run(["restart"])).toBe(exitCodes.completed);
    expect(h.schtasks.verbs().filter((verb) => verb !== "/Query")).toEqual(["/Create", "/Run"]);
    expect(h.schtasks.tasks.get("keywork node")?.state).toBe("Running");
  });

  it("refuses when no node is registered and touches nothing", async () => {
    const h = harness();
    expect(await h.run(["restart"])).toBe(exitCodes.unresolved);
    expect(h.err[0]).toBe(
      "keywork node restart: the node is not installed; keywork node install sets it up",
    );
    expect(h.schtasks.verbs().filter((verb) => verb !== "/Query")).toEqual([]);
    expect(existsSync(nodePaths(root).config)).toBe(false);
  });

  it("says a node held by a crash loop stays held, and leaves the hold to reset", async () => {
    const h = harness();
    await h.run(["install"]);
    const paths = nodePaths(root);
    writeStoppedItem(
      paths.stoppedItem,
      nodeStoppedItem({
        machine: { id: "m-1", name: "MOAK-MAIN" },
        at: t0,
        reason: "three crashes in five minutes",
        crashes: [],
        logTail: [],
      }),
    );
    expect(await h.run(["restart"])).toBe(exitCodes.completed);
    expect(readStoppedItem(paths.stoppedItem)).toBeDefined();
    expect(h.out.at(-1)).toBe(
      "note: the node on MOAK-MAIN stopped after three crashes in five minutes; keywork node reset clears that and starts it",
    );
  });

  it("stops and starts the systemd user unit without rewriting it or the config", async () => {
    const unitDir = join(root, ".config", "systemd", "user");
    const systemd = new FakeSystemd(unitDir);
    const h = harness({ platform: "linux", account: linuxKeeper, run: systemd.run });
    await h.run(["install"]);
    const unit = readFileSync(join(unitDir, defaultUnitName), "utf8");
    const config = readFileSync(nodePaths(root).config, "utf8");
    const before = systemd.calls.length;
    expect(await h.run(["restart"])).toBe(exitCodes.completed);
    const verbs = systemd.calls
      .slice(before)
      .filter((call) => call[0] === "systemctl" && call[2] !== "show")
      .map((call) => call[2]);
    expect(verbs).toEqual(["stop", "reset-failed", "start"]);
    expect(systemd.active.has(defaultUnitName)).toBe(true);
    expect(readFileSync(join(unitDir, defaultUnitName), "utf8")).toBe(unit);
    expect(readFileSync(nodePaths(root).config, "utf8")).toBe(config);
  });

  it("boots the launchd agent out and loads the same plist again", async () => {
    const launchctl = new RecordedLaunchctl(keeperUid);
    const h = harness({
      platform: "darwin",
      account: { name: "keeper", domain: null, uid: keeperUid },
      run: launchctl.run,
    });
    await h.run(["install"]);
    const plist = join(root, "Library", "LaunchAgents", `${defaultAgentLabel}.plist`);
    const written = readFileSync(plist, "utf8");
    const before = launchctl.calls.length;
    expect(await h.run(["restart"])).toBe(exitCodes.completed);
    const verbs = launchctl
      .verbs()
      .slice(before)
      .filter((verb) => verb !== "print");
    expect(verbs).toEqual(["bootout", "kickstart", "bootstrap"]);
    expect(launchctl.loaded.get(defaultAgentLabel)?.printed).toBe("running");
    expect(readFileSync(plist, "utf8")).toBe(written);
  });
});

describe("keywork node run", () => {
  it("supervises the core and one keywork serve per workspace until stopped", async () => {
    const h = harness();
    await h.run(["install", "--no-start"]);
    const exit = h.run(["run", "--supervise", "--hidden"]);
    await settle(10);
    expect(h.hidden).toBe(1);
    const [core, serve] = h.processes.spawned;
    expect(core?.unit).toMatchObject({
      name: "core",
      argv: ["C:\\bun\\bun.exe", "C:\\keywork\\packages\\cli\\src\\main.ts", "node", "run"],
      cwd: nodePaths(root).state,
      env: { KEYWORK_NODE_SUPERVISOR: "999" },
    });
    expect(serve?.unit.argv.slice(2)).toEqual(["serve", "--port", "0"]);
    expect(serve?.unit.cwd).toBe(workspace);
    expect(nodeFileStore(nodePaths(root).nodeFile).read()?.state).toBe("running");
    h.stop.abort();
    expect(await exit).toBe(exitCodes.completed);
    expect(nodeFileStore(nodePaths(root).nodeFile).read()?.state).toBe("stopped");
  });

  it("runs the core until its supervisor is gone", async () => {
    const h = harness({ env: { KEYWORK_NODE_SUPERVISOR: "555" }, isAlive: () => false });
    await h.run(["install", "--no-start"]);
    const exit = h.run(["run"]);
    await settle(10);
    expect(h.core).toEqual(["composed with 1 workspace(s)", "activity.start"]);
    await h.clock.advanceTo(t0 + 5_000, () => settle());
    expect(await exit).toBe(exitCodes.completed);
    expect(h.out).toContain("node core: supervisor 555 is gone; stopping");
    expect(h.core.at(-1)).toBe("activity.stop");
  });

  it("only hides the console of the supervisor", async () => {
    const h = harness();
    expect(await h.run(["run", "--hidden"])).toBe(exitCodes.usage);
    expect(h.hidden).toBe(0);
  });
});

describe("keywork node usage", () => {
  it("refuses a missing or unknown verb and a path given as a workspace", async () => {
    const h = harness();
    expect(await h.run([])).toBe(exitCodes.usage);
    expect(await h.run(["start"])).toBe(exitCodes.usage);
    expect(await h.run(["toString"])).toBe(exitCodes.usage);
    expect(await h.run(["install", "--workspace", "C:\\src"])).toBe(exitCodes.usage);
    expect(await h.run(["status", "--bogus"])).toBe(exitCodes.usage);
    expect(h.err[1]).toContain('unknown verb "start"');
    expect(h.err.every((line) => line.includes("usage: keywork node install"))).toBe(true);
  });

  it("reports a broken node config instead of guessing", async () => {
    const h = harness();
    mkdirSync(nodePaths(root).state, { recursive: true });
    writeFileSync(nodePaths(root).config, JSON.stringify({ mesh: { port: "47800" } }));
    expect(await h.run(["install"])).toBe(exitCodes.failed);
    expect(h.err[0]).toContain("mesh.port that is not a port");
  });

  it("prints the firewall script only for Windows", async () => {
    const h = harness({ platform: "linux", account: linuxKeeper });
    expect(await h.run(["firewall"])).toBe(exitCodes.unresolved);
    expect(h.err[0]).toContain("100.64.0.0/10 and fd7a:115c:a1e0::/48");
  });
});

describe("keywork node workspace", () => {
  function folder(name: string): string {
    const path = join(root, "src", name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  function opens(): Record<string, { at: string; console: number | null }> {
    return JSON.parse(readFileSync(nodePaths(root).opens, "utf8"));
  }

  it("adds the folder the console names, records the open and the console holding it", async () => {
    const h = harness();
    const notes = folder("notes");
    expect(await h.run(["workspace", "add", notes, "--console", "7300"])).toBe(exitCodes.completed);
    expect(readNodeConfig(nodePaths(root).config).workspaces).toEqual([{ cwd: notes, slug: null }]);
    expect(Object.values(opens())).toEqual([{ at: "2026-11-05T09:00:00.000Z", console: 7300 }]);
    expect(h.out[0]).toBe(`serves: ${notes}`);
    expect(h.out[1]).toMatch(/^ticket: .*server\.json$/);
    expect(h.out[2]).toBe(
      "note: the node is not running here; it takes the change when it next starts (keywork node install sets it up)",
    );
  });

  it("adds the folder it stands in when none is named, once", async () => {
    const h = harness({ isAlive: (pid) => pid === 5001 });
    nodeFileStore(nodePaths(root).nodeFile).write(
      recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 }),
    );
    await h.run(["workspace", "add"]);
    h.out.length = 0;
    expect(await h.run(["workspace", "add"])).toBe(exitCodes.completed);
    expect(readNodeConfig(nodePaths(root).config).workspaces).toEqual([
      { cwd: workspace, slug: null },
    ]);
    expect(h.out[0]).toBe(`serves already: ${workspace}`);
    expect(h.out[2]).toBe(
      "node: running as pid 5001; it starts serving it now, or wakes it if it was parked",
    );
  });

  it("refuses a folder that is not there, a console that is not a pid, and an unknown action", async () => {
    const h = harness();
    expect(await h.run(["workspace", "add", join(root, "absent")])).toBe(exitCodes.usage);
    expect(h.err[0]).toContain("no folder at");
    expect(await h.run(["workspace", "add", "--console", "me"])).toBe(exitCodes.usage);
    expect(await h.run(["workspace", "remove", "--console", "7300"])).toBe(exitCodes.usage);
    expect(await h.run(["install", "--console", "7300"])).toBe(exitCodes.usage);
    expect(await h.run(["workspace", "open"])).toBe(exitCodes.usage);
    expect(await h.run(["workspace"])).toBe(exitCodes.usage);
    expect(await h.run(["workspace", "list", "C:src"])).toBe(exitCodes.usage);
    expect(h.err.slice(1)).toEqual([
      expect.stringContaining("--console names a process id"),
      expect.stringContaining("--console only applies to workspace add"),
      expect.stringContaining("--console only applies to workspace add"),
      expect.stringContaining('unknown workspace action "open"'),
      expect.stringContaining("add, remove or list"),
      expect.stringContaining("unexpected C:src"),
    ]);
    expect(existsSync(nodePaths(root).config)).toBe(false);
  });

  it("removes a served folder and its open, and changes nothing for one it does not serve", async () => {
    const h = harness();
    const notes = folder("notes");
    await h.run(["workspace", "add", notes]);
    await h.run(["workspace", "add"]);
    h.out.length = 0;
    expect(await h.run(["workspace", "remove", notes])).toBe(exitCodes.completed);
    expect(readNodeConfig(nodePaths(root).config).workspaces).toEqual([
      { cwd: workspace, slug: null },
    ]);
    expect(Object.keys(opens())).toHaveLength(1);
    expect(h.out[0]).toBe(
      `stopped serving: ${notes}; the folder and what it holds stay as they are`,
    );
    h.out.length = 0;
    expect(await h.run(["workspace", "remove", notes])).toBe(exitCodes.completed);
    expect(h.out).toEqual([`not served: ${notes}; nothing to stop`]);
  });

  it("lists the served folders with what the running node is doing with each, parked included", async () => {
    const h = harness({ isAlive: (pid) => pid === 5001 });
    const notes = folder("notes");
    await h.run(["workspace", "add"]);
    await h.run(["workspace", "add", notes]);
    const node = recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 });
    nodeFileStore(nodePaths(root).nodeFile).write({
      ...node,
      workspaces: node.workspaces.map((view) => ({ ...view, state: "parked", url: null })),
    });
    h.out.length = 0;
    expect(await h.run(["workspace", "list"])).toBe(exitCodes.completed);
    expect(h.out).toEqual([
      `serves: ${workspace} · parked`,
      `serves: ${notes} · waiting for the node`,
    ]);
    h.out.length = 0;
    await h.run(["workspace", "list", "--json"]);
    expect(JSON.parse(h.out.join("\n"))).toEqual({
      running: true,
      workspaces: [
        { cwd: workspace, slug: null, state: "parked", url: null },
        { cwd: notes, slug: null, state: "waiting for the node", url: null },
      ],
    });
  });

  it("says parked in node status for a workspace the node parked", async () => {
    const h = harness({ isAlive: (pid) => pid === 5001 });
    const node = recordedNode({ supervisor: 5001, core: 5002, workspace: 5003 });
    nodeFileStore(nodePaths(root).nodeFile).write({
      ...node,
      workspaces: node.workspaces.map((view) => ({
        ...view,
        state: "parked",
        pid: null,
        url: null,
      })),
    });
    await h.run(["status"]);
    expect(h.out).toContain(`workspace: ${workspace} parked · ticket server.json`);
  });

  it("is picked up by the running node: a folder added starts and a folder removed stops", async () => {
    let heard: (file: string) => void = () => {};
    let watched = "";
    const h = harness({
      watchFolder: (where, changed) => {
        watched = where;
        heard = changed;
        return () => {};
      },
    });
    await h.run(["install", "--no-start"]);
    const exit = h.run(["run", "--supervise"]);
    await settle(10);
    expect(watched).toBe(nodePaths(root).state);
    const notes = folder("notes");
    await h.run(["workspace", "add", notes]);
    heard("task.xml");
    await settle(10);
    expect(h.processes.spawned.some((child) => child.unit.cwd === notes)).toBe(false);
    heard("config.json");
    await settle(10);
    const started = h.processes.spawned.find((child) => child.unit.cwd === notes);
    expect(started?.unit.argv.slice(2)).toEqual(["serve", "--port", "0"]);
    expect(
      nodeFileStore(nodePaths(root).nodeFile)
        .read()
        ?.workspaces.map((view) => view.cwd),
    ).toEqual([workspace, notes]);
    await h.run(["workspace", "remove", notes]);
    heard("config.json");
    await settle(10);
    expect(started?.running).toBe(false);
    expect(
      nodeFileStore(nodePaths(root).nodeFile)
        .read()
        ?.workspaces.map((view) => view.cwd),
    ).toEqual([workspace]);
    h.stop.abort();
    expect(await exit).toBe(exitCodes.completed);
  });
});
