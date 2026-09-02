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

export function gaugeStyleFor(instruments: InstrumentTier, focused: boolean): GaugeStyle {
  if (instruments === "cockpit") return "bar";
  return focused ? "steps" : "tile";
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
      return `${twinTile(reading, options.glyphs)} ${formatTokenCount(reading.used)}`;
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
const tileLadder = ["⡀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿", "█"] as const;

function stepsGauge(
  reading: ContextReading,
  ramp: readonly string[],
  glyphs: GlyphSupport,
): string {
  const empty = resolveMark(emptyStepMark, glyphs);
  const bounds = [0, reading.flushAt / 2, reading.flushAt, reading.compactAt];
  return bounds.map((from, zone) => (reading.used > from ? (ramp[zone] ?? "#") : empty)).join("");
}

function twinTile(reading: ContextReading, glyphs: GlyphSupport): string {
  if (glyphs.glyphTier < 2) return stopGlyph(reading, resolveRamp(tile.fill, glyphs));
  const steps = tileLadder.length * 2;
  const lit = Math.max(1, Math.min(steps, Math.ceil((reading.used / reading.window) * steps)));
  const first = tileLadder[Math.min(tileLadder.length, lit) - 1] ?? "█";
  const second = lit <= tileLadder.length ? "·" : (tileLadder[lit - tileLadder.length - 1] ?? "█");
  return `${first}${second}`;
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
