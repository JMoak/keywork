import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { rememberFrom } from "./admission.ts";
import { citationAuditEvent } from "./citations.ts";
import {
  applySourceForget,
  forgetEcho,
  planSourceForget,
  StaleForgetPlanError,
  sourceForgetting,
  workspaceOrCraftStore,
} from "./forget.ts";
import { parseMemorySource } from "./sources.ts";
import { isStagedWrite } from "./staging.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-forget-source-");
const clock = () => new Date("2026-11-06T09:00:00.000Z");
const web = parseMemorySource("web:example.com");

async function vault(): Promise<{ store: MemoryStore; root: string }> {
  const root = await scratch();
  const store = new MemoryStore({ vaultRoot: root, trusted: true, now: clock });
  await store.writeNote({
    title: "Fetched Pricing",
    body: "\nPrices from the vendor page\nsecond line\n",
    provenance: "agent",
    origin: web,
    anchor: { at: "2026-11-05T10:00:00.000Z", sha: "abc123", checkpoint: `${hostname()}:cp-1` },
  });
  await store.writeNote({
    title: "Vendor Notes",
    body: "Links to [[Fetched Pricing]] and [[Keeper Rule]]\n",
    provenance: "agent",
    origin: web,
  });
  await store.writeNote({
    title: "Keeper Rule",
    body: "Always ask before buying; see [[Fetched Pricing]]\n",
    provenance: "user",
  });
  await store.writeNote({
    title: "Elsewhere",
    body: "from another site\n",
    provenance: "agent",
    origin: parseMemorySource("web:other.org"),
  });
  await store.recordAudit(
    citationAuditEvent({
      kind: "recall",
      note: "Fetched Pricing",
      surface: "search",
      timestamp: "",
      session: "s-1",
    }),
  );
  await store.recordAudit(
    citationAuditEvent({ kind: "citation", note: "Vendor Notes", timestamp: "", session: "s-1" }),
  );
  await store.recordAudit(
    citationAuditEvent({ kind: "citation", note: "Keeper Rule", timestamp: "" }),
  );
  return { store, root };
}

