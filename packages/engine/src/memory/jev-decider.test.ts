import { describe, expect, it } from "vitest";
import { builtinDecider } from "./builtin-decider.ts";
import {
  type ActionCandidates,
  type Decided,
  type MemoryDecider,
  memoryQuestions,
  type NotePair,
} from "./decider.ts";
import type { DriftJudgmentPort } from "./drift.ts";
import type { CurationJudgmentPort, DailyEntryCandidate } from "./gardener.ts";
import {
  type JevAnswer,
  type JevAsk,
  type JevClient,
  type JevFailureReason,
  type JevReply,
  jevModel,
} from "./jev.ts";
import { jevDecider, withFallback } from "./jev-decider.ts";
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

function hitOf(name: string, ranks: LegRanks = { lexical: 1 }, superseded = false): SearchHit {
  return {
    note: noteOf(name),
    score: 1,
    legs: [],
    ranks,
    superseded,
    relations: { contradicts: [] },
  };
}

function candidates(
  hits: SearchHit[],
  overrides: Partial<ActionCandidates> = {},
): ActionCandidates {
  return {
    action: { callId: "call-1", tool: "edit", subject: "src/dock.ts", subjectKind: "path" },
    hits,
    surfaced: new Set(),
    budget: { tokens: 1024, notes: 3 },
    ...overrides,
  };
}

interface ScriptedClient extends JevClient {
  asked: JevAsk[];
}

function scriptedClient(reply: (ask: JevAsk) => JevReply): ScriptedClient {
  const asked: JevAsk[] = [];
  return {
    model: jevModel,
    asked,
    ask: async (ask) => {
      asked.push(ask);
      return reply(ask);
    },
  };
}

function answering(answers: Record<string, JevAnswer>): JevReply {
  return { ok: true, answers, model: jevModel, inputTokens: 900, stateHash: "state-hash" };
}

function nouls(odds: Record<string, number>): JevReply {
  return answering(
    Object.fromEntries(
      Object.entries(odds).map(([key, noul]) => [key, { type: "noul" as const, noul }]),
    ),
  );
}

function choosing(key: string, option: string, odds: number, confidence = odds): JevReply {
  return answering({
    [key]: { type: "choice", choice: option, probabilities: { [option]: odds }, confidence },
  });
}

function failing(reason: JevFailureReason): JevReply {
  return { ok: false, reason };
}

function onTrial(
  client: JevClient,
  seams: Parameters<typeof builtinDecider>[0] = {},
): MemoryDecider {
  return withFallback(jevDecider({ client, trial: true }), builtinDecider(seams));
}

const older = noteOf("Old Auth", { created: "2026-01-01" });
const newer = noteOf("New Auth", { created: "2026-09-01" });
const pair: NotePair = { a: older, b: newer, similarity: 0.42 };

const chatModel: CurationJudgmentPort = {
  id: "closing:test",
  proposePromotions: async () => [],
  classifyPair: async () => ({ relation: "distinct", confidence: 0.7 }),
};

const driftModel: DriftJudgmentPort = {
  id: "drift:test",
  assess: async () => ({ verdict: "hold", reason: "the diff renames nothing it claims" }),
};

const entry: DailyEntryCandidate = {
  id: "2026-10-15#0",
  date: "2026-10-15",
  time: "09:00",
  provenance: "agent",
  text: "Released 0.4 today.",
};

const mention = {
  source: noteOf("Notes", { body: "We use bun." }),
  target: noteOf("Bun"),
  mention: "bun",
};

function withoutVolatile(decided: Decided<unknown>) {
  const { id: _id, latencyMs: _latency, ...decision } = decided.decision;
  return { outcome: decided.outcome, decision };
}

