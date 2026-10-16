import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ActionBudget,
  type DailyEntryCandidate,
  type DriftVerdict,
  type EntryDurability,
  isMissingFileError,
  type LegRanks,
  type MemoryDecision,
  type MemoryQuestion,
  type MentionVerdict,
  memoryQuestions,
  type PairRelation,
  type PairSide,
  type PendingAction,
  type Provenance,
} from "../../packages/engine/src/index.ts";

export const fixtureCorpusDir = "packages/engine/src/memory/fixtures/decisions";

export const corpusFiles = {
  points: "corpus.jsonl",
  labels: "labels.jsonl",
  manifest: "harvest.json",
  vault: "vault",
  sessions: "sessions",
} as const;

export type DecisionPoint = ActionPoint | EntryPoint | PairPoint | DriftPoint | MentionPoint;

export type Half = "fit" | "held-out";

export interface ActionPoint {
  id: string;
  question: typeof memoryQuestions.actionRelevance;
  half: Half;
  session: string;
  action: PendingAction;
  candidates: CandidateNote[];
  surfaced: string[];
  budget: ActionBudget;
  rides: number;
  recorded?: RecordedSelection;
}

export interface CandidateNote {
  name: string;
  title: string;
  layer: string;
  excerpt: string;
  tokens: number;
  superseded: boolean;
  ranks: LegRanks;
}

export interface RecordedSelection {
  decider: string;
  candidates: string[];
  kept: string[];
}

export interface EntryPoint {
  id: string;
  question: typeof memoryQuestions.entryDurability;
  half: Half;
  entry: DailyEntryCandidate;
}

export interface PairPoint {
  id: string;
  question: typeof memoryQuestions.pairRelation;
  half: Half;
  a: NoteState;
  b: NoteState;
  similarity: number;
}

export interface NoteState {
  name: string;
  title: string;
  provenance: Provenance;
  created?: string;
  body: string;
}

export interface DriftPoint {
  id: string;
  question: typeof memoryQuestions.driftVerdict;
  half: Half;
  note: NoteState;
  evidence: string[];
}

export interface MentionPoint {
  id: string;
  question: typeof memoryQuestions.mentionIsLink;
  half: Half;
  source: { name: string; title: string; sentence: string };
  target: { name: string; title: string; excerpt: string };
  mention: string;
}

export type Label = CandidateLabel | AnswerLabel;

export type LabelSource = "hindsight" | "judge" | "inbox" | "hand";

export interface CandidateLabel {
  point: string;
  note: string;
  relevant: boolean;
  source: LabelSource;
  evidence: string;
}

export interface AnswerLabel {
  point: string;
  answer: string;
  holds: boolean;
  source: LabelSource;
  evidence: string;
}

export interface AnswerLine {
  point: string;
  pointHash: string;
  question: MemoryQuestion;
  outcome: OutcomeRecord;
  decision: MemoryDecision;
}

export type OutcomeRecord =
  | { kept: string[] }
  | { durability: EntryDurability }
  | { relation: PairRelation; keep?: PairSide; confidence: number }
  | { verdict: DriftVerdict; reason: string }
  | { verdict: MentionVerdict };

export interface HarvestManifest {
  sessions: number;
  points: Record<string, number>;
  labels: Record<string, number>;
  judge: JudgeStatus;
  reproduction: SessionReproduction[];
}

export type JudgeStatus =
  | { ran: true; judge: string; labels: number }
  | { ran: false; reason: string };

export interface SessionReproduction {
  session: string;
  reproduced: boolean;
  detail: string;
}

export interface Corpus {
  dir: string;
  points: DecisionPoint[];
  labels: Label[];
  manifest: HarvestManifest | undefined;
}

export async function readCorpus(dir: string): Promise<Corpus> {
  const points = await readJsonLines(join(dir, corpusFiles.points), isDecisionPoint);
  const labels = await readJsonLines(join(dir, corpusFiles.labels), isLabel);
  const manifest = await readJsonFile(join(dir, corpusFiles.manifest));
  return { dir, points, labels, manifest: manifest as HarvestManifest | undefined };
}

export function halfOf(pointId: string): Half {
  return Number.parseInt(sha256(pointId).slice(0, 8), 16) % 2 === 0 ? "fit" : "held-out";
}

export function pointHash(point: DecisionPoint): string {
  return sha256(canonicalJson(decidedState(point)));
}

export function corpusDigest(points: readonly DecisionPoint[]): string {
  return sha256(points.map(pointHash).join("\n")).slice(0, 12);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedKeys(value));
}

export async function writeJsonLines(file: string, values: readonly unknown[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, values.map((value) => `${canonicalJson(value)}\n`).join(""), "utf8");
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(sortedKeys(value), null, 2)}\n`, "utf8");
}

export async function readJsonLines<T>(
  file: string,
  accepts: (value: unknown) => value is T,
): Promise<T[]> {
  const raw = await readOptional(file);
  if (raw === undefined) return [];
  return raw
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line !== "")
    .map(({ line, number }) => {
      const value: unknown = JSON.parse(line);
      if (!accepts(value)) throw new Error(`${file}:${number} is not a line this eval reads`);
      return value;
    });
}

export async function readJsonFile(file: string): Promise<unknown> {
  const raw = await readOptional(file);
  return raw === undefined ? undefined : JSON.parse(raw);
}

export function isDecisionPoint(value: unknown): value is DecisionPoint {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.half === "fit" || value.half === "held-out") &&
    corpusQuestions.has(value.question as MemoryQuestion)
  );
}

export function isLabel(value: unknown): value is Label {
  if (!isRecord(value) || typeof value.point !== "string" || typeof value.evidence !== "string")
    return false;
  if (!labelSources.has(value.source as LabelSource)) return false;
  const candidate = typeof value.note === "string" && typeof value.relevant === "boolean";
  const answer = typeof value.answer === "string" && typeof value.holds === "boolean";
  return candidate !== answer;
}

export function isAnswerLine(value: unknown): value is AnswerLine {
  return (
    isRecord(value) &&
    typeof value.point === "string" &&
    typeof value.pointHash === "string" &&
    isRecord(value.outcome) &&
    isRecord(value.decision)
  );
}

export function decidableCandidates(point: ActionPoint): CandidateNote[] {
  const surfaced = new Set(point.surfaced);
  return point.candidates.filter(
    (candidate) => !candidate.superseded && !surfaced.has(candidate.name),
  );
}

export function isCandidateLabel(label: Label): label is CandidateLabel {
  return "note" in label;
}

export const corpusQuestions: ReadonlySet<MemoryQuestion> = new Set([
  memoryQuestions.actionRelevance,
  memoryQuestions.entryDurability,
  memoryQuestions.pairRelation,
  memoryQuestions.driftVerdict,
  memoryQuestions.mentionIsLink,
]);

const labelSources: ReadonlySet<LabelSource> = new Set(["hindsight", "judge", "inbox", "hand"]);

function decidedState(point: DecisionPoint): unknown {
  switch (point.question) {
    case memoryQuestions.actionRelevance:
      return {
        action: point.action,
        candidates: point.candidates,
        surfaced: point.surfaced,
        budget: point.budget,
      };
    case memoryQuestions.entryDurability:
      return { entry: point.entry };
    case memoryQuestions.pairRelation:
      return { a: point.a, b: point.b, similarity: point.similarity };
    case memoryQuestions.driftVerdict:
      return { note: point.note, evidence: point.evidence };
    case memoryQuestions.mentionIsLink:
      return { source: point.source, target: point.target, mention: point.mention };
  }
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, sortedKeys(value[key])]),
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}
