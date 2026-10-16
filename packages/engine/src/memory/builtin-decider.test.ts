import { describe, expect, it } from "vitest";
import { builtinDecider } from "./builtin-decider.ts";
import {
  type ActionCandidates,
  agesOf,
  keptSideOf,
  memoryQuestions,
  type NotePair,
  type PairJudgment,
} from "./decider.ts";
import type { DriftJudgmentPort } from "./drift.ts";
import type { CurationJudgmentPort, PairVerdict } from "./gardener.ts";
import type { Note } from "./notes.ts";
import type { LegRanks, SearchHit } from "./search.ts";

function noteOf(name: string, overrides: Partial<Note> = {}): Note {
  return {
    name,
    path: `${name}.md`,
    title: name,
    provenance: "agent",
    pinned: false,
    aliases: [],
    body: `${name} body\n`,
    links: [],
    tokens: 10,
    frontmatter: {},
    ...overrides,
  };
}

function hitOf(name: string, tokens: number, ranks: LegRanks, superseded = false): SearchHit {
  return {
    note: noteOf(name, { tokens }),
    score: 1,
    legs: Object.keys(ranks) as SearchHit["legs"],
    ranks,
    superseded,
    relations: { contradicts: [] },
  };
}

function candidates(overrides: Partial<ActionCandidates> = {}): ActionCandidates {
  return {
    action: { callId: "call-1", tool: "edit", subject: "src/dock.ts", subjectKind: "path" },
    hits: [],
    surfaced: new Set(),
    budget: { tokens: 1024, notes: 3 },
    ...overrides,
  };
}

