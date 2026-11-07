import type { ToolCallPart, Usage } from "../../messages.ts";
import type { Provider } from "../../provider.ts";
import type { ServerFingerprint } from "../capabilities/index.ts";
import { auroc, brier, ece, fitThreshold, type Scored } from "../decide/calibration.ts";
import type { Decider, DecisionQuestion, DecisionState } from "../decide/types.ts";
import { failedTurnScore, scoreTurn, type TurnScore } from "./score.ts";
import type { BenchTrace, BenchTurn } from "./trace.ts";

export const minimumRepeats = 3;

export interface Spread {
  mean: number;
  min: number;
  max: number;
}

export interface ChatBenchOptions {
  reference: string;
  fingerprint: ServerFingerprint;
  provider: Provider;
  trace: BenchTrace;
  repeats?: number | undefined;
  clock?: (() => number) | undefined;
}

export interface ChatBenchReport {
  kind: "chat";
  reference: string;
  fingerprint: ServerFingerprint;
  trace: string;
  repeats: number;
  turns: number;
  validAt1: Spread;
  toolCalls: {
    name: Spread;
    schema: Spread;
    arguments: Spread;
    noTool: Spread | null;
    parallel: Spread | null;
  };
  tokensPerTurn: Spread | null;
  secondsPerTurn: Spread;
  decodeTokensPerSecond: Spread | null;
  fallbacks: number;
}

export interface LabelledDecision {
  id: string;
  state: DecisionState;
  question: Extract<DecisionQuestion, { type: "noul" }>;
  label: boolean;
}

export interface DecideBenchOptions {
  reference: string;
  fingerprint: ServerFingerprint;
  decider: Decider;
  rows: readonly LabelledDecision[];
  repeats?: number | undefined;
  clock?: (() => number) | undefined;
  targetPrecision?: number | undefined;
  minSupport?: number | undefined;
}

export interface PrecisionThreshold {
  target: number;
  threshold: number;
  precision: number;
  coverage: number;
  n: number;
}

export interface DecideBenchReport {
  kind: "decide";
  reference: string;
  fingerprint: ServerFingerprint;
  rows: number;
  repeats: number;
  validAt1: Spread;
  brier: Spread | null;
  ece: Spread | null;
  auroc: Spread | null;
  thresholdAtPrecision: PrecisionThreshold | null;
  secondsPerQuestion: Spread;
  inputTokensPerQuestion: Spread | null;
  fallbacks: number;
}

export type BenchReport = ChatBenchReport | DecideBenchReport;

export async function runChatBench(options: ChatBenchOptions): Promise<ChatBenchReport> {
  const repeats = checkedRepeats(options.repeats);
  const clock = options.clock ?? (() => performance.now());
  const runs: TurnRun[][] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const turns: TurnRun[] = [];
    for (const turn of options.trace.turns) {
      turns.push(await runTurn(options.provider, options.trace, turn, clock));
    }
    runs.push(turns);
  }
  const all = runs.flat();
  const share = (pick: (score: TurnScore) => boolean | null) =>
    spreadOf(runs.flatMap((turns) => shareOf(turns.map((run) => pick(run.score)))));
  return {
    kind: "chat",
    reference: options.reference,
    fingerprint: options.fingerprint,
    trace: options.trace.name,
    repeats,
    turns: options.trace.turns.length,
    validAt1: share((score) => score.valid) ?? zeroSpread,
    toolCalls: {
      name: share((score) => score.name) ?? zeroSpread,
      schema: share((score) => score.schema) ?? zeroSpread,
      arguments: share((score) => score.arguments) ?? zeroSpread,
      noTool: share((score) => score.noTool),
      parallel: share((score) => score.parallel),
    },
    tokensPerTurn: spreadOf(all.flatMap((run) => (run.usage ? [tokensOf(run.usage)] : []))),
    secondsPerTurn: spreadOf(all.map((run) => run.seconds)) ?? zeroSpread,
    decodeTokensPerSecond: spreadOf(all.flatMap(decodeRateOf)),
    fallbacks: all.filter((run) => run.failed).length,
  };
}

