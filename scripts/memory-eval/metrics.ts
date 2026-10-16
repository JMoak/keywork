import {
  type FallbackReason,
  type MemoryDecision,
  type MemoryQuestion,
  memoryQuestions,
  titleKey,
} from "../../packages/engine/src/index.ts";
import { percentile } from "../soak/budget.ts";
import {
  applyCalibration,
  type CalibrationMap,
  eceNoiseFloor,
  expectedCalibrationError,
  fitIsotonic,
  type ProbabilitySample,
  type ReliabilityBin,
  reliabilityBins,
} from "./calibration.ts";
import {
  type ActionPoint,
  type AnswerLabel,
  type AnswerLine,
  type Corpus,
  type DecisionPoint,
  decidableCandidates,
  isCandidateLabel,
  type Label,
  type LabelSource,
} from "./corpus.ts";

export const jevDollarsPerMillionInputTokens = 0.042;

export type Answers = ReadonlyMap<string, AnswerLine>;

export interface QuestionMeasures {
  question: MemoryQuestion;
  points: number;
  injection?: Injection;
  hindsight?: RecallQuality;
  judged?: RecallQuality;
  agreement?: Agreement;
  latency: Spread;
  waited?: Spread;
  fallbacks: FallbackCount[];
  calibration?: Calibration;
  cost: Cost;
}

export interface Injection {
  injected: number;
  carried: number;
}

export interface RecallQuality {
  relevant: number;
  kept: number;
  keptRelevant: number;
  recall: number | undefined;
  precision: number | undefined;
  harmful?: HarmfulDrops;
}

export interface HarmfulDrops {
  count: number;
  rate: number;
  drops: { point: string; note: string }[];
}

export interface Agreement {
  labeled: number;
  agreed: number;
  rate: number | undefined;
}

export interface Spread {
  p50: number;
  p95: number;
  max: number;
}

export interface FallbackCount {
  reason: FallbackReason;
  count: number;
}

export interface Calibration {
  samples: number;
  rawEce: number;
  ece: number;
  noiseFloor: number;
  bins: ReliabilityBin[];
  map: CalibrationMap;
}

export interface Cost {
  inputTokens: number;
  usd: number;
}

export interface Disagreement {
  point: string;
  subject: string;
  ours: string;
  theirs: string;
}

export function answersOf(lines: readonly AnswerLine[]): Answers {
  return new Map(lines.map((line) => [line.point, line]));
}

export function measureQuestion(
  question: MemoryQuestion,
  corpus: Corpus,
  answers: Answers,
  baseline?: Answers,
): QuestionMeasures {
  const heldOut = pointsOf(corpus, question, "held-out");
  const decisions = heldOut.flatMap((point) => answers.get(point.id)?.decision ?? []);
  const calibration = calibrationOf(question, corpus, answers);
  return {
    question,
    points: heldOut.length,
    ...(isActionQuestion(question)
      ? actionMeasures(heldOut.filter(isActionPoint), corpus.labels, answers, baseline)
      : { agreement: agreementOf(heldOut, corpus.labels, answers) }),
    latency: spreadOf(decisions.map((decision) => decision.latencyMs)),
    ...(isHotPathQuestion(question) && {
      waited: spreadOf(decisions.map((decision) => decision.waitedMs ?? decision.latencyMs)),
    }),
    fallbacks: fallbacksOf(decisions),
    ...(calibration !== undefined && { calibration }),
    cost: costOf(decisions),
  };
}

export function isActionQuestion(question: MemoryQuestion): boolean {
  return question === memoryQuestions.actionRelevance;
}

export function isHotPathQuestion(question: MemoryQuestion): boolean {
  return (
    question === memoryQuestions.actionRelevance || question === memoryQuestions.searchRelevance
  );
}

export function questionsIn(corpus: Corpus): MemoryQuestion[] {
  const present = new Set<MemoryQuestion>(corpus.points.map((point) => point.question));
  return Object.values(memoryQuestions).filter((question) => present.has(question));
}

export function keptOf(line: AnswerLine | undefined): string[] {
  return line !== undefined && "kept" in line.outcome ? line.outcome.kept : [];
}

export function answerOf(line: AnswerLine | undefined): string | undefined {
  if (line === undefined) return undefined;
  const { outcome } = line;
  if ("durability" in outcome) return outcome.durability;
  if ("relation" in outcome) return outcome.relation;
  if ("verdict" in outcome) return outcome.verdict;
  return undefined;
}

