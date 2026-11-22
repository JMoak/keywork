import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArcRegistry,
  conflictMarkers,
  localHost,
  type MemoryStore,
  markMultiHostVault,
  type Note,
} from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import type { AirlockDigestView, ArcAirlockPort } from "@keywork/tui";
import { describe, expect, it, vi } from "vitest";
import {
  arcLayerId,
  bootstrapInjection,
  citationTrail,
  curingStage,
  memoryPanePort,
  memoryRecall,
  openWorkspaceMemory,
  retrievalDisclosure,
  sweepOnClose,
} from "./memory.ts";

const tempDir = scratchDirs("keywork-cli-memory-");

async function declaredWorkspace(): Promise<string> {
  const cwd = await tempDir();
  await mkdir(join(cwd, ".keywork"), { recursive: true });
  await writeFile(join(cwd, ".keywork", "workspace.json"), JSON.stringify({ name: "fixture" }));
  return cwd;
}

describe("openWorkspaceMemory", () => {
  it("is absent in an untrusted folder without a workspace declaration", async () => {
    expect(openWorkspaceMemory(await tempDir(), false)).toBeUndefined();
  });

  it("opens a trusted folder's vault without a declaration, creating it on the first write", async () => {
    const cwd = await tempDir();
    const memory = openWorkspaceMemory(cwd, true);
    expect(memory?.store.trusted).toBe(true);
    expect(memory?.vaultRoot).toBe(join(cwd, ".keywork", "memory"));
    expect(await memory?.store.listStaged()).toEqual([]);
    expect(await memory?.store.listNotes()).toEqual([]);
    expect(existsSync(join(cwd, ".keywork"))).toBe(false);

    await memory?.store.writeNote({ title: "First", body: "kept\n", provenance: "user" });
    expect(await readFile(join(cwd, ".keywork", "memory", "First.md"), "utf8")).toContain("kept");
  });

  it("writes per host once the vault is marked multi-host, and leases the sweep", async () => {
    const cwd = await declaredWorkspace();
    const single = openWorkspaceMemory(cwd, true);
    expect(single?.store.host).toBeUndefined();
    expect(single?.lease).toBeUndefined();
    await markMultiHostVault(join(cwd, ".keywork", "memory"));
    const multi = openWorkspaceMemory(cwd, true);
    expect(multi?.store.host).toBe(localHost());
    expect(multi?.lease?.host).toBe(localHost());
    await multi?.store.appendDaily("entry", "user");
    const files = await readdir(join(cwd, ".keywork", "memory", "daily"));
    expect(files).toEqual([
      expect.stringMatching(new RegExp(`^\\d{4}-\\d{2}-\\d{2}\\.${localHost()}\\.md$`)),
    ]);
  });

  it("heals a conflict-marked note before the first bootstrap read", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "user" });
    const path = join(cwd, ".keywork", "memory", "Ratio Rule.md");
    const ours = await readFile(path, "utf8");
    await writeFile(path, conflictMarkers({ ours, theirs: ours.replace("60/40", "70/30") }));
    await memory.store.writeMoc(["Ratio Rule"], "user");
    const injection = await bootstrapInjection(memory);
    expect(injection?.text).toContain("60/40");
    expect((await memory.store.listNotes()).map((note) => note.name).sort()).toEqual([
      "Ratio Rule",
      "Ratio Rule (conflict copy)",
    ]);
    expect((await memory.store.listStaged()).map((item) => item.kind)).toEqual(["contradiction"]);
  });
});

