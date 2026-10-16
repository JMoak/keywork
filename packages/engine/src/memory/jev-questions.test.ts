import { describe, expect, it } from "vitest";
import type { LayeredSearchHit } from "./arcs/recall.ts";
import { memoryQuestions, type PendingAction } from "./decider.ts";
import { boundedDriftEvidence } from "./drift.ts";
import type { DailyEntryCandidate } from "./gardener.ts";
import type { JevAnswer } from "./jev.ts";
import {
  actionRelevancePlan,
  driftVerdictPlan,
  entryDurabilityPlan,
  jevCaps,
  jevQuestions,
  mentionIsLinkPlan,
  pairRelationPlan,
  readRecall,
  scrubberFor,
} from "./jev-questions.ts";
import type { Note } from "./notes.ts";
import type { SearchHit } from "./search.ts";

const scrub = scrubberFor([]);

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

function hitOf(note: Note): SearchHit {
  return {
    note,
    score: 1,
    legs: ["lexical"],
    ranks: { lexical: 1 },
    superseded: false,
    relations: { contradicts: [] },
  };
}

const editAuth: PendingAction = {
  callId: "call-1",
  tool: "edit",
  subject: "src/auth/token.ts",
  subjectKind: "path",
};

function choice(option: string, odds: number, confidence = odds): Record<string, JevAnswer> {
  return {
    answer: { type: "choice", choice: option, probabilities: { [option]: odds }, confidence },
  };
}

function keyedAs(key: string, answers: Record<string, JevAnswer>): Record<string, JevAnswer> {
  return Object.fromEntries(Object.values(answers).map((answer) => [key, answer]));
}

describe("action-relevance@1", () => {
  it("sends the action and an excerpt per candidate, and asks one noul per note", () => {
    const tokens = noteOf("Auth Tokens", {
      body: "Tokens rotate hourly; never cache them.\n\nA second paragraph stays home.\n",
    });
    const plan = actionRelevancePlan(editAuth, [hitOf(tokens)], scrub);

    expect(JSON.stringify(plan.ask)).toBe(
      JSON.stringify({
        state: {
          action: { tool: "edit", subject: "src/auth/token.ts" },
          notes: {
            "Auth Tokens": {
              title: "Auth Tokens",
              layer: "workspace",
              excerpt: "Tokens rotate hourly; never cache them.",
            },
          },
        },
        questions: {
          "Auth Tokens": {
            type: "noul",
            instructions:
              'Does the note "Auth Tokens" in notes bear on this action, so that an agent about to take it should read the note first?',
            criteria: {
              true: "The note states a fact, rule, or warning about the file or command in this action",
              false:
                "The note is about something else and only shares a word or a topic with the action",
            },
          },
        },
        pace: "hot-path",
      }),
    );
  });

  it("caps each excerpt at 480 characters of the first paragraph", () => {
    const long = noteOf("Long", { body: `${"a".repeat(600)}\n\nsecond` });
    const plan = actionRelevancePlan(editAuth, [hitOf(long)], scrub);
    const notes = plan.ask.state.notes as Record<string, { excerpt: string }>;
    expect(notes.Long?.excerpt).toBe("a".repeat(jevCaps.excerpt));
  });

  it("asks about five candidates at most", () => {
    const hits = ["A", "B", "C", "D", "E", "F", "G"].map((name) => hitOf(noteOf(name)));
    const plan = actionRelevancePlan(editAuth, hits, scrub);
    expect(Object.keys(plan.ask.questions)).toEqual(["A", "B", "C", "D", "E"]);
    expect(plan.keyOf(hits[5] as SearchHit)).toBeUndefined();
  });

  it("tells two notes with one name apart by their layer", () => {
    const workspace: LayeredSearchHit = { ...hitOf(noteOf("Deploy")), layer: "workspace" };
    const arc: LayeredSearchHit = { ...hitOf(noteOf("Deploy")), layer: "arc", arc: "release" };
    const plan = actionRelevancePlan(editAuth, [workspace, arc], scrub);
    expect(Object.keys(plan.ask.questions)).toEqual(["Deploy (workspace)", "Deploy (arc:release)"]);
    expect(plan.oddsOf({ "Deploy (arc:release)": { type: "noul", noul: 0.2 } }, arc)).toBe(0.2);
  });

  it("never lets a secret on a command line reach the request body", () => {
    const secrets = [{ name: "DEPLOY_TOKEN", value: "plain-deploy-value-42" }];
    const command: PendingAction = {
      callId: "call-2",
      tool: "bash",
      subject:
        "curl -H 'Authorization: Bearer abcdefghijklmnop' -d sk-proj-0123456789abcdef https://x?t=plain-deploy-value-42",
      subjectKind: "command",
    };
    const plan = actionRelevancePlan(command, [hitOf(noteOf("Deploy"))], scrubberFor(secrets));
    const body = JSON.stringify(plan.ask);

    expect(body).not.toContain("abcdefghijklmnop");
    expect(body).not.toContain("sk-proj-0123456789abcdef");
    expect(body).not.toContain("plain-deploy-value-42");
    expect(plan.ask.state.action).toEqual({
      tool: "bash",
      subject:
        "curl -H 'Authorization: ‹redacted:bearer›' -d ‹redacted:key› https://x?t=‹redacted:DEPLOY_TOKEN›",
    });
  });

  it("redacts before it caps, so a cut can never leave half a secret behind", () => {
    const leaking = noteOf("Leak", { body: `${"x ".repeat(236)}sk-abcdefghijklmnop` });
    const plan = actionRelevancePlan(editAuth, [hitOf(leaking)], scrub);
    const notes = plan.ask.state.notes as Record<string, { excerpt: string }>;
    expect(notes.Leak?.excerpt).toBe(`${"x ".repeat(236)}‹redacte`);
  });
});

