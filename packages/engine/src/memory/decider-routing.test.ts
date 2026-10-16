import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";
import type { ToolCallPart } from "../messages.ts";
import { builtinDecider } from "./builtin-decider.ts";
import {
  type Decided,
  type DecisionChoice,
  type EntryDurability,
  type MemoryDecider,
  type MemoryDecision,
  type MemoryQuestion,
  memoryQuestions,
} from "./decider.ts";
import { checkDrift, type DiffChanges } from "./drift.ts";
import { type CurationJudgmentPort, type DailyEntryCandidate, Gardener } from "./gardener.ts";
import type { Note } from "./notes.ts";
import { pointOfActionRecall } from "./point-of-action.ts";
import type { LegRanks, MemorySearcher, SearchHit } from "./search.ts";
import { MemoryStore } from "./store.ts";

const scratch = scratchDirs("keywork-decider-routing-");
const clock = () => new Date("2026-10-15T09:00:00.000Z");

async function trustedStore(now: () => Date = clock): Promise<MemoryStore> {
  return new MemoryStore({ vaultRoot: await scratch(), trusted: true, now });
}

function tickingClock(): () => Date {
  let minute = 0;
  return () => new Date(Date.UTC(2026, 9, 15, 9, minute++));
}

function decisionOf(question: MemoryQuestion, choice: DecisionChoice): MemoryDecision {
  return {
    id: `scripted-${question}`,
    question,
    about: { kind: "query", query: "scripted" },
    candidates: [],
    choice,
    decider: "jev",
    latencyMs: 1,
  };
}

function decided<Outcome>(
  question: MemoryQuestion,
  outcome: Outcome,
  choice: DecisionChoice,
): Decided<Outcome> {
  return { outcome, decision: decisionOf(question, choice) };
}

function scriptedDecider(overrides: Partial<MemoryDecider>): MemoryDecider {
  return { ...builtinDecider(), id: "scripted", ...overrides };
}

function hitOf(name: string, ranks: LegRanks = { lexical: 1 }, superseded = false): SearchHit {
  const note: Note = {
    name,
    path: `${name}.md`,
    title: name,
    provenance: "agent",
    pinned: false,
    aliases: [],
    body: `${name} body\n`,
    links: [],
    tokens: 20,
    frontmatter: {},
  };
  return { note, score: 1, legs: [], ranks, superseded, relations: { contradicts: [] } };
}

function searcherOf(hits: SearchHit[]): MemorySearcher {
  return { search: async () => ({ hits, source: { kind: "lexical" } }) };
}

function write(path: string, callId = "call-1"): ToolCallPart {
  return { type: "tool-call", callId, name: "write", arguments: { path, content: "x" } };
}

describe("point-of-action recall through the decider", () => {
  it("records one decision per recall with its candidates, kept and dropped, before injecting", async () => {
    const order: string[] = [];
    const decisions: MemoryDecision[] = [];
    const recall = pointOfActionRecall({
      search: searcherOf([
        hitOf("Dock Rule"),
        hitOf("Old Rule", { lexical: 2 }, true),
        hitOf("Neighbor", { graph: 1 }),
      ]),
      onDecision: (decision) => {
        order.push("decided");
        decisions.push(decision);
      },
      onRecall: (name) => order.push(`recalled ${name}`),
    });

    await recall(write("src/dock.ts"));

    expect(order).toEqual(["decided", "recalled Dock Rule"]);
    expect(decisions).toEqual([
      expect.objectContaining({
        question: "action-relevance@1",
        about: { kind: "call", callId: "call-1" },
        candidates: ["Dock Rule", "Old Rule", "Neighbor"],
        choice: { kept: ["Dock Rule"], dropped: ["Old Rule", "Neighbor"] },
        decider: "builtin",
      }),
    ]);
  });

  it("records a decision that keeps nothing, so a silent recall still says why", async () => {
    const decisions: MemoryDecision[] = [];
    const recall = pointOfActionRecall({
      search: searcherOf([hitOf("Old Rule", { lexical: 1 }, true)]),
      onDecision: (decision) => decisions.push(decision),
    });

    expect(await recall(write("src/dock.ts"))).toBeUndefined();
    expect(decisions.map((decision) => decision.choice)).toEqual([
      { kept: [], dropped: ["Old Rule"] },
    ]);
  });

  it("injects what the decider it is given keeps, in the decider's order", async () => {
    const hits = [hitOf("First"), hitOf("Second"), hitOf("Third")];
    const recalled: string[] = [];
    const recall = pointOfActionRecall({
      search: searcherOf(hits),
      decider: scriptedDecider({
        chooseForAction: async (input) =>
          decided(memoryQuestions.actionRelevance, [input.hits[2], input.hits[0]] as SearchHit[], {
            kept: ["Third", "First"],
            dropped: ["Second"],
          }),
      }),
      onRecall: (name) => recalled.push(name),
    });

    const injected = await recall(write("src/dock.ts"));

    expect(recalled).toEqual(["Third", "First"]);
    expect(injected?.indexOf("[[Third]]")).toBeLessThan(injected?.indexOf("[[First]]") ?? -1);
    expect(injected).not.toContain("[[Second]]");
  });

  it("decides nothing when the search finds nothing or the subject was already asked about", async () => {
    const decisions: MemoryDecision[] = [];
    const empty = pointOfActionRecall({
      search: searcherOf([]),
      onDecision: (decision) => decisions.push(decision),
    });
    await empty(write("src/dock.ts"));
    const repeated = pointOfActionRecall({
      search: searcherOf([hitOf("Dock Rule")]),
      onDecision: (decision) => decisions.push(decision),
    });
    await repeated(write("src/dock.ts", "call-1"));
    await repeated(write("src/dock.ts", "call-2"));

    expect(decisions.map((decision) => decision.about)).toEqual([
      { kind: "call", callId: "call-1" },
    ]);
  });
});