describe("which questions reach Jev", () => {
  it("asks nothing for an unproven question and records the builtin with no fallback", async () => {
    const client = scriptedClient(() => nouls({}));
    const decider = withFallback(jevDecider({ client }), builtinDecider());
    const builtin = builtinDecider();

    const decisions = [
      await decider.chooseForAction(candidates([hitOf("Dock")])),
      ...(await decider.triageEntries({ entries: [entry] })),
      await decider.relatePair(pair),
      await decider.assessDrift({ note: older, evidence: [] }),
      await decider.weighMention(mention),
    ];
    const expected = [
      await builtin.chooseForAction(candidates([hitOf("Dock")])),
      ...(await builtin.triageEntries({ entries: [entry] })),
      await builtin.relatePair(pair),
      await builtin.assessDrift({ note: older, evidence: [] }),
      await builtin.weighMention(mention),
    ];

    expect(client.asked).toEqual([]);
    expect(decisions.map(withoutVolatile)).toEqual(expected.map(withoutVolatile));
  });

  it("asks a question proven for its own edition without the trial flag", async () => {
    const client = scriptedClient(() => nouls({ Dock: 0.95 }));
    const proofs = [
      { edition: jevModel, question: memoryQuestions.actionRelevance },
      { edition: "jev-1.14.0", question: memoryQuestions.mentionIsLink },
    ];
    const decider = withFallback(jevDecider({ client, proofs }), builtinDecider());

    await decider.chooseForAction(candidates([hitOf("Dock")]));
    await decider.weighMention(mention);

    expect(client.asked.map((ask) => Object.keys(ask.questions))).toEqual([["Dock"]]);
  });

  it("asks every question on trial", async () => {
    const client = scriptedClient(() => failing("late"));
    const decider = onTrial(client);

    await decider.chooseForAction(candidates([hitOf("Dock")]));
    await decider.triageEntries({ entries: [entry] });
    await decider.relatePair(pair);
    await decider.assessDrift({ note: older, evidence: [] });
    await decider.weighMention(mention);

    expect(client.asked.map((ask) => ask.pace)).toEqual([
      "hot-path",
      "sweep",
      "sweep",
      "sweep",
      "sweep",
    ]);
  });

  it("asks nothing when every candidate was screened out by policy", async () => {
    const client = scriptedClient(() => nouls({}));
    const decided = await onTrial(client).chooseForAction(
      candidates([hitOf("Old", { lexical: 1 }, true), hitOf("Seen")], {
        surfaced: new Set(["Seen"]),
      }),
    );
    expect(client.asked).toEqual([]);
    expect(decided.decision).toMatchObject({ decider: "builtin", choice: { kept: [] } });
    expect(decided.decision.fallback).toBeUndefined();
  });
});

describe("every failure falls back to the builtin and names its reason", () => {
  const reasons: JevFailureReason[] = [
    "no-key",
    "refused",
    "late",
    "rate-limited",
    "overloaded",
    "malformed",
    "unreachable",
    "degraded",
  ];

  it.each(reasons)("recall: %s", async (reason) => {
    const input = candidates([hitOf("Dock"), hitOf("Neighbor", { graph: 1 })]);
    const decided = await onTrial(scriptedClient(() => failing(reason))).chooseForAction(input);
    const builtin = await builtinDecider().chooseForAction(input);

    expect(decided.outcome).toEqual(builtin.outcome);
    expect(decided.decision).toMatchObject({
      decider: "builtin",
      choice: builtin.decision.choice,
      rule: builtin.decision.rule,
      fallback: { reason },
    });
  });

  it.each(reasons)("curation: %s escalates to the chat model", async (reason) => {
    const decided = await onTrial(
      scriptedClient(() => failing(reason)),
      {
        curation: chatModel,
      },
    ).relatePair(pair);
    expect(decided.outcome).toEqual({ relation: "distinct", confidence: 0.7 });
    expect(decided.decision).toMatchObject({ decider: "builtin", fallback: { reason } });
  });

  it.each(reasons)("drift, mention and triage: %s", async (reason) => {
    const decider = onTrial(
      scriptedClient(() => failing(reason)),
      { drift: driftModel },
    );
    const drift = await decider.assessDrift({ note: older, evidence: [] });
    const link = await decider.weighMention(mention);
    const [triage] = await decider.triageEntries({ entries: [entry] });

    expect(drift.outcome.verdict).toBe("hold");
    expect(link.outcome).toBe("link");
    expect(triage?.outcome).toEqual({ entryId: entry.id, durability: "unsure" });
    for (const decision of [drift.decision, link.decision, triage?.decision]) {
      expect(decision).toMatchObject({ decider: "builtin", fallback: { reason } });
    }
  });

  it("keeps what an answer from the wrong model cost, and decides nothing on it", async () => {
    const client = scriptedClient(() => ({
      ok: false,
      reason: "unproven-model",
      model: "jev-1.14.0",
      inputTokens: 640,
      stateHash: "state-hash",
    }));
    const decided = await onTrial(client).chooseForAction(candidates([hitOf("Dock")]));
    expect(decided.decision).toMatchObject({
      decider: "builtin",
      fallback: { reason: "unproven-model" },
      model: "jev-1.14.0",
      inputTokens: 640,
      stateHash: "state-hash",
    });
    expect(decided.decision.scores).toBeUndefined();
  });

  it("never lets a failure throw into the memory path", async () => {
    const decider = onTrial(scriptedClient(() => failing("unreachable")));
    await expect(decider.chooseForAction(candidates([hitOf("Dock")]))).resolves.toBeDefined();
  });
});

