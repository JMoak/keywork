import { searchHitLayer, workspaceLayer } from "./arcs/recall.ts";
import {
  agesOf,
  type CurationBand,
  type DriftCase,
  type EntryDurability,
  entryDurabilities,
  type MemoryQuestion,
  type MentionCandidate,
  type MentionVerdict,
  memoryQuestions,
  type NotePair,
  type PairRelation,
  type PendingAction,
  pairRelations,
} from "./decider.ts";
import { boundedDriftEvidence } from "./drift.ts";
import type { DailyEntryCandidate } from "./gardener.ts";
import type { JevAnswer, JevAsk, JevObject, JevQuestion } from "./jev.ts";
import type { DriftVerdict, Note } from "./notes.ts";
import { type NamedSecret, redactForPersistence } from "./redaction.ts";
import type { SearchHit } from "./search.ts";

export const jevQuestions: readonly MemoryQuestion[] = [
  memoryQuestions.actionRelevance,
  memoryQuestions.entryDurability,
  memoryQuestions.pairRelation,
  memoryQuestions.driftVerdict,
  memoryQuestions.mentionIsLink,
];

export const jevCaps = {
  candidates: 5,
  neighbors: 3,
  excerpt: 480,
  sentence: 480,
  body: 2_000,
} as const;

export const jevBands = {
  recall: { dropAtMost: 0.1, rankFirstAtLeast: 0.9 },
  verdict: { decideAtLeast: 0.9 },
  curation: { actAtLeast: 0.95, actConfidenceAtLeast: 0.9, proposeAtLeast: 0.5 },
} as const;

export type Scrub = (text: string, cap?: number) => string;

export function scrubberFor(secrets: readonly NamedSecret[]): Scrub {
  return (text, cap) => {
    const redacted = redactForPersistence(text, secrets);
    return cap === undefined ? redacted : capped(redacted, cap);
  };
}

export interface Reading<Verdict> {
  scores: Record<string, number>;
  confidence: number;
  odds: number;
  verdict?: Verdict;
}

export type RecallReading = "drop" | "rank-first" | "undecided";

export interface RelevancePlan {
  ask: JevAsk;
  keyOf(hit: SearchHit): string | undefined;
  oddsOf(answers: Readonly<Record<string, JevAnswer>>, hit: SearchHit): number | undefined;
}

export function actionRelevancePlan(
  action: PendingAction,
  eligible: readonly SearchHit[],
  scrub: Scrub,
): RelevancePlan {
  const keys = distinctKeys(eligible.slice(0, jevCaps.candidates), scrub);
  const notes = Object.fromEntries(
    [...keys].map(([hit, key]) => [key, noteExcerpt(hit, scrub)] as const),
  );
  const questions = Object.fromEntries(
    [...keys.values()].map((key) => [key, relevanceQuestion(key)] as const),
  );
  const keyOf = (hit: SearchHit): string | undefined => keys.get(hit);
  return {
    ask: {
      state: { action: { tool: action.tool, subject: scrub(action.subject) }, notes },
      questions,
      pace: "hot-path",
    },
    keyOf,
    oddsOf: (answers, hit) => {
      const key = keyOf(hit);
      const answer = key === undefined ? undefined : answers[key];
      return answer?.type === "noul" ? answer.noul : undefined;
    },
  };
}

export function readRecall(odds: number): RecallReading {
  if (odds <= jevBands.recall.dropAtMost) return "drop";
  if (odds >= jevBands.recall.rankFirstAtLeast) return "rank-first";
  return "undecided";
}

export function noulConfidence(odds: number): number {
  return Math.abs(2 * odds - 1);
}

export interface ChoicePlan<Verdict> {
  ask: JevAsk;
  read(answers: Readonly<Record<string, JevAnswer>>): Reading<Verdict>;
}

