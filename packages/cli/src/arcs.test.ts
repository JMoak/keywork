import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  closingJudgment,
  IneligibleDeliveryError,
  MemorySearch,
  type MemoryStore,
  MissingSuccessorError,
  type Provider,
  SessionStore,
  type TurnDelta,
  textMessage,
} from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import {
  type ArcService,
  type ArcServiceOptions,
  arcService,
  arcsUnavailable,
  type ClosingRequest,
} from "./arcs.ts";
import {
  arcLayerId,
  type CitationTrail,
  citationTrail,
  openWorkspaceMemory,
  type WorkspaceMemory,
} from "./memory.ts";
import { boundSessionCounts, sessionPort } from "./sessions/ports.ts";

const tempDir = scratchDirs("keywork-cli-arcs-");

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
  released: string[];
}

async function worldOf(options: { trusted?: boolean; declared?: boolean } = {}): Promise<World> {
  const cwd = options.declared === false ? await tempDir() : await declaredWorkspace();
  const sessionDir = join(cwd, "sessions");
  const trusted = options.trusted ?? true;
  const memory = openWorkspaceMemory(cwd, trusted);
  const released: string[] = [];
  const arcs = arcService({
    cwd,
    trusted,
    memory: () => memory,
    boundSessionCounts: () => boundSessionCounts(sessionDir),
    onReleased: (sessionId) => released.push(sessionId),
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  });
  return { cwd, sessionDir, memory, arcs, released };
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
    const inbox = await memory?.store.listStaged();
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
    expect(world.released).toEqual([world.sessionId]);
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

describe("the airlock surface (J18)", () => {
  const closeTime = "2026-08-21T12:00:00.000Z";

  function citeArcNote(citations: CitationTrail, session: string, note: string): void {
    const ledger = citations.forSession(session);
    ledger.recordRecall(note, "search", arcLayerId("dock-v2"));
    ledger.recordReply(`per [[${note}]]`);
  }

  async function airlockWorld(
    options: { wedge?: string; closing?: ArcServiceOptions["closing"] } = {},
  ) {
    const base = await worldOf();
    const memory = base.memory;
    if (memory === undefined) throw new Error("expected workspace memory");
    const flushed: string[] = [];
    const citations = citationTrail(() => memory);
    const arcs: ArcService = arcService({
      cwd: base.cwd,
      trusted: true,
      memory: () => memory,
      boundSessionCounts: () => boundSessionCounts(base.sessionDir),
      now: () => new Date(closeTime),
      citedNotes: (slug) => citations.citedNotes(slug),
      flushFor: (sessionId) => {
        if (sessionId === options.wedge) return undefined;
        return async () => {
          flushed.push(sessionId);
          await arcs.layerStoreFor(sessionId)?.appendDaily(`flushed by ${sessionId}`, "agent");
        };
      },
      ...(options.closing !== undefined && { closing: options.closing }),
    });
    const registry = arcs.registry();
    if (registry === undefined) throw new Error("expected a registry");
    await arcs.port.create("dock-v2");
    await arcs.port.create("next-arc");
    const layer = registry.arcStore("dock-v2");
    await layer.writeNote({
      title: "Dock Ratio Finding",
      body: "Docks split 50/50 by default.\n",
      provenance: "agent",
    });
    await layer.writeNote({
      title: "Uncited Hunch",
      body: "Thirds, maybe.\n",
      provenance: "agent",
    });
    citeArcNote(citations, "s1", "Dock Ratio Finding");
    const questions = registry.openQuestions("dock-v2");
    for (const title of ["Tie order", "Theme drift", "Old worry"]) {
      await questions.add({ title, body: `${title}?`, provenance: "user" });
    }
    arcs.recordBinding("s1", "dock-v2");
    arcs.recordBinding("s2", "dock-v2");
    const airlock = arcs.port.airlock;
    if (airlock === undefined) throw new Error("expected the airlock port");
    return { ...base, memory, arcs, registry, airlock, flushed, citations };
  }

  it("flips eligibility when the citation trail says a note was cited (J13)", async () => {
    const { arcs, airlock, citations } = await airlockWorld();
    await arcs.port.close("dock-v2");
    const before = await airlock.digest("dock-v2");
    expect(before?.candidates.map((c) => [c.note, c.eligible])).toEqual([
      ["Dock Ratio Finding", true],
      ["Uncited Hunch", false],
    ]);

    citeArcNote(citations, "s2", "Uncited Hunch");

    const after = await airlock.digest("dock-v2");
    expect(after?.candidates.map((c) => [c.note, c.eligible])).toEqual([
      ["Dock Ratio Finding", true],
      ["Uncited Hunch", true],
    ]);
  });

  it("never grants eligibility from a citation of a note that was not recalled (R6)", async () => {
    const { arcs, airlock, citations } = await airlockWorld();
    await arcs.port.close("dock-v2");
    const outcome = citations.forSession("s2").recordReply("surely [[Uncited Hunch]] holds");
    expect(outcome.rejected).toEqual(["Uncited Hunch"]);
    const digest = await airlock.digest("dock-v2");
    expect(digest?.candidates.find((c) => c.note === "Uncited Hunch")?.eligible).toBe(false);
  });

  it("closing sweeps every live session, stages the digest, and finishes only once each item is decided", async () => {
    const { arcs, airlock, memory, registry, flushed, cwd } = await airlockWorld();

    expect(await arcs.port.close("dock-v2")).toEqual({
      kind: "pending",
      candidates: 2,
      questions: 3,
      wedged: 0,
    });
    expect(flushed.sort()).toEqual(["s1", "s2"]);
    const arcDaily = await registry.arcStore("dock-v2").readDaily("2026-08-21");
    expect(arcDaily.map((entry) => entry.text).sort()).toEqual(["flushed by s1", "flushed by s2"]);

    const digest = await airlock.digest("dock-v2");
    expect(digest?.sweep).toEqual({ acked: 2, wedged: 0 });
    expect(digest?.candidates.map((c) => [c.note, c.eligible, c.shortfalls])).toEqual([
      ["Dock Ratio Finding", true, []],
      ["Uncited Hunch", false, ["uncited"]],
    ]);
    expect(digest?.questions.map((q) => q.title).sort()).toEqual([
      "Old worry",
      "Theme drift",
      "Tie order",
    ]);
    expect(await airlock.digest("next-arc")).toBeUndefined();

    const undecided = await airlock.finish("dock-v2");
    expect(undecided.kind).toBe("undecided");
    expect(undecided.kind === "undecided" && [...undecided.items].sort()).toEqual([
      "Dock Ratio Finding",
      "Old worry",
      "Theme drift",
      "Tie order",
    ]);
    expect((await airlock.digest("dock-v2"))?.candidates.map((c) => c.choice)).toEqual([
      undefined,
      "leave",
    ]);
    await expect(airlock.triageCandidate("dock-v2", "Uncited Hunch", "deliver")).rejects.toThrow(
      IneligibleDeliveryError,
    );
    expect(await airlock.deliverEligible("dock-v2")).toBe(1);
    await airlock.triageQuestion("dock-v2", "Tie order", "resolve");
    await airlock.triageQuestion("dock-v2", "Theme drift", "carry");
    await airlock.triageQuestion("dock-v2", "Old worry", "drop");
    const decided = await airlock.digest("dock-v2");
    expect(decided?.successor).toBe("next-arc");
    expect(decided?.candidates.map((c) => c.choice)).toEqual(["deliver", "leave"]);
    expect(new Map(decided?.questions.map((q) => [q.title, q.choice]))).toEqual(
      new Map([
        ["Tie order", "resolve"],
        ["Theme drift", "carry"],
        ["Old worry", "drop"],
      ]),
    );

    expect(await airlock.finish("dock-v2")).toEqual({ kind: "closed", delivered: 1, released: 2 });
    expect(flushed).toHaveLength(2);

    const delivered = await memory.store.readNote("Dock Ratio Finding");
    expect(delivered?.delivered).toBe(closeTime);
    expect(delivered?.frontmatter.valid_from).toBe(closeTime);
    expect(delivered?.distilledFrom).toBe("arcs/dock-v2/MOC");
    expect(delivered?.links).toContain("arc dock-v2 delivery");
    const record = await memory.store.readNote("arc dock-v2 delivery");
    expect(record?.links).toEqual(
      expect.arrayContaining(["Dock Ratio Finding", "arcs/dock-v2/MOC"]),
    );
    expect(await memory.store.readNote("Uncited Hunch")).toBeUndefined();
    expect(await registry.arcStore("dock-v2").readNote("Uncited Hunch")).toBeDefined();
    const dailyLines: string[] = [];
    for (const date of await memory.store.listDailyDates()) {
      dailyLines.push(...(await memory.store.readDaily(date)).map((entry) => entry.text));
    }
    expect(dailyLines).toContain("arc dock-v2 delivered · distilled 1 notes");
    const statuses = new Map(
      (await registry.openQuestions("dock-v2").list()).map((q) => [q.title, q.status]),
    );
    expect(statuses).toEqual(
      new Map([
        ["Tie order", "resolved"],
        ["Theme drift", "carried"],
        ["Old worry", "dropped"],
      ]),
    );
    expect((await registry.openQuestions("next-arc").open()).map((q) => q.title)).toEqual([
      "Theme drift",
    ]);
    expect((await arcs.port.list()).find((arc) => arc.slug === "dock-v2")?.status).toBe("archived");
    expect(arcs.bindings.sessionsBoundTo("dock-v2")).toEqual([]);
    expect(await airlock.digest("dock-v2")).toBeUndefined();
    const audit = await readFile(join(cwd, ".keywork", "memory", "curation.md"), "utf8");
    expect(audit).toContain("arc dock-v2 closed: delivered 1, left 1 archived");
    expect(audit).toContain("questions 1 resolved / 1 carried / 1 dropped");

    arcs.recordBinding("s3", "dock-v2");
    const recall = await arcs.searcher(memory.search, "s3").search("thirds maybe");
    expect(recall.hits).toEqual([]);
    const temporal = await arcs.searcher(memory.search, "s3").search("docks split");
    expect(temporal.hits[0]?.note.delivered).toBe(closeTime);
  });

  it("refuses to finish past a session that didn't flush until forced, then flushes the rest first", async () => {
    const { arcs, airlock, flushed } = await airlockWorld({ wedge: "s2" });
    expect(await arcs.port.close("dock-v2")).toMatchObject({ kind: "pending", wedged: 1 });
    expect(flushed).toEqual(["s1"]);
    expect((await airlock.digest("dock-v2"))?.sweep).toEqual({ acked: 1, wedged: 1 });
    await airlock.deliverEligible("dock-v2");
    for (const title of ["Tie order", "Theme drift", "Old worry"]) {
      await airlock.triageQuestion("dock-v2", title, "drop");
    }
    expect(await airlock.finish("dock-v2")).toEqual({ kind: "wedged", sessions: ["s2"] });
    expect(await airlock.finish("dock-v2", { force: true })).toEqual({
      kind: "closed",
      delivered: 1,
      released: 2,
    });
    expect(flushed).toEqual(["s1"]);
  });

  it("carrying needs another active arc and names the newest one", async () => {
    const { arcs, airlock } = await airlockWorld();
    await arcs.port.abandon("next-arc");
    await arcs.port.close("dock-v2");
    await expect(airlock.triageQuestion("dock-v2", "Tie order", "carry")).rejects.toThrow(
      MissingSuccessorError,
    );
    await arcs.port.create("later-arc");
    await airlock.triageQuestion("dock-v2", "Tie order", "carry");
    expect((await airlock.digest("dock-v2"))?.successor).toBe("later-arc");
  });

  it("routes a crashed session's late staged items to the workspace inbox when it reattaches", async () => {
    const { arcs, airlock, memory, registry, sessionDir, cwd } = await airlockWorld();
    await arcs.port.close("dock-v2");
    await airlock.deliverEligible("dock-v2");
    for (const title of ["Tie order", "Theme drift", "Old worry"]) {
      await airlock.triageQuestion("dock-v2", title, "drop");
    }
    await airlock.finish("dock-v2");
    await registry.arcStore("dock-v2").writeNote({
      title: "Late Finding",
      body: "arrived after the close\n",
      provenance: "untrusted",
    });
    expect((await registry.arcStore("dock-v2").listStaged()).length).toBe(1);

    const file = join(sessionDir, "crashed.jsonl");
    const crashed = await SessionStore.create(file, cwd);
    await crashed.appendArcBinding("dock-v2");
    await arcs.attached(await SessionStore.open(file));

    expect(arcs.bindings.bindingOf(crashed.header.id)).toBeUndefined();
    expect((await SessionStore.open(file)).arcBinding()).toBeUndefined();
    expect(await registry.arcStore("dock-v2").listStaged()).toEqual([]);
    const inbox = await memory.store.listStaged();
    expect(inbox.map((item) => (item.kind === "note" ? item.target : item.kind))).toEqual([
      "Late Finding.md",
    ]);
    expect((await arcs.port.list()).find((arc) => arc.slug === "dock-v2")?.status).toBe("archived");
  });

  it("abandon archives without distilling and keeps every file searchable", async () => {
    const { arcs, airlock, registry, cwd } = await airlockWorld();
    await arcs.port.close("dock-v2");
    await arcs.port.abandon("dock-v2");
    expect(await airlock.digest("dock-v2")).toBeUndefined();
    expect(await registry.arcStore("dock-v2").readNote("Dock Ratio Finding")).toBeDefined();
    const moc = await readFile(
      join(cwd, ".keywork", "memory", "arcs", "dock-v2", "MOC.md"),
      "utf8",
    );
    expect(moc).toContain("abandoned: true");
    const audit = await readFile(join(cwd, ".keywork", "memory", "curation.md"), "utf8");
    expect(audit).toContain("arc dock-v2 abandoned");
  });

  describe("the closing agent (J28)", () => {
    const direction = "focus on the dock rules";

    function distiller(): Provider {
      return {
        name: "mock",
        async *stream(request): AsyncIterable<TurnDelta> {
          if (request.systemPrompt.startsWith("You curate")) {
            yield { type: "text", text: '{"relation": "distinct", "confidence": 0}' };
          } else {
            const entryId = /\d{4}-\d{2}-\d{2}#\d+/.exec(JSON.stringify(request.messages))?.[0];
            const steered = request.systemPrompt.includes(direction);
            const proposal = {
              entryId,
              title: steered ? "Dock Rules Digest" : "General Digest",
              body: steered ? "distilled toward the dock rules\n" : "distilled with no steer\n",
              confidence: 0.95,
            };
            yield { type: "text", text: JSON.stringify([proposal]) };
          }
          yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
        },
      };
    }

    const seamOver =
      (provider: Provider): ArcServiceOptions["closing"] =>
      (request: ClosingRequest) =>
        closingJudgment({
          provider,
          ...(request.direction !== undefined && { direction: request.direction }),
          onDegrade: request.onDegrade,
        });

    async function triageEverything(world: Awaited<ReturnType<typeof airlockWorld>>) {
      await world.airlock.deliverEligible("dock-v2");
      for (const title of ["Tie order", "Theme drift", "Old worry"]) {
        await world.airlock.triageQuestion("dock-v2", title, "drop");
      }
    }

    it("steers the distiller: the direction changes the candidates and rides the digest and the record", async () => {
      const world = await airlockWorld({ closing: seamOver(distiller()) });
      await world.arcs.port.close("dock-v2", direction);
      const digest = await world.airlock.digest("dock-v2");
      expect(digest?.direction).toBe(direction);
      const titles = digest?.candidates.map((candidate) => candidate.note);
      expect(titles).toContain("Dock Rules Digest");
      expect(titles).not.toContain("General Digest");
      expect(await world.memory.store.readNote("Dock Rules Digest")).toBeUndefined();

      citeArcNote(world.citations, "s1", "Dock Rules Digest");
      await triageEverything(world);
      expect((await world.airlock.finish("dock-v2")).kind).toBe("closed");
      expect(await world.memory.store.readNote("Dock Rules Digest")).toBeDefined();
      const record = await world.memory.store.readNote("arc dock-v2 delivery");
      expect(record?.body).toContain(`direction: ${direction}`);
    });

    it("distills without a direction too, and the record then carries no direction line", async () => {
      const world = await airlockWorld({ closing: seamOver(distiller()) });
      await world.arcs.port.close("dock-v2");
      const digest = await world.airlock.digest("dock-v2");
      expect(digest?.direction).toBeUndefined();
      expect(digest?.candidates.map((candidate) => candidate.note)).toContain("General Digest");
      await triageEverything(world);
      await world.airlock.finish("dock-v2");
      const record = await world.memory.store.readNote("arc dock-v2 delivery");
      expect(record?.body).not.toContain("direction:");
    });

    it("degrades to the deterministic sweep, byte for byte, when no model is bound", async () => {
      const bare = await airlockWorld();
      const seamed = await airlockWorld({ closing: () => undefined });
      const recordAfterClose = async (world: Awaited<ReturnType<typeof airlockWorld>>) => {
        await world.arcs.port.close("dock-v2");
        await triageEverything(world);
        await world.airlock.finish("dock-v2");
        const raw = await readFile(
          join(world.cwd, ".keywork", "memory", "arc dock-v2 delivery.md"),
          "utf8",
        );
        return raw.replace(/^created: .*$/m, "created: (wall clock)");
      };
      expect(await recordAfterClose(seamed)).toBe(await recordAfterClose(bare));
    });

    it("keeps a provider failure to one notice and the deterministic candidates", async () => {
      const failing: Provider = {
        name: "mock",
        stream(): AsyncIterable<TurnDelta> {
          throw new Error("socket hangup");
        },
      };
      const world = await airlockWorld({ closing: seamOver(failing) });
      const outcome = await world.arcs.port.close("dock-v2", direction);
      expect(outcome.kind).toBe("pending");
      expect(outcome.notice).toBe("closing agent didn't run (socket hangup) · swept without it");
      expect((await world.airlock.digest("dock-v2"))?.candidates.map((c) => c.note)).toEqual([
        "Dock Ratio Finding",
        "Uncited Hunch",
      ]);
    });

    it("rejects a proposal citing a daily entry that does not exist (R6)", async () => {
      const hallucinating: ArcServiceOptions["closing"] = () => ({
        id: "hallucinating",
        proposePromotions: async () => [
          {
            entryId: "2099-01-01#7",
            title: "Ghost Finding",
            body: "never happened\n",
            confidence: 0.99,
          },
        ],
        classifyPair: async () => ({ relation: "distinct", confidence: 0 }),
      });
      const world = await airlockWorld({ closing: hallucinating });
      await world.arcs.port.close("dock-v2", direction);
      const digest = await world.airlock.digest("dock-v2");
      expect(digest?.candidates.map((candidate) => candidate.note)).not.toContain("Ghost Finding");
      expect(await world.registry.arcStore("dock-v2").readNote("Ghost Finding")).toBeUndefined();
      expect(await world.memory.store.readNote("Ghost Finding")).toBeUndefined();
    });
  });
});