describe("recall by odds", () => {
  it("drops at 0.10, ranks first at 0.90, and leaves the middle to the rule", async () => {
    const client = scriptedClient(() => nouls({ Alpha: 0.04, Bravo: 0.5, Charlie: 0.95 }));
    const input = candidates(
      [
        hitOf("Alpha"),
        hitOf("Bravo"),
        hitOf("Charlie", { graph: 1 }),
        hitOf("Delta", { lexical: 1 }, true),
        hitOf("Echo"),
      ],
      { surfaced: new Set(["Echo"]) },
    );

    const decided = await onTrial(client).chooseForAction(input);

    expect(Object.keys(client.asked[0]?.questions ?? {})).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(decided.outcome.map((hit) => hit.note.name)).toEqual(["Charlie", "Bravo"]);
    expect(decided.decision).toMatchObject({
      question: "action-relevance@1",
      candidates: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"],
      choice: { kept: ["Charlie", "Bravo"], dropped: ["Alpha", "Delta", "Echo"] },
      scores: { Alpha: 0.04, Bravo: 0.5, Charlie: 0.95 },
      confidence: 0,
      decider: "jev",
      model: jevModel,
      inputTokens: 900,
      stateHash: "state-hash",
      rule: "[[Bravo]] matches the path by its words; [[Delta]] is superseded; [[Echo]] was already surfaced",
      fallback: { reason: "undecided", undecided: ["Bravo"] },
    });
  });

  it("calls a decision builtin when Jev decided no candidate", async () => {
    const input = candidates([hitOf("Alpha"), hitOf("Bravo", { graph: 1 })]);
    const decided = await onTrial(
      scriptedClient(() => nouls({ Alpha: 0.5, Bravo: 0.6 })),
    ).chooseForAction(input);
    const builtin = await builtinDecider().chooseForAction(input);

    expect(decided.outcome).toEqual(builtin.outcome);
    expect(decided.decision).toMatchObject({
      decider: "builtin",
      choice: builtin.decision.choice,
      fallback: { reason: "undecided", undecided: ["Alpha", "Bravo"] },
      scores: { Alpha: 0.5, Bravo: 0.6 },
    });
  });

  it("still holds the note cap and the token budget over what Jev ranked first", async () => {
    const input = candidates([hitOf("Alpha"), hitOf("Bravo")], {
      budget: { tokens: 1024, notes: 1 },
    });
    const decided = await onTrial(
      scriptedClient(() => nouls({ Alpha: 0.92, Bravo: 0.99 })),
    ).chooseForAction(input);

    expect(decided.decision).toMatchObject({
      choice: { kept: ["Alpha"], dropped: ["Bravo"] },
      confidence: expect.closeTo(0.84, 10),
      decider: "jev",
      rule: "[[Bravo]] is past the 1-note cap",
    });
    expect(decided.decision.fallback).toBeUndefined();
  });
});