export function entryDurabilityPlan(
  entry: DailyEntryCandidate,
  neighbors: readonly Note[],
  scrub: Scrub,
): ChoicePlan<EntryDurability> {
  const state: JevObject = {
    entry: {
      text: scrub(entry.text, jevCaps.body),
      date: entry.date,
      provenance: entry.provenance,
    },
    neighbors: Object.fromEntries(
      neighbors
        .slice(0, jevCaps.neighbors)
        .map((note) => [
          scrub(note.name),
          { title: scrub(note.title), excerpt: scrub(firstParagraph(note.body), jevCaps.excerpt) },
        ]),
    ),
  };
  return choicePlan(state, "durability", durabilityQuestion, (answer) =>
    decisiveVerdict(answer, entryDurabilities),
  );
}

export interface PairReading {
  relation: PairRelation;
  band: CurationBand;
}

export function pairRelationPlan(pair: NotePair, scrub: Scrub): ChoicePlan<PairReading> {
  const { older, newer } = agesOf(pair);
  const side = (note: Note): JevObject => ({
    title: scrub(note.title),
    body: scrub(note.body, jevCaps.body),
    provenance: note.provenance,
  });
  const state = { older: side(older), newer: side(newer) };
  return choicePlan(state, "relation", relationQuestion, curationReading);
}

export function driftVerdictPlan(input: DriftCase, scrub: Scrub): ChoicePlan<DriftVerdict> {
  const state: JevObject = {
    note: { title: scrub(input.note.title), body: scrub(input.note.body, jevCaps.body) },
    evidence: boundedDriftEvidence(input.evidence.map((line) => scrub(line))),
  };
  return choicePlan(state, "verdict", verdictQuestion, (answer) =>
    decisiveVerdict(answer, driftVerdicts),
  );
}

export function mentionIsLinkPlan(
  candidate: MentionCandidate,
  scrub: Scrub,
): ChoicePlan<MentionVerdict> {
  const { source, target } = candidate;
  const state: JevObject = {
    source: {
      title: scrub(source.title),
      sentence: scrub(sentenceAround(source.body, candidate.mention), jevCaps.sentence),
    },
    target: {
      title: scrub(target.title),
      excerpt: scrub(firstParagraph(target.body), jevCaps.excerpt),
    },
  };
  return {
    ask: { state, questions: { link: linkQuestion }, pace: "sweep" },
    read: (answers) => {
      const answer = answers.link;
      if (answer?.type !== "noul") return { scores: {}, confidence: 0, odds: 0 };
      const reading = readRecall(answer.noul);
      return {
        scores: { [target.name]: answer.noul },
        confidence: noulConfidence(answer.noul),
        odds: answer.noul,
        ...(reading !== "undecided" && { verdict: reading === "drop" ? "no-link" : "link" }),
      };
    },
  };
}

const driftVerdicts = ["hold", "stale", "unsure"] as const satisfies readonly DriftVerdict[];

const unsure = "unsure";

function relevanceQuestion(key: string): JevQuestion {
  return {
    type: "noul",
    instructions: `Does the note ${JSON.stringify(key)} in notes bear on this action, so that an agent about to take it should read the note first?`,
    criteria: {
      true: "The note states a fact, rule, or warning about the file or command in this action",
      false: "The note is about something else and only shares a word or a topic with the action",
    },
  };
}

const durabilityQuestion: JevQuestion = {
  type: "choice",
  instructions: "What is this daily-log entry, compared with the neighbor notes?",
  criteria: {
    "new-durable": "A lasting fact, decision, or convention that no neighbor note records",
    "changes-a-note": "Lasting information that changes or corrects what a neighbor note says",
    "reinforces-a-note": "Repeats or confirms what a neighbor note already says",
    episodic: "Only about that day: progress, a one-off event, or a passing state",
    unsure: "The entry does not settle which of these it is",
  } satisfies Record<EntryDurability, string>,
};

const relationQuestion: JevQuestion = {
  type: "choice",
  instructions: "How does the newer note relate to the older note?",
  criteria: {
    duplicate: "Both notes record the same claims",
    "newer-supersedes-older": "The newer note replaces what the older note claims",
    "older-still-holds":
      "The notes cover the same point, and the older note's claim is the one that still holds",
    contradiction:
      "The notes make claims that cannot both be true, and neither one is clearly the replacement",
    distinct: "The notes are about different things",
    unsure: "The notes do not settle how they relate",
  } satisfies Record<PairRelation, string>,
};

