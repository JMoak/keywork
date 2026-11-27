import type { ModelReference } from "../inference/types.ts";

export type PromiseKind = "chores-ran" | "models-reachable" | "workshop-healthy" | "gates-valid";

export const promiseKinds: readonly PromiseKind[] = [
  "chores-ran",
  "models-reachable",
  "workshop-healthy",
  "gates-valid",
];

export type PromiseState = "kept" | "repairing" | "broken" | "unknown";

export interface PromiseEvidence {
  subject: string;
  checkedAt: string | null;
  found: string;
  ok: boolean | null;
}

export type RepairOutcome = "repairing" | "repaired" | "failed";

export interface RepairEpisode {
  subject: string;
  startedAt: string;
  tries: number;
  bound: number;
  nextAt: string | null;
  endedAt: string | null;
  outcome: RepairOutcome;
}

export interface CreaturePromise {
  kind: PromiseKind;
  state: PromiseState;
  checks: string;
  evidence: PromiseEvidence[];
  repairs: RepairEpisode[];
}

export type ChoiceId = "retry" | "model" | "off";

export type PromiseChoice =
  | { id: "retry"; label: string }
  | { id: "model"; label: string; models: ModelReference[] }
  | { id: "off"; label: string };

export interface QuestionAbout {
  chores: string[];
  conversation: boolean;
  model: ModelReference | null;
}

export interface PromiseQuestion {
  id: string;
  creature: string;
  promise: PromiseKind;
  sentence: string;
  address: string | null;
  lastFailure: string | null;
  since: string;
  choices: PromiseChoice[];
  about: QuestionAbout;
}

export interface CreaturePromises {
  creature: string;
  promises: CreaturePromise[];
  questions: PromiseQuestion[];
}

export interface PromiseAnswer {
  choice: ChoiceId;
  model?: ModelReference | undefined;
}

export interface AnsweredQuestion {
  question: PromiseQuestion;
  done: string;
  promises: CreaturePromises;
}

export type AnswerRefusal =
  | "missing-creature"
  | "missing-question"
  | { refusal: string; status: 400 | 409 };