function distiller(): CurationJudgmentPort & { seen: string[][] } {
  const seen: string[][] = [];
  return {
    id: "closing:fake",
    seen,
    proposePromotions: async (entries) => {
      seen.push(entries.map((entry) => entry.text));
      return [];
    },
    classifyPair: async () => ({ relation: "distinct", confidence: 1 }),
  };
}

function triageBy(
  durabilityOf: (entry: DailyEntryCandidate) => EntryDurability,
): MemoryDecider["triageEntries"] {
  return async ({ entries }) =>
    entries.map((entry) => {
      const durability = durabilityOf(entry);
      return decided(
        memoryQuestions.entryDurability,
        { entryId: entry.id, durability },
        durability,
      );
    });
}

describe("the Gardener through the decider", () => {
  it("hands the distiller only the entries the decider passes, and records each triage", async () => {
    const store = await trustedStore();
    await store.appendDaily("lunch was late", "user");
    await store.appendDaily("tests run on node, never bun", "user");
    await store.appendDaily("node again, as noted", "user");
    const chatModel = distiller();
    const decisions: MemoryDecision[] = [];
    const gardener = new Gardener({
      store,
      judgment: chatModel,
      decider: scriptedDecider({
        triageEntries: triageBy((entry) =>
          entry.text.startsWith("lunch")
            ? "episodic"
            : entry.text.startsWith("node")
              ? "reinforces-a-note"
              : "new-durable",
        ),
      }),
      onDecision: (decision) => decisions.push(decision),
    });

    await gardener.sweep();

    expect(chatModel.seen).toEqual([["tests run on node, never bun"]]);
    expect(decisions.map((decision) => decision.choice)).toEqual([
      "episodic",
      "new-durable",
      "reinforces-a-note",
    ]);
  });

  it("skips the distiller entirely when the decider passes nothing", async () => {
    const store = await trustedStore();
    await store.appendDaily("lunch was late", "user");
    const chatModel = distiller();
    const gardener = new Gardener({
      store,
      judgment: chatModel,
      decider: scriptedDecider({ triageEntries: triageBy(() => "episodic") }),
    });

    await gardener.sweep();

    expect(chatModel.seen).toEqual([]);
  });

  it("acts on the decider's pair relation and writes the merged body it carries", async () => {
    const store = await trustedStore(tickingClock());
    await store.writeNote({
      title: "Node test runner",
      body: "tests run on node not bun\n",
      provenance: "agent",
    });
    await store.writeNote({
      title: "Node testing",
      body: "tests run on node\n",
      provenance: "agent",
    });
    const decisions: MemoryDecision[] = [];
    const asked: number[] = [];
    const gardener = new Gardener({
      store,
      judgment: distiller(),
      decider: scriptedDecider({
        relatePair: async (pair) => {
          asked.push(pair.similarity);
          return decided(
            memoryQuestions.pairRelation,
            {
              relation: "duplicate",
              keep: "older",
              confidence: 0.97,
              mergedBody: "tests run on node, never bun\n",
            },
            "duplicate",
          );
        },
      }),
      onDecision: (decision) => decisions.push(decision),
    });

    const report = await gardener.sweep();

    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThanOrEqual(0.3);
    expect(report.merged).toEqual([{ keep: "Node test runner", retired: "Node testing" }]);
    expect((await store.readNote("Node test runner"))?.body).toBe("tests run on node, never bun\n");
    expect((await store.readNote("Node testing"))?.supersededBy).toBe("Node test runner");
    expect(decisions.map((decision) => decision.question)).toContain("pair-relation@1");
  });

  it("holds a decider's propose band to a card and lets its act band apply, whatever the confidence", async () => {
    const outcomes = [];
    for (const [band, confidence] of [
      ["propose", 0.99],
      ["act", 0.6],
    ] as const) {
      const store = await trustedStore(tickingClock());
      await store.writeNote({
        title: "Node runner",
        body: "tests run on node\n",
        provenance: "agent",
      });
      await store.writeNote({
        title: "Node tests",
        body: "tests run on node\n",
        provenance: "agent",
      });
      const gardener = new Gardener({
        store,
        judgment: distiller(),
        decider: scriptedDecider({
          relatePair: async () =>
            decided(
              memoryQuestions.pairRelation,
              { relation: "duplicate", keep: "older", confidence, band },
              "duplicate",
            ),
        }),
      });
      const report = await gardener.sweep();
      const cards = (await store.listStaged()).filter((item) => item.kind === "merge-proposal");
      outcomes.push({ band, merged: report.merged.length, cards: cards.length });
    }
    expect(outcomes).toEqual([
      { band: "propose", merged: 0, cards: 1 },
      { band: "act", merged: 1, cards: 0 },
    ]);
  });

  it("stages a contradiction card and acts on nothing an unsure decider returns", async () => {
    const store = await trustedStore();
    await store.writeNote({
      title: "Ratio rule",
      body: "dock ratio is 50 50\n",
      provenance: "agent",
    });
    await store.writeNote({
      title: "Ratio law",
      body: "dock ratio is 70 30\n",
      provenance: "agent",
    });
    for (const relation of ["unsure", "contradiction"] as const) {
      const gardener = new Gardener({
        store,
        judgment: distiller(),
        decider: scriptedDecider({
          relatePair: async () =>
            decided(memoryQuestions.pairRelation, { relation, confidence: 0.99 }, relation),
        }),
      });
      const report = await gardener.sweep();
      expect(report.merged).toEqual([]);
      expect(report.superseded).toEqual([]);
    }
    const staged = await store.listStaged();
    expect(staged.filter((item) => item.kind === "contradiction")).toHaveLength(1);
  });

  it("drops a link card the decider weighs as no link, and records the verdict", async () => {
    const store = await trustedStore();
    await store.writeNote({
      title: "Bun runtime",
      body: "keywork runs on bun\n",
      provenance: "agent",
    });
    await store.writeNote({
      title: "Setup guide",
      body: "install bun runtime before anything else\n",
      provenance: "agent",
    });
    const decisions: MemoryDecision[] = [];
    const gardener = new Gardener({
      store,
      decider: scriptedDecider({
        weighMention: async () => decided(memoryQuestions.mentionIsLink, "no-link", "no-link"),
      }),
      onDecision: (decision) => decisions.push(decision),
    });

    await gardener.sweep();

    expect((await store.listStaged()).filter((item) => item.kind === "link-proposal")).toEqual([]);
    expect(decisions.map((decision) => decision.choice)).toEqual(["no-link"]);
  });

  it("asks no triage or pair question when no chat model is wired, as the dormant workspace did", async () => {
    const store = await trustedStore();
    await store.appendDaily("tests run on node", "user");
    await store.writeNote({
      title: "Node test runner",
      body: "tests run on node\n",
      provenance: "agent",
    });
    await store.writeNote({
      title: "Node testing",
      body: "tests run on node\n",
      provenance: "agent",
    });
    const questions: string[] = [];
    const gardener = new Gardener({
      store,
      onDecision: (decision) => questions.push(decision.question),
    });

    await gardener.sweep();

    expect(questions.every((question) => question === "mention-is-link@1")).toBe(true);
  });
});