describe("memoryPanePort", () => {
  async function stagedWrite(seed: { store: MemoryStore }) {
    return (await seed.store.listStaged()).find((item) => item.kind === "note");
  }

  async function populatedMemory(trusted = true) {
    const cwd = await declaredWorkspace();
    const seed = openWorkspaceMemory(cwd, true);
    if (seed === undefined) throw new Error("expected a workspace memory");
    await seed.store.writeNote({ title: "User Fact", body: "typed by hand\n", provenance: "user" });
    await seed.store.writeNote({ title: "Fresh Guess", body: "inferred\n", provenance: "agent" });
    await seed.store.writeNote({
      title: "Proven Rule",
      body: "recalled often\n",
      provenance: "agent",
      usefulness: 0.6,
    });
    await seed.store.writeNote({
      title: "Web Claim",
      body: "from a fetched page\n",
      provenance: "untrusted",
    });
    const [review] = await seed.store.propose([
      {
        kind: "contradiction",
        a: "User Fact",
        b: "Fresh Guess",
        aProvenance: "user",
        bProvenance: "agent",
        confidence: 0.7,
      },
    ]);
    const memory = trusted ? seed : openWorkspaceMemory(cwd, false);
    if (memory === undefined || review === undefined) throw new Error("fixture setup failed");
    return { memory, seed, reviewId: review.id };
  }

  it("maps notes, staged writes, and review items into pane inputs", async () => {
    const { memory, seed } = await populatedMemory();
    const inputs = await memoryPanePort(() => memory).load();
    expect(inputs.layers).toEqual([
      {
        id: "workspace",
        kind: "workspace",
        label: "workspace",
        prompt: { budget: 4096, used: 0 },
      },
    ]);
    const curing = new Map(inputs.notes.map((note) => [note.title, note.curing]));
    expect(curing.get("User Fact")).toBe(3);
    expect(curing.get("Fresh Guess")).toBe(0);
    expect(curing.get("Proven Rule")).toBe(3);
    const staged = inputs.inbox.filter((item) => item.kind === "staged");
    const stagedItem = await stagedWrite(seed);
    expect(staged).toEqual([
      {
        id: stagedItem?.id,
        kind: "staged",
        title: "Web Claim.md",
        provenance: "untrusted",
        created: stagedItem?.created,
        detail: "note",
        note: "Web Claim",
      },
    ]);
    const contradiction = inputs.inbox.find((item) => item.kind === "contradiction");
    expect(contradiction?.title).toBe("User Fact vs Fresh Guess");
    expect(contradiction?.provenance).toBe("agent");
    const fact = inputs.notes.find((note) => note.title === "User Fact");
    expect(fact?.file).toBe(join(memory.vaultRoot, "User Fact.md"));
    expect(fact?.body).toBe("typed by hand\n");
  });

  it("shows arc review cards as airlock items and loads each waiting digest through the airlock port", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    const registry = new ArcRegistry({ vaultRoot: memory.vaultRoot, trusted: true });
    await registry.createArc("dock-v2");
    await registry.createArc("quiet-arc");
    await memory.store.propose([
      { kind: "arc-distillation", arc: "dock-v2", note: "Dock Lesson", eligible: true },
      { kind: "arc-question", arc: "dock-v2", note: "Tie order" },
    ]);
    const digest: AirlockDigestView = { arc: "dock-v2", candidates: [], questions: [] };
    const asked: string[] = [];
    const airlock: ArcAirlockPort = {
      digest: async (slug) => {
        asked.push(slug);
        return slug === "dock-v2" ? digest : undefined;
      },
      triageCandidate: async () => {},
      triageQuestion: async () => {},
      deliverEligible: async () => 0,
      finish: async () => ({ kind: "closed", delivered: 0, released: 0 }),
    };
    const port = memoryPanePort(
      () => memory,
      () => registry,
      airlock,
    );
    const inputs = await port.load();
    expect(inputs.inbox.map((item) => [item.kind, item.title, item.arc, item.detail])).toEqual([
      ["airlock", "deliver Dock Lesson", "dock-v2", "eligible"],
      ["airlock", "triage Tie order", "dock-v2", undefined],
    ]);
    expect(asked.sort()).toEqual(["dock-v2", "quiet-arc"]);
    expect(inputs.airlocks).toEqual([digest]);
    expect(port.airlock).toBe(airlock);
    expect(memoryPanePort(() => memory).airlock).toBeUndefined();
  });

  it("routes approve to the store for staged writes and reviews alike", async () => {
    const { memory, seed, reviewId } = await populatedMemory();
    const port = memoryPanePort(() => memory);
    const stagedItem = await stagedWrite(seed);
    await port.approve(stagedItem?.id ?? "");
    expect((await seed.store.listNotes()).map((note) => note.title)).toContain("Web Claim");
    await port.approve(reviewId);
    expect(await seed.store.listStaged()).toEqual([]);
  });

  it("discard drops a staged item without landing it", async () => {
    const { memory, seed } = await populatedMemory();
    const stagedItem = await stagedWrite(seed);
    await memoryPanePort(() => memory).discard(stagedItem?.id ?? "");
    expect((await seed.store.listStaged()).map((item) => item.kind)).toEqual(["contradiction"]);
    expect((await seed.store.listNotes()).map((note) => note.title)).not.toContain("Web Claim");
  });

  it("an untrusted vault loads as calm emptiness, never content", async () => {
    const { memory } = await populatedMemory(false);
    expect(await memoryPanePort(() => memory).load()).toEqual({
      layers: [],
      notes: [],
      inbox: [],
      ledger: [],
    });
  });
});