export async function runDecideBench(options: DecideBenchOptions): Promise<DecideBenchReport> {
  const repeats = checkedRepeats(options.repeats);
  const clock = options.clock ?? (() => performance.now());
  const runs: DecisionRun[][] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const answered: DecisionRun[] = [];
    for (const row of options.rows) answered.push(await runDecision(options.decider, row, clock));
    runs.push(answered);
  }
  const all = runs.flat();
  const scoredRuns = runs.map((answered) => answered.flatMap(scoredOf));
  const pooled = scoredRuns.flat();
  const target = options.targetPrecision ?? 0.95;
  const fitted = fitThreshold(pooled, target, options.minSupport ?? 20);
  return {
    kind: "decide",
    reference: options.reference,
    fingerprint: options.fingerprint,
    rows: options.rows.length,
    repeats,
    validAt1:
      spreadOf(runs.flatMap((answered) => shareOf(answered.map((run) => run.pYes !== null)))) ??
      zeroSpread,
    brier: spreadOf(scoredRuns.filter(nonEmpty).map(brier)),
    ece: spreadOf(scoredRuns.filter(nonEmpty).map((scored) => ece(scored))),
    auroc: spreadOf(scoredRuns.flatMap((scored) => definedOnly(auroc(scored)))),
    thresholdAtPrecision:
      fitted === undefined
        ? null
        : {
            target,
            threshold: fitted.threshold,
            precision: fitted.accuracy,
            coverage: fitted.coverage,
            n: fitted.n,
          },
    secondsPerQuestion: spreadOf(all.map((run) => run.seconds)) ?? zeroSpread,
    inputTokensPerQuestion: spreadOf(all.flatMap((run) => definedOnly(run.inputTokens))),
    fallbacks: all.filter((run) => run.pYes === null).length,
  };
}

interface TurnRun {
  score: TurnScore;
  usage: Usage | undefined;
  seconds: number;
  failed: boolean;
}

async function runTurn(
  provider: Provider,
  trace: BenchTrace,
  turn: BenchTurn,
  clock: () => number,
): Promise<TurnRun> {
  const started = clock();
  const calls: ToolCallPart[] = [];
  let usage: Usage | undefined;
  try {
    const request = {
      systemPrompt: turn.systemPrompt,
      messages: turn.messages,
      tools: trace.tools,
    };
    for await (const delta of provider.stream(request)) {
      if (delta.type === "tool-call") calls.push(delta.call);
      if (delta.type === "done") usage = delta.usage;
    }
  } catch {
    return {
      score: failedTurnScore(turn),
      usage: undefined,
      seconds: secondsSince(started, clock),
      failed: true,
    };
  }
  return {
    score: scoreTurn(turn, trace.tools, calls),
    usage,
    seconds: secondsSince(started, clock),
    failed: false,
  };
}

interface DecisionRun {
  row: LabelledDecision;
  pYes: number | null;
  inputTokens: number | undefined;
  seconds: number;
}

async function runDecision(
  decider: Decider,
  row: LabelledDecision,
  clock: () => number,
): Promise<DecisionRun> {
  const started = clock();
  const reply = await decider.decide({ state: row.state, questions: { [row.id]: row.question } });
  const seconds = secondsSince(started, clock);
  const answer = reply.ok ? reply.answers[row.id] : undefined;
  return {
    row,
    pYes: answer?.type === "noul" ? answer.pYes : null,
    inputTokens: reply.ok ? (reply.usage.inputTokens ?? undefined) : undefined,
    seconds,
  };
}

function scoredOf(run: DecisionRun): Scored[] {
  return run.pYes === null ? [] : [{ confidence: run.pYes, correct: run.row.label }];
}

function checkedRepeats(repeats = minimumRepeats): number {
  if (!Number.isInteger(repeats) || repeats < minimumRepeats) {
    throw new RangeError(`a bench needs at least ${minimumRepeats} repeats, got ${repeats}`);
  }
  return repeats;
}

function shareOf(outcomes: readonly (boolean | null)[]): number[] {
  const applicable = outcomes.filter((outcome): outcome is boolean => outcome !== null);
  if (applicable.length === 0) return [];
  return [applicable.filter(Boolean).length / applicable.length];
}

function spreadOf(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

const zeroSpread: Spread = { mean: 0, min: 0, max: 0 };

function tokensOf(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

function decodeRateOf(run: TurnRun): number[] {
  if (run.usage === undefined || run.seconds <= 0 || run.usage.outputTokens === 0) return [];
  return [run.usage.outputTokens / run.seconds];
}

function secondsSince(started: number, clock: () => number): number {
  return (clock() - started) / 1000;
}

function nonEmpty(scored: readonly Scored[]): boolean {
  return scored.length > 0;
}

function definedOnly(value: number | undefined): number[] {
  return value === undefined ? [] : [value];
}
