import { keeperFitRows, keeperFitSupport, type ModelCalibration } from "./calibration.ts";
import { oneWayDoorClass } from "./facts.ts";
import { keeperPlan } from "./gate.ts";
import type { Promotion } from "./promotions.ts";
import type { ClassReport, KeeperReport } from "./report.ts";

export const nothingEnforced =
  "Nothing is enforced: keeper.would-approve runs in shadow, every ask still waits for the " +
  "keeper, and no recommendation ever reaches a session.";

export const oneWayDoorSentence =
  "destructive forms in keywork's K9 sense stay ask-only, and no evidence promotes them";

export function formatKeeperReport(report: KeeperReport): string {
  const opening = openingOf(report);
  if (report.rows === 0) return [opening, "", emptyLedgerSentence(report)].join("\n");
  return [
    opening,
    "",
    `ledger    ${report.ledgerPath}`,
    `evidence  ${evidenceLine(report)}`,
    "",
    ...classTable([...report.classes, ...(report.gate === undefined ? [] : [report.gate])]),
    ...calibrationSection(report),
    "",
    "grades",
    ...report.classes.map(gradeLine),
  ].join("\n");
}

export function enforcedSentence(promotions: readonly Promotion[]): string {
  const classes = promotions.map((promotion) => `"${promotion.ruleClass}"`).join(", ");
  return (
    `keeper.would-approve decides for you in ${classes}; every other ask still waits for the ` +
    "keeper, and each decision is logged and shown as decided for you, with one key to overturn it."
  );
}

export function calibrationSentence(entry: ModelCalibration): string {
  const bar = entry.bar === undefined ? "" : ` above bar ${entry.bar.toFixed(2)}`;
  switch (entry.state) {
    case "fitting":
      return `fitting, ${entry.labelled} of the ${keeperFitRows} answers the bar is fitted on`;
    case "no-bar":
      return (
        `no bar: on the first ${keeperFitRows} answers no confidence keeps ` +
        `${percent(keeperPlan.target)} with at least ${keeperFitSupport} calls above it`
      );
    case "collecting":
      return `collecting, ${entry.acts} of ${entry.sampleSize} held-out calls${bar}`;
    case "awaiting-labels":
      return `awaiting the keeper's answers on the planned sample of ${entry.sampleSize}`;
    case "accepted":
    case "rejected":
      return verdictSentence(entry, bar);
  }
}

export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function preciseShare(share: number): string {
  return `${(Math.floor(share * 1000) / 10).toFixed(1)}%`;
}

function openingOf(report: KeeperReport): string {
  const promotions = report.promotions ?? [];
  return promotions.length === 0 ? nothingEnforced : enforcedSentence(promotions);
}

function verdictSentence(entry: ModelCalibration, bar: string): string {
  const size = entry.acts;
  const errors = entry.errors ?? 0;
  const bound = preciseShare(entry.lowerBound ?? 0);
  const interval =
    entry.interval === undefined
      ? ""
      : ` (95% interval ${preciseShare(entry.interval.lower)} to ${preciseShare(entry.interval.upper)})`;
  if (entry.state === "accepted") {
    return `accepted, ${size - errors} of ${size} held-out calls${bar} approved${interval}, exact lower bound ${bound}`;
  }
  return (
    `rejected, ${errors} of ${size} held-out calls${bar} denied${interval}; the exact lower bound ` +
    `${bound} misses ${percent(keeperPlan.target)}, and only a new model or rubric starts a fresh sample`
  );
}

function emptyLedgerSentence(report: KeeperReport): string {
  return `No answered asks yet. Each ask the keeper answers adds one row to ${report.ledgerPath}.`;
}

function evidenceLine(report: KeeperReport): string {
  const counted = `${report.evidenceVersion ?? "unversioned"}, ${rowsWord(report.rows)}`;
  if (report.earlierRows === 0) return counted;
  return `${counted} (${rowsWord(report.earlierRows)} under earlier evidence not counted)`;
}

const headings = ["rule class", "rows", "labelled", "agreement", "brier", "would act", "grade"];

function classTable(reports: readonly ClassReport[]): string[] {
  return table(headings, reports.map(classCells), [0, headings.length - 1]);
}

function table(heads: readonly string[], body: readonly string[][], left: readonly number[]) {
  const cells = [heads, ...body];
  const widths = heads.map((_, column) =>
    Math.max(...cells.map((row) => (row[column] ?? "").length)),
  );
  return cells.map((row) =>
    row
      .map((cell, column) => {
        const width = widths[column] ?? cell.length;
        return left.includes(column) ? cell.padEnd(width) : cell.padStart(width);
      })
      .join("  ")
      .trimEnd(),
  );
}

function classCells(report: ClassReport): string[] {
  return [
    report.ruleClass,
    String(report.rows),
    String(report.labelled),
    report.agreement === undefined ? "-" : percent(report.agreement),
    report.brier === undefined ? "-" : report.brier.toFixed(3),
    actsCell(report),
    report.oneWayDoor ? oneWayDoorClass : report.gradeWord,
  ];
}

function actsCell(report: ClassReport): string {
  if (report.wrongActs === 0) return String(report.wouldAct);
  return `${report.wouldAct} (${report.wrongActs} denied)`;
}

function gradeLine(report: ClassReport): string {
  return `  ${report.ruleClass}: ${report.oneWayDoor ? oneWayDoorSentence : report.gradeText}`;
}

const calibrationHeadings = [
  "model",
  "rule class",
  "labelled",
  "bar",
  "held-out",
  "review",
  "state",
];

function calibrationSection(report: KeeperReport): string[] {
  const entries = report.calibration ?? [];
  if (entries.length === 0) return [];
  return [
    "",
    `calibration (per model and rule class: the bar is fitted on the first ${keeperFitRows} answers, judged on the calls after them; a blind review samples answered asks at ${percent(report.auditRate ?? 0)})`,
    ...table(calibrationHeadings, entries.map(calibrationCells), [0, 1, 6]),
    ...entries.map(
      (entry) => `  ${entry.model}, ${entry.ruleClass}: ${calibrationSentence(entry)}`,
    ),
    ...pendingReviewLine(report.pendingReviews ?? 0),
  ];
}

function calibrationCells(entry: ModelCalibration): string[] {
  return [
    entry.model,
    entry.ruleClass,
    String(entry.labelled),
    entry.bar === undefined ? "-" : entry.bar.toFixed(2),
    entry.state === "fitting" ? "-" : `${entry.acts}/${entry.sampleSize}`,
    `${entry.review.agreedWithGate}/${entry.review.answered}`,
    entry.state,
  ];
}

function pendingReviewLine(pending: number): string[] {
  if (pending === 0) return [];
  const calls = pending === 1 ? "call waits" : "calls wait";
  return [`${pending} ${calls} for a blind review: keywork creatures review`];
}

function rowsWord(count: number): string {
  return `${count} ${count === 1 ? "row" : "rows"}`;
}