describe("citationTrail", () => {
  async function trailWorld() {
    const memory = openWorkspaceMemory(await declaredWorkspace(), true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    return { memory, trail: citationTrail(() => memory) };
  }

  it("feeds a cited recall into the curation score, deterministically", async () => {
    const { memory, trail } = await trailWorld();
    trail.forSession("session-1").recordRecall("Ratio Rule", "search");
    trail.recordReply("session-1", "the split is 60/40 per [[Ratio Rule]]");
    const report = await memory.gardener.sweep();
    expect(report.usefulness["Ratio Rule"]).toBe(0.3);
    const stamped = await memory.store.readNote("Ratio Rule");
    expect(curingStage(stamped as Note)).toBe(2);
  });

  it("rejects a hallucinated citation: no event, no audit line, nothing cited (R6)", async () => {
    const { memory, trail } = await trailWorld();
    trail.forSession("session-1").recordRecall("Ratio Rule", "search");
    const outcome = trail.forSession("session-1").recordReply("see [[Invented Note]]");
    expect(outcome).toEqual({ cited: [], rejected: ["Invented Note"] });
    const report = await memory.gardener.sweep();
    expect(report.usefulness).toEqual({});
    const audit = await memory.store.readAudit();
    expect(audit.some((entry) => entry.event.includes("Invented Note"))).toBe(false);
  });

  it("persists events through the audit ledger and reads arc citations back across runs", async () => {
    const { memory, trail } = await trailWorld();
    const ledger = trail.forSession("s1");
    ledger.recordRecall("Arc Finding", "search", arcLayerId("dock-v2"));
    ledger.recordReply("per [[Arc Finding]]");
    await memory.store.recordAudit("settle");
    const audit = await memory.store.readAudit();
    expect(audit.map((entry) => entry.event)).toEqual([
      "recall [[Arc Finding]] via search in arc:dock-v2 by session s1",
      "citation [[Arc Finding]] in arc:dock-v2 by session s1",
      "settle",
    ]);
    const relaunched = citationTrail(() => memory);
    expect(await relaunched.citedNotes("dock-v2")).toEqual(["Arc Finding"]);
    expect(await relaunched.citedNotes("other-arc")).toEqual([]);
  });

  it("records bootstrap injections so the reply can cite them", async () => {
    const { memory } = await trailWorld();
    await memory.store.writeNote({
      title: "Pinned Fact",
      body: "f\n",
      provenance: "user",
      pinned: true,
    });
    await memory.store.writeMoc(["Pinned Fact"], "user");
    const injection = await bootstrapInjection(memory);
    const trail = citationTrail(
      () => memory,
      () => injection,
    );
    const outcome = trail.forSession("s1").recordReply("per [[Pinned Fact]]");
    expect(outcome.cited).toEqual(["Pinned Fact"]);
    await memory.store.recordAudit("settle");
  });

  it("drops tap events while the session key is unresolved, then records once it binds", async () => {
    const { memory, trail } = await trailWorld();
    let sessionId: string | undefined;
    const tap = trail.tapFor(() => sessionId);
    tap.recordRecall("Ratio Rule", "search");
    sessionId = "sess-late";
    tap.recordRecall("Ratio Rule", "search");
    trail.recordReply("sess-late", "[[Ratio Rule]]");
    const report = await memory.gardener.sweep();
    expect(report.usefulness["Ratio Rule"]).toBe(0.3);
  });

  it("stays inert for an untrusted workspace: no audit writes attempted", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, false);
    if (memory === undefined) throw new Error("expected a workspace memory");
    const trail = citationTrail(() => memory);
    const ledger = trail.forSession("s1");
    ledger.recordRecall("Ratio Rule", "search");
    ledger.recordReply("[[Ratio Rule]]");
    expect(await memory.store.readAudit()).toEqual([]);
  });
});