function selectedBeforeThePort(
  hits: readonly SearchHit[],
  alreadySurfaced: ReadonlySet<string>,
  tokenBudget: number,
  noteCap: number,
): SearchHit[] {
  const chosen: SearchHit[] = [];
  let spent = 0;
  for (const hit of hits) {
    if (chosen.length >= noteCap) break;
    if (hit.superseded || alreadySurfaced.has(hit.note.name)) continue;
    if (hit.ranks.lexical === undefined && hit.ranks.semantic === undefined) continue;
    if (spent + hit.note.tokens > tokenBudget) continue;
    chosen.push(hit);
    spent += hit.note.tokens;
  }
  return chosen;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const rankDraws: LegRanks[] = [
  { lexical: 1 },
  { semantic: 2 },
  { graph: 1 },
  { lexical: 3, graph: 1 },
];

describe("builtinDecider.chooseForAction", () => {
  it("keeps exactly what point-of-action recall kept before the port, over many draws", async () => {
    const random = seededRandom(7);
    const decider = builtinDecider();
    for (let draw = 0; draw < 300; draw += 1) {
      const hits = Array.from({ length: Math.floor(random() * 8) }, (_, index) =>
        hitOf(
          `Note ${index}`,
          1 + Math.floor(random() * 300),
          rankDraws[Math.floor(random() * rankDraws.length)] ?? { lexical: 1 },
          random() < 0.2,
        ),
      );
      const surfaced = new Set(hits.filter(() => random() < 0.2).map((hit) => hit.note.name));
      const budget = {
        tokens: 1 + Math.floor(random() * 600),
        notes: 1 + Math.floor(random() * 4),
      };

      const { outcome, decision } = await decider.chooseForAction(
        candidates({ hits, surfaced, budget }),
      );

      const before = selectedBeforeThePort(hits, surfaced, budget.tokens, budget.notes);
      expect(outcome).toEqual(before);
      expect(decision.choice).toEqual({
        kept: before.map((hit) => hit.note.name),
        dropped: hits.filter((hit) => !before.includes(hit)).map((hit) => hit.note.name),
      });
      expect(decision.candidates).toEqual(hits.map((hit) => hit.note.name));
    }
  });

  it("records the call, the builtin as decider, and no odds", async () => {
    const { decision } = await builtinDecider().chooseForAction(
      candidates({ hits: [hitOf("Dock Rule", 40, { lexical: 1 })] }),
    );

    expect(decision).toEqual({
      id: expect.any(String),
      question: "action-relevance@1",
      about: { kind: "call", callId: "call-1" },
      candidates: ["Dock Rule"],
      choice: { kept: ["Dock Rule"], dropped: [] },
      decider: "builtin",
      rule: '[[Dock Rule]] shares "dock" with the path',
      latencyMs: expect.any(Number),
    });
  });

  it("says in words why each candidate was kept or dropped", async () => {
    const { decision } = await builtinDecider().chooseForAction(
      candidates({
        action: { callId: "c", tool: "bash", subject: "bun test dock", subjectKind: "command" },
        hits: [
          hitOf("Old Dock", 10, { lexical: 1 }, true),
          hitOf("Seen Dock", 10, { lexical: 2 }),
          hitOf("Neighbor", 10, { graph: 1 }),
          hitOf("Dock Rule", 10, { lexical: 3 }),
          hitOf("Meaning", 10, { semantic: 1 }),
          hitOf("Huge Dock", 900, { lexical: 4 }),
          hitOf("Late Dock", 10, { lexical: 5 }),
        ],
        surfaced: new Set(["Seen Dock"]),
        budget: { tokens: 100, notes: 2 },
      }),
    );

    expect(decision.rule?.split("; ")).toEqual([
      "[[Old Dock]] is superseded",
      "[[Seen Dock]] was already surfaced",
      "[[Neighbor]] is only a graph neighbor",
      '[[Dock Rule]] shares "dock" with the command',
      "[[Meaning]] is near the command in meaning",
      "[[Huge Dock]] is past the 2-note cap",
      "[[Late Dock]] is past the 2-note cap",
    ]);
  });

  it("names the budget a note would overflow", async () => {
    const { decision } = await builtinDecider().chooseForAction(
      candidates({ hits: [hitOf("Huge Dock", 2000, { lexical: 1 })] }),
    );

    expect(decision.rule).toBe("[[Huge Dock]] would pass the 1024-token budget");
    expect(decision.choice).toEqual({ kept: [], dropped: ["Huge Dock"] });
  });
});

describe("builtinDecider.triageEntries", () => {
  it("sends every entry to the distiller, one decision per entry", async () => {
    const entries = [
      { id: "2026-08-10#0", date: "2026-08-10", time: "09:00", provenance: "user", text: "a" },
      { id: "2026-08-10#1", date: "2026-08-10", time: "09:05", provenance: "agent", text: "b" },
    ] as const;

    const triaged = await builtinDecider().triageEntries({ entries });

    expect(triaged.map(({ outcome }) => outcome)).toEqual([
      { entryId: "2026-08-10#0", durability: "unsure" },
      { entryId: "2026-08-10#1", durability: "unsure" },
    ]);
    expect(triaged[1]?.decision).toMatchObject({
      question: memoryQuestions.entryDurability,
      about: { kind: "entry", entryId: "2026-08-10#1" },
      candidates: ["2026-08-10#1"],
      choice: "unsure",
      decider: "builtin",
      rule: "every trusted entry within the sweep budget goes to the distiller",
    });
  });
});

describe("builtinDecider.relatePair", () => {
  const older = noteOf("Older", { created: "2026-08-01" });
  const newer = noteOf("Newer", { created: "2026-08-09" });

  function chatModelSaying(verdict: PairVerdict): CurationJudgmentPort & { asked: string[][] } {
    const asked: string[][] = [];
    return {
      id: "closing:fake",
      asked,
      proposePromotions: async () => [],
      classifyPair: async (a, b) => {
        asked.push([a.name, b.name]);
        return verdict;
      },
    };
  }

  function keptBeforeThePort({ a, b }: NotePair, verdict: PairVerdict): Note {
    const newerOf = (b.created ?? "") > (a.created ?? "") ? b : a;
    return verdict.keep === "a" ? a : verdict.keep === "b" ? b : newerOf;
  }

  function keptAfter(pair: NotePair, judgment: PairJudgment): Note | undefined {
    const side = keptSideOf(judgment);
    if (side === undefined) return undefined;
    return agesOf(pair)[side];
  }

  const verdicts: PairVerdict[] = [
    { relation: "duplicate", confidence: 0.9, mergedBody: "merged\n" },
    { relation: "duplicate", confidence: 0.9, keep: "a" },
    { relation: "duplicate", confidence: 0.9, keep: "b" },
    { relation: "supersedes", confidence: 0.85 },
    { relation: "supersedes", confidence: 0.85, keep: "a" },
    { relation: "supersedes", confidence: 0.85, keep: "b" },
  ];

  it("keeps the same note the Gardener kept before the port, either way round", async () => {
    for (const pair of [
      { a: older, b: newer, similarity: 0.4 },
      { a: newer, b: older, similarity: 0.4 },
    ]) {
      for (const verdict of verdicts) {
        const chatModel = chatModelSaying(verdict);
        const { outcome } = await builtinDecider({ curation: chatModel }).relatePair(pair);

        expect(keptAfter(pair, outcome)).toBe(keptBeforeThePort(pair, verdict));
        expect(outcome.confidence).toBe(verdict.confidence);
        expect(outcome.relation === "duplicate" ? outcome.mergedBody : undefined).toBe(
          verdict.mergedBody,
        );
        expect(chatModel.asked).toEqual([[pair.a.name, pair.b.name]]);
      }
    }
  });

  it("passes distinct and contradiction through and keeps nothing", async () => {
    const pair = { a: older, b: newer, similarity: 0.35 };
    for (const relation of ["distinct", "contradiction"] as const) {
      const chatModel = chatModelSaying({ relation, confidence: 0.7 });
      const { outcome } = await builtinDecider({ curation: chatModel }).relatePair(pair);
      expect(outcome).toEqual({ relation, confidence: 0.7 });
      expect(keptSideOf(outcome)).toBeUndefined();
    }
  });

  it("records the pair by age with the similarity and the judge in words", async () => {
    const chatModel = chatModelSaying({ relation: "duplicate", confidence: 0.9, keep: "a" });

    const { decision } = await builtinDecider({ curation: chatModel }).relatePair({
      a: older,
      b: newer,
      similarity: 0.4123,
    });

    expect(decision).toMatchObject({
      question: "pair-relation@1",
      about: { kind: "pair", older: "Older", newer: "Newer" },
      candidates: ["Older", "Newer"],
      choice: "duplicate",
      confidence: 0.9,
      decider: "builtin",
      rule: "jaccard 0.41 · judged by closing:fake, keeping the older note",
    });
    expect(JSON.stringify(decision)).not.toContain("merged");
  });

  it("is unsure and asks no one when no chat model is wired", async () => {
    const { outcome, decision } = await builtinDecider().relatePair({
      a: older,
      b: newer,
      similarity: 0.5,
    });

    expect(outcome).toEqual({ relation: "unsure", confidence: 0 });
    expect(decision.rule).toBe("jaccard 0.50 · no chat model to judge the pair");
  });
});

describe("builtinDecider.assessDrift", () => {
  const note = noteOf("Auth Tokens");

  it("returns the chat model's assessment untouched and records its reason", async () => {
    const chatModel: DriftJudgmentPort = {
      id: "drift:fake",
      assess: async () => ({ verdict: "stale", reason: "the diff renames\n  mintToken" }),
    };

    const { outcome, decision } = await builtinDecider({ drift: chatModel }).assessDrift({
      note,
      evidence: ["src/auth.ts: @@ -1 +1 @@"],
    });

    expect(outcome).toEqual({ verdict: "stale", reason: "the diff renames\n  mintToken" });
    expect(decision).toMatchObject({
      question: "drift-verdict@1",
      about: { kind: "note", note: "Auth Tokens" },
      candidates: ["Auth Tokens"],
      choice: "stale",
      decider: "builtin",
      rule: "asked drift:fake · the diff renames mintToken",
    });
  });

  it("is unsure when no chat model is wired", async () => {
    const { outcome, decision } = await builtinDecider().assessDrift({ note, evidence: [] });

    expect(outcome).toEqual({ verdict: "unsure", reason: "no chat model to ask" });
    expect(decision.rule).toBe("no chat model to ask");
  });
});

describe("builtinDecider.weighMention", () => {
  it("links every mention the rule found", async () => {
    const { outcome, decision } = await builtinDecider().weighMention({
      source: noteOf("Deploy"),
      target: noteOf("Auth Tokens"),
      mention: "Auth Tokens",
    });

    expect(outcome).toBe("link");
    expect(decision).toMatchObject({
      question: "mention-is-link@1",
      about: { kind: "mention", note: "Deploy", target: "Auth Tokens" },
      candidates: ["Auth Tokens"],
      choice: "link",
      decider: "builtin",
      rule: 'mentions "Auth Tokens" without linking it',
    });
  });
});
