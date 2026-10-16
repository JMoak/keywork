import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  type ActionBudget,
  actionRecallDefaults,
  extractWikilinks,
  type MemoryDecision,
  MemorySearch,
  MemoryStore,
  memoryQuestions,
  type NamedSecret,
  type PendingAction,
  pendingAction,
  type SearchHit,
  searchHitLayer,
  type ToolCallPart,
  titleKey,
  wikilinkTarget,
  workspaceLayer,
} from "../../packages/engine/src/index.ts";
import {
  type ActionPoint,
  type AnswerLabel,
  type CandidateLabel,
  type CandidateNote,
  corpusFiles,
  type DecisionPoint,
  decidableCandidates,
  type HarvestManifest,
  halfOf,
  isLabel,
  type JudgeStatus,
  type Label,
  type PairPoint,
  type RecordedSelection,
  readJsonLines,
  type SessionReproduction,
  writeJsonFile,
  writeJsonLines,
} from "./corpus.ts";
import { harvestCuration } from "./curation.ts";
import { type Redact, recallExcerpt, redactorFor } from "./exposure.ts";
import type { Judge } from "./judge.ts";
import { keptOf } from "./metrics.ts";
import { builtinArm } from "./replay.ts";
import {
  type AssistantTurn,
  placedCalls,
  type RecordedSession,
  readSessions,
  ridesAfter,
  turnsAfter,
} from "./sessions.ts";

export interface HarvestOptions {
  sessions: string;
  vault: string;
  budget?: ActionBudget;
  secrets?: readonly NamedSecret[];
  judge?: Judge;
  judgeAbsence?: string;
}

export interface Harvest {
  points: DecisionPoint[];
  labels: Label[];
  manifest: HarvestManifest;
}

export const hindsightTurns = 3;

export const defaultActionBudget: ActionBudget = {
  tokens: actionRecallDefaults.tokens,
  notes: actionRecallDefaults.notes,
};

export async function harvestCorpus(options: HarvestOptions): Promise<Harvest> {
  const redact = redactorFor(options.secrets ?? []);
  const seams: SessionSeams = {
    search: new MemorySearch(new MemoryStore({ vaultRoot: options.vault, trusted: true })),
    budget: options.budget ?? defaultActionBudget,
    redact,
    judge: options.judge,
  };
  const sessions = await readSessions(options.sessions);
  const harvested: SessionHarvest[] = [];
  for (const session of sessions) harvested.push(await harvestSession(session, seams));
  const curation = await harvestCuration(options.vault, redact);
  const pairJudgments =
    options.judge === undefined
      ? []
      : await judgePairs(options.judge, curation.points, curation.labels);
  const points = [...harvested.flatMap((session) => session.points), ...curation.points];
  const labels = [
    ...harvested.flatMap((session) => session.labels),
    ...curation.labels,
    ...pairJudgments,
  ];
  return {
    points,
    labels,
    manifest: {
      sessions: sessions.length,
      points: countBy(points, (point) => point.question),
      labels: countBy(labels, (label) => label.source),
      judge: judgeStatus(options, labels),
      reproduction: harvested.map((session) => session.reproduction),
    },
  };
}

export async function writeHarvest(
  out: string,
  harvest: Harvest,
  vault: string,
  secrets: readonly NamedSecret[] = [],
): Promise<void> {
  const earlier = await readJsonLines(join(out, corpusFiles.labels), isLabel);
  const judged = harvest.manifest.judge.ran;
  const kept = earlier.filter(
    (label) => label.source === "hand" || (!judged && label.source === "judge"),
  );
  const labels = [...harvest.labels, ...kept];
  await writeJsonLines(join(out, corpusFiles.points), harvest.points);
  await writeJsonLines(join(out, corpusFiles.labels), labels);
  await writeJsonFile(join(out, corpusFiles.manifest), {
    ...harvest.manifest,
    labels: countBy(labels, (label) => label.source),
  });
  const snapshot = join(out, corpusFiles.vault);
  if (resolve(vault) !== resolve(snapshot))
    await snapshotVault(vault, snapshot, redactorFor(secrets));
}

interface SessionHarvest {
  points: ActionPoint[];
  labels: CandidateLabel[];
  reproduction: SessionReproduction;
}

