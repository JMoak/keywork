import {
  answeredByOracle,
  calibrationOf,
  keeperFitRows,
  type ModelCalibration,
  modelOfRow,
} from "./calibration.ts";
import { isOneWayDoorClass } from "./facts.ts";
import { inLedgerOrder, keeperLedgerPath } from "./files.ts";
import { calibrationSentence, oneWayDoorSentence, percent, preciseShare } from "./format.ts";
import { keeperPlan } from "./gate.ts";
import {
  type DemotedBy,
  type Demotion,
  demotedByThis,
  type Promotion,
  promotionFor,
  readPromotionBook,
  writeDemotion,
  writePromotion,
} from "./promotions.ts";
import { loadRatchet, type Ratchet } from "./ratchet.ts";
import {
  allClasses,
  currentEvidence,
  readKeeperRows,
  reviewsAmong,
  ruleClassOfRow,
  sinceLastDemotion,
} from "./report.ts";
import { readReviewBook } from "./review.ts";

export type PromotionRefusal =
  | "one-way-door"
  | "every-class"
  | "promoted"
  | "unanswered"
  | "uncalibrated"
  | "blind-review";

export type PromoteOutcome =
  | { promoted: true; promotion: Promotion; sentence: string }
  | {
      promoted: false;
      refusal: PromotionRefusal;
      sentence: string;
      calibration?: ModelCalibration;
    };

export type DemoteOutcome =
  | { demoted: true; demotion: Demotion; promotions: Promotion[]; sentence: string }
  | { demoted: false; sentence: string };

export interface PromotionOptions {
  nodeState: string;
  ruleClass: string;
  creature?: string | undefined;
  ratchet?: Ratchet | undefined;
  now?: (() => Date) | undefined;
}

export interface DemotionOptions extends PromotionOptions {
  by?: DemotedBy | undefined;
  reason?: string | undefined;
}

export async function promoteKeeperClass(options: PromotionOptions): Promise<PromoteOutcome> {
  const { ruleClass } = options;
  if (isOneWayDoorClass(ruleClass)) return refused("one-way-door", oneWayDoorRefusal(ruleClass));
  if (ruleClass === allClasses) return refused("every-class", everyClassRefusal);
  const ratchet = options.ratchet ?? (await loadRatchet());
  return inLedgerOrder(keeperLedgerPath(options.nodeState), async () => {
    const book = await readPromotionBook(options.nodeState);
    const promoted = promotionFor(book.active, ruleClass, options.creature);
    if (promoted !== undefined) return refused("promoted", alreadyPromoted(promoted));
    const standing = await standingOf({ ...options, ratchet }, book.demotions);
    if (standing === undefined) return refused("unanswered", noAnswersIn(ruleClass));
    return promotedOn(standing, { ...options, ratchet });
  });
}

export async function demoteKeeperClass(options: DemotionOptions): Promise<DemoteOutcome> {
  return inLedgerOrder(keeperLedgerPath(options.nodeState), () => demoteNow(options));
}

export async function demoteNow(options: DemotionOptions): Promise<DemoteOutcome> {
  const { ruleClass } = options;
  const book = await readPromotionBook(options.nodeState);
  const demotion: Demotion = {
    ruleClass,
    ...(options.creature !== undefined && { creature: options.creature }),
    by: options.by ?? "keeper",
    reason: options.reason ?? "the keeper took it back",
    at: nowOf(options),
  };
  const promotions = demotedByThis(book.active, demotion);
  if (promotions.length === 0) return { demoted: false, sentence: notPromoted(ruleClass) };
  await writeDemotion(options.nodeState, demotion);
  return { demoted: true, demotion, promotions, sentence: demotedSentence(ruleClass) };
}

export function evidenceNeeded(ratchet: Pick<Ratchet, "requiredActs">, ruleClass: string): string {
  const confidence = keeperPlan.confidence ?? 0.95;
  const acts = ratchet.requiredActs(keeperPlan.target, confidence, keeperPlan.maxErrors ?? 0);
  const perSession = keeperPlan.group?.maxPerGroup;
  const sessionCap = perSession === undefined ? "" : `, at most ${perSession} from one session`;
  return (
    `Promoting "${ruleClass}" needs a planned sample the bar was not fitted on: the bar is fitted ` +
    `per model on the first ${keeperFitRows} answers the keeper gave in the class, then the first ` +
    `${acts} distinct calls after them that clear it${sessionCap}, each approved by the keeper ` +
    `with none denied, so that the exact one-sided ${percent(confidence)} lower bound on ` +
    `agreement reaches the promised ${percent(keeperPlan.target)}.`
  );
}

