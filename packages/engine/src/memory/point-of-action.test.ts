import { describe, expect, it } from "vitest";
import type { ToolCallPart } from "../messages.ts";
import { contextBudgetFor } from "../session/context-budget.ts";
import { CitationLedger } from "./citations.ts";
import type { Note } from "./notes.ts";
import { actionRecallBudget, actionSubject, pointOfActionRecall } from "./point-of-action.ts";
import type { LegRanks, MemorySearcher, SearchHit, SearchOutcome } from "./search.ts";

function call(name: string, args: unknown): ToolCallPart {
  return { type: "tool-call", callId: "call-1", name, arguments: args };
}

function noteOf(name: string, tokens: number, body = `${name} body`): Note {
  return {
    name,
    path: `${name}.md`,
    title: name,
    provenance: "agent",
    pinned: false,
    aliases: [],
    body: `${body}\n`,
    links: [],
    tokens,
    frontmatter: {},
  };
}

function hitOf(
  name: string,
  tokens: number,
  ranks: LegRanks = { lexical: 1 },
  superseded = false,
): SearchHit {
  return {
    note: noteOf(name, tokens),
    score: 1,
    legs: Object.keys(ranks) as SearchHit["legs"],
    ranks,
    superseded,
    relations: { contradicts: [] },
  };
}

function searcherOf(hits: SearchHit[]): MemorySearcher & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    search: async (query) => {
      queries.push(query);
      return { hits, source: { kind: "lexical" } };
    },
  };
}

describe("actionSubject", () => {
  it("keys write and edit on the path and bash on the command's first line", () => {
    expect(actionSubject(call("write", { path: "src/app.ts", content: "x" }))).toBe("src/app.ts");
    expect(actionSubject(call("edit", { path: "docs/vision.md" }))).toBe("docs/vision.md");
    expect(actionSubject(call("bash", { command: "bun test\necho done" }))).toBe("bun test");
  });

  it("answers undefined for non-mutating tools, malformed arguments, and blank subjects", () => {
    expect(actionSubject(call("read", { path: "a.ts" }))).toBeUndefined();
    expect(actionSubject(call("write", "not an object"))).toBeUndefined();
    expect(actionSubject(call("write", { path: "   " }))).toBeUndefined();
    expect(actionSubject(call("bash", {}))).toBeUndefined();
  });

  it("caps a runaway subject at 200 characters", () => {
    const subject = actionSubject(call("bash", { command: "x".repeat(500) }));
    expect(subject).toHaveLength(200);
  });
});

describe("pointOfActionRecall", () => {
  it("surfaces relevant notes before a mutation, sourced and inside the grammar", async () => {
    const recall = pointOfActionRecall({ search: searcherOf([hitOf("Dock Rule", 40)]) });
    const injected = await recall(call("write", { path: "src/dock.ts" }));
    expect(injected).toBe(
      "## memory for src/dock.ts\n\n### [[Dock Rule]]\n\nDock Rule body\n\nretrieval: lexical",
    );
  });

  it("stays silent on zero hits and on unknown subjects", async () => {
    const recall = pointOfActionRecall({ search: searcherOf([]) });
    expect(await recall(call("write", { path: "src/dock.ts" }))).toBeUndefined();
    expect(await recall(call("read", { path: "src/dock.ts" }))).toBeUndefined();
  });

  it("speaks once per subject and never repeats a note for a second subject", async () => {
    const searcher = searcherOf([hitOf("Dock Rule", 40)]);
    const recall = pointOfActionRecall({ search: searcher });
    expect(await recall(call("write", { path: "src/dock.ts" }))).toBeDefined();
    expect(await recall(call("write", { path: "src/dock.ts" }))).toBeUndefined();
    expect(await recall(call("edit", { path: "src/other.ts" }))).toBeUndefined();
    expect(searcher.queries).toEqual(["src/dock.ts", "src/other.ts"]);
  });

  it("filters superseded and graph-only hits", async () => {
    const recall = pointOfActionRecall({
      search: searcherOf([
        hitOf("Old Rule", 20, { lexical: 1 }, true),
        hitOf("Graph Neighbor", 20, { graph: 1 }),
        hitOf("Live Rule", 20, { semantic: 2 }),
      ]),
    });
    const injected = await recall(call("write", { path: "src/dock.ts" }));
    expect(injected).toContain("[[Live Rule]]");
    expect(injected).not.toContain("[[Old Rule]]");
    expect(injected).not.toContain("[[Graph Neighbor]]");
  });

  it("records injected notes as action recalls on the citation tap", async () => {
    const ledger = new CitationLedger({ now: () => new Date("2026-08-31T09:00:00.000Z") });
    const recall = pointOfActionRecall({
      search: searcherOf([hitOf("Dock Rule", 40)]),
      tap: ledger,
    });
    await recall(call("write", { path: "src/dock.ts" }));
    expect(ledger.events()).toEqual([
      {
        kind: "recall",
        note: "Dock Rule",
        surface: "action",
        timestamp: "2026-08-31T09:00:00.000Z",
      },
    ]);
  });

  it("respects the token and note budgets over many random draws", async () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let draw = 0; draw < 100; draw += 1) {
      const tokens = 1 + Math.floor(random() * 300);
      const hits = Array.from({ length: Math.floor(random() * 12) }, (_, index) =>
        hitOf(`Note ${index}`, 1 + Math.floor(random() * 200)),
      );
      const recorded: SearchHit["note"][] = [];
      const recall = pointOfActionRecall({
        search: searcherOf(hits),
        tokens,
        onRecall: (name) => {
          const hit = hits.find((candidate) => candidate.note.name === name);
          if (hit !== undefined) recorded.push(hit.note);
        },
      });
      await recall(call("write", { path: `draw-${draw}.ts` }));
      expect(recorded.length).toBeLessThanOrEqual(3);
      const spent = recorded.reduce((sum, note) => sum + note.tokens, 0);
      expect(spent).toBeLessThanOrEqual(tokens);
    }
  });

  it("gives up within its time budget instead of blocking the tool call", async () => {
    const stuck: MemorySearcher = {
      search: () => new Promise<SearchOutcome>(() => {}),
    };
    const recall = pointOfActionRecall({ search: stuck, milliseconds: 20 });
    const started = performance.now();
    expect(await recall(call("write", { path: "src/dock.ts" }))).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("treats a throwing search as a miss", async () => {
    const failing: MemorySearcher = {
      search: async () => {
        throw new Error("index offline");
      },
    };
    const recall = pointOfActionRecall({ search: failing });
    expect(await recall(call("write", { path: "src/dock.ts" }))).toBeUndefined();
  });

  it("draws its default budget from the context reserves", () => {
    const budget = contextBudgetFor(200_000);
    expect(actionRecallBudget(budget)).toBe(1024);
    expect(actionRecallBudget(contextBudgetFor(8_000))).toBe(125);
  });
});
