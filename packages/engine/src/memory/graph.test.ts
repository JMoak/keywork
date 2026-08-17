import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { entityTypeSchema, MemoryGraph, predicateSchema, predicates } from "./graph.ts";
import { MemoryStore, type Note } from "./store.ts";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const root = cleanups.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function vault(files: Record<string, string>): Promise<Note[]> {
  const root = await mkdtemp(join(tmpdir(), "keywork-graph-"));
  cleanups.push(root);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return new MemoryStore({ vaultRoot: root, trusted: true }).listNotes();
}

function note(body: string, frontmatter: Record<string, string> = {}): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  return lines.length === 0 ? body : `---\n${lines.join("\n")}\n---\n${body}`;
}

describe("ontology", () => {
  it("stays small, closed, and typed", () => {
    expect(entityTypeSchema.options).toHaveLength(9);
    expect(predicateSchema.options).toHaveLength(16);
    expect(entityTypeSchema.safeParse("vibe").success).toBe(false);
    expect(predicateSchema.safeParse("reminds_of").success).toBe(false);
    expect(predicates).toContain("consolidates");
    expect(predicates).toContain("consolidated_by");
  });
});

describe("MemoryGraph.fromNotes", () => {
  it("derives nodes from notes and edges from wikilinks and typed relations", async () => {
    const graph = MemoryGraph.fromNotes(
      await vault({
        "Dock Decision.md": note("we chose [[Split Layout]]", {
          type: '"decision"',
          applies_to: '"[[entities/packages/tui/layout.ts]]"',
        }),
        "Split Layout.md": note("panes split evenly"),
        "entities/packages/tui/layout.ts.md": note("layout module", {
          aliases: '["layout.ts"]',
        }),
      }),
    );
    expect(graph.nodes()).toHaveLength(3);
    expect(graph.resolve("Dock Decision")?.type).toBe("decision");
    expect(graph.resolve("entities/packages/tui/layout.ts")?.type).toBe("file");
    expect(graph.edges).toContainEqual({
      subject: "Dock Decision",
      predicate: "relates_to",
      object: "Split Layout",
    });
    expect(graph.edges).toContainEqual({
      subject: "Dock Decision",
      predicate: "applies_to",
      object: "entities/packages/tui/layout.ts",
    });
  });

  it("resolves file entities through their canonical repo path and short-name alias", async () => {
    const graph = MemoryGraph.fromNotes(
      await vault({
        "entities/packages/tui/layout.ts.md": note("layout module", {
          aliases: '["layout.ts"]',
        }),
      }),
    );
    expect(graph.resolve("layout.ts")?.name).toBe("entities/packages/tui/layout.ts");
    expect(graph.resolve("ENTITIES/PACKAGES/TUI/LAYOUT.TS")?.name).toBe(
      "entities/packages/tui/layout.ts",
    );
  });

  it("records dangling links as worth-writing instead of crashing", async () => {
    const graph = MemoryGraph.fromNotes(
      await vault({
        "Lonely Note.md": note("see [[Never Written]]", { depends_on: '"[[Also Missing]]"' }),
      }),
    );
    expect(graph.edgeCount).toBe(0);
    expect(graph.danglingLinks).toEqual([
      { from: "Lonely Note", predicate: "relates_to", to: "Never Written" },
      { from: "Lonely Note", predicate: "depends_on", to: "Also Missing" },
    ]);
    expect(graph.rank(["Lonely Note"])).toEqual([]);
  });

  it("skips ontology-invalid relations while still indexing the note", async () => {
    const graph = MemoryGraph.fromNotes(
      await vault({
        "Odd Note.md": note("body", { depends_on: '"not a wikilink"', type: '"vibe"' }),
        "Other.md": note("links to [[Odd Note]]"),
      }),
    );
    const odd = graph.resolve("Odd Note");
    expect(odd).toBeDefined();
    expect(odd?.type).toBeUndefined();
    expect(graph.skippedRelations).toEqual([
      { note: "Odd Note", predicate: "depends_on", value: "not a wikilink" },
    ]);
    expect(graph.edges).toEqual([
      { subject: "Other", predicate: "relates_to", object: "Odd Note" },
    ]);
  });

  it("carries supersession and consolidation as distinct typed edges", async () => {
    const graph = MemoryGraph.fromNotes(
      await vault({
        "New Rule.md": note("60/40", { supersedes: '"[[Old Rule]]"' }),
        "Old Rule.md": note("50/50", { superseded_by: '"[[New Rule]]"' }),
        "Arc Lesson.md": note("distilled", { consolidated_by: '"[[Season Summary]]"' }),
        "Season Summary.md": note("the season", { consolidates: '"[[Arc Lesson]]"' }),
      }),
    );
    const predicatesUsed = graph.edges.map((edge) => edge.predicate).sort();
    expect(predicatesUsed).toEqual([
      "consolidated_by",
      "consolidates",
      "superseded_by",
      "supersedes",
    ]);
  });
});

