import {
  type MemoryDecision,
  type MemoryQuestion,
  memoryQuestions,
} from "../../packages/engine/src/index.ts";
import {
  type ActionPoint,
  type AnswerLabel,
  type AnswerLine,
  type CandidateLabel,
  type CandidateNote,
  type Corpus,
  type DecisionPoint,
  type EntryPoint,
  type Half,
  type Label,
  type LabelSource,
  type OutcomeRecord,
  type PairPoint,
  pointHash,
} from "./corpus.ts";

export function candidate(name: string, overrides: Partial<CandidateNote> = {}): CandidateNote {
  return {
    name,
    title: name,
    layer: "workspace",
    excerpt: `${name} says something worth knowing.`,
    tokens: 100,
    superseded: false,
    ranks: { lexical: 1 },
    ...overrides,
  };
}

export function actionPoint(
  id: string,
  names: readonly string[],
  overrides: Partial<ActionPoint> = {},
): ActionPoint {
  return {
    id,
    question: memoryQuestions.actionRelevance,
    half: "held-out",
    session: "session",
    action: { callId: id, tool: "edit", subject: `src/${id}.ts`, subjectKind: "path" },
    candidates: names.map((name) => candidate(name)),
    surfaced: [],
    budget: { tokens: 1024, notes: 3 },
    rides: 2,
    ...overrides,
  };
}

export function entryPoint(id: string, half: Half = "held-out"): EntryPoint {
  return {
    id,
    question: memoryQuestions.entryDurability,
    half,
    entry: { id, date: "2026-10-08", time: "09:00", provenance: "agent", text: `entry ${id}` },
  };
}

export function pairPoint(id: string, half: Half = "held-out"): PairPoint {
  return {
    id,
    question: memoryQuestions.pairRelation,
    half,
    a: { name: `${id} older`, title: `${id} older`, provenance: "agent", body: "older body" },
    b: { name: `${id} newer`, title: `${id} newer`, provenance: "agent", body: "newer body" },
    similarity: 0.5,
  };
}

export function decision(
  question: MemoryQuestion,
  overrides: Partial<MemoryDecision> = {},
): MemoryDecision {
  return {
    id: `decision-${question}`,
    question,
    about: { kind: "query", query: "test" },
    candidates: [],
    choice: "unsure",
    decider: "jev",
    latencyMs: 10,
    ...overrides,
  };
}

export function keeps(
  point: ActionPoint,
  kept: readonly string[],
  overrides: Partial<MemoryDecision> = {},
): AnswerLine {
  return line(point, { kept: [...kept] }, overrides);
}

export function answers(
  point: DecisionPoint,
  answer: string,
  overrides: Partial<MemoryDecision> = {},
): AnswerLine {
  const outcome =
    point.question === memoryQuestions.entryDurability
      ? { durability: answer }
      : { relation: answer, confidence: overrides.confidence ?? 0 };
  return line(point, outcome as OutcomeRecord, overrides);
}

export function relevant(
  point: string,
  note: string,
  isRelevant = true,
  source: LabelSource = "hindsight",
): CandidateLabel {
  return { point, note, relevant: isRelevant, source, evidence: "test" };
}

export function verdict(
  point: string,
  answer: string,
  holds = true,
  source: LabelSource = "hand",
): AnswerLabel {
  return { point, answer, holds, source, evidence: "test" };
}

export function corpusOf(points: readonly DecisionPoint[], labels: readonly Label[] = []): Corpus {
  return { dir: "test", points: [...points], labels: [...labels], manifest: undefined };
}

function line(
  point: DecisionPoint,
  outcome: OutcomeRecord,
  overrides: Partial<MemoryDecision>,
): AnswerLine {
  return {
    point: point.id,
    pointHash: pointHash(point),
    question: point.question,
    outcome,
    decision: decision(point.question, overrides),
  };
}