interface SessionSeams {
  search: MemorySearch;
  budget: ActionBudget;
  redact: Redact;
  judge: Judge | undefined;
}

async function harvestSession(
  session: RecordedSession,
  seams: SessionSeams,
): Promise<SessionHarvest> {
  const builtin = builtinArm();
  const subjects = new Set<string>();
  const surfaced = new Set<string>();
  const points: ActionPoint[] = [];
  const labels: CandidateLabel[] = [];
  const builtinKept: string[] = [];
  for (const { call, turn } of placedCalls(session)) {
    const action = pendingAction(call);
    if (session.deniedCalls.has(call.callId) || action === undefined) continue;
    if (seams.budget.tokens <= 0 || subjects.has(action.subject)) continue;
    subjects.add(action.subject);
    const { hits } = await seams.search.search(action.subject, { limit: seams.budget.notes });
    if (hits.length === 0) continue;
    const point = actionPoint(session, { call, action, turn }, hits, surfaced, seams);
    const kept = keptOf(await builtin.answer(point));
    builtinKept.push(...kept);
    for (const name of point.recorded?.kept ?? kept) surfaced.add(name);
    points.push(point);
    labels.push(...hindsightLabels(point, turnsAfter(session, turn, hindsightTurns)));
    if (seams.judge !== undefined)
      labels.push(...(await judgeCandidates(seams.judge, point, session, turn)));
  }
  return { points, labels, reproduction: reproductionOf(session, points, builtinKept) };
}

interface PlacedAction {
  call: ToolCallPart;
  action: PendingAction;
  turn: number;
}

function actionPoint(
  session: RecordedSession,
  { call, action, turn }: PlacedAction,
  hits: readonly SearchHit[],
  surfaced: ReadonlySet<string>,
  seams: SessionSeams,
): ActionPoint {
  const id = `${session.name}#${call.callId}`;
  const recorded = recordedSelection(session.decisions.get(call.callId));
  return {
    id,
    question: memoryQuestions.actionRelevance,
    half: halfOf(id),
    session: session.name,
    action: { ...action, subject: seams.redact(action.subject) },
    candidates: hits.map((hit) => candidateOf(hit, seams.redact)),
    surfaced: hits.map((hit) => hit.note.name).filter((name) => surfaced.has(name)),
    budget: seams.budget,
    rides: ridesAfter(session, turn),
    ...(recorded !== undefined && { recorded }),
  };
}

function candidateOf(hit: SearchHit, redact: Redact): CandidateNote {
  return {
    name: hit.note.name,
    title: redact(hit.note.title),
    layer: searchHitLayer(hit) ?? workspaceLayer,
    excerpt: recallExcerpt(hit.note.body, redact),
    tokens: hit.note.tokens,
    superseded: hit.superseded,
    ranks: hit.ranks,
  };
}

function recordedSelection(decision: MemoryDecision | undefined): RecordedSelection | undefined {
  if (decision === undefined || typeof decision.choice !== "object") return undefined;
  return { decider: decision.decider, candidates: decision.candidates, kept: decision.choice.kept };
}

function hindsightLabels(point: ActionPoint, next: readonly AssistantTurn[]): CandidateLabel[] {
  return decidableCandidates(point).map((candidate) => {
    const use = useOf(candidate.name, next);
    return {
      point: point.id,
      note: candidate.name,
      relevant: use !== undefined,
      source: "hindsight",
      evidence: use ?? `neither cited nor read in the next ${hindsightTurns} turns`,
    };
  });
}

function useOf(name: string, turns: readonly AssistantTurn[]): string | undefined {
  const key = titleKey(name);
  for (const [index, turn] of turns.entries()) {
    const later = `${index + 1} ${index === 0 ? "turn" : "turns"} later`;
    if (extractWikilinks(turn.text).some((link) => titleKey(link) === key)) return `cited ${later}`;
    if (turn.calls.some((call) => readsNote(call, key))) return `read with memory_get ${later}`;
  }
  return undefined;
}

function readsNote(call: ToolCallPart, key: string): boolean {
  if (call.name !== "memory_get") return false;
  const note = (call.arguments as { note?: unknown } | null)?.note;
  const target = typeof note === "string" ? (wikilinkTarget(note) ?? note) : undefined;
  return target !== undefined && titleKey(target) === key;
}

