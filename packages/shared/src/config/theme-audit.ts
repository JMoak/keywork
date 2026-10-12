import {
  type ContrastMeasurement,
  contrastFailures,
  contrastMeasurements,
  type MeasuredLayer,
  type Theme,
} from "./theme.ts";

export interface ThemeAudit {
  readonly theme: string;
  readonly minMarginLc: number;
  readonly sectionMarginLc: number;
  readonly failures: readonly string[];
}

export function auditTheme(theme: Theme): ThemeAudit {
  const measurements = contrastMeasurements(theme);
  return {
    theme: theme.name,
    minMarginLc: smallestMargin(measurements, "tokens"),
    sectionMarginLc: smallestMargin(measurements, "sections"),
    failures: contrastFailures(theme),
  };
}

function smallestMargin(
  measurements: readonly ContrastMeasurement[],
  layer: MeasuredLayer,
): number {
  const margins = measurements
    .filter((measurement) => measurement.layer === layer)
    .map((measurement) => measurement.lc - measurement.floor);
  return margins.length === 0 ? Number.POSITIVE_INFINITY : tenthsBelow(Math.min(...margins));
}

function tenthsBelow(value: number): number {
  return Math.floor(value * 10) / 10;
}