describe("the recall band", () => {
  it.each([
    [0, "drop"],
    [0.1, "drop"],
    [0.11, "undecided"],
    [0.5, "undecided"],
    [0.89, "undecided"],
    [0.9, "rank-first"],
    [1, "rank-first"],
  ] as const)("reads %f as %s", (odds, reading) => {
    expect(readRecall(odds)).toBe(reading);
  });
});

describe("entry-durability@1", () => {
  const entry: DailyEntryCandidate = {
    id: "2026-10-15#0",
    date: "2026-10-15",
    time: "09:12",
    provenance: "agent",
    text: "We moved the release branch cut to Thursdays.",
  };

  it("sends the entry and at most three neighbor excerpts", () => {
    const neighbors = ["A", "B", "C", "D"].map((name) =>
      noteOf(name, { body: `${name} says something.\n\nMore.` }),
    );
    const plan = entryDurabilityPlan(entry, neighbors, scrub);
    expect(plan.ask.state).toEqual({
      entry: { text: entry.text, date: "2026-10-15", provenance: "agent" },
      neighbors: {
        A: { title: "A", excerpt: "A says something." },
        B: { title: "B", excerpt: "B says something." },
        C: { title: "C", excerpt: "C says something." },
      },
    });
    expect(plan.ask.pace).toBe("sweep");
    expect(Object.keys(plan.ask.questions)).toEqual(["durability"]);
  });

  it("decides at a top answer of 0.90 and never on unsure", () => {
    const plan = entryDurabilityPlan(entry, [], scrub);
    const read = (option: string, odds: number) =>
      plan.read(keyedAs("durability", choice(option, odds))).verdict;
    expect(read("episodic", 0.9)).toBe("episodic");
    expect(read("episodic", 0.89)).toBeUndefined();
    expect(read("unsure", 0.99)).toBeUndefined();
  });
});

