import { keeperPlan } from "./gate.ts";
import type { AcceptanceResult, DecisionRecord, Interval, Ratchet, Scored } from "./ratchet.ts";
import { type BlindReview, blindReviewOf, emptyReviewBook, type ReviewBook } from "./review.ts";

export const keeperFitRows = 50;
export const keeperFitSupport = 20;
export const auditTag = "audit";

export type CalibrationState =
  | "fitting"
  | "no-bar"
  | "collecting"
  | "awaiting-labels"
  | "accepted"
  | "rejected";

export interface ModelCalibration {
  model: string;
  ruleClass: string;
  state: CalibrationState;
  labelled: number;
  fitRows: number;
  heldOutRows: number;
  bar?: number;
  fitActs?: number;
  acts: number;
  sampleSize: number;
  agreement?: number;
  interval?: Interval;
  errors?: number;
  lowerBound?: number;
  review: BlindReview;
}

export type CalibrationRatchet = Pick<
  Ratchet,
  "evaluateAcceptance" | "fitThreshold" | "wilsonInterval" | "requiredActs"
>;

export function calibrationOf(
  ratchet: CalibrationRatchet,
  ruleClass: string,
  rows: readonly DecisionRecord[],
  book: ReviewBook = emptyReviewBook,
): ModelCalibration[] {
  return [...byModel(rows.filter(isEvidence))].map(([model, modelRows]) =>
    modelCalibrationOf(ratchet, { model, ruleClass, rows: modelRows, book }),
  );
}

export function modelOfRow(row: DecisionRecord): string {
  return row.model ?? row.oracle;
}

export function answeredByOracle(row: DecisionRecord): boolean {
  return !row.failedOpen && row.strategy !== "floored" && row.strategy !== "bypass";
}

export function plannedSampleSize(ratchet: Pick<Ratchet, "requiredActs">): number {
  return ratchet.requiredActs(
    keeperPlan.target,
    keeperPlan.confidence ?? 0.95,
    keeperPlan.maxErrors ?? 0,
  );
}

interface ModelRows {
  model: string;
  ruleClass: string;
  rows: readonly DecisionRecord[];
  book: ReviewBook;
}

function modelCalibrationOf(
  ratchet: CalibrationRatchet,
  { model, ruleClass, rows, book }: ModelRows,
): ModelCalibration {
  const labelled = rows.filter(hasVerdict);
  const fit = labelled.slice(0, keeperFitRows);
  const heldOut = labelled.length < keeperFitRows ? [] : rowsAfter(rows, fit.at(-1));
  const base = {
    model,
    ruleClass,
    labelled: labelled.length,
    fitRows: fit.length,
    heldOutRows: heldOut.length,
    acts: 0,
    sampleSize: plannedSampleSize(ratchet),
    review: blindReviewOf(book, model, ruleClass),
  };
  if (labelled.length < keeperFitRows) return { ...base, state: "fitting" };
  const fitted = ratchet.fitThreshold(fit.map(scoredForYes), keeperPlan.target, keeperFitSupport);
  if (fitted === undefined) return { ...base, state: "no-bar" };
  const acceptance = ratchet.evaluateAcceptance(
    heldOut.map((row) => ruledAt(row, fitted.threshold)),
    keeperPlan,
  );
  return {
    ...base,
    state: acceptance.status,
    bar: fitted.threshold,
    fitActs: fitted.n,
    review: blindReviewOf(book, model, ruleClass, fitted.threshold),
    acts: actsIn(acceptance),
    ...verdictOf(ratchet, acceptance),
  };
}

function isEvidence(row: DecisionRecord): boolean {
  return (row.mode === "shadow" || row.tags.includes(auditTag)) && answeredByOracle(row);
}

function rowsAfter(
  rows: readonly DecisionRecord[],
  last: DecisionRecord | undefined,
): DecisionRecord[] {
  return last === undefined ? [] : rows.slice(rows.indexOf(last) + 1);
}

function hasVerdict(row: DecisionRecord): boolean {
  return typeof row.outcome?.truth === "boolean";
}

function scoredForYes(row: DecisionRecord): Scored {
  return { confidence: row.go, correct: row.outcome?.truth === true };
}

function ruledAt(row: DecisionRecord, bar: number): DecisionRecord {
  return { ...row, soft: row.go >= bar ? "act" : "review" };
}

function actsIn(acceptance: AcceptanceResult): number {
  return acceptance.status === "collecting" ? acceptance.acts : acceptance.sample.length;
}

function verdictOf(
  ratchet: CalibrationRatchet,
  acceptance: AcceptanceResult,
): Pick<ModelCalibration, "agreement" | "interval" | "errors" | "lowerBound"> {
  if (acceptance.status !== "accepted" && acceptance.status !== "rejected") return {};
  const size = acceptance.sample.length;
  const agreement = (size - acceptance.errors) / size;
  return {
    agreement,
    interval: ratchet.wilsonInterval(agreement, size, acceptance.plan.confidence),
    errors: acceptance.errors,
    lowerBound: acceptance.lowerBound,
  };
}

function byModel(rows: readonly DecisionRecord[]): Map<string, DecisionRecord[]> {
  const groups = new Map<string, DecisionRecord[]>();
  for (const row of rows) {
    const model = modelOfRow(row);
    groups.set(model, [...(groups.get(model) ?? []), row]);
  }
  return groups;
}