describe("memoryRecall", () => {
  it("discloses degradation when the embedding source fails", async () => {
    const memory = openWorkspaceMemory(await declaredWorkspace(), true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    memory.embeddings = {
      id: "fake-embed",
      embed: async () => {
        throw new Error("socket reset");
      },
    };
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    const disclosures: string[] = [];
    const recall = memoryRecall(memory, "sess-1", (line) => disclosures.push(line));
    await recall?.search.search("ratio");
    expect(disclosures).toEqual([
      "memory search fell back to lexical, embeddings from fake-embed aren't available",
    ]);
  });
});

describe("retrievalDisclosure", () => {
  it("names the source for hybrid, degraded for fallback, nothing for lexical", () => {
    expect(retrievalDisclosure({ kind: "lexical" })).toBeUndefined();
    expect(retrievalDisclosure({ kind: "hybrid", embeddings: "voyage-3" })).toBe(
      "memory search uses embeddings from voyage-3",
    );
    expect(
      retrievalDisclosure({ kind: "lexical-degraded", embeddings: "voyage-3", reason: "down" }),
    ).toBe("memory search fell back to lexical, embeddings from voyage-3 aren't available");
  });
});

describe("sweepOnClose", () => {
  it("leaves an audit entry on a trusted vault and swallows nothing-to-do", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, true);
    if (memory === undefined) throw new Error("expected a workspace memory");
    await memory.store.writeNote({ title: "Ratio Rule", body: "60/40\n", provenance: "agent" });
    await sweepOnClose(memory);
    const audit = await readFile(join(cwd, ".keywork", "memory", "curation.md"), "utf8");
    expect(audit).toContain("gardener sweep");
  });

  it("still proposes preferences when the sweep fails, then surfaces the failure", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, true);
    if (memory === undefined) throw new Error("memory expected");
    for (const _ of [1, 2, 3]) await memory.askGate.record("bash git", "yes");
    vi.spyOn(memory.gardener, "sweep").mockRejectedValue(new Error("disk full"));

    await expect(sweepOnClose(memory)).rejects.toThrow("memory close: disk full");

    const items = await memory.store.listStaged();
    expect(items.filter((item) => item.kind === "preference-proposal")).toHaveLength(1);
  });
});

describe("ask-gate preferences at close", () => {
  it("stays inert for an untrusted workspace", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, false);
    if (memory === undefined) throw new Error("memory expected");
    for (const _ of [1, 2, 3]) await memory.askGate.record("bash git", "yes");

    await sweepOnClose(memory);

    expect(await memory.store.listStaged()).toHaveLength(0);
  });
});

describe("ask-gate persistence", () => {
  it("never writes ask events into an untrusted clone", async () => {
    const cwd = await declaredWorkspace();
    const memory = openWorkspaceMemory(cwd, false);
    if (memory === undefined) throw new Error("memory expected");
    await memory.askGate.record("bash git", "yes");

    await expect(
      readFile(join(cwd, ".keywork", "memory", ".staging", "ask-gate.json")),
    ).rejects.toThrow();
  });
});