async function judgeCandidates(
  judge: Judge,
  point: ActionPoint,
  session: RecordedSession,
  turn: number,
): Promise<CandidateLabel[]> {
  const turns = turnsAfter(session, turn, hindsightTurns).map((next) => rendered(next, session));
  const labels: CandidateLabel[] = [];
  for (const candidate of decidableCandidates(point)) {
    const verdict = await judge.relevance({
      action: point.action,
      note: { title: candidate.title, excerpt: candidate.excerpt },
      turns,
    });
    if (verdict === undefined) continue;
    labels.push({
      point: point.id,
      note: candidate.name,
      relevant: verdict.relevant,
      source: "judge",
      evidence: `${judge.id}: ${verdict.reason}`,
    });
  }
  return labels;
}

async function judgePairs(
  judge: Judge,
  points: readonly DecisionPoint[],
  inbox: readonly AnswerLabel[],
): Promise<AnswerLabel[]> {
  const seen = new Set(inbox.map((label) => label.point));
  const unseen = points.filter(
    (point): point is PairPoint =>
      point.question === memoryQuestions.pairRelation && !seen.has(point.id),
  );
  const labels: AnswerLabel[] = [];
  for (const point of unseen) {
    const verdict = await judge.relation({ older: point.a, newer: point.b });
    if (verdict === undefined) continue;
    labels.push({
      point: point.id,
      answer: verdict.relation,
      holds: true,
      source: "judge",
      evidence: `${judge.id}: ${verdict.reason}`,
    });
  }
  return labels;
}

function rendered(turn: AssistantTurn, session: RecordedSession): string {
  const calls = turn.calls.map((call) => {
    const result = session.results.get(call.callId)?.slice(0, renderedResultChars) ?? "";
    return `called ${call.name} ${JSON.stringify(call.arguments).slice(0, renderedArgumentChars)}\nresult: ${result}`;
  });
  return [turn.text, ...calls].filter((part) => part !== "").join("\n");
}

const renderedResultChars = 400;
const renderedArgumentChars = 300;

function reproductionOf(
  session: RecordedSession,
  points: readonly ActionPoint[],
  builtinKept: readonly string[],
): SessionReproduction {
  const underJev = points.some((point) => point.recorded?.decider === "jev");
  if (underJev)
    return {
      session: session.name,
      reproduced: false,
      detail: "recorded under jev, so the builtin is not expected to reproduce it",
    };
  const journaled = session.actionInjections;
  const reproduced = sameNames(journaled, builtinKept);
  return {
    session: session.name,
    reproduced,
    detail: reproduced
      ? `the builtin reproduces all ${journaled.length} journaled action injections`
      : `the journal injected ${linked(journaled)} where the builtin keeps ${linked(builtinKept)}`,
  };
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function linked(names: readonly string[]): string {
  return names.length === 0 ? "nothing" : names.map((name) => `[[${name}]]`).join(", ");
}

function judgeStatus(options: HarvestOptions, labels: readonly Label[]): JudgeStatus {
  if (options.judge === undefined)
    return { ran: false, reason: options.judgeAbsence ?? "the harvest was given no judge" };
  return {
    ran: true,
    judge: options.judge.id,
    labels: labels.filter((label) => label.source === "judge").length,
  };
}

function countBy<Item>(
  items: readonly Item[],
  keyOf: (item: Item) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[keyOf(item)] = (counts[keyOf(item)] ?? 0) + 1;
  return counts;
}

async function snapshotVault(vault: string, snapshot: string, redact: Redact): Promise<void> {
  const entries = await readdir(vault, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const from = join(entry.parentPath, entry.name);
    const path = relative(vault, from);
    if (!isSnapshotted(path)) continue;
    const to = join(snapshot, path);
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, redact(await readFile(from, "utf8")), "utf8");
  }
}

function isSnapshotted(path: string): boolean {
  const parts = path.split(/[\\/]/);
  const hidden = parts.slice(0, -1).some((part) => part.startsWith(".") && part !== ".staging");
  return !hidden && (path.endsWith(".md") || path.endsWith(".json"));
}
