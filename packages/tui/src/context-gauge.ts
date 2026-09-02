import { type ContextReading, formatTokenCount } from "@keywork/engine";
import type { Flavor } from "@keywork/shared";
import { density, type GlyphSupport, resolveMark, resolveRamp, tile } from "./capability.ts";

export type GaugeStyle = "ramp" | "bar" | "bare" | "steps" | "tile";

export type InstrumentTier = Flavor["instruments"];

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
  switch (options.style) {
    case "bar":
      return barGauge(reading, ramp);
    case "bare":
      return stopGlyph(reading, ramp);
    case "steps":
      return `${stepsGauge(reading, ramp, options.glyphs)} ${formatTokenCount(reading.used)}`;
    case "tile":
      return `${stopGlyph(reading, resolveRamp(tile.fill, options.glyphs))} ${formatTokenCount(reading.used)}`;
    case "ramp":
      return `${stopGlyph(reading, ramp)} ${formatTokenCount(reading.used)}`;
  }
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

function stopGlyph(reading: ContextReading, ramp: readonly string[]): string {
  const [light = ".", medium = ":", heavy = "+", full = "#"] = ramp;
  if (reading.used > reading.compactAt) return full;
  if (reading.used > reading.flushAt) return heavy;
  if (reading.used > reading.flushAt / 2) return medium;
  return light;
}

const emptyStepMark = { tier1: "·", tier0: "." };

function stepsGauge(
  reading: ContextReading,
  ramp: readonly string[],
  glyphs: GlyphSupport,
): string {
  const empty = resolveMark(emptyStepMark, glyphs);
  const bounds = [0, reading.flushAt / 2, reading.flushAt, reading.compactAt, reading.window];
  return Array.from({ length: 4 }, (_, zone) => {
    const from = bounds[zone] ?? 0;
    const to = bounds[zone + 1] ?? from;
    if (reading.used <= from) return empty;
    if (to <= from) return ramp.at(-1) ?? "#";
    const fill = Math.min(1, (reading.used - from) / (to - from));
    return ramp[Math.min(ramp.length - 1, Math.ceil(fill * ramp.length) - 1)] ?? "#";
  }).join("");
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
