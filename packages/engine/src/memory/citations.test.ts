import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapMemory } from "./bootstrap.ts";
import { CitationLedger, citationChain, citationUsefulnessFeed } from "./citations.ts";
import { Gardener } from "./gardener.ts";
import { MemoryStore } from "./store.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function vaultRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keywork-citations-"));
  cleanups.push(root);
  return root;
}

async function openStore(): Promise<MemoryStore> {
  return new MemoryStore({
    vaultRoot: await vaultRoot(),
    trusted: true,
    now: () => new Date("2026-08-16T09:00:00.000Z"),
  });
}

function ledgerAt(second = 0): CitationLedger {
  return new CitationLedger({ now: () => new Date(2026, 7, 16, 9, 0, second) });
}

describe("CitationLedger", () => {
  it("accepts citations of recalled notes and rejects hallucinated ids", () => {
    const ledger = ledgerAt();
    ledger.recordRecall("Ratio Rule", "search");
    const outcome = ledger.recordReply(
      "Per [[Ratio Rule]] the split is 60/40, unlike [[Invented Note]].",
    );
    expect(outcome).toEqual({ cited: ["Ratio Rule"], rejected: ["Invented Note"] });
    expect(ledger.events().filter((event) => event.kind === "citation")).toHaveLength(1);
  });

  it("matches citations case-insensitively and emits one event per note per reply", () => {
    const ledger = ledgerAt();
    ledger.recordRecall("Ratio Rule", "get");
    const outcome = ledger.recordReply("[[ratio rule]] twice: [[Ratio Rule]]");
    expect(outcome.cited).toEqual(["Ratio Rule"]);
    expect(ledger.events().filter((event) => event.kind === "citation")).toHaveLength(1);
  });

  it("keeps cited and uncited recalls distinguishable", () => {
    const ledger = ledgerAt();
    ledger.recordRecall("Cited Note", "search");
    ledger.recordRecall("Ignored Note", "search");
    ledger.recordReply("see [[Cited Note]]");
    expect(ledger.citedRecalls()).toEqual(["Cited Note"]);
    expect(ledger.uncitedRecalls()).toEqual(["Ignored Note"]);
  });

  it("records bootstrap-injected notes as recalls, so they are citable", async () => {
    const store = await openStore();
    await store.writeNote({ title: "Pinned Fact", body: "f\n", provenance: "user", pinned: true });
    await store.writeMoc(["Pinned Fact"], "user");
    const ledger = ledgerAt();
    ledger.recordBootstrap(await bootstrapMemory([{ name: "workspace", store, budget: 10_000 }]));
    expect(ledger.recordReply("per [[Pinned Fact]]").cited).toEqual(["Pinned Fact"]);
    expect(ledger.events()[0]).toMatchObject({
      kind: "recall",
      note: "Pinned Fact",
      surface: "bootstrap",
    });
  });

  it("feeds citation events to the usefulness EMA, not raw recalls", async () => {
    const store = await openStore();
    await store.writeNote({ title: "Handy Fact", body: "h\n", provenance: "agent" });
    await store.writeNote({ title: "Noise Fact", body: "n\n", provenance: "agent" });
    const gardener = new Gardener({ store });
    const ledger = new CitationLedger({
      onCitation: citationUsefulnessFeed(gardener, () => "session-1"),
    });
    ledger.recordRecall("Handy Fact", "search");
    ledger.recordRecall("Noise Fact", "search");
    ledger.recordReply("the answer follows [[Handy Fact]]");
    const report = await gardener.sweep();
    expect(report.usefulness["Handy Fact"]).toBeGreaterThan(0);
    expect(report.usefulness["Noise Fact"]).toBeUndefined();
  });

  it("drops citation events when no session is resolvable", () => {
    const recorded: [string, string][] = [];
    const feed = citationUsefulnessFeed(
      { recordRecall: (note, session) => recorded.push([note, session]) },
      () => undefined,
    );
    feed({ kind: "citation", note: "Ghost", timestamp: "2026-08-16T09:00:00.000Z" });
    expect(recorded).toEqual([]);
  });

  it("keeps a rolling median of recall latency per surface", () => {
    const ledger = ledgerAt();
    expect(ledger.medianLatencyMs("search")).toBeUndefined();
    for (const ms of [10, 30, 20]) ledger.recordLatency("search", ms);
    ledger.recordLatency("get", 500);
    expect(ledger.medianLatencyMs("search")).toBe(20);
    ledger.recordLatency("search", 40);
    expect(ledger.medianLatencyMs("search")).toBe(25);
    for (let i = 0; i < 64; i += 1) ledger.recordLatency("search", 100);
    expect(ledger.medianLatencyMs("search")).toBe(100);
  });
});

describe("citationChain", () => {
  it("walks claim to note to provenance across the supersession chain", async () => {
    const store = await openStore();
    await store.writeNote({ title: "First Rule", body: "v1\n", provenance: "user" });
    await store.writeNote({
      title: "Second Rule",
      body: "v2\n",
      provenance: "agent",
      supersedes: "First Rule",
    });
    await store.writeNote({
      title: "Third Rule",
      body: "v3\n",
      provenance: "user",
      supersedes: "Second Rule",
    });
    const chain = await citationChain(store, "First Rule");
    expect(chain).toEqual({
      note: "First Rule",
      provenance: "user",
      created: "2026-08-16T09:00:00.000Z",
      supersession: [
        { note: "Second Rule", provenance: "agent", created: "2026-08-16T09:00:00.000Z" },
        { note: "Third Rule", provenance: "user", created: "2026-08-16T09:00:00.000Z" },
      ],
    });
  });

  it("answers undefined for an unknown note and stops calmly at a dangling successor", async () => {
    const root = await vaultRoot();
    await writeFile(
      join(root, "Orphaned Rule.md"),
      '---\nsuperseded_by: "[[Never Written]]"\n---\nold\n',
      "utf8",
    );
    const store = new MemoryStore({ vaultRoot: root, trusted: true });
    expect(await citationChain(store, "Never Written")).toBeUndefined();
    expect(await citationChain(store, "Orphaned Rule")).toEqual({
      note: "Orphaned Rule",
      provenance: "user",
      supersession: [],
    });
  });

  it("terminates on a supersession cycle instead of looping", async () => {
    const root = await vaultRoot();
    await mkdir(dirname(join(root, "A.md")), { recursive: true });
    await writeFile(join(root, "A.md"), '---\nsuperseded_by: "[[B]]"\n---\na\n', "utf8");
    await writeFile(join(root, "B.md"), '---\nsuperseded_by: "[[A]]"\n---\nb\n', "utf8");
    const store = new MemoryStore({ vaultRoot: root, trusted: true });
    const chain = await citationChain(store, "A");
    expect(chain?.supersession).toEqual([{ note: "B", provenance: "user" }]);
  });
});