describe("pair-relation@1", () => {
  const older = noteOf("Old Auth", { created: "2026-01-01", body: "o".repeat(2_500) });
  const newer = noteOf("New Auth", { created: "2026-09-01", provenance: "user" });

  it("sends both notes as bounded bodies, older first by their created stamps", () => {
    const plan = pairRelationPlan({ a: newer, b: older, similarity: 0.5 }, scrub);
    expect(plan.ask.state).toEqual({
      older: { title: "Old Auth", body: "o".repeat(jevCaps.body), provenance: "agent" },
      newer: { title: "New Auth", body: "New Auth body\n", provenance: "user" },
    });
  });

  it.each([
    ["newer-supersedes-older", 0.95, 0.9, { relation: "newer-supersedes-older", band: "act" }],
    ["duplicate", 0.99, 0.89, { relation: "duplicate", band: "propose" }],
    ["duplicate", 0.94, 0.99, { relation: "duplicate", band: "propose" }],
    ["contradiction", 0.5, 0.5, { relation: "contradiction", band: "propose" }],
    ["distinct", 0.49, 0.9, undefined],
    ["unsure", 0.99, 0.99, undefined],
  ] as const)("reads %s at %f with confidence %f as %o", (option, odds, confidence, verdict) => {
    const plan = pairRelationPlan({ a: older, b: newer, similarity: 0.5 }, scrub);
    expect(plan.read(keyedAs("relation", choice(option, odds, confidence))).verdict).toEqual(
      verdict,
    );
  });
});

describe("drift-verdict@1", () => {
  it("bounds the evidence exactly as the builtin's judgment does and caps the body", () => {
    const evidence = Array.from({ length: 14 }, (_, index) => `+${"x".repeat(600)} ${index}`);
    const note = noteOf("Mint Token", { body: "b".repeat(3_000) });
    const plan = driftVerdictPlan({ note, evidence }, scrub);
    expect(plan.ask.state).toEqual({
      note: { title: "Mint Token", body: "b".repeat(jevCaps.body) },
      evidence: boundedDriftEvidence(evidence),
    });
    expect((plan.ask.state.evidence as string).length).toBe(6_000);
  });

  it("decides hold or stale at 0.90 and leaves unsure to the builtin", () => {
    const plan = driftVerdictPlan({ note: noteOf("N"), evidence: [] }, scrub);
    const read = (option: string, odds: number) =>
      plan.read(keyedAs("verdict", choice(option, odds))).verdict;
    expect(read("stale", 0.93)).toBe("stale");
    expect(read("hold", 0.9)).toBe("hold");
    expect(read("stale", 0.85)).toBeUndefined();
    expect(read("unsure", 0.97)).toBeUndefined();
  });
});

describe("mention-is-link@1", () => {
  const source = noteOf("Release Notes", {
    body: "We ship weekly. The bun upgrade broke the build twice! Nobody minded.",
  });
  const target = noteOf("Bun", { body: "Bun is the runtime.\n\nDetails." });

  it("sends the sentence around the mention and the target's excerpt", () => {
    const plan = mentionIsLinkPlan({ source, target, mention: "bun" }, scrub);
    expect(plan.ask.state).toEqual({
      source: { title: "Release Notes", sentence: "The bun upgrade broke the build twice!" },
      target: { title: "Bun", excerpt: "Bun is the runtime." },
    });
  });

  it.each([
    [0.1, "no-link"],
    [0.5, undefined],
    [0.9, "link"],
  ] as const)("reads %f as %s", (odds, verdict) => {
    const plan = mentionIsLinkPlan({ source, target, mention: "bun" }, scrub);
    const reading = plan.read({ link: { type: "noul", noul: odds } });
    expect(reading.verdict).toBe(verdict);
    expect(reading.scores).toEqual({ Bun: odds });
  });
});

describe("the catalog", () => {
  it("maps every port question and none of the reserved ones", () => {
    expect(jevQuestions).toEqual([
      memoryQuestions.actionRelevance,
      memoryQuestions.entryDurability,
      memoryQuestions.pairRelation,
      memoryQuestions.driftVerdict,
      memoryQuestions.mentionIsLink,
    ]);
  });
});