interface Standing {
  calibration: ModelCalibration;
  evidenceVersion: string;
}

async function standingOf(
  options: PromotionOptions & { ratchet: Ratchet },
  demotions: readonly Demotion[],
): Promise<Standing | undefined> {
  const { ratchet, ruleClass } = options;
  const rows = currentEvidence(await readKeeperRows(options)).filter(
    (row) => ruleClassOfRow(row) === ruleClass,
  );
  const newest = rows.filter(answeredByOracle).at(-1);
  if (newest?.evidenceVersion === undefined) return undefined;
  const book = reviewsAmong(await readReviewBook(options.nodeState), rows);
  const calibration = calibrationOf(
    ratchet,
    ruleClass,
    sinceLastDemotion(rows, ruleClass, demotions),
    book,
  ).find((entry) => entry.model === modelOfRow(newest));
  return calibration && { calibration, evidenceVersion: newest.evidenceVersion };
}

async function promotedOn(
  { calibration, evidenceVersion }: Standing,
  options: PromotionOptions & { ratchet: Ratchet },
): Promise<PromoteOutcome> {
  const { ruleClass, ratchet } = options;
  if (calibration.state !== "accepted" || calibration.bar === undefined) {
    const today = `Today, for ${calibration.model}: ${calibrationSentence(calibration)}.`;
    return refused("uncalibrated", `${evidenceNeeded(ratchet, ruleClass)} ${today}`, calibration);
  }
  if (calibration.review.deniedAtBar > 0) {
    return refused("blind-review", blindReviewRefusal(calibration), calibration);
  }
  const promotion: Promotion = {
    ruleClass,
    model: calibration.model,
    evidenceVersion,
    bar: calibration.bar,
    ...(options.creature !== undefined && { creature: options.creature }),
    sampleSize: calibration.acts,
    errors: calibration.errors ?? 0,
    lowerBound: calibration.lowerBound ?? 0,
    by: "keeper",
    at: nowOf(options),
  };
  await writePromotion(options.nodeState, promotion);
  return { promoted: true, promotion, sentence: promotedSentence(promotion) };
}

function refused(
  refusal: PromotionRefusal,
  sentence: string,
  calibration?: ModelCalibration,
): PromoteOutcome {
  return { promoted: false, refusal, sentence, ...(calibration !== undefined && { calibration }) };
}

const everyClassRefusal =
  `Promotion takes one rule class by name; "${allClasses}" is the report's total, never a class ` +
  "the keeper can hand over.";

function oneWayDoorRefusal(ruleClass: string): string {
  return `"${ruleClass}" is a one-way door: ${oneWayDoorSentence}.`;
}

function alreadyPromoted(promotion: Promotion): string {
  return (
    `"${promotion.ruleClass}" already decides for you on ${promotion.model} above ` +
    `${promotion.bar.toFixed(2)}, since ${promotion.at}; demote it to hand it back.`
  );
}

function noAnswersIn(ruleClass: string): string {
  return `No answered asks in "${ruleClass}" yet.`;
}

function blindReviewRefusal(calibration: ModelCalibration): string {
  const count = calibration.review.deniedAtBar;
  return (
    `The blind review found ${count} ${count === 1 ? "call" : "calls"} above the bar that the ` +
    `keeper denied on a second look, so "${calibration.ruleClass}" stays with the keeper.`
  );
}

function promotedSentence(promotion: Promotion): string {
  return (
    `"${promotion.ruleClass}" now decides for you on ${promotion.model} above ` +
    `${promotion.bar.toFixed(2)}: ${promotion.sampleSize - promotion.errors} of ` +
    `${promotion.sampleSize} held-out calls approved, exact lower bound ` +
    `${preciseShare(promotion.lowerBound)}. Every decision is still logged and shown as decided ` +
    "for you with one key to overturn it, a blind review still samples the calls, and demote " +
    "hands the class back."
  );
}

function notPromoted(ruleClass: string): string {
  return `"${ruleClass}" is not promoted; every ask in it already waits for the keeper.`;
}

function demotedSentence(ruleClass: string): string {
  return (
    `"${ruleClass}" is back with the keeper: every ask in it waits for an answer again. ` +
    "Promoting it again needs a fresh planned sample after this point."
  );
}

function nowOf(options: { now?: (() => Date) | undefined }): string {
  return (options.now ?? (() => new Date()))().toISOString();
}
