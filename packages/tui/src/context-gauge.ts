import { type ContextReading, formatTokenCount } from "@keywork/engine";
import { density, type GlyphSupport, resolveRamp } from "./capability.ts";

export type GaugeStyle = "ramp" | "bar";

export type InstrumentTier = "calm" | "cockpit";

export interface GaugeOptions {
  readonly style: GaugeStyle;
  readonly glyphs: GlyphSupport;
}

export const barCells = 10;

export function gaugeStyleFor(instruments: InstrumentTier): GaugeStyle {
  return instruments === "cockpit" ? "bar" : "ramp";
}

export function contextGauge(reading: ContextReading, options: GaugeOptions): string {
  if (reading.used === 0) return "";
  const ramp = resolveRamp(density, options.glyphs);
  return options.style === "bar" ? barGauge(reading, ramp) : rampGauge(reading, ramp);
}

export function contextReadout(reading: ContextReading): string[] {
  const basis = reading.declared
    ? "window declared in keywork.json"
    : `window assumed at ${reading.window} · declare models[…].contextWindow in keywork.json for an honest limit`;
  return [
    `context ${reading.used} of ${reading.window} tokens · estimated from the conversation text`,
    `memory flush at ${reading.flushAt} · compaction at ${reading.compactAt}`,
    basis,
  ];
}

function rampGauge(reading: ContextReading, ramp: readonly string[]): string {
  const [light = ".", medium = ":", heavy = "+", full = "#"] = ramp;
  const cell =
    reading.used > reading.compactAt
      ? full
      : reading.used > reading.flushAt
        ? heavy
        : reading.used > reading.flushAt / 2
          ? medium
          : light;
  return `${cell} ${formatTokenCount(reading.used)}`;
}

function barGauge(reading: ContextReading, ramp: readonly string[]): string {
  const [room = ".", flush = ":", compaction = "+", used = "#"] = ramp;
  const cellWidth = reading.window / barCells;
  const usedCells = Math.min(barCells, Math.round(reading.used / cellWidth));
  const cells = Array.from({ length: barCells }, (_, index) => {
    if (index < usedCells) return used;
    const start = index * cellWidth;
    const end = start + cellWidth;
    if (reading.compactAt < end) return compaction;
    if (reading.flushAt < end) return flush;
    return room;
  });
  return `${cells.join("")} ${formatTokenCount(reading.used)}/${formatTokenCount(reading.window)}`;
}
