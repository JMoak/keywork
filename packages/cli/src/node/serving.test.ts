import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../../engine/src/routines/testing.ts";
import { defaultNodeConfig, withoutWorkspace, withWorkspace } from "./config.ts";
import { type FolderOpens, heldByConsole, opensStore } from "./opens.ts";
import { type ServedSource, Serving, watchFolder, workspaceInUse } from "./serving.ts";
import { Supervisor, type SupervisorEvent, type UnitSpec } from "./supervisor.ts";
import { FakeProcesses, settle } from "./testing.ts";
import type { WorkspaceUnit } from "./units.ts";

const t0 = Date.parse("2026-11-07T09:00:00Z");
const minute = 60_000;
const hour = 60 * minute;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keywork-node-serving-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const core: UnitSpec = { name: "core", argv: ["bun", "main.ts", "node", "run"], cwd: "/state" };

function served(folder: string, identity: string): WorkspaceUnit {
  return {
    workspace: { cwd: folder, slug: null },
    identity,
    ticket: `/home/keeper/.keywork/workspaces/${identity}/server.json`,
    spec: {
      name: `workspace:${identity}`,
      argv: ["bun", "main.ts", "serve", "--port", "0"],
      cwd: folder,
    },
  };
}

const stead = served("/src/stead", "aaa111");
const notes = served("/src/notes", "bbb222");

interface Rig {
  clock: FakeClock;
  processes: FakeProcesses;
  supervisor: Supervisor;
  serving: Serving;
  events: SupervisorEvent[];
  said: string[];
  changed(): Promise<void>;
  advance(ms: number): Promise<void>;
  setServed(units: readonly WorkspaceUnit[]): void;
  breakServed(problem: string): void;
  open(unit: WorkspaceUnit, at: number, console?: number): void;
  inUse: Set<string>;
  alive: Set<number>;
  stop(): Promise<void>;
}

async function serving(initial: readonly WorkspaceUnit[] = [stead]): Promise<Rig> {
  const clock = new FakeClock(t0);
  const processes = new FakeProcesses();
  const events: SupervisorEvent[] = [];
  const said: string[] = [];
  const inUse = new Set<string>();
  const alive = new Set<number>();
  let units: readonly WorkspaceUnit[] = initial;
  let opens: FolderOpens = {};
  let broken: string | undefined;
  let notify = (): void => {};
  const source: ServedSource = {
    read: () => {
      if (broken !== undefined) throw new Error(broken);
      return { workspaces: units, opens };
    },
    watch: (changed) => {
      notify = changed;
      return () => {
        notify = () => {};
      };
    },
    inUse: async (unit) => inUse.has(unit.identity),
  };
  const supervisor = new Supervisor({
    units: [core, ...initial.map((unit) => unit.spec)],
    spawn: processes.spawn,
    clock,
    onEvent: (event) => events.push(event),
  });
  const stopping = new AbortController();
  const outcome = supervisor.run(stopping.signal);
  const keeper = new Serving({
    supervisor,
    source,
    workspaces: initial,
    clock,
    isAlive: (pid) => alive.has(pid),
    say: (line) => said.push(line),
  });
  const unwatch = keeper.start();
  await settle();
  return {
    clock,
    processes,
    supervisor,
    serving: keeper,
    events,
    said,
    inUse,
    alive,
    changed: async () => {
      notify();
      await settle(10);
    },
    advance: (ms) => clock.advanceTo(clock.now() + ms, () => settle(10)),
    setServed: (next) => {
      units = next;
    },
    breakServed: (problem) => {
      broken = problem;
    },
    open: (unit, at, console) => {
      opens = {
        ...opens,
        [unit.identity]: { at: new Date(at).toISOString(), console: console ?? null },
      };
    },
    stop: async () => {
      unwatch();
      stopping.abort();
      await outcome;
    },
  };
}

function stateOf(rig: Rig, unit: WorkspaceUnit): string | undefined {
  return rig.supervisor.status().get(unit.spec.name)?.state;
}

