import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { auditLine, parseAuditLog } from "./audit.ts";
import { bootstrapMemory } from "./bootstrap.ts";
import {
  type CitationEvent,
  CitationLedger,
  citationAuditEvent,
  citationChain,
  citationUsefulnessFeed,
  parseCitationEvents,
  type RecallEvent,
} from "./citations.ts";
import { Gardener } from "./gardener.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-citations-");

async function vaultRoot(): Promise<string> {
  const root = await scratch();
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

  it("tags recalls and citations with their source layer and session", () => {
    const ledger = new CitationLedger({
      now: () => new Date("2026-08-31T09:00:00.000Z"),
      session: "s1",
    });
    ledger.recordRecall("Arc Finding", "search", "arc:dock-v2");
    const outcome = ledger.recordReply("see [[Arc Finding]]");
    expect(outcome.cited).toEqual(["Arc Finding"]);
    expect(ledger.events()).toEqual([
      {
        kind: "recall",
        note: "Arc Finding",
        surface: "search",
        layer: "arc:dock-v2",
        session: "s1",
        timestamp: "2026-08-31T09:00:00.000Z",
      },
      {
        kind: "citation",
        note: "Arc Finding",
        layer: "arc:dock-v2",
        session: "s1",
        timestamp: "2026-08-31T09:00:00.000Z",
      },
    ]);
  });

  it("counts a memory_get re-read of an already surfaced note as one citation", () => {
    const ledger = ledgerAt();
    ledger.recordRecall("Convention", "search");
    ledger.recordRecall("Convention", "get");
    ledger.recordRecall("Convention", "get");
    expect(ledger.citations().map((event) => event.note)).toEqual(["Convention"]);
  });

  it("never treats a bare memory_get as a usefulness signal", () => {
    const ledger = ledgerAt();
    ledger.recordRecall("Looked Up", "get");
    ledger.recordRecall("Looked Up", "get");
    expect(ledger.citations()).toEqual([]);
    expect(ledger.uncitedRecalls()).toEqual(["Looked Up"]);
  });

  it("hands recall and citation events to onEvent, latency stays out", () => {
    const seen: string[] = [];
    const ledger = new CitationLedger({ onEvent: (event) => seen.push(event.kind) });
    ledger.recordRecall("A Note", "bootstrap");
    ledger.recordLatency("search", 5);
    ledger.recordReply("[[A Note]]");
    expect(seen).toEqual(["recall", "citation"]);
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

describe("the citation audit codec", () => {
  const stamp = "2026-08-31T09:00:00.000Z";

  it("round-trips every event shape through the append-only audit reader", () => {
    const events: (RecallEvent | CitationEvent)[] = [
      { kind: "recall", note: "Plain Note", surface: "bootstrap", timestamp: stamp },
      {
        kind: "recall",
        note: "Arc Finding",
        surface: "action",
        layer: "arc:dock-v2",
        session: "s1",
        timestamp: stamp,
      },
      { kind: "citation", note: "Plain Note", timestamp: stamp },
      {
        kind: "citation",
        note: "Arc Finding",
        layer: "arc:dock-v2",
        session: "s1",
        timestamp: stamp,
      },
    ];
    const log = events.map((event) => auditLine(stamp, citationAuditEvent(event))).join("");
    expect(parseCitationEvents(parseAuditLog(log))).toEqual(events);
  });

  it("skips audit lines that are not citation events", () => {
    const log = [
      auditLine(stamp, "gardener sweep: promoted 1, merged 0, superseded 0, flagged 0, rejected 0"),
      auditLine(stamp, "recall [[Kept]] via search"),
      auditLine(stamp, "arc dock-v2 closed: delivered 1, left 0 archived, questions 0"),
    ].join("");
    expect(parseCitationEvents(parseAuditLog(log))).toEqual([
      { kind: "recall", note: "Kept", surface: "search", timestamp: stamp },
    ]);
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
