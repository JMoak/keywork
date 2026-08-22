import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySearch, type MemoryStore, SessionStore, textMessage } from "@keywork/engine";
import { afterEach, describe, expect, it } from "vitest";
import { type ArcService, arcService, arcsUnavailable } from "./arcs.ts";
import { openWorkspaceMemory, type WorkspaceMemory } from "./memory.ts";
import { boundSessionCounts, sessionPort } from "./sessions.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "keywork-cli-arcs-"));
  tempDirs.push(dir);
  return dir;
}

async function declaredWorkspace(): Promise<string> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "fixture" }));
  return cwd;
}

interface World {
  cwd: string;
  sessionDir: string;
  memory: WorkspaceMemory | undefined;
  arcs: ArcService;
}

async function worldOf(options: { trusted?: boolean; declared?: boolean } = {}): Promise<World> {
  const cwd = options.declared === false ? await tempDir() : await declaredWorkspace();
  const sessionDir = join(cwd, "sessions");
  const trusted = options.trusted ?? true;
  const memory = openWorkspaceMemory(cwd, trusted);
  const arcs = arcService({
    cwd,
    trusted,
    memory: () => memory,
    boundSessionCounts: () => boundSessionCounts(sessionDir),
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  return { cwd, sessionDir, memory, arcs };
}

describe("arcService availability", () => {
  it("lists nothing and refuses to create without a declared workspace", async () => {
    const { arcs } = await worldOf({ declared: false });
    expect(await arcs.port.list()).toEqual([]);
    await expect(arcs.port.create("dock-v2")).rejects.toThrow(arcsUnavailable);
    expect(arcs.registry()).toBeUndefined();
  });

  it("stays inert in an untrusted workspace", async () => {
    const { arcs } = await worldOf({ trusted: false });
    expect(await arcs.port.list()).toEqual([]);
    await expect(arcs.port.create("dock-v2")).rejects.toThrow(arcsUnavailable);
  });

  it("finds the vault lazily, so a workspace materialized mid-session starts working", async () => {
    const cwd = await tempDir();
    const arcs = arcService({
      cwd,
      trusted: true,
      memory: () => undefined,
      boundSessionCounts: async () => new Map(),
    });
    expect(await arcs.port.list()).toEqual([]);
    await mkdir(join(cwd, ".keywork", "memory"), { recursive: true });
    await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "late" }));
    await arcs.port.create("late-arc");
    expect((await arcs.port.list()).map((arc) => arc.slug)).toEqual(["late-arc"]);
  });
});

