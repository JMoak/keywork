import { describe, expect, it } from "vitest";
import {
  applyCalibration,
  eceNoiseFloor,
  expectedCalibrationError,
  fitIsotonic,
  type ProbabilitySample,
  reliabilityBins,
  seededRandom,
} from "./calibration.ts";

function samplesAt(probability: number, positives: number, total: number): ProbabilitySample[] {
  return Array.from({ length: total }, (_, index) => ({ probability, outcome: index < positives }));
}

describe("expectedCalibrationError", () => {
  it("is zero when every bin's frequency matches its stated probability", () => {
    const samples = [...samplesAt(0.8, 80, 100), ...samplesAt(0.25, 25, 100)];
    expect(expectedCalibrationError(samples)).toBeCloseTo(0, 10);
  });

  it("weights each bin's gap by its share of the samples", () => {
    const overconfident = samplesAt(0.95, 50, 50);
    const honest = samplesAt(0.15, 15, 100);
    const samples = [
      ...overconfident.map((sample, index) => ({ ...sample, outcome: index < 25 })),
      ...honest,
    ];
    expect(expectedCalibrationError(samples)).toBeCloseTo((50 / 150) * 0.45, 10);
  });

  it("reads the textbook overconfident model: 0.9 stated, 0.5 observed, ECE 0.4", () => {
    expect(expectedCalibrationError(samplesAt(0.9, 5, 10))).toBeCloseTo(0.4, 10);
  });

  it("is zero over no samples", () => {
    expect(expectedCalibrationError([])).toBe(0);
  });
});

describe("reliabilityBins", () => {
  it("bins by tenths and keeps only the bins that hold samples, 1.0 in the top bin", () => {
    const bins = reliabilityBins([
      { probability: 0.05, outcome: false },
      { probability: 0.91, outcome: true },
      { probability: 1, outcome: true },
    ]);
    expect(bins).toEqual([
      { from: 0, to: 0.1, count: 1, meanProbability: 0.05, frequency: 0 },
      { from: 0.9, to: 1, count: 2, meanProbability: expect.closeTo(0.955, 10), frequency: 1 },
    ]);
  });
});

describe("fitIsotonic", () => {
  it("pools adjacent violators into a non-decreasing step map", () => {
    const map = fitIsotonic([
      { probability: 0.2, outcome: true },
      { probability: 0.4, outcome: false },
      { probability: 0.6, outcome: true },
      { probability: 0.8, outcome: true },
    ]);
    expect(map).toEqual([
      { upTo: 0.4, calibrated: 0.5 },
      { upTo: 0.6, calibrated: 1 },
      { upTo: 0.8, calibrated: 1 },
    ]);
    const steps = map.map((step) => step.calibrated);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it("pools tied probabilities before fitting", () => {
    expect(fitIsotonic([...samplesAt(0.7, 3, 4)])).toEqual([{ upTo: 0.7, calibrated: 0.75 }]);
  });

  it("brings an overconfident decider back to its observed frequency", () => {
    const fit = [...samplesAt(0.9, 5, 10), ...samplesAt(0.1, 1, 10)];
    const map = fitIsotonic(fit);
    const calibrated = fit.map((sample) => ({
      ...sample,
      probability: applyCalibration(map, sample.probability),
    }));
    expect(expectedCalibrationError(fit)).toBeCloseTo(0.4 / 2, 10);
    expect(expectedCalibrationError(calibrated)).toBeCloseTo(0, 10);
  });
});

describe("applyCalibration", () => {
  const map = [
    { upTo: 0.3, calibrated: 0.1 },
    { upTo: 0.7, calibrated: 0.5 },
  ];

  it("maps through the first step that covers the probability and clamps past the last", () => {
    expect(applyCalibration(map, 0.2)).toBe(0.1);
    expect(applyCalibration(map, 0.3)).toBe(0.1);
    expect(applyCalibration(map, 0.31)).toBe(0.5);
    expect(applyCalibration(map, 0.99)).toBe(0.5);
  });

  it("is the identity with no map fitted", () => {
    expect(applyCalibration([], 0.42)).toBe(0.42);
  });
});

describe("eceNoiseFloor", () => {
  it("is reproducible from its seed", () => {
    const probabilities = [0.1, 0.4, 0.6, 0.9, 0.95, 0.3];
    expect(eceNoiseFloor(probabilities)).toBe(eceNoiseFloor(probabilities));
    expect(eceNoiseFloor(probabilities, { seed: 7 })).not.toBe(eceNoiseFloor(probabilities));
  });

  it("shrinks as the sample grows, because a calibrated decider's ECE is sampling noise", () => {
    const small = Array.from({ length: 20 }, (_, index) => (index % 10) / 10 + 0.05);
    const large = Array.from({ length: 2000 }, (_, index) => (index % 10) / 10 + 0.05);
    const smallFloor = eceNoiseFloor(small);
    const largeFloor = eceNoiseFloor(large);
    expect(largeFloor).toBeLessThan(smallFloor);
    expect(largeFloor).toBeLessThan(0.05);
  });

  it("is zero over no probabilities", () => {
    expect(eceNoiseFloor([])).toBe(0);
  });
});

describe("seededRandom", () => {
  it("replays the same uniform stream for the same seed", () => {
    const first = seededRandom(1015);
    const second = seededRandom(1015);
    const draws = Array.from({ length: 5 }, () => first());
    expect(Array.from({ length: 5 }, () => second())).toEqual(draws);
    expect(draws.every((draw) => draw >= 0 && draw < 1)).toBe(true);
  });
});
