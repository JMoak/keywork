export interface ProbabilitySample {
  probability: number;
  outcome: boolean;
}

export interface ReliabilityBin {
  from: number;
  to: number;
  count: number;
  meanProbability: number;
  frequency: number;
}

export interface CalibrationStep {
  upTo: number;
  calibrated: number;
}

export type CalibrationMap = readonly CalibrationStep[];

export const reliabilityBinCount = 10;

export function reliabilityBins(
  samples: readonly ProbabilitySample[],
  bins = reliabilityBinCount,
): ReliabilityBin[] {
  const grouped = Array.from({ length: bins }, () => [] as ProbabilitySample[]);
  for (const sample of samples) grouped[binIndex(sample.probability, bins)]?.push(sample);
  return grouped.flatMap((members, index) =>
    members.length === 0
      ? []
      : [
          {
            from: index / bins,
            to: (index + 1) / bins,
            count: members.length,
            meanProbability: mean(members.map((member) => member.probability)),
            frequency: mean(members.map((member) => (member.outcome ? 1 : 0))),
          },
        ],
  );
}

export function expectedCalibrationError(
  samples: readonly ProbabilitySample[],
  bins = reliabilityBinCount,
): number {
  if (samples.length === 0) return 0;
  return reliabilityBins(samples, bins).reduce(
    (total, bin) =>
      total + (bin.count / samples.length) * Math.abs(bin.frequency - bin.meanProbability),
    0,
  );
}

export function fitIsotonic(samples: readonly ProbabilitySample[]): CalibrationMap {
  const pooled: Block[] = [];
  for (const block of tiedBlocks(samples)) {
    let current = block;
    for (
      let previous = pooled.at(-1);
      previous !== undefined && rateOf(previous) > rateOf(current);
      previous = pooled.at(-1)
    ) {
      pooled.pop();
      current = merged(previous, current);
    }
    pooled.push(current);
  }
  return pooled.map((block) => ({ upTo: block.upTo, calibrated: rateOf(block) }));
}

export function applyCalibration(map: CalibrationMap, probability: number): number {
  if (map.length === 0) return probability;
  const step = map.find((candidate) => probability <= candidate.upTo) ?? map.at(-1);
  return step?.calibrated ?? probability;
}

export function eceNoiseFloor(
  probabilities: readonly number[],
  options: { bins?: number; draws?: number; seed?: number } = {},
): number {
  if (probabilities.length === 0) return 0;
  const draws = options.draws ?? noiseFloorDraws;
  const random = seededRandom(options.seed ?? noiseFloorSeed);
  let total = 0;
  for (let draw = 0; draw < draws; draw += 1) {
    const simulated = probabilities.map((probability) => ({
      probability,
      outcome: random() < probability,
    }));
    total += expectedCalibrationError(simulated, options.bins);
  }
  return total / draws;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const noiseFloorDraws = 200;
const noiseFloorSeed = 1015;

interface Block {
  upTo: number;
  positives: number;
  count: number;
}

function tiedBlocks(samples: readonly ProbabilitySample[]): Block[] {
  const byProbability = new Map<number, Block>();
  for (const { probability, outcome } of samples) {
    const block = byProbability.get(probability) ?? { upTo: probability, positives: 0, count: 0 };
    block.positives += outcome ? 1 : 0;
    block.count += 1;
    byProbability.set(probability, block);
  }
  return [...byProbability.values()].sort((a, b) => a.upTo - b.upTo);
}

function rateOf(block: Block): number {
  return block.positives / block.count;
}

function merged(earlier: Block, later: Block): Block {
  return {
    upTo: later.upTo,
    positives: earlier.positives + later.positives,
    count: earlier.count + later.count,
  };
}

function binIndex(probability: number, bins: number): number {
  return Math.min(bins - 1, Math.max(0, Math.floor(probability * bins)));
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
