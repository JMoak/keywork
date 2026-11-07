import { readFile } from "node:fs/promises";
import { brier } from "../../models/decide/calibration.ts";
import {
  answeredByOracle,
  type CalibrationRatchet,
  calibrationOf,
  type ModelCalibration,
  modelOfRow,
} from "./calibration.ts";
import { isOneWayDoorClass, oneWayDoorClass } from "./facts.ts";
import { keeperGateId, keeperPlan } from "./gate.ts";
import {
  type Demotion,
  type Promotion,
  promotionsCovering,
  readPromotionBook,
} from "./promotions.ts";
import { type DecisionRecord, type EvidenceGrade, loadRatchet, type Ratchet } from "./ratchet.ts";
import { classTagPrefix, creatureTagPrefix, keeperLedgerPath, oneWayDoorTag } from "./record.ts";
import {
  emptyReviewBook,
  keeperAuditRate,
  pendingReviews,
  type ReviewBook,
  readReviewBook,
} from "./review.ts";

export const allClasses = "all classes";

export interface ClassReport {
  ruleClass: string;
  model?: string;
  rows: number;
  labelled: number;
  answered: number;
  agreement?: number;
  brier?: number;
  wouldAct: number;
  wrongActs: number;
  oneWayDoor: boolean;
  grade: EvidenceGrade;
  gradeWord: string;
  gradeText: string;
}

export interface KeeperReport {
  gateId: string;
  mode: "shadow" | "enforce";
  enforced: boolean;
  ledgerPath: string;
  evidenceVersion?: string;
  rows: number;
  earlierRows: number;
  classes: ClassReport[];
  gate?: ClassReport;
  auditRate?: number;
  calibration?: ModelCalibration[];
  promotions?: Promotion[];
  pendingReviews?: number;
}

export interface ReportExtras {
  book?: ReviewBook | undefined;
  promotions?: readonly Promotion[] | undefined;
  demotions?: readonly Demotion[] | undefined;
}

export type GradingRatchet = Pick<Ratchet, "gradeOf" | "gradeWord" | "describeGrade"> &
  CalibrationRatchet;

export interface ReadReportOptions {
  nodeState: string;
  ratchet?: Ratchet | undefined;
  creature?: string | undefined;
}

export async function readKeeperReport(options: ReadReportOptions): Promise<KeeperReport> {
  const ratchet = options.ratchet ?? (await loadRatchet());
  const ledgerPath = keeperLedgerPath(options.nodeState);
  const kept = await readKeeperRows({ ...options, ratchet });
  const [book, promotions] = await Promise.all([
    readReviewBook(options.nodeState),
    readPromotionBook(options.nodeState),
  ]);
  return keeperReportOf(ratchet, kept, ledgerPath, {
    book: options.creature === undefined ? book : reviewsAmong(book, kept),
    promotions: promotionsCovering(promotions.active, options.creature),
    demotions: promotions.demotions,
  });
}

export async function readKeeperRows(options: ReadReportOptions): Promise<DecisionRecord[]> {
  const ratchet = options.ratchet ?? (await loadRatchet());
  const rows = await readRows(ratchet, keeperLedgerPath(options.nodeState));
  const tag = `${creatureTagPrefix}${options.creature}`;
  return options.creature === undefined ? rows : rows.filter((row) => row.tags.includes(tag));
}

export function currentEvidence(rows: readonly DecisionRecord[]): DecisionRecord[] {
  const gateRows = rows.filter((row) => row.gateId === keeperGateId);
  const evidenceVersion = gateRows.at(-1)?.evidenceVersion;
  return gateRows.filter((row) => row.evidenceVersion === evidenceVersion);
}

export function sinceLastDemotion(
  rows: readonly DecisionRecord[],
  ruleClass: string,
  demotions: readonly Demotion[],
): DecisionRecord[] {
  const boundary = demotions.filter((demotion) => demotion.ruleClass === ruleClass).at(-1)?.at;
  return boundary === undefined ? [...rows] : rows.filter((row) => row.at > boundary);
}