describe("forget by source, dry run", () => {
  it("lists exactly the notes, anchors, edges and citations that would go, with counts and first lines", async () => {
    const { store } = await vault();
    const plan = await planSourceForget(store, web);

    expect(plan.source).toBe("web:example.com");
    expect(plan.counts).toEqual({
      notes: 2,
      anchors: 1,
      edges: 3,
      citations: 2,
      entries: 0,
      staged: 0,
    });
    expect(plan.notes).toEqual([
      {
        name: "Fetched Pricing",
        path: "Fetched Pricing.md",
        firstLine: "Prices from the vendor page",
      },
      {
        name: "Vendor Notes",
        path: "Vendor Notes.md",
        firstLine: "Links to [[Fetched Pricing]] and [[Keeper Rule]]",
      },
    ]);
    expect(plan.anchors).toEqual([
      {
        note: "Fetched Pricing",
        at: "2026-11-05T10:00:00.000Z",
        sha: "abc123",
        checkpoint: `${hostname()}:cp-1`,
      },
    ]);
    expect(plan.edges).toEqual(
      expect.arrayContaining([
        { subject: "Vendor Notes", predicate: "relates_to", object: "Fetched Pricing" },
        { subject: "Vendor Notes", predicate: "relates_to", object: "Keeper Rule" },
        { subject: "Keeper Rule", predicate: "relates_to", object: "Fetched Pricing" },
      ]),
    );
    expect(plan.citations.map((line) => [line.kind, line.note])).toEqual([
      ["recall", "Fetched Pricing"],
      ["citation", "Vendor Notes"],
    ]);
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("touches nothing: the vault reads the same after a dry run", async () => {
    const { store, root } = await vault();
    const before = await readFile(join(root, "curation.md"), "utf8");
    await planSourceForget(store, web);
    expect((await store.listNotes()).map((note) => note.name).sort()).toEqual([
      "Elsewhere",
      "Fetched Pricing",
      "Keeper Rule",
      "Vendor Notes",
    ]);
    expect(await readFile(join(root, "curation.md"), "utf8")).toBe(before);
    expect(store.ledger().filter((entry) => entry.op === "edit")).toEqual([]);
  });

  it("gives the same digest twice and a new one once a listed note changes", async () => {
    const { store } = await vault();
    const first = await planSourceForget(store, web);
    expect((await planSourceForget(store, web)).digest).toBe(first.digest);
    await store.writeNote({
      title: "Fetched Pricing",
      body: "\nPrices from the vendor page\nedited further down\n",
      provenance: "agent",
    });
    expect((await planSourceForget(store, web)).digest).not.toBe(first.digest);
  });
});

describe("forget by source, apply", () => {
  it("removes what the dry run listed, scrubs its citations and audits the forget in one ledger step", async () => {
    const { store, root } = await vault();
    const plan = await planSourceForget(store, web);
    const report = await applySourceForget(store, web, plan.digest);

    expect(report).toMatchObject({ source: "web:example.com", counts: plan.counts });
    expect((await store.listNotes()).map((note) => note.name).sort()).toEqual([
      "Elsewhere",
      "Keeper Rule",
    ]);
    const audit = await readFile(join(root, "curation.md"), "utf8");
    expect(audit).not.toContain("[[Fetched Pricing]]");
    expect(audit).not.toContain("[[Vendor Notes]]");
    expect(audit).toContain("citation [[Keeper Rule]]");
    expect(audit).toContain(`forgot web:example.com · ${forgetEcho(plan).split(" · ")[1] ?? ""}`);
    expect(forgetEcho(plan)).toBe(
      "forgot web:example.com · 2 notes, 1 anchor, 3 edges, 2 citations, 0 entries",
    );
    expect(store.ledger().at(-1)?.id).toBe(report.ledgerId);
  });

  it("is one revert away from undone, byte for byte", async () => {
    const { store, root } = await vault();
    const audit = await readFile(join(root, "curation.md"), "utf8");
    const pricing = await readFile(join(root, "Fetched Pricing.md"), "utf8");
    const plan = await planSourceForget(store, web);
    const report = await applySourceForget(store, web, plan.digest);

    expect(await store.revert(report.ledgerId ?? "")).toBe("reverted");
    expect(await readFile(join(root, "curation.md"), "utf8")).toBe(audit);
    expect(await readFile(join(root, "Fetched Pricing.md"), "utf8")).toBe(pricing);
  });

  it("refuses a stale dry run and touches nothing", async () => {
    const { store } = await vault();
    const plan = await planSourceForget(store, web);
    await store.writeNote({
      title: "Late Arrival",
      body: "also from the page\n",
      provenance: "agent",
      origin: web,
    });
    await expect(applySourceForget(store, web, plan.digest)).rejects.toBeInstanceOf(
      StaleForgetPlanError,
    );
    expect((await store.listNotes()).length).toBe(5);
  });

  it("applies an empty plan as a no-op without a ledger entry", async () => {
    const { store } = await vault();
    const nothing = parseMemorySource("workshop:ws-none");
    const plan = await planSourceForget(store, nothing);
    const ledger = store.ledger().length;
    expect(await applySourceForget(store, nothing, plan.digest)).toEqual({
      source: "workshop:ws-none",
      counts: { notes: 0, anchors: 0, edges: 0, citations: 0, entries: 0, staged: 0 },
    });
    expect(store.ledger().length).toBe(ledger);
  });

  it("forgets a session's notes and daily entries and keeps mixed provenance with the reason", async () => {
    const root = await scratch();
    const store = new MemoryStore({ vaultRoot: root, trusted: true, now: clock });
    await store.writeNote({ title: "Mine", body: "a\n", provenance: "agent", session: "s-a" });
    await store.writeNote({ title: "Mixed", body: "a\n", provenance: "agent", session: "s-a" });
    await store.writeNote({ title: "Mixed", body: "b\n", provenance: "agent", session: "s-b" });
    await store.appendDaily("from a", "agent", "s-a");
    await store.appendDaily("from b", "agent", "s-b");
    const session = parseMemorySource("session:s-a");
    const plan = await planSourceForget(store, session);

    expect(plan.notes.map((note) => note.name)).toEqual(["Mine"]);
    expect(plan.entries.map((entry) => entry.text)).toEqual(["from a"]);
    expect(plan.kept).toEqual([
      { note: "Mixed", reason: "also revised by session s-b; mixed provenance, kept" },
    ]);
    await applySourceForget(store, session, plan.digest);
    expect((await store.readDaily()).map((entry) => entry.text)).toEqual(["from b"]);
    expect((await store.listNotes()).map((note) => note.name)).toEqual(["Mixed"]);
  });
});

describe("the served forgetting", () => {
  it("answers refusals instead of throwing for a bad source or a stale digest", async () => {
    const { store } = await vault();
    const forgetting = sourceForgetting(workspaceOrCraftStore(store));
    expect(await forgetting.preview("ftp:nowhere")).toMatchObject({ refused: "invalid-source" });
    expect(await forgetting.apply("web:example.com", "not-the-digest")).toMatchObject({
      refused: "stale",
    });
  });

  it("forgets one craft note from the creature's own layer", async () => {
    const { store } = await vault();
    const wrenRoot = await scratch();
    const wren = new MemoryStore({ vaultRoot: wrenRoot, trusted: true, now: clock });
    await wren.writeNote({
      title: "Triage Order",
      body: "Oldest first.\n",
      provenance: "agent",
      origin: { kind: "craft", id: "wren" },
    });
    await wren.writeNote({
      title: "Label Words",
      body: "Short labels.\n",
      provenance: "agent",
      origin: { kind: "craft", id: "wren" },
    });
    const forgetting = sourceForgetting(workspaceOrCraftStore(store, () => wren));
    const plan = await forgetting.preview("craft:wren/Triage Order");
    if (!("digest" in plan)) throw new Error(plan.error);
    expect(plan.notes.map((note) => note.name)).toEqual(["Triage Order"]);
    await forgetting.apply("craft:wren/Triage Order", plan.digest);
    expect((await wren.listNotes()).map((note) => note.name)).toEqual(["Label Words"]);
    expect((await store.listNotes()).length).toBe(4);
  });
});

describe("forget by source, staged items", () => {
  const wren = parseMemorySource("creature:wren");

  async function staged(): Promise<MemoryStore> {
    const store = new MemoryStore({ vaultRoot: await scratch(), trusted: true, now: clock });
    await rememberFrom(store, wren, {
      title: "message from wren K3GImfYB",
      body: "The five largest docs are listed in notes/largest.md\nsecond line\n",
      self: "cob",
    });
    await rememberFrom(store, parseMemorySource("creature:sol"), {
      title: "message from sol 0a1b2c3d",
      body: "Elsewhere\n",
      self: "cob",
    });
    return store;
  }

  it("lists the staged items that source put in memory under their own count, with first lines", async () => {
    const store = await staged();
    const plan = await planSourceForget(store, wren);

    expect(plan.counts).toEqual({
      notes: 0,
      anchors: 0,
      edges: 0,
      citations: 0,
      entries: 0,
      staged: 1,
    });
    expect(plan.staged).toEqual([
      {
        id: expect.any(String),
        kind: "note",
        target: "message from wren K3GImfYB.md",
        for: "creature:cob",
        firstLine: "The five largest docs are listed in notes/largest.md",
      },
    ]);
    expect((await store.listStaged()).length).toBe(2);
  });

  it("drops them on apply in one ledger entry that one revert restores byte for byte", async () => {
    const store = await staged();
    const before = await store.listStaged();
    const plan = await planSourceForget(store, wren);
    const report = await applySourceForget(store, wren, plan.digest);

    expect(report.counts.staged).toBe(1);
    expect(report.ledgerId).toBeDefined();
    const left = (await store.listStaged()).filter(isStagedWrite);
    expect(left.map((item) => item.source)).toEqual(["creature:sol"]);
    expect(forgetEcho(plan)).toBe(
      "forgot creature:wren · 0 notes, 0 anchors, 0 edges, 0 citations, 0 entries, 1 staged item",
    );

    expect(await store.revert(report.ledgerId ?? "")).toBe("reverted");
    expect(await store.listStaged()).toEqual(before);
  });

  it("refuses a digest taken before the staged item changed", async () => {
    const store = await staged();
    const plan = await planSourceForget(store, wren);
    await rememberFrom(store, wren, {
      title: "message from wren 99999999",
      body: "more\n",
      self: "cob",
    });
    await expect(applySourceForget(store, wren, plan.digest)).rejects.toBeInstanceOf(
      StaleForgetPlanError,
    );
  });
});
