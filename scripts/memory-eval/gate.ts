import type { MemoryQuestion } from "../../packages/engine/src/index.ts";
import { dollars, fixed, percent, plural } from "./format.ts";
import { isActionQuestion, isHotPathQuestion, type QuestionMeasures } from "./metrics.ts";

export const gateMargins = {
  recallGap: 0.02,
  harmfulDropRate: 0.02,
  tokenShare: 0.6,
  spendShare: 0.2,
  waitedP95Ms: 50,
  ece: 0.05,
} as const;

export interface Criterion {
  number: 1 | 2 | 3 | 4 | 5;
  name: string;
  passed: boolean;
  detail: string;
}

export interface QuestionVerdict {
  question: MemoryQuestion;
  heldOut: number;
  criteria: Criterion[];
  proven: boolean;
}

export function gateQuestion(
  challenger: QuestionMeasures,
  builtin: QuestionMeasures,
): QuestionVerdict {
  const criteria = isActionQuestion(challenger.question)
    ? [
        recallCriterion(challenger, builtin),
        tokenCriterion(challenger, builtin),
        ...(isHotPathQuestion(challenger.question) ? [waitCriterion(challenger)] : []),
        calibrationCriterion(challenger),
      ]
    : [
        spendCriterion(challenger, builtin),
        calibrationCriterion(challenger),
        agreementCriterion(challenger, builtin),
      ];
  return {
    question: challenger.question,
    heldOut: challenger.points,
    criteria,
    proven: challenger.points > 0 && criteria.every((criterion) => criterion.passed),
  };
}

export function passedCount(verdict: QuestionVerdict): number {
  return verdict.criteria.filter((criterion) => criterion.passed).length;
}

function recallCriterion(challenger: QuestionMeasures, builtin: QuestionMeasures): Criterion {
  const ours = challenger.judged ?? challenger.hindsight;
  const theirs = builtin.judged ?? builtin.hindsight;
  const name = "recall within 0.02 of the builtin's, harmful drops under 2% of relevant notes";
  if (ours?.recall === undefined || theirs?.recall === undefined)
    return {
      number: 1,
      name,
      passed: false,
      detail: "no relevant notes are labeled on the held-out half",
    };
  const harmful = ours.harmful ?? { count: 0, rate: 0, drops: [] };
  const closeEnough = theirs.recall - ours.recall <= gateMargins.recallGap + floatSlack;
  const fewDrops = harmful.rate < gateMargins.harmfulDropRate;
  return {
    number: 1,
    name,
    passed: closeEnough && fewDrops,
    detail: `recall ${fixed(ours.recall)} against the builtin's ${fixed(theirs.recall)}; ${plural(harmful.count, "harmful drop")} of ${plural(ours.relevant, "relevant note")} (${percent(harmful.rate)})`,
  };
}

function tokenCriterion(challenger: QuestionMeasures, builtin: QuestionMeasures): Criterion {
  const ours = challenger.injection?.injected ?? 0;
  const theirs = builtin.injection?.injected ?? 0;
  const name = "tokens injected at 60% of the builtin's or less";
  if (theirs === 0)
    return {
      number: 2,
      name,
      passed: ours === 0,
      detail: `injects ${ours} tokens where the builtin injected none`,
    };
  return {
    number: 2,
    name,
    passed: ours <= theirs * gateMargins.tokenShare,
    detail: `injects ${ours} tokens, ${percent(ours / theirs)} of the builtin's ${theirs}`,
  };
}

function spendCriterion(challenger: QuestionMeasures, builtin: QuestionMeasures): Criterion {
  const ours = challenger.cost.usd;
  const theirs = builtin.cost.usd;
  const name = "background spend at 20% of the builtin's or less";
  if (theirs === 0)
    return {
      number: 2,
      name,
      passed: ours === 0,
      detail: `spends ${dollars(ours)} where the builtin, with no chat model wired, spent nothing`,
    };
  return {
    number: 2,
    name,
    passed: ours <= theirs * gateMargins.spendShare,
    detail: `spends ${dollars(ours)}, ${percent(ours / theirs)} of the builtin's ${dollars(theirs)}`,
  };
}

function waitCriterion(challenger: QuestionMeasures): Criterion {
  const p95 = challenger.waited?.p95 ?? 0;
  return {
    number: 3,
    name: "hot-path wait p95 under 50 ms",
    passed: p95 < gateMargins.waitedP95Ms,
    detail: `wait p95 ${p95} ms`,
  };
}

function calibrationCriterion(challenger: QuestionMeasures): Criterion {
  const name = "ECE after the fitted map under 0.05";
  const calibration = challenger.calibration;
  if (calibration === undefined)
    return {
      number: 4,
      name,
      passed: false,
      detail: "states no labeled probabilities to calibrate",
    };
  return {
    number: 4,
    name,
    passed: calibration.ece < gateMargins.ece,
    detail: `ECE ${fixed(calibration.ece, 3)} over ${plural(calibration.samples, "sample")} (noise floor ${fixed(calibration.noiseFloor, 3)})`,
  };
}

function agreementCriterion(challenger: QuestionMeasures, builtin: QuestionMeasures): Criterion {
  const name = "agreement with the person's verdicts at least the builtin's";
  const ours = challenger.agreement;
  const theirs = builtin.agreement;
  if (ours?.rate === undefined)
    return { number: 5, name, passed: false, detail: "no labeled verdicts on the held-out half" };
  const baseline = theirs?.rate ?? 0;
  return {
    number: 5,
    name,
    passed: ours.rate >= baseline,
    detail: `agrees with ${ours.agreed} of ${ours.labeled} verdicts (${fixed(ours.rate)}) against the builtin's ${fixed(baseline)}`,
  };
}

const floatSlack = 1e-9;