export function disagreements(
  points: readonly DecisionPoint[],
  ours: Answers,
  theirs: Answers,
): Disagreement[] {
  return points.flatMap((point) => {
    const mine = describeAnswer(ours.get(point.id));
    const other = describeAnswer(theirs.get(point.id));
    return mine === other
      ? []
      : [{ point: point.id, subject: subjectOf(point), ours: mine, theirs: other }];
  });
}

export function hasJudgeLabels(labels: readonly Label[]): boolean {
  return labels.some((label) => label.source === "judge");
}

const hindsightSources: readonly LabelSource[] = ["hand", "hindsight"];
const judgedSources: readonly LabelSource[] = ["hand", "judge"];
const bestCandidateSources: readonly LabelSource[] = ["hand", "judge", "hindsight"];
const verdictSources: readonly LabelSource[] = ["hand", "inbox", "judge", "hindsight"];

function actionMeasures(
  points: readonly ActionPoint[],
  labels: readonly Label[],
  answers: Answers,
  baseline: Answers | undefined,
): Pick<QuestionMeasures, "injection" | "hindsight" | "judged"> {
  return {
    injection: injectionOf(points, answers),
    hindsight: recallQuality(
      points,
      candidateVerdicts(labels, hindsightSources),
      answers,
      baseline,
    ),
    ...(hasJudgeLabels(labels) && {
      judged: recallQuality(points, candidateVerdicts(labels, judgedSources), answers, baseline),
    }),
  };
}

function injectionOf(points: readonly ActionPoint[], answers: Answers): Injection {
  let injected = 0;
  let carried = 0;
  for (const point of points) {
    const kept = new Set(keptOf(answers.get(point.id)));
    const tokens = point.candidates
      .filter((candidate) => kept.has(candidate.name))
      .reduce((total, candidate) => total + candidate.tokens, 0);
    injected += tokens;
    carried += tokens * point.rides;
  }
  return { injected, carried };
}

function recallQuality(
  points: readonly ActionPoint[],
  verdicts: ReadonlyMap<string, boolean>,
  answers: Answers,
  baseline: Answers | undefined,
): RecallQuality {
  let relevant = 0;
  let kept = 0;
  let keptRelevant = 0;
  const drops: HarmfulDrops["drops"] = [];
  for (const point of points) {
    const ours = keySet(keptOf(answers.get(point.id)));
    const theirs = keySet(keptOf(baseline?.get(point.id)));
    for (const candidate of decidableCandidates(point)) {
      const verdict = verdicts.get(candidateKey(point.id, candidate.name));
      if (verdict === undefined) continue;
      const isKept = ours.has(titleKey(candidate.name));
      if (isKept) kept += 1;
      if (!verdict) continue;
      relevant += 1;
      if (isKept) keptRelevant += 1;
      else if (theirs.has(titleKey(candidate.name)))
        drops.push({ point: point.id, note: candidate.name });
    }
  }
  return {
    relevant,
    kept,
    keptRelevant,
    recall: ratio(keptRelevant, relevant),
    precision: ratio(keptRelevant, kept),
    ...(baseline !== undefined && {
      harmful: { count: drops.length, rate: ratio(drops.length, relevant) ?? 0, drops },
    }),
  };
}

function agreementOf(
  points: readonly DecisionPoint[],
  labels: readonly Label[],
  answers: Answers,
): Agreement {
  let labeled = 0;
  let agreed = 0;
  for (const point of points) {
    const verdicts = pointVerdicts(labels, point.id);
    if (verdicts.length === 0) continue;
    labeled += 1;
    if (agreesWith(answerOf(answers.get(point.id)), verdicts)) agreed += 1;
  }
  return { labeled, agreed, rate: ratio(agreed, labeled) };
}

function calibrationOf(
  question: MemoryQuestion,
  corpus: Corpus,
  answers: Answers,
): Calibration | undefined {
  const fit = samplesOf(pointsOf(corpus, question, "fit"), corpus.labels, answers);
  const heldOut = samplesOf(pointsOf(corpus, question, "held-out"), corpus.labels, answers);
  if (heldOut.length === 0) return undefined;
  const map = fitIsotonic(fit);
  const calibrated = heldOut.map((sample) => ({
    ...sample,
    probability: applyCalibration(map, sample.probability),
  }));
  return {
    samples: heldOut.length,
    rawEce: expectedCalibrationError(heldOut),
    ece: expectedCalibrationError(calibrated),
    noiseFloor: eceNoiseFloor(calibrated.map((sample) => sample.probability)),
    bins: reliabilityBins(calibrated),
    map,
  };
}

