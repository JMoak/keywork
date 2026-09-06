import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import { ArcRecall, searchHitLayer } from "../arcs/recall.ts";
import { ArcRegistry } from "../arcs/registry.ts";
import { MemorySearch } from "../search.ts";
import { MemoryStore } from "../store.ts";
import { BotRecall, botBootstrapLayer } from "./recall.ts";
import { BotRegistry, MissingBotLayerError } from "./registry.ts";

const scratch = scratchDirs("keywork-bot-recall-");

async function fixture(trusted = true): Promise<{
  recall: BotRecall;
  registry: BotRegistry;
  workspace: MemoryStore;
  root: string;
}> {
  const root = await scratch();
  const workspace = new MemoryStore({ vaultRoot: root, trusted });
  const registry = new BotRegistry({ vaultRoot: root, trusted });
  const recall = new BotRecall({ base: new MemorySearch(workspace), registry });
  return { recall, registry, workspace, root };
}

async function teach(registry: BotRegistry, slug: string, title: string): Promise<void> {
  await registry.materialize(slug);
  await registry.botStore(slug).writeNote({
    title,
    body: "Review comments should stay terse.\n",
    provenance: "agent",
  });
}

describe("the boosted bot stratum", () => {
  it("adds the active bot's hits atop workspace hits, tagged and boosted, hiding nothing", async () => {
    const { recall, registry, workspace } = await fixture();
    await workspace.writeNote({
      title: "Review Convention",
      body: "Review comments should stay terse.\n",
      provenance: "user",
    });
    await teach(registry, "reviewer", "Terse Reviews");
    const outcome = await recall.searchAmbient("terse review comments", "reviewer");
    const layers = outcome.hits.map(searchHitLayer);
    expect(layers).toContain("bot:reviewer");
    expect(layers).toContain("workspace");
    expect(outcome.hits[0]?.layer).toBe("bot");
    expect(outcome.botSource).toEqual({ kind: "lexical" });
  });

  it("lets two sessions bound to one bot recall each other's layer writes", async () => {
    const { registry, workspace, root } = await fixture();
    const registryB = new BotRegistry({ vaultRoot: root, trusted: true });
    const sessionA = new BotRecall({ base: new MemorySearch(workspace), registry });
    const sessionB = new BotRecall({ base: new MemorySearch(workspace), registry: registryB });
    await teach(registry, "reviewer", "Terse Reviews");
    const fromB = await sessionB.searchAmbient("terse review comments", "reviewer");
    expect(fromB.hits.map((hit) => hit.note.name)).toEqual(["Terse Reviews"]);
    await registryB.botStore("reviewer").writeNote({
      title: "Snapshot Tests",
      body: "Jordan dislikes snapshot tests in reviews.\n",
      provenance: "agent",
    });
    const fromA = await sessionA.searchAmbient("snapshot tests", "reviewer");
    expect(fromA.hits.map((hit) => hit.note.name)).toEqual(["Snapshot Tests"]);
  });

  it("keeps other bots' layers out of ambient recall yet reachable by explicit search", async () => {
    const { recall, registry } = await fixture();
    await teach(registry, "reviewer", "Terse Reviews");
    await teach(registry, "scout", "Terse Scouting");
    const ambient = await recall.searchAmbient("terse", "reviewer");
    expect(ambient.hits.map((hit) => hit.note.name)).toEqual(["Terse Reviews"]);
    const unbound = await recall.searchAmbient("terse", undefined);
    expect(unbound.hits).toEqual([]);
    const explicit = await recall.searchBot("scout", "terse");
    expect(explicit.hits.map((hit) => hit.note.name)).toEqual(["Terse Scouting"]);
    expect(explicit.hits[0]?.layer).toBe("bot");
    await expect(recall.searchBot("ghost", "terse")).rejects.toBeInstanceOf(MissingBotLayerError);
  });

  it("composes over an arc-composed searcher, keeping the arc tags beneath", async () => {
    const { registry, workspace, root } = await fixture();
    const arcs = new ArcRegistry({ vaultRoot: root, trusted: true });
    await arcs.createArc("dock-v2");
    await arcs.arcStore("dock-v2").writeNote({
      title: "Dock Terse Note",
      body: "terse dock finding\n",
      provenance: "agent",
    });
    await teach(registry, "reviewer", "Terse Reviews");
    const arcRecall = new ArcRecall({ workspace: new MemorySearch(workspace), registry: arcs });
    const recall = new BotRecall({
      base: {
        search: async (query, options) => {
          const outcome = await arcRecall.searchAmbient(query, "dock-v2", options);
          return { hits: outcome.hits, source: outcome.workspaceSource };
        },
      },
      registry,
    });
    const outcome = await recall.searchAmbient("terse", "reviewer");
    expect(outcome.hits.map(searchHitLayer).sort()).toEqual(["arc:dock-v2", "bot:reviewer"]);
  });

  it("skips a retired bot's layer in ambient recall", async () => {
    const { recall, registry } = await fixture();
    await teach(registry, "reviewer", "Terse Reviews");
    await registry.retireBot("reviewer");
    const outcome = await recall.searchAmbient("terse", "reviewer");
    expect(outcome.hits).toEqual([]);
  });

  it("is inert in an untrusted vault", async () => {
    const { recall, registry } = await fixture(false);
    const outcome = await recall.searchAmbient("terse", "reviewer");
    expect(outcome.hits).toEqual([]);
    expect(await botBootstrapLayer(registry, "reviewer", 512)).toEqual({
      name: "bot:reviewer",
      selection: { notes: [], tokens: 0, budget: 512, skipped: [] },
    });
  });
});

describe("botBootstrapLayer", () => {
  it("leads with the MOC and stays within the budget it was handed", async () => {
    const { registry } = await fixture();
    await teach(registry, "reviewer", "Terse Reviews");
    await registry.botStore("reviewer").writeNote({
      title: "Long Habit",
      body: `${"words ".repeat(400)}\n`,
      provenance: "agent",
    });
    const layer = await botBootstrapLayer(registry, "reviewer", 120);
    expect(layer.name).toBe("bot:reviewer");
    expect(layer.selection.notes[0]?.name).toBe("MOC");
    expect(layer.selection.notes.map((note) => note.name)).toContain("Terse Reviews");
    expect(layer.selection.skipped).toEqual(["Long Habit"]);
    expect(layer.selection.tokens).toBeLessThanOrEqual(120);
  });

  it("is empty for a bot whose layer never materialized", async () => {
    const { registry } = await fixture();
    const layer = await botBootstrapLayer(registry, "reviewer", 512);
    expect(layer.selection.notes).toEqual([]);
  });
});
