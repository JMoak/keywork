import { contextBudgetFor, readContext } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { contextGauge, contextReadout, gaugeStyleFor } from "./context-gauge.ts";
import { assumedGlyphs } from "./marks.ts";

const budget = contextBudgetFor(8_000);
const tier0 = { glyphTier: 0 as const, nerdFont: false };
const tier1 = { glyphTier: 1 as const, nerdFont: false };

function ramp(used: number, glyphs = assumedGlyphs): string {
  return contextGauge(readContext(used, budget), { style: "ramp", glyphs });
}

function bar(used: number, glyphs = assumedGlyphs): string {
  return contextGauge(readContext(used, budget), { style: "bar", glyphs });
}

describe("contextGauge steps", () => {
  const steps = (used: number, glyphs = assumedGlyphs) =>
    contextGauge(readContext(used, budget), { style: "steps", glyphs });

  it("lights each zone brighter than the one before", () => {
    expect(steps(0)).toBe("");
    expect(steps(1_000)).toBe("░··· 1k");
    expect(steps(3_600)).toBe("░▒·· 3.6k");
    expect(steps(7_100)).toBe("░▒▓· 7.1k");
    expect(steps(7_700)).toBe("░▒▓█ 7.7k");
  });

  it("keeps the rise legible in plain ascii at tier 0", () => {
    expect(steps(7_700, tier0)).toBe(".:+# 7.7k");
  });
});

describe("contextGauge tile", () => {
  const tile = (used: number, glyphs = assumedGlyphs) =>
    contextGauge(readContext(used, budget), { style: "tile", glyphs });

  it("climbs braille dots then fills each cell solid before the next begins", () => {
    expect(tile(0)).toBe("");
    expect(tile(500)).toBe("⣀· 500");
    expect(tile(1_000)).toBe("⣄· 1k");
    expect(tile(4_000)).toBe("█· 4k");
    expect(tile(6_000)).toBe("█⣦ 6k");
    expect(tile(8_000)).toBe("██ 8k");
  });

  it("falls back to the single tile-fill glyph below glyph tier 2", () => {
    expect(tile(4_000, tier1)).toBe("▒ 4k");
    expect(tile(4_000, tier0)).toBe(": 4k");
  });
});

describe("contextGauge bare", () => {
  const bare = (used: number) =>
    contextGauge(readContext(used, budget), { style: "bare", glyphs: assumedGlyphs });

  it("is the ramp cell without the count", () => {
    expect(bare(0)).toBe("");
    expect(bare(1_000)).toBe("░");
    expect(bare(3_600)).toBe("▒");
    expect(bare(7_600)).toBe("█");
  });
});

describe("contextGauge ramp", () => {
  it("is absent until something has been measured", () => {
    expect(ramp(0)).toBe("");
  });

  it("steps through the density ramp at the real marks", () => {
    expect(ramp(1_000)).toBe("░ 1k");
    expect(ramp(3_600)).toBe("▒ 3.6k");
    expect(ramp(7_000)).toBe("▒ 7k");
    expect(ramp(7_200)).toBe("▓ 7.2k");
    expect(ramp(7_600)).toBe("█ 7.6k");
  });

  it("falls to ASCII at tier 0", () => {
    expect(ramp(7_600, tier0)).toBe("# 7.6k");
  });
});

describe("contextGauge bar", () => {
  it("draws the used ink, the free track, and the two marks as cells", () => {
    expect(bar(400)).toBe("█░░░░░░░▒▓ 400/8k");
    expect(bar(4_000)).toBe("█████░░░▒▓ 4k/8k");
    expect(bar(7_000)).toBe("█████████▓ 7k/8k");
    expect(bar(8_000)).toBe("██████████ 8k/8k");
  });

  it("stays honest past the window", () => {
    expect(bar(9_500)).toBe("██████████ 9.5k/8k");
  });

  it("renders the same structure in ASCII", () => {
    expect(bar(4_000, tier0)).toBe("#####...:+ 4k/8k");
  });
});

describe("gaugeStyleFor", () => {
  it("gives the focused pane the rising steps and the unfocused pane the twin tile", () => {
    expect(gaugeStyleFor("calm", true)).toBe("steps");
    expect(gaugeStyleFor("calm", false)).toBe("tile");
  });

  it("keeps the cockpit on the bar regardless of focus", () => {
    expect(gaugeStyleFor("cockpit", true)).toBe("bar");
    expect(gaugeStyleFor("cockpit", false)).toBe("bar");
  });
});

describe("contextReadout", () => {
  it("states the usage, both marks, and the basis of the window", () => {
    expect(contextReadout(readContext(4_000, budget))).toEqual([
      "context 4000 of 8000 tokens · estimated from the conversation text",
      "memory flush at 7000 · compaction at 7334",
      "window declared in keywork.json",
    ]);
  });

  it("says when the window is assumed and how to declare one", () => {
    const lines = contextReadout(readContext(4_000, contextBudgetFor(undefined)));
    expect(lines[2]).toBe(
      "window assumed at 200000 · declare models[…].contextWindow in keywork.json for an honest limit",
    );
  });
});
