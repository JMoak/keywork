import type { DriftAssessment } from "./drift.ts";
import type { DailyEntryCandidate } from "./gardener.ts";
import { entityTypes } from "./graph.ts";
import type { DriftVerdict, Note } from "./notes.ts";
import type { SearchHit } from "./search.ts";

export interface MemoryDecider {
  readonly id: string;
  chooseForAction(input: ActionCandidates): Promise<Decided<SearchHit[]>>;
  triageEntries(input: EntryCandidates): Promise<Decided<EntryTriage>[]>;
  relatePair(input: NotePair): Promise<Decided<PairJudgment>>;
  assessDrift(input: DriftCase): Promise<Decided<DriftAssessment>>;
  weighMention(input: MentionCandidate): Promise<Decided<MentionVerdict>>;
}

export interface Decided<Outcome> {
  readonly outcome: Outcome;
  readonly decision: MemoryDecision;
}

export type DecisionSink = (decision: MemoryDecision) => void;

export function recorded<Outcome>(
  decided: Decided<Outcome>,
  sink: DecisionSink | undefined,
): Outcome {
  sink?.(decided.decision);
  return decided.outcome;
}

export const memoryQuestions = {
  actionRelevance: "action-relevance@1",
  entryDurability: "entry-durability@1",
  entryKind: "entry-kind@1",
  pairRelation: "pair-relation@1",
  driftVerdict: "drift-verdict@1",
  mentionIsLink: "mention-is-link@1",
  searchRelevance: "search-relevance@1",
  skillApplies: "skill-applies@1",
} as const;

export type MemoryQuestion = (typeof memoryQuestions)[keyof typeof memoryQuestions];

export const entryDurabilities = [
  "new-durable",
  "changes-a-note",
  "reinforces-a-note",
  "episodic",
  "unsure",
] as const;

export type EntryDurability = (typeof entryDurabilities)[number];

export const noteKinds = [...entityTypes, "none"] as const;

export type NoteKind = (typeof noteKinds)[number];

export const pairRelations = [
  "duplicate",
  "newer-supersedes-older",
  "older-still-holds",
  "contradiction",
  "distinct",
  "unsure",
] as const;

export type PairRelation = (typeof pairRelations)[number];

export const mentionVerdicts = ["link", "no-link"] as const;

export type MentionVerdict = (typeof mentionVerdicts)[number];

export type DeciderName = "builtin" | "jev";

export interface MemoryDecision {
  id: string;
  question: MemoryQuestion;
  about: DecisionSubject;
  candidates: string[];
  choice: DecisionChoice;
  scores?: Record<string, number>;
  confidence?: number;
  decider: DeciderName;
  model?: string;
  rule?: string;
  fallback?: DecisionFallback;
  latencyMs: number;
  waitedMs?: number;
  inputTokens?: number;
  stateHash?: string;
}

export type DecisionSubject =
  | { kind: "call"; callId: string }
  | { kind: "pair"; older: string; newer: string }
  | { kind: "entry"; entryId: string }
  | { kind: "note"; note: string }
  | { kind: "mention"; note: string; target: string }
  | { kind: "query"; query: string };

export type DecisionChoice =
  | Selection
  | EntryDurability
  | PairRelation
  | DriftVerdict
  | MentionVerdict;

export interface Selection {
  kept: string[];
  dropped: string[];
}

export interface DecisionFallback {
  reason: FallbackReason;
  undecided?: string[];
}

export type FallbackReason =
  | "no-key"
  | "refused"
  | "late"
  | "rate-limited"
  | "overloaded"
  | "malformed"
  | "unreachable"
  | "degraded"
  | "undecided"
  | "unproven-model";

export interface ActionCandidates {
  action: PendingAction;
  hits: readonly SearchHit[];
  surfaced: ReadonlySet<string>;
  budget: ActionBudget;
}

export interface PendingAction {
  callId: string;
  tool: string;
  subject: string;
  subjectKind: "path" | "command";
}

export interface ActionBudget {
  tokens: number;
  notes: number;
}

export interface EntryCandidates {
  entries: readonly DailyEntryCandidate[];
  neighbors?: ReadonlyMap<string, readonly Note[]>;
}

export interface EntryTriage {
  entryId: string;
  durability: EntryDurability;
}

export interface NotePair {
  a: Note;
  b: Note;
  similarity: number;
}

export type PairSide = "older" | "newer";

export type PairJudgment = (
  | { relation: "duplicate"; keep: PairSide; confidence: number; mergedBody?: string }
  | { relation: Exclude<PairRelation, "duplicate">; confidence: number }
) & { band?: CurationBand };

export type CurationBand = "act" | "propose";

export interface DriftCase {
  note: Note;
  evidence: readonly string[];
}

export interface MentionCandidate {
  source: Note;
  target: Note;
  mention: string;
}

export interface DecisionAsk {
  question: MemoryQuestion;
  about: DecisionSubject;
  candidates: string[];
}

export function actionAsk(input: ActionCandidates): DecisionAsk {
  return {
    question: memoryQuestions.actionRelevance,
    about: { kind: "call", callId: input.action.callId },
    candidates: input.hits.map((hit) => hit.note.name),
  };
}

export function entryAsk(entry: DailyEntryCandidate): DecisionAsk {
  return {
    question: memoryQuestions.entryDurability,
    about: { kind: "entry", entryId: entry.id },
    candidates: [entry.id],
  };
}

export function pairAsk(pair: NotePair): DecisionAsk {
  const { older, newer } = agesOf(pair);
  return {
    question: memoryQuestions.pairRelation,
    about: { kind: "pair", older: older.name, newer: newer.name },
    candidates: [older.name, newer.name],
  };
}

export function driftAsk(input: DriftCase): DecisionAsk {
  return {
    question: memoryQuestions.driftVerdict,
    about: { kind: "note", note: input.note.name },
    candidates: [input.note.name],
  };
}

export function mentionAsk(candidate: MentionCandidate): DecisionAsk {
  return {
    question: memoryQuestions.mentionIsLink,
    about: { kind: "mention", note: candidate.source.name, target: candidate.target.name },
    candidates: [candidate.target.name],
  };
}

export function agesOf({ a, b }: Pick<NotePair, "a" | "b">): { older: Note; newer: Note } {
  return (b.created ?? "") > (a.created ?? "") ? { older: a, newer: b } : { older: b, newer: a };
}

export function keptSideOf(judgment: PairJudgment): PairSide | undefined {
  switch (judgment.relation) {
    case "duplicate":
      return judgment.keep;
    case "newer-supersedes-older":
      return "newer";
    case "older-still-holds":
      return "older";
    default:
      return undefined;
  }
}

export function screenForAction(hit: SearchHit, surfaced: ReadonlySet<string>): string | undefined {
  if (hit.superseded) return "is superseded";
  if (surfaced.has(hit.note.name)) return "was already surfaced";
  return undefined;
}

export type BudgetFit = (hit: SearchHit) => string | undefined;

export function actionBudgetFit(budget: ActionBudget): BudgetFit {
  let kept = 0;
  let spent = 0;
  return (hit) => {
    if (kept >= budget.notes) return `is past the ${budget.notes}-note cap`;
    if (spent + hit.note.tokens > budget.tokens)
      return `would pass the ${budget.tokens}-token budget`;
    kept += 1;
    spent += hit.note.tokens;
    return undefined;
  };
}