describe("contradictionsOf", () => {
  it("surfaces contradiction partners from either edge direction", async () => {
    const notes = await vault({
      "Use Bun.md": note("run on bun", { contradicts: '"[[Use Node]]"' }),
      "Use Node.md": note("run on node"),
    });
    const graph = MemoryGraph.fromNotes(notes);
    expect(graph.contradictionsOf("Use Bun")).toEqual(["Use Node"]);
    expect(graph.contradictionsOf("Use Node")).toEqual(["Use Bun"]);
    expect(graph.contradictionsOf("Never Written")).toEqual([]);
  });
});

describe("outline", () => {
  it("answers local one and two hop neighborhoods, never a global view", async () => {
    const graph = MemoryGraph.fromNotes(
      await vault({
        "A.md": note("see [[B]]"),
        "B.md": note("see [[C]]"),
        "C.md": note("see [[D]]"),
        "D.md": note("the end"),
      }),
    );
    expect(graph.outline("A", 1)).toEqual([
      { name: "B", predicate: "relates_to", direction: "out", depth: 1 },
    ]);
    expect(graph.outline("A", 2)).toEqual([
      { name: "B", predicate: "relates_to", direction: "out", depth: 1 },
      { name: "C", predicate: "relates_to", direction: "out", depth: 2 },
    ]);
    expect(graph.outline("C", 1)).toEqual([
      { name: "B", predicate: "relates_to", direction: "in", depth: 1 },
      { name: "D", predicate: "relates_to", direction: "out", depth: 1 },
    ]);
    expect(graph.outline("Never Written", 2)).toEqual([]);
  });
});

describe("rank", () => {
  it("converges on cyclic wikilinks and keeps total mass bounded", async () => {
    const graph = MemoryGraph.fromNotes(
      await vault({
        "A.md": note("see [[B]]"),
        "B.md": note("see [[C]]"),
        "C.md": note("back to [[A]]"),
      }),
    );
    const ranked = graph.rank(["A"], { iterations: 50 });
    expect(ranked.map((entry) => entry.name)).toEqual(["A", "B", "C"]);
    const mass = ranked.reduce((sum, entry) => sum + entry.score, 0);
    expect(mass).toBeGreaterThan(0.5);
    expect(mass).toBeLessThanOrEqual(1.000001);
  });

  it("ranks near neighbors of the seed above far ones", async () => {
    const graph = MemoryGraph.fromNotes(
      await vault({
        "Seed.md": note("see [[Near]]"),
        "Near.md": note("see [[Far]]"),
        "Far.md": note("the frontier"),
        "Island.md": note("unlinked"),
      }),
    );
    const ranked = graph.rank(["Seed"], { iterations: 40 });
    const scores = new Map(ranked.map((entry) => [entry.name, entry.score]));
    expect((scores.get("Seed") ?? 0) > (scores.get("Far") ?? 0)).toBe(true);
    expect((scores.get("Near") ?? 0) > (scores.get("Far") ?? 0)).toBe(true);
    expect(scores.has("Island")).toBe(false);
  });

  it("mutes entirely without seeds or without edges", async () => {
    const linked = MemoryGraph.fromNotes(
      await vault({ "A.md": note("see [[B]]"), "B.md": note("b") }),
    );
    expect(linked.rank([])).toEqual([]);
    expect(linked.rank(["Never Written"])).toEqual([]);
    const edgeless = MemoryGraph.fromNotes(await vault({ "A.md": note("alone") }));
    expect(edgeless.rank(["A"])).toEqual([]);
  });
});