describe("drift through the decider", () => {
  const changes: DiffChanges = {
    against: "abc123",
    files: ["src/auth.ts"],
    patch: [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "@@ -1,1 +1,1 @@",
      "-export function mintToken() {}",
      "+export function issueToken() {}",
      "",
    ].join("\n"),
  };

  it("stamps and stages what the decider assesses, and records each assessment", async () => {
    const store = await trustedStore();
    await store.writeNote({
      title: "Auth Tokens",
      body: "Tokens come from mintToken in src/auth.ts.\n",
      provenance: "agent",
    });
    const decisions: MemoryDecision[] = [];

    const report = await checkDrift({
      store,
      changes,
      now: clock,
      decider: scriptedDecider({
        assessDrift: async () =>
          decided(
            memoryQuestions.driftVerdict,
            { verdict: "stale", reason: "jev 0.94: the diff renames mintToken" },
            "stale",
          ),
      }),
      onDecision: (decision) => decisions.push(decision),
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        note: "Auth Tokens",
        verdict: "stale",
        reason: "jev 0.94: the diff renames mintToken",
      }),
    ]);
    expect(report.proposed).toHaveLength(1);
    expect((await store.readNote("Auth Tokens"))?.drift?.verdict).toBe("stale");
    expect(decisions.map((decision) => decision.question)).toEqual(["drift-verdict@1"]);
  });

  it("is unsure about every note when neither a judgment nor a decider is given", async () => {
    const store = await trustedStore();
    await store.writeNote({
      title: "Auth Tokens",
      body: "Tokens come from mintToken in src/auth.ts.\n",
      provenance: "agent",
    });

    const report = await checkDrift({ store, changes, now: clock });

    expect(report.findings.map((finding) => finding.verdict)).toEqual(["unsure"]);
    expect(report.proposed).toEqual([]);
  });
});
