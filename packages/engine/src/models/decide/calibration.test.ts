import { describe, expect, it } from "vitest";
import { auroc, brier, ece, fitThreshold, reliability, type Scored } from "./calibration.ts";

const scored = (confidence: number, correct: boolean): Scored => ({ confidence, correct });

describe("calibration math", () => {
  it("scores a perfect forecaster zero Brier and zero ECE", () => {
    const perfect = [scored(1, true), scored(0, false), scored(1, true)];
    expect(brier(perfect)).toBe(0);
    expect(ece(perfect)).toBe(0);
  });

  it("charges the squared gap between stated and observed for Brier", () => {
    expect(brier([scored(0.8, true), scored(0.8, false)])).toBeCloseTo((0.04 + 0.64) / 2);
  });

  it("weights each bin's gap by its share of the items for ECE", () => {
    const items = [
      scored(0.95, true),
      scored(0.95, false),
      scored(0.15, false),
      scored(0.15, false),
    ];
    expect(ece(items)).toBeCloseTo(0.5 * Math.abs(0.95 - 0.5) + 0.5 * Math.abs(0.15 - 0));
    expect(
      reliability(items)
        .filter((bin) => bin.n > 0)
        .map((bin) => bin.lo),
    ).toEqual([0.1, 0.9]);
  });

  it("ranks positives above negatives for AUROC, counting ties as half", () => {
    expect(auroc([scored(0.9, true), scored(0.1, false)])).toBe(1);
    expect(auroc([scored(0.1, true), scored(0.9, false)])).toBe(0);
    expect(auroc([scored(0.5, true), scored(0.5, false)])).toBe(0.5);
    expect(
      auroc([scored(0.9, true), scored(0.6, false), scored(0.4, true), scored(0.2, false)]),
    ).toBe(0.75);
    expect(auroc([scored(0.9, true)])).toBeUndefined();
  });

  it("fits the lowest bar that keeps the target precision with enough support", () => {
    const items = [
      ...Array.from({ length: 20 }, () => scored(0.95, true)),
      scored(0.7, false),
      ...Array.from({ length: 9 }, () => scored(0.7, true)),
      ...Array.from({ length: 10 }, () => scored(0.3, false)),
    ];
    expect(fitThreshold(items, 0.95)).toMatchObject({ threshold: 0.7, n: 30 });
    expect(fitThreshold(items, 0.99)).toMatchObject({ threshold: 0.95, n: 20 });
    expect(fitThreshold(items, 0.99, 25)).toBeUndefined();
  });
});