describe("arcService lifecycle", () => {
  it("creates arcs in the vault and counts the sessions bound to each", async () => {
    const { arcs, sessionDir, cwd } = await worldOf();
    const created = await arcs.port.create("dock-v2");
    expect(created).toMatchObject({ slug: "dock-v2", status: "active", sessions: 0 });
    expect(await readdir(join(cwd, ".keywork", "memory", "arcs", "dock-v2"))).toContain("MOC.md");

    const port = sessionPort(sessionDir, cwd, {
      onAttach: (store) => arcs.attached(store),
      onArcBound: (id, arc) => arcs.recordBinding(id, arc),
    });
    const first = await port.create();
    const second = await port.create();
    await first?.append(textMessage("user", "one"));
    await second?.append(textMessage("user", "two"));
    await first?.bindArc?.("dock-v2");
    await second?.bindArc?.("dock-v2");

    expect(await arcs.port.list()).toEqual([
      { slug: "dock-v2", status: "active", created: "2026-08-21T12:00:00.000Z", sessions: 2 },
    ]);
    expect(arcs.bindings.sessionsBoundTo("dock-v2").sort()).toEqual([first?.id, second?.id].sort());
  });

  it("notifies subscribers on create, bind, close, and abandon", async () => {
    const { arcs } = await worldOf();
    let notified = 0;
    const stop = arcs.port.subscribe?.(() => {
      notified += 1;
    });
    await arcs.port.create("a");
    arcs.recordBinding("s1", "a");
    await arcs.port.close("a");
    await arcs.port.create("b");
    await arcs.port.abandon("b");
    expect(notified).toBe(5);
    stop?.();
    await arcs.port.create("c");
    expect(notified).toBe(5);
  });

  it("closes a clean arc straight through the airlock and releases its sessions", async () => {
    const { arcs } = await worldOf();
    await arcs.port.create("dock-v2");
    arcs.recordBinding("s1", "dock-v2");
    const outcome = await arcs.port.close("dock-v2");
    expect(outcome).toEqual({ kind: "closed", delivered: 0, released: 1 });
    expect((await arcs.port.list())[0]?.status).toBe("archived");
    expect(arcs.bindings.bindingOf("s1")).toBeUndefined();
  });

  it("leaves an arc with notes waiting at the airlock and opens the inbox door", async () => {
    const { arcs, memory } = await worldOf();
    await arcs.port.create("dock-v2");
    await arcs
      .registry()
      ?.arcStore("dock-v2")
      .writeNote({ title: "Dock Rule", body: "two docks max\n", provenance: "agent" });
    arcs.recordBinding("s1", "dock-v2");

    const outcome = await arcs.port.close("dock-v2");

    expect(outcome).toEqual({ kind: "pending", candidates: 1, questions: 0, wedged: 1 });
    expect((await arcs.port.list())[0]?.status).toBe("active");
    const inbox = await memory?.inbox.list();
    expect(inbox?.map((item) => item.kind)).toEqual(["arc-distillation"]);
  });

  async function boundWorld(): Promise<World & { sessionId: string; file: string }> {
    const world = await worldOf();
    await world.arcs.port.create("dock-v2");
    const port = sessionPort(world.sessionDir, world.cwd, {
      onAttach: (store) => world.arcs.attached(store),
      onArcBound: (id, arc) => world.arcs.recordBinding(id, arc),
    });
    const attached = await port.create();
    if (attached === undefined) throw new Error("expected a session");
    await attached.append(textMessage("user", "bound work"));
    await attached.bindArc?.("dock-v2");
    const [file] = await readdir(world.sessionDir);
    return { ...world, sessionId: attached.id, file: join(world.sessionDir, file ?? "") };
  }

  async function relaunchedBindingOf(world: World, file: string): Promise<string | undefined> {
    const relaunched = arcService({
      cwd: world.cwd,
      trusted: true,
      memory: () => world.memory,
      boundSessionCounts: () => boundSessionCounts(world.sessionDir),
    });
    const store = await SessionStore.open(file);
    relaunched.attached(store);
    return relaunched.bindings.bindingOf(store.header.id);
  }

  it("persists the release on close so a relaunch sees the session unbound", async () => {
    const world = await boundWorld();
    expect(await boundSessionCounts(world.sessionDir)).toEqual(new Map([["dock-v2", 1]]));

    expect(await world.arcs.port.close("dock-v2")).toEqual({
      kind: "closed",
      delivered: 0,
      released: 1,
    });

    expect(await boundSessionCounts(world.sessionDir)).toEqual(new Map());
    expect(await relaunchedBindingOf(world, world.file)).toBeUndefined();
    expect((await world.arcs.port.list())[0]?.sessions).toBe(0);
  });

  it("persists the release on abandon too", async () => {
    const world = await boundWorld();

    await world.arcs.port.abandon("dock-v2");

    expect(await boundSessionCounts(world.sessionDir)).toEqual(new Map());
    expect(await relaunchedBindingOf(world, world.file)).toBeUndefined();
    expect(world.arcs.bindings.bindingOf(world.sessionId)).toBeUndefined();
  });

  it("abandon archives in place without deleting the arc layer", async () => {
    const { arcs, cwd } = await worldOf();
    await arcs.port.create("dock-v2");
    await arcs.port.abandon("dock-v2");
    expect((await arcs.port.list())[0]?.status).toBe("archived");
    const moc = await readFile(
      join(cwd, ".keywork", "memory", "arcs", "dock-v2", "MOC.md"),
      "utf8",
    );
    expect(moc).toContain("abandoned: true");
  });
});

describe("arcService as the memory layer", () => {
  it("seeds bindings from a session's persisted entry on attach and drops them on release", async () => {
    const { arcs, sessionDir, cwd } = await worldOf();
    await arcs.port.create("infra");
    const file = join(sessionDir, "bound.jsonl");
    const store = await SessionStore.create(file, cwd);
    await store.appendArcBinding("infra");

    arcs.attached(await SessionStore.open(file));
    expect(arcs.bindings.bindingOf(store.header.id)).toBe("infra");
    expect(arcs.layerStoreFor(store.header.id)).toBeDefined();

    arcs.released(store.header.id);
    expect(arcs.bindings.bindingOf(store.header.id)).toBeUndefined();
    expect(arcs.layerStoreFor(store.header.id)).toBeUndefined();
  });

  it("points a bound session's flush at the arc layer", async () => {
    const { arcs, cwd } = await worldOf();
    await arcs.port.create("infra");
    arcs.recordBinding("s1", "infra");
    const layer = arcs.layerStoreFor("s1") as MemoryStore;
    await layer.appendDaily("learned about the arc", "agent");
    const dailyDir = join(cwd, ".keywork", "memory", "arcs", "infra", "daily");
    expect((await readdir(dailyDir)).length).toBe(1);
  });

  it("recalls the active arc's notes on top of the workspace garden, and only the workspace when unbound", async () => {
    const { arcs, memory } = await worldOf();
    if (memory === undefined) throw new Error("expected workspace memory");
    await memory.store.writeNote({
      title: "Shared Rule",
      body: "dock rule shared\n",
      provenance: "user",
    });
    await arcs.port.create("infra");
    await arcs
      .registry()
      ?.arcStore("infra")
      .writeNote({ title: "Infra Rule", body: "dock rule for infra\n", provenance: "user" });
    const workspace = new MemorySearch(memory.store);

    const unbound = await arcs.searcher(workspace, "s1").search("dock rule");
    expect(unbound.hits.map((hit) => hit.note.name)).toEqual(["Shared Rule"]);

    arcs.recordBinding("s1", "infra");
    const bound = await arcs.searcher(workspace, () => "s1").search("dock rule");
    expect(bound.hits.map((hit) => hit.note.name).sort()).toEqual(["Infra Rule", "Shared Rule"]);
  });
});
