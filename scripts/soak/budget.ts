export interface SoakSample {
  readonly turn: number;
  readonly panes: number;
  readonly rssBytes: number;
  readonly heapBytes: number;
  readonly renderMs: number;
  readonly busesWithListeners: number;
}

export interface SoakResidue {
  readonly busesWithListeners: number;
  readonly fatalGuardListeners: number;
}

export interface SoakThresholds {
  readonly warmupTurns: number;
  readonly heapGrowthRatio: number;
  readonly heapSlackBytes: number;
  readonly rssGrowthRatio: number;
  readonly renderP95Ms: number;
  readonly livePanesCeiling: number;
}

export const defaultThresholds: SoakThresholds = {
  warmupTurns: 50,
  heapGrowthRatio: 1.25,
  heapSlackBytes: 8 * 1024 * 1024,
  rssGrowthRatio: 1.5,
  renderP95Ms: 50,
  livePanesCeiling: 2,
};

export interface SoakVerdict {
  readonly ok: boolean;
  readonly findings: readonly string[];
  readonly baseline: SoakSample | undefined;
  readonly last: SoakSample | undefined;
  readonly renderP95Ms: number;
}

export function judgeSoak(
  samples: readonly SoakSample[],
  residue: SoakResidue,
  thresholds: SoakThresholds = defaultThresholds,
): SoakVerdict {
  const baseline = samples.find((sample) => sample.turn >= thresholds.warmupTurns);
  const last = samples.at(-1);
  const renderP95Ms = percentile(
    samples.map((sample) => sample.renderMs),
    95,
  );
  const findings = [
    ...growthFindings(baseline, last, thresholds),
    ...samples
      .filter((sample) => sample.busesWithListeners > thresholds.livePanesCeiling)
      .map(
        (sample) =>
          `turn ${sample.turn}: ${sample.busesWithListeners} agent buses still have listeners with at most ${thresholds.livePanesCeiling} conversation panes alive`,
      ),
    ...(renderP95Ms > thresholds.renderP95Ms
      ? [`render p95 ${renderP95Ms.toFixed(1)}ms exceeds the ${thresholds.renderP95Ms}ms ceiling`]
      : []),
    ...(residue.busesWithListeners > 0
      ? [`${residue.busesWithListeners} agent buses kept listeners after quit`]
      : []),
    ...(residue.fatalGuardListeners > 0
      ? [`${residue.fatalGuardListeners} fatal-guard process listeners survived quit`]
      : []),
  ];
  return { ok: findings.length === 0, findings, baseline, last, renderP95Ms };
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? 0;
}

export function formatReport(verdict: SoakVerdict, samples: readonly SoakSample[]): string {
  const header = `${"turn".padStart(6)} ${"panes".padStart(5)} ${"rss MB".padStart(8)} ${"heap MB".padStart(8)} ${"render ms".padStart(10)} ${"buses".padStart(5)}`;
  const rows = samples.map(
    (sample) =>
      `${String(sample.turn).padStart(6)} ${String(sample.panes).padStart(5)} ${megabytes(sample.rssBytes).padStart(8)} ${megabytes(sample.heapBytes).padStart(8)} ${sample.renderMs.toFixed(1).padStart(10)} ${String(sample.busesWithListeners).padStart(5)}`,
  );
  const summary =
    verdict.baseline === undefined || verdict.last === undefined
      ? "not enough samples past warmup to judge growth"
      : `heap ${megabytes(verdict.baseline.heapBytes)} → ${megabytes(verdict.last.heapBytes)} MB · rss ${megabytes(verdict.baseline.rssBytes)} → ${megabytes(verdict.last.rssBytes)} MB · render p95 ${verdict.renderP95Ms.toFixed(1)} ms`;
  const outcome = verdict.ok
    ? "soak ok"
    : `soak failed:\n${verdict.findings.map((finding) => `  - ${finding}`).join("\n")}`;
  return [header, ...rows, "", summary, outcome].join("\n");
}

function growthFindings(
  baseline: SoakSample | undefined,
  last: SoakSample | undefined,
  thresholds: SoakThresholds,
): string[] {
  if (baseline === undefined || last === undefined || baseline === last) return [];
  const heapCeiling = baseline.heapBytes * thresholds.heapGrowthRatio + thresholds.heapSlackBytes;
  const rssCeiling = baseline.rssBytes * thresholds.rssGrowthRatio;
  return [
    ...(last.heapBytes > heapCeiling
      ? [
          `heap grew from ${megabytes(baseline.heapBytes)} MB at turn ${baseline.turn} to ${megabytes(last.heapBytes)} MB at turn ${last.turn} (ceiling ${megabytes(heapCeiling)} MB)`,
        ]
      : []),
    ...(last.rssBytes > rssCeiling
      ? [
          `rss grew from ${megabytes(baseline.rssBytes)} MB at turn ${baseline.turn} to ${megabytes(last.rssBytes)} MB at turn ${last.turn} (ceiling ${megabytes(rssCeiling)} MB)`,
        ]
      : []),
  ];
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