const verdictQuestion: JevQuestion = {
  type: "choice",
  instructions: "Does the note still hold after the code change shown in evidence?",
  criteria: {
    hold: "Nothing in the change contradicts or retires what the note claims",
    stale: "The change contradicts or retires what the note claims",
    unsure: "The evidence does not settle it",
  } satisfies Record<DriftVerdict, string>,
};

const linkQuestion: JevQuestion = {
  type: "noul",
  instructions:
    "Does the sentence in source use the target note's title to mean the subject the target note is about?",
  criteria: {
    true: "The words name the subject the target note is about",
    false: "The words are used in another sense, or match only by coincidence",
  },
};

type ChoiceAnswer = Extract<JevAnswer, { type: "choice" }>;

function choicePlan<Verdict>(
  state: JevObject,
  key: string,
  question: JevQuestion,
  decide: (answer: ChoiceAnswer) => Verdict | undefined,
): ChoicePlan<Verdict> {
  return {
    ask: { state, questions: { [key]: question }, pace: "sweep" },
    read: (answers) => {
      const answer = answers[key];
      if (answer?.type !== "choice") return { scores: {}, confidence: 0, odds: 0 };
      const verdict = decide(answer);
      return {
        scores: { ...answer.probabilities },
        confidence: answer.confidence,
        odds: topOdds(answer),
        ...(verdict !== undefined && { verdict }),
      };
    },
  };
}

function decisiveVerdict<Option extends string>(
  answer: ChoiceAnswer,
  options: readonly Option[],
): Option | undefined {
  const option = options.find((candidate) => candidate === answer.choice);
  if (option === undefined || option === unsure) return undefined;
  return topOdds(answer) >= jevBands.verdict.decideAtLeast ? option : undefined;
}

function curationReading(answer: ChoiceAnswer): PairReading | undefined {
  const relation = pairRelations.find((candidate) => candidate === answer.choice);
  const odds = topOdds(answer);
  const { actAtLeast, actConfidenceAtLeast, proposeAtLeast } = jevBands.curation;
  if (relation === undefined || relation === unsure || odds < proposeAtLeast) return undefined;
  const acts = odds >= actAtLeast && answer.confidence >= actConfidenceAtLeast;
  return { relation, band: acts ? "act" : "propose" };
}

function topOdds(answer: ChoiceAnswer): number {
  return answer.probabilities[answer.choice] ?? 0;
}

function noteExcerpt(hit: SearchHit, scrub: Scrub): JevObject {
  return {
    title: scrub(hit.note.title),
    layer: layerOf(hit),
    excerpt: scrub(firstParagraph(hit.note.body), jevCaps.excerpt),
  };
}

function distinctKeys(hits: readonly SearchHit[], scrub: Scrub): Map<SearchHit, string> {
  const names = hits.map((hit) => scrub(hit.note.name));
  return new Map(
    hits.map((hit) => {
      const name = scrub(hit.note.name);
      const shared = names.filter((other) => other === name).length > 1;
      return [hit, shared ? `${name} (${layerOf(hit)})` : name] as const;
    }),
  );
}

function layerOf(hit: SearchHit): string {
  return searchHitLayer(hit) ?? workspaceLayer;
}

function firstParagraph(body: string): string {
  return (
    body
      .trim()
      .split(/\n\s*\n/, 1)[0]
      ?.trim() ?? ""
  );
}

function sentenceAround(body: string, mention: string): string {
  const at = body.toLowerCase().indexOf(mention.toLowerCase());
  if (at === -1) return firstParagraph(body);
  for (const sentence of body.matchAll(/[^.!?\n]+[.!?]*/g)) {
    const start = sentence.index ?? 0;
    if (start <= at && at < start + sentence[0].length) return sentence[0].trim();
  }
  return firstParagraph(body);
}

function capped(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length <= limit ? text : characters.slice(0, limit).join("");
}
