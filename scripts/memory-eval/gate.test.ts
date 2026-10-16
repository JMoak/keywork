import { describe, expect, it } from "vitest";
import { memoryQuestions } from "../../packages/engine/src/index.ts";
import { gateMargins, gateQuestion } from "./gate.ts";
import type { QuestionMeasures, RecallQuality } from "./metrics.ts";

function quality(recall: number, harmfulRate = 0): RecallQuality {
  return {
    relevant: 100,
    kept: 100,
    keptRelevant: Math.round(recall * 100),
    recall,
    precision: 1,
    harmful: { count: Math.round(harmfulRate * 100), rate: harmfulRate, drops: [] },
  };
}

function recallMeasures(overrides: Partial<QuestionMeasures> = {}): QuestionMeasures {
  return {
    question: memoryQuestions.actionRelevance,
    points: 40,
    injection: { injected: 1000, carried: 4000 },
    hindsight: quality(0.9),
    latency: { p50: 1, p95: 2, max: 3 },
    waited: { p50: 1, p95: 2, max: 3 },
    fallbacks: [],
    cost: { inputTokens: 0, usd: 0 },
    ...overrides,
  };
}

const builtin = recallMeasures();
const calibrated = {
  samples: 80,
  rawEce: 0.1,
  ece: 0.03,
  noiseFloor: 0.04,
  bins: [],
  map: [],
};
const passing = recallMeasures({
  injection: { injected: 500, carried: 1500 },
  hindsight: quality(0.89),
  waited: { p50: 5, p95: 30, max: 140 },
  calibration: calibrated,
  cost: { inputTokens: 60_000, usd: 0.00252 },
});

describe("gateQuestion for a recall question", () => {
  it("proves a question that clears all four of its criteria", () => {
    const verdict = gateQuestion(passing, builtin);
    expect(verdict.criteria.map((criterion) => [criterion.number, criterion.passed])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
    ]);
    expect(verdict.proven).toBe(true);
  });

  it("holds each margin exactly as decision 10 states it", () => {
    const atRecallMargin = recallMeasures({
      ...passing,
      hindsight: quality(0.9 - gateMargins.recallGap),
    });
    expect(gateQuestion(atRecallMargin, builtin).criteria[0]?.passed).toBe(true);
    const pastRecallMargin = recallMeasures({ ...passing, hindsight: quality(0.87) });
    expect(gateQuestion(pastRecallMargin, builtin).criteria[0]?.passed).toBe(false);
    const harmfulAtTwoPercent = recallMeasures({ ...passing, hindsight: quality(0.9, 0.02) });
    expect(gateQuestion(harmfulAtTwoPercent, builtin).criteria[0]?.passed).toBe(false);
    const tokensAtSixtyPercent = recallMeasures({
      ...passing,
      injection: { injected: 600, carried: 0 },
    });
    expect(gateQuestion(tokensAtSixtyPercent, builtin).criteria[1]?.passed).toBe(true);
    const tokensPastSixtyPercent = recallMeasures({
      ...passing,
      injection: { injected: 601, carried: 0 },
    });
    expect(gateQuestion(tokensPastSixtyPercent, builtin).criteria[1]?.passed).toBe(false);
    const waitAtFifty = recallMeasures({ ...passing, waited: { p50: 1, p95: 50, max: 50 } });
    expect(gateQuestion(waitAtFifty, builtin).criteria[2]?.passed).toBe(false);
    const eceAtFiveHundredths = recallMeasures({
      ...passing,
      calibration: { ...calibrated, ece: 0.05 },
    });
    expect(gateQuestion(eceAtFiveHundredths, builtin).criteria[3]?.passed).toBe(false);
  });

  it("refuses a decider that states no odds, and says why", () => {
    const { calibration: _, ...uncalibrated } = passing;
    const verdict = gateQuestion(uncalibrated, builtin);
    expect(verdict.proven).toBe(false);
    expect(verdict.criteria[3]?.detail).toBe("states no labeled probabilities to calibrate");
  });

  it("refuses a question with nothing relevant labeled or nothing held out", () => {
    const unlabeled = recallMeasures({
      ...passing,
      hindsight: { ...quality(0), recall: undefined },
    });
    expect(gateQuestion(unlabeled, builtin).criteria[0]).toMatchObject({
      passed: false,
      detail: "no relevant notes are labeled on the held-out half",
    });
    expect(gateQuestion(recallMeasures({ ...passing, points: 0 }), builtin).proven).toBe(false);
  });

  it("gates on judge-rated quality when the corpus has judge labels", () => {
    const judgedWorse = recallMeasures({ ...passing, judged: quality(0.5) });
    expect(gateQuestion(judgedWorse, recallMeasures({ judged: quality(0.9) })).proven).toBe(false);
  });

  it("explains each criterion in numbers", () => {
    expect(gateQuestion(passing, builtin).criteria.map((criterion) => criterion.detail)).toEqual([
      "recall 0.89 against the builtin's 0.90; 0 harmful drops of 100 relevant notes (0.0%)",
      "injects 500 tokens, 50.0% of the builtin's 1000",
      "wait p95 30 ms",
      "ECE 0.030 over 80 samples (noise floor 0.040)",
    ]);
  });
});

describe("gateQuestion for a curation question", () => {
  const curation = (overrides: Partial<QuestionMeasures>): QuestionMeasures => ({
    question: memoryQuestions.pairRelation,
    points: 12,
    agreement: { labeled: 10, agreed: 8, rate: 0.8 },
    latency: { p50: 200, p95: 400, max: 500 },
    fallbacks: [],
    calibration: calibrated,
    cost: { inputTokens: 10_000, usd: 0.00042 },
    ...overrides,
  });

  it("asks for spend, calibration and agreement, never the hot-path wait", () => {
    const chatModel = curation({
      agreement: { labeled: 10, agreed: 7, rate: 0.7 },
      cost: { inputTokens: 0, usd: 0.01 },
    });
    const verdict = gateQuestion(curation({}), chatModel);
    expect(verdict.criteria.map((criterion) => criterion.number)).toEqual([2, 4, 5]);
    expect(verdict.proven).toBe(true);
  });

  it("cannot beat a builtin that spent nothing", () => {
    const networkFree = curation({
      agreement: { labeled: 10, agreed: 0, rate: 0 },
      cost: { inputTokens: 0, usd: 0 },
    });
    const verdict = gateQuestion(curation({}), networkFree);
    expect(verdict.criteria[0]).toMatchObject({
      passed: false,
      detail: "spends $0.000420 where the builtin, with no chat model wired, spent nothing",
    });
    expect(verdict.proven).toBe(false);
  });

  it("refuses agreement below the builtin's or with no verdicts to agree with", () => {
    const better = curation({
      agreement: { labeled: 10, agreed: 9, rate: 0.9 },
      cost: { inputTokens: 0, usd: 1 },
    });
    expect(gateQuestion(curation({}), better).criteria[2]?.passed).toBe(false);
    const unlabeled = curation({ agreement: { labeled: 0, agreed: 0, rate: undefined } });
    expect(gateQuestion(unlabeled, better).criteria[2]?.detail).toBe(
      "no labeled verdicts on the held-out half",
    );
  });
});
