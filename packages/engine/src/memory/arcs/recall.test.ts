import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySearch } from "../search.ts";
import { MemoryStore } from "../store.ts";
import { ArcRecall, arcBootstrapLayer } from "./recall.ts";
import { ArcRegistry, MissingArcError } from "./registry.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function fixture(trusted = true): Promise<{
  recall: ArcRecall;
  registry: ArcRegistry;
  workspace: MemoryStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "keywork-recall-"));
  cleanups.push(root);
  const workspace = new MemoryStore({ vaultRoot: root, trusted });
  const registry = new ArcRegistry({ vaultRoot: root, trusted });
  const recall = new ArcRecall({ workspace: new MemorySearch(workspace), registry });
  return { recall, registry, workspace };
}

async function seedArcNote(registry: ArcRegistry, slug: string, title: string): Promise<void> {
  await registry.arcStore(slug).writeNote({
    title,
    body: "The dock ratio convention is 50/50.\n",
    provenance: "agent",
  });
}

describe("the boosted arc stratum", () => {
  it("adds arc hits on top of workspace hits, tagged by layer, arc boosted above ties", async () => {
    const { recall, registry, workspace } = await fixture();
    await workspace.writeNote({
      title: "Ratio Convention",
      body: "The dock ratio convention is 50/50.\n",
      provenance: "user",
    });
    await registry.createArc("dock-v2");
    await seedArcNote(registry, "dock-v2", "Dock Ratio Finding");
    const outcome = await recall.searchAmbient("dock ratio convention", "dock-v2");
    const layers = outcome.hits.map((hit) => hit.layer);
    expect(layers).toContain("arc");
    expect(layers).toContain("workspace");
    expect(outcome.hits[0]?.layer).toBe("arc");
  });

  it("never masks a workspace hit, however loud the arc stratum is", async () => {
    const { recall, registry, workspace } = await fixture();
    await workspace.writeNote({
      title: "Workspace Dock Fact",
      body: "The dock ratio convention is 50/50.\n",
      provenance: "user",
    });
    await registry.createArc("dock-v2");
    for (let i = 0; i < 12; i += 1) {
      await seedArcNote(registry, "dock-v2", `Arc Dock Note ${i}`);
    }
    const ambient = await recall.searchAmbient("dock ratio convention", "dock-v2", { limit: 4 });
    const workspaceOnly = await recall.searchAmbient("dock ratio convention", undefined, {
      limit: 4,
    });
    for (const hit of workspaceOnly.hits) {
      expect(ambient.hits.map((h) => h.note.name)).toContain(hit.note.name);
    }
  });

  it("excludes other live arcs from ambient recall but keeps them explicitly searchable", async () => {
    const { recall, registry } = await fixture();
    await registry.createArc("dock-v2");
    await registry.createArc("infra");
    await seedArcNote(registry, "infra", "Infra Dock Secret");
    const ambient = await recall.searchAmbient("dock ratio", "dock-v2");
    expect(ambient.hits.map((hit) => hit.note.name)).not.toContain("Infra Dock Secret");
    const explicit = await recall.searchArc("infra", "dock ratio");
    expect(explicit.hits.map((hit) => hit.note.name)).toContain("Infra Dock Secret");
    expect(explicit.hits.every((hit) => hit.layer === "arc")).toBe(true);
  });

  it("excludes archived arcs from ambient recall entirely, even when still bound", async () => {
    const { recall, registry } = await fixture();
    await registry.createArc("dock-v2");
    await seedArcNote(registry, "dock-v2", "Dock Ratio Finding");
    await registry.archiveArc("dock-v2");
    const ambient = await recall.searchAmbient("dock ratio", "dock-v2");
    expect(ambient.hits).toEqual([]);
    const explicit = await recall.searchArc("dock-v2", "dock ratio");
    expect(explicit.hits.map((hit) => hit.note.name)).toContain("Dock Ratio Finding");
  });

  it("rejects explicit search of an arc that does not exist", async () => {
    const { recall } = await fixture();
    await expect(recall.searchArc("ghost", "anything")).rejects.toThrow(MissingArcError);
  });

  it("stays inert in an untrusted workspace", async () => {
    const { recall } = await fixture(false);
    const outcome = await recall.searchAmbient("dock ratio", "dock-v2");
    expect(outcome.hits).toEqual([]);
  });
});

describe("the arc bootstrap slice", () => {
  it("transcludes the MOC first, then notes within budget, listing what was skipped", async () => {
    const { registry } = await fixture();
    await registry.createArc("dock-v2");
    const store = registry.arcStore("dock-v2");
    await store.writeNote({ title: "Small Note", body: "tiny\n", provenance: "agent" });
    await store.writeNote({
      title: "Huge Note",
      body: `${"x".repeat(4000)}\n`,
      provenance: "agent",
    });
    const layer = await arcBootstrapLayer(registry, "dock-v2", 200);
    expect(layer.name).toBe("arc:dock-v2");
    expect(layer.selection.notes[0]?.name).toBe("MOC");
    expect(layer.selection.notes.map((note) => note.name)).toContain("Small Note");
    expect(layer.selection.skipped).toContain("Huge Note");
    expect(layer.selection.tokens).toBeLessThanOrEqual(200);
  });

  it("selects nothing from an archived arc", async () => {
    const { registry } = await fixture();
    await registry.createArc("dock-v2");
    await registry.archiveArc("dock-v2");
    const layer = await arcBootstrapLayer(registry, "dock-v2", 200);
    expect(layer.selection.notes).toEqual([]);
  });
});