describe("curation by bands", () => {
  it("lets a decisive answer act alone at 0.95 with confidence 0.90", async () => {
    const decided = await onTrial(
      scriptedClient(() => choosing("relation", "newer-supersedes-older", 0.97, 0.93)),
    ).relatePair(pair);

    expect(decided.outcome).toEqual({
      relation: "newer-supersedes-older",
      confidence: 0.97,
      band: "act",
    });
    expect(decided.decision).toMatchObject({
      question: "pair-relation@1",
      about: { kind: "pair", older: "Old Auth", newer: "New Auth" },
      choice: "newer-supersedes-older",
      scores: { "newer-supersedes-older": 0.97 },
      confidence: 0.93,
      decider: "jev",
    });
  });

  it("stages a proposal with the odds between 0.50 and the act band", async () => {
    const decided = await onTrial(
      scriptedClient(() => choosing("relation", "duplicate", 0.8)),
    ).relatePair(pair);
    expect(decided.outcome).toEqual({
      relation: "duplicate",
      keep: "newer",
      confidence: 0.8,
      band: "propose",
    });
  });

  it("escalates below 0.50 to the builtin's chat model and names the pair undecided", async () => {
    const decided = await onTrial(
      scriptedClient(() => choosing("relation", "duplicate", 0.4)),
      { curation: chatModel },
    ).relatePair(pair);
    expect(decided.outcome).toEqual({ relation: "distinct", confidence: 0.7 });
    expect(decided.decision).toMatchObject({
      decider: "builtin",
      fallback: { reason: "undecided", undecided: ["Old Auth", "New Auth"] },
      scores: { duplicate: 0.4 },
    });
  });
});

describe("drift, mentions and triage", () => {
  it("stamps a decisive drift verdict with the odds in words", async () => {
    const decided = await onTrial(
      scriptedClient(() => choosing("verdict", "stale", 0.93)),
      { drift: driftModel },
    ).assessDrift({ note: older, evidence: ["src/auth.ts: @@ -1 +1 @@"] });
    expect(decided.outcome).toEqual({ verdict: "stale", reason: "jev: stale at 0.93" });
    expect(decided.decision).toMatchObject({ choice: "stale", decider: "jev" });
  });

  it("asks the chat model about a drift Jev could not settle", async () => {
    const decided = await onTrial(
      scriptedClient(() => choosing("verdict", "stale", 0.85)),
      { drift: driftModel },
    ).assessDrift({ note: older, evidence: [] });
    expect(decided.outcome.verdict).toBe("hold");
    expect(decided.decision.fallback).toEqual({ reason: "undecided", undecided: ["Old Auth"] });
  });

  it("suppresses a link card at 0.10 and keeps it, undecided, in the middle", async () => {
    const odds = [0.05, 0.5, 0.95];
    const client = scriptedClient(() => nouls({ link: odds.shift() ?? 0 }));
    const decider = onTrial(client);
    const verdicts = [
      await decider.weighMention(mention),
      await decider.weighMention(mention),
      await decider.weighMention(mention),
    ];
    expect(verdicts.map((decided) => [decided.outcome, decided.decision.decider])).toEqual([
      ["no-link", "jev"],
      ["link", "builtin"],
      ["link", "jev"],
    ]);
  });

  it("triages each entry on its own question with its neighbors", async () => {
    const second = { ...entry, id: "2026-10-15#1", text: "Decided: releases cut Thursdays." };
    const replies = [
      choosing("durability", "episodic", 0.95),
      choosing("durability", "unsure", 0.97),
    ];
    const client = scriptedClient(() => replies.shift() ?? failing("late"));
    const neighbor = noteOf("Release Cadence", { body: "Releases cut on Tuesdays." });

    const triaged = await onTrial(client).triageEntries({
      entries: [entry, second],
      neighbors: new Map([[second.id, [neighbor]]]),
    });

    expect(triaged.map((decided) => decided.outcome)).toEqual([
      { entryId: entry.id, durability: "episodic" },
      { entryId: second.id, durability: "unsure" },
    ]);
    expect(triaged.map((decided) => decided.decision.decider)).toEqual(["jev", "builtin"]);
    expect(client.asked[1]?.state.neighbors).toEqual({
      "Release Cadence": { title: "Release Cadence", excerpt: "Releases cut on Tuesdays." },
    });
  });
});