function samplesOf(
  points: readonly DecisionPoint[],
  labels: readonly Label[],
  answers: Answers,
): ProbabilitySample[] {
  const candidates = candidateVerdicts(labels, bestCandidateSources);
  return points.flatMap((point) => {
    const line = answers.get(point.id);
    if (line === undefined) return [];
    if (point.question === memoryQuestions.actionRelevance)
      return decidableCandidates(point).flatMap((candidate) =>
        sampleOf(
          line.decision.scores?.[candidate.name],
          candidates.get(candidateKey(point.id, candidate.name)),
        ),
      );
    const verdicts = pointVerdicts(labels, point.id);
    if (verdicts.length === 0) return [];
    if (point.question === memoryQuestions.mentionIsLink)
      return sampleOf(line.decision.scores?.[point.target.name], agreesWith("link", verdicts));
    return sampleOf(statedConfidence(line.decision), agreesWith(answerOf(line), verdicts));
  });
}

function sampleOf(
  probability: number | undefined,
  outcome: boolean | undefined,
): ProbabilitySample[] {
  return probability === undefined || outcome === undefined ? [] : [{ probability, outcome }];
}

function statedConfidence(decision: MemoryDecision): number | undefined {
  if (decision.confidence !== undefined) return decision.confidence;
  const scores = Object.values(decision.scores ?? {});
  return scores.length === 0 ? undefined : Math.max(...scores);
}

function candidateVerdicts(
  labels: readonly Label[],
  sources: readonly LabelSource[],
): Map<string, boolean> {
  const verdicts = new Map<string, boolean>();
  for (const source of sources) {
    for (const label of labels) {
      if (label.source !== source || !isCandidateLabel(label)) continue;
      const key = candidateKey(label.point, label.note);
      if (!verdicts.has(key)) verdicts.set(key, label.relevant);
    }
  }
  return verdicts;
}

function pointVerdicts(labels: readonly Label[], point: string): AnswerLabel[] {
  const answers = labels.filter(
    (label): label is AnswerLabel => label.point === point && !isCandidateLabel(label),
  );
  const source = verdictSources.find((candidate) =>
    answers.some((label) => label.source === candidate),
  );
  return answers.filter((label) => label.source === source);
}

function agreesWith(answer: string | undefined, verdicts: readonly AnswerLabel[]): boolean {
  return verdicts.every((verdict) =>
    verdict.holds ? answer === verdict.answer : answer !== verdict.answer,
  );
}

function fallbacksOf(decisions: readonly MemoryDecision[]): FallbackCount[] {
  const counts = new Map<FallbackReason, number>();
  for (const decision of decisions) {
    const reason = decision.fallback?.reason;
    if (reason !== undefined) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts].map(([reason, count]) => ({ reason, count }));
}

function costOf(decisions: readonly MemoryDecision[]): Cost {
  const inputTokens = decisions.reduce((total, decision) => total + (decision.inputTokens ?? 0), 0);
  return { inputTokens, usd: (inputTokens * jevDollarsPerMillionInputTokens) / 1_000_000 };
}

function spreadOf(values: readonly number[]): Spread {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

function describeAnswer(line: AnswerLine | undefined): string {
  if (line === undefined) return "no answer";
  if ("kept" in line.outcome)
    return line.outcome.kept.length === 0
      ? "kept nothing"
      : `kept ${line.outcome.kept.map((name) => `[[${name}]]`).join(", ")}`;
  return answerOf(line) ?? "no answer";
}

function subjectOf(point: DecisionPoint): string {
  switch (point.question) {
    case memoryQuestions.actionRelevance:
      return `${point.action.tool} ${point.action.subject}`;
    case memoryQuestions.entryDurability:
      return `entry ${point.entry.id}`;
    case memoryQuestions.pairRelation:
      return `[[${point.a.name}]] and [[${point.b.name}]]`;
    case memoryQuestions.driftVerdict:
      return `[[${point.note.name}]] after a diff`;
    case memoryQuestions.mentionIsLink:
      return `[[${point.source.name}]] mentions "${point.mention}" of [[${point.target.name}]]`;
  }
}

function pointsOf(corpus: Corpus, question: MemoryQuestion, half: DecisionPoint["half"]) {
  return corpus.points.filter((point) => point.question === question && point.half === half);
}

function isActionPoint(point: DecisionPoint): point is ActionPoint {
  return point.question === memoryQuestions.actionRelevance;
}

function candidateKey(point: string, note: string): string {
  return `${point}\n${titleKey(note)}`;
}

function keySet(names: readonly string[]): Set<string> {
  return new Set(names.map(titleKey));
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
}