describe("the node serves the folders it is told to while it runs", () => {
  it("starts a workspace added to the served set without a restart", async () => {
    const rig = await serving();
    expect(rig.processes.of(notes.spec.name)).toHaveLength(0);
    rig.setServed([stead, notes]);
    await rig.changed();
    expect(rig.processes.latest(notes.spec.name).unit.cwd).toBe("/src/notes");
    expect(stateOf(rig, notes)).toBe("running");
    expect(rig.processes.of("core")).toHaveLength(1);
    expect(rig.processes.of(stead.spec.name)).toHaveLength(1);
    expect(rig.serving.workspaces().map((unit) => unit.identity)).toEqual(["aaa111", "bbb222"]);
    expect(rig.events.map((event) => event.event)).toContain("unit.added");
    await rig.stop();
  });

  it("stops a removed workspace's server and forgets it, leaving the others running", async () => {
    const rig = await serving([stead, notes]);
    const notesChild = rig.processes.latest(notes.spec.name);
    rig.setServed([stead]);
    await rig.changed();
    expect(notesChild.running).toBe(false);
    expect(notesChild.stopRequests).toBe(1);
    expect(rig.supervisor.status().has(notes.spec.name)).toBe(false);
    expect(rig.processes.latest(stead.spec.name).running).toBe(true);
    expect(rig.serving.workspaces().map((unit) => unit.identity)).toEqual(["aaa111"]);
    await rig.advance(10 * minute);
    expect(rig.processes.of(notes.spec.name)).toHaveLength(1);
    expect(rig.events.some((event) => event.event === "unit.exited")).toBe(false);
    await rig.stop();
  });

  it("parks a workspace after an hour with no console, creature or chore, then starts it on the next open", async () => {
    const rig = await serving([stead]);
    const first = rig.processes.latest(stead.spec.name);
    await rig.advance(55 * minute);
    expect(stateOf(rig, stead)).toBe("running");
    await rig.advance(10 * minute);
    expect(stateOf(rig, stead)).toBe("parked");
    expect(first.running).toBe(false);
    expect(rig.serving.workspaces().map((unit) => unit.identity)).toEqual(["aaa111"]);
    await rig.advance(hour);
    expect(rig.processes.of(stead.spec.name)).toHaveLength(1);
    rig.open(stead, rig.clock.now());
    await rig.changed();
    expect(stateOf(rig, stead)).toBe("running");
    expect(rig.processes.of(stead.spec.name)).toHaveLength(2);
    expect(rig.events.map((event) => event.event)).toEqual(
      expect.arrayContaining(["unit.parked", "unit.woken"]),
    );
    await rig.stop();
  });

  it("never parks a workspace a living console holds open", async () => {
    const rig = await serving([stead]);
    rig.open(stead, t0, 7300);
    rig.alive.add(7300);
    await rig.changed();
    await rig.advance(3 * hour);
    expect(stateOf(rig, stead)).toBe("running");
    rig.alive.delete(7300);
    await rig.advance(55 * minute);
    expect(stateOf(rig, stead)).toBe("running");
    await rig.advance(10 * minute);
    expect(stateOf(rig, stead)).toBe("parked");
    await rig.stop();
  });

  it("never parks a workspace with a creature or a chore", async () => {
    const rig = await serving([stead]);
    rig.inUse.add("aaa111");
    await rig.advance(3 * hour);
    expect(stateOf(rig, stead)).toBe("running");
    await rig.stop();
  });

  it("keeps serving what runs when the served set cannot be read", async () => {
    const rig = await serving([stead]);
    rig.breakServed("node config at config.json is not valid JSON");
    await rig.changed();
    expect(stateOf(rig, stead)).toBe("running");
    expect(rig.said).toEqual([
      "serving: the served folders could not be read, so nothing changed: node config at config.json is not valid JSON",
    ]);
    await rig.stop();
  });
});

describe("the served set on disk", () => {
  it("removes one workspace and keeps the rest, and leaves the config as it was when absent", () => {
    const config = withWorkspace(
      withWorkspace(defaultNodeConfig(), { cwd: join(dir, "a"), slug: null }),
      { cwd: join(dir, "b"), slug: null },
    );
    const without = withoutWorkspace(config, { cwd: join(dir, "a"), slug: null });
    expect(without.workspaces).toEqual([{ cwd: join(dir, "b"), slug: null }]);
    expect(withoutWorkspace(without, { cwd: join(dir, "a"), slug: null })).toBe(without);
    expect(withoutWorkspace(config, { cwd: join(dir, "a"), slug: "notes" })).toBe(config);
  });

  it("records each folder open with the console that holds it and forgets it on removal", () => {
    const store = opensStore(join(dir, "opens.json"));
    expect(store.read()).toEqual({});
    store.record("aaa111", { at: "2026-11-07T09:00:00.000Z", console: 7300 });
    store.record("bbb222", { at: "2026-11-07T09:01:00.000Z", console: null });
    store.forget("aaa111");
    expect(store.read()).toEqual({ bbb222: { at: "2026-11-07T09:01:00.000Z", console: null } });
    writeFileSync(join(dir, "opens.json"), "{ not json");
    expect(store.read()).toEqual({});
  });

  it("holds a folder only while its console process lives", () => {
    const open = { at: "2026-11-07T09:00:00.000Z", console: 7300 };
    expect(heldByConsole(open, (pid) => pid === 7300)).toBe(true);
    expect(heldByConsole(open, () => false)).toBe(false);
    expect(heldByConsole({ ...open, console: null }, () => true)).toBe(false);
    expect(heldByConsole(undefined, () => true)).toBe(false);
  });

  it("tells the node when a file in its state folder changes", async () => {
    const heard = new Promise<string>((resolve) => {
      const unwatch = watchFolder(dir, (file) => {
        unwatch();
        resolve(file);
      });
    });
    writeFileSync(join(dir, "config.json"), "{}\n");
    expect(await heard).toBe("config.json");
  });
});

describe("whether a served workspace is in use", () => {
  function ticketFile(): string {
    const file = join(dir, "server.json");
    writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:53111", token: "t0ken" }));
    return file;
  }

  function answering(creatures: number, working: boolean): typeof fetch {
    return (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/creatures") {
        return Response.json({ creatures: Array.from({ length: creatures }, () => ({})) });
      }
      return Response.json({ sessions: [{ id: "s1", working }] });
    }) as typeof fetch;
  }

  it("is in use with a creature or a working session, and idle with neither", async () => {
    const unit = { ticket: ticketFile() };
    expect(await workspaceInUse(unit, answering(1, false))).toBe(true);
    expect(await workspaceInUse(unit, answering(0, true))).toBe(true);
    expect(await workspaceInUse(unit, answering(0, false))).toBe(false);
  });

  it("counts a server without creatures as having none, and a missing ticket as in use", async () => {
    const unit = { ticket: ticketFile() };
    const noCreatures = (async (input: string | URL | Request) =>
      new URL(String(input)).pathname === "/creatures"
        ? new Response("{}", { status: 503 })
        : Response.json({ sessions: [] })) as typeof fetch;
    expect(await workspaceInUse(unit, noCreatures)).toBe(false);
    expect(await workspaceInUse({ ticket: join(dir, "absent.json") }, answering(0, false))).toBe(
      true,
    );
  });
});