export function keeperReportOf(
  ratchet: GradingRatchet,
  rows: readonly DecisionRecord[],
  ledgerPath: string,
  extras: ReportExtras = {},
): KeeperReport {
  const gateRows = rows.filter((row) => row.gateId === keeperGateId);
  const current = currentEvidence(gateRows);
  const evidenceVersion = current.at(-1)?.evidenceVersion;
  const groups = byRuleClass(current);
  const classes = [...groups]
    .map(([ruleClass, classRows]) => classReportOf(ratchet, ruleClass, classRows))
    .sort((left, right) => right.rows - left.rows || left.ruleClass.localeCompare(right.ruleClass));
  const book = extras.book ?? emptyReviewBook;
  const promotions = [...(extras.promotions ?? [])];
  return {
    gateId: keeperGateId,
    mode: promotions.length > 0 ? "enforce" : "shadow",
    enforced: promotions.length > 0,
    ledgerPath,
    ...(evidenceVersion !== undefined && { evidenceVersion }),
    rows: current.length,
    earlierRows: gateRows.length - current.length,
    classes,
    ...(current.length > 0 && { gate: classReportOf(ratchet, allClasses, current) }),
    auditRate: keeperAuditRate,
    calibration: classes.flatMap(({ ruleClass }) =>
      calibrationOf(
        ratchet,
        ruleClass,
        sinceLastDemotion(groups.get(ruleClass) ?? [], ruleClass, extras.demotions ?? []),
        book,
      ),
    ),
    promotions,
    pendingReviews: pendingReviews(book).length,
  };
}

export function classReportOf(
  ratchet: GradingRatchet,
  ruleClass: string,
  rows: readonly DecisionRecord[],
): ClassReport {
  const labelled = rows.filter((row) => row.outcome !== undefined);
  const newest = rows.filter(answeredByOracle).at(-1);
  const model = newest === undefined ? undefined : modelOfRow(newest);
  const scored = labelled.filter(answeredByOracle).map((row) => ({
    confidence: row.confidence,
    correct: row.outcome?.correct === true,
  }));
  const acts = rows.filter((row) => row.soft === "act");
  const grade = ratchet.gradeOf(rows, { plan: keeperPlan });
  return {
    ruleClass,
    ...(model !== undefined && { model }),
    rows: rows.length,
    labelled: labelled.length,
    answered: scored.length,
    ...(scored.length > 0 && {
      agreement: scored.filter((item) => item.correct).length / scored.length,
      brier: brier(scored),
    }),
    wouldAct: acts.length,
    wrongActs: acts.filter((row) => row.outcome?.truth === false).length,
    oneWayDoor: isOneWayDoorClass(ruleClass),
    grade,
    gradeWord: ratchet.gradeWord(grade),
    gradeText: ratchet.describeGrade(grade),
  };
}

export function ruleClassOfRow(row: DecisionRecord): string {
  const tag = row.tags.find((candidate) => candidate.startsWith(classTagPrefix));
  if (tag !== undefined) return tag.slice(classTagPrefix.length);
  return row.tags.includes(oneWayDoorTag) ? oneWayDoorClass : "unclassified";
}

function byRuleClass(rows: readonly DecisionRecord[]): Map<string, DecisionRecord[]> {
  const groups = new Map<string, DecisionRecord[]>();
  for (const row of rows) {
    const ruleClass = ruleClassOfRow(row);
    groups.set(ruleClass, [...(groups.get(ruleClass) ?? []), row]);
  }
  return groups;
}

export function reviewsAmong(book: ReviewBook, rows: readonly DecisionRecord[]): ReviewBook {
  const ids = new Set(rows.map((row) => row.id));
  return {
    draws: book.draws.filter((draw) => ids.has(draw.recordId)),
    answers: book.answers.filter((answer) => ids.has(answer.recordId)),
  };
}

async function readRows(
  ratchet: Pick<Ratchet, "parseJsonlLedger">,
  ledgerPath: string,
): Promise<DecisionRecord[]> {
  const text = await readFile(ledgerPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return ratchet.parseJsonlLedger(text);
}
