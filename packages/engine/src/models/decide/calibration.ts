export interface Scored {
  readonly confidence: number;
  readonly correct: boolean;
}

export interface ReliabilityBin {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  readonly meanConfidence: number;
  readonly accuracy: number;
}

export interface CoveragePoint {
  readonly threshold: number;
  readonly coverage: number;
  readonly accuracy: number;
  readonly n: number;
}

export function brier(items: readonly Scored[]): number {
  return mean(items.map((s) => (s.confidence - (s.correct ? 1 : 0)) ** 2));
}

export function reliability(items: readonly Scored[], bins = 10): ReliabilityBin[] {
  const buckets: Scored[][] = Array.from({ length: bins }, () => []);
  for (const s of items) {
    const i = Math.min(bins - 1, Math.floor(clamp(s.confidence, 0, 1) * bins));
    buckets[i]?.push(s);
  }
  return buckets.map((bucket, i) => ({
    lo: i / bins,
    hi: (i + 1) / bins,
    n: bucket.length,
    meanConfidence: mean(bucket.map((s) => s.confidence)),
    accuracy: mean(bucket.map((s) => (s.correct ? 1 : 0))),
  }));
}

export function ece(items: readonly Scored[], bins = 10): number {
  if (items.length === 0) return 0;
  return reliability(items, bins).reduce(
    (sum, bin) => sum + (bin.n / items.length) * Math.abs(bin.meanConfidence - bin.accuracy),
    0,
  );
}

export function auroc(items: readonly Scored[]): number | undefined {
  const positives = items.filter((s) => s.correct).length;
  const negatives = items.length - positives;
  if (positives === 0 || negatives === 0) return undefined;
  const ranks = midRanks(items.map((s) => s.confidence));
  const positiveRankSum = items.reduce((sum, s, i) => sum + (s.correct ? (ranks[i] ?? 0) : 0), 0);
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

export function riskCoverage(items: readonly Scored[]): CoveragePoint[] {
  const sorted = items.slice().sort((a, b) => b.confidence - a.confidence);
  const points: CoveragePoint[] = [];
  let right = 0;
  for (const [i, s] of sorted.entries()) {
    if (s.correct) right++;
    if (sorted[i + 1]?.confidence === s.confidence) continue;
    points.push({
      threshold: s.confidence,
      coverage: (i + 1) / sorted.length,
      accuracy: right / (i + 1),
      n: i + 1,
    });
  }
  return points;
}

export function fitThreshold(
  items: readonly Scored[],
  target: number,
  minSupport = 20,
): CoveragePoint | undefined {
  let best: CoveragePoint | undefined;
  for (const point of riskCoverage(items)) {
    if (point.n >= minSupport && point.accuracy >= target) best = point;
  }
  return best;
}

function midRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks: number[] = new Array(values.length).fill(0);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]?.value === order[start]?.value) end++;
    const rank = (start + end) / 2 + 1;
    for (let k = start; k <= end; k++) ranks[order[k]?.index ?? 0] = rank;
    start = end + 1;
  }
  return ranks;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
