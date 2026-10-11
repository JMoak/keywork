import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { SweepLease } from "./lease.ts";
import { conflictMarkers } from "./merge.ts";
import { conflictArtifactOriginal, conflictSiblingName, reconcileVault } from "./reconcile.ts";
import { MemorySearch } from "./search.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-reconcile-");

async function vault(): Promise<{ root: string; store: MemoryStore }> {
  const root = await scratch();
  const store = new MemoryStore({ vaultRoot: root, trusted: true, host: "alpha" });
  await store.writeNote({ title: "Runtime", body: "we use bun\n", provenance: "agent" });
  return { root, store };
}

describe("self-reconciliation after a sync", () => {
  it("splits a conflict-marked note into the kept note and a conflict-of sibling with one card", async () => {
    const { root, store } = await vault();
    const ours = await readFile(join(root, "Runtime.md"), "utf8");
    const theirs = ours.replace("we use bun", "we use deno");
    await writeFile(join(root, "Runtime.md"), conflictMarkers({ ours, theirs }), "utf8");
    const report = await reconcileVault({ store });
    expect(report.intake).toEqual([
      {
        original: "Runtime",
        sibling: "Runtime (conflict copy)",
        source: "markers",
        provenance: { original: "agent", sibling: "agent" },
      },
    ]);
    expect(report.cards).toEqual(["contradiction:runtime<->runtime (conflict copy)"]);
    expect(await readFile(join(root, "Runtime.md"), "utf8")).toBe(ours);
    const sibling = await store.readNote("Runtime (conflict copy)");
    expect(sibling?.body).toBe("we use deno\n");
    expect(sibling?.frontmatter["conflict-of"]).toBe("[[Runtime]]");
    expect((await store.listStaged()).map((item) => item.kind)).toEqual(["contradiction"]);
    const again = await reconcileVault({ store });
    expect(again.intake).toEqual([]);
    expect(again.cards).toEqual([]);
    expect((await store.listStaged()).length).toBe(1);
  });

  it("heals hunk-level markers inside frontmatter that would otherwise break every read", async () => {
    const { root, store } = await vault();
    await writeFile(
      join(root, "Runtime.md"),
      [
        "---",
        'provenance: "agent"',
        "<<<<<<< HEAD",
        "usefulness: 0.5",
        "=======",
        "usefulness: 0.3",
        ">>>>>>> beta",
        "---",
        "we use bun",
        "",
      ].join("\n"),
      "utf8",
    );
    await expect(store.listNotes()).rejects.toThrow(/malformed frontmatter/);
    const report = await reconcileVault({ store });
    expect(report.intake.map((intake) => intake.sibling)).toEqual(["Runtime (conflict copy)"]);
    const notes = await store.listNotes();
    expect(notes.map((note) => [note.name, note.usefulness])).toEqual([
      ["Runtime (conflict copy)", 0.3],
      ["Runtime", 0.5],
    ]);
  });

  it("quarantines sync-tool conflict copies as siblings and restores an orphaned copy", async () => {
    const { root, store } = await vault();
    const copy = (await readFile(join(root, "Runtime.md"), "utf8")).replace("bun", "node");
    await writeFile(join(root, "Runtime (Jordan's conflicted copy 2026-08-10).md"), copy, "utf8");
    await writeFile(join(root, "Runtime.sync-conflict-20260810-091500-ABCDEF7.md"), copy, "utf8");
    await writeFile(
      join(root, "Lost (conflicted copy 2026-08-10 101010).md"),
      "only copy\n",
      "utf8",
    );
    const report = await reconcileVault({ store });
    expect(report.intake.map((intake) => [intake.sibling, intake.source])).toEqual([
      ["Runtime (conflict copy)", "artifact"],
      ["Runtime (conflict copy 2)", "artifact"],
    ]);
    expect(report.restored).toEqual(["Lost"]);
    expect(report.cards).toHaveLength(2);
    expect((await readdir(root)).filter((name) => name.endsWith(".md")).sort()).toEqual([
      "Lost.md",
      "Runtime (conflict copy 2).md",
      "Runtime (conflict copy).md",
      "Runtime.md",
    ]);
    expect((await store.readNote("Lost"))?.body).toBe("only copy\n");
    expect(await store.revert(store.ledger().at(-1)?.id ?? "")).toBe("reverted");
  });

  it("reports hosts, the lease and the index, and stays inert when untrusted", async () => {
    const { root, store } = await vault();
    await store.appendDaily("x", "agent");
    const lease = new SweepLease({ vaultRoot: root, host: "beta" });
    await lease.acquire();
    const search = new MemorySearch(store);
    const report = await reconcileVault({ store, search, lease });
    expect(report.host).toBe("alpha");
    expect(report.hosts).toEqual(["alpha"]);
    expect(report.lease?.host).toBe("beta");
    expect(report.index).toEqual({ notes: 1, refreshed: [], dropped: [] });
    const inert = new MemoryStore({ vaultRoot: root, trusted: false });
    expect(await reconcileVault({ store: inert })).toMatchObject({ intake: [], hosts: [] });
  });

  it("recognizes the sync tools' conflict filenames", () => {
    expect(conflictArtifactOriginal("A (Jordan's conflicted copy 2026-08-10).md")).toBe("A.md");
    expect(conflictArtifactOriginal("A (conflicted copy 2026-08-10 101010).md")).toBe("A.md");
    expect(
      conflictArtifactOriginal("entities/src/a.ts.sync-conflict-20260810-091500-ABCDEF7.md"),
    ).toBe("entities/src/a.ts.md");
    expect(conflictArtifactOriginal("A (conflict copy).md")).toBeUndefined();
    expect(conflictArtifactOriginal("Plain.md")).toBeUndefined();
    expect(conflictSiblingName("A", new Set(["A (conflict copy)"]))).toBe("A (conflict copy 2)");
  });
});
