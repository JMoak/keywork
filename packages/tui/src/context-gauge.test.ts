import { contextBudgetFor, readContext } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { contextGauge, contextReadout, gaugeStyleFor } from "./context-gauge.ts";
import { assumedGlyphs } from "./marks.ts";

const budget = contextBudgetFor(8_000);
const tier0 = { glyphTier: 0 as const, nerdFont: false };

function ramp(used: number, glyphs = assumedGlyphs): string {
  return contextGauge(readContext(used, budget), { style: "ramp", glyphs });
}

function bar(used: number, glyphs = assumedGlyphs): string {
  return contextGauge(readContext(used, budget), { style: "bar", glyphs });
}

describe("contextGauge render candidates", () => {
  const gaugeOf = (style: "bare" | "steps" | "tile", used: number, glyphs = assumedGlyphs) =>
    contextGauge(readContext(used, budget), { style, glyphs });

  it("bare is the ramp cell without the count", () => {
    expect(gaugeOf("bare", 0)).toBe("");
    expect(gaugeOf("bare", 1_000)).toBe("░");
    expect(gaugeOf("bare", 3_600)).toBe("▒");
    expect(gaugeOf("bare", 7_600)).toBe("█");
  });

  it("tile climbs the tile-fill stages at the same honest stops", () => {
    expect(gaugeOf("tile", 0)).toBe("");
    expect(gaugeOf("tile", 1_000)).toBe("▖ 1k");
    expect(gaugeOf("tile", 3_600)).toBe("▌ 3.6k");
    expect(gaugeOf("tile", 7_200)).toBe("▙ 7.2k");
    expect(gaugeOf("tile", 7_600)).toBe("█ 7.6k");
  });

  it("steps brightens segment by segment across the four zones", () => {
    expect(gaugeOf("steps", 0)).toBe("");
    expect(gaugeOf("steps", 1_000)).toMatch(/^[░▒▓█]··· 1k$/);
    expect(gaugeOf("steps", 3_600)).toMatch(/^█[░▒▓█]·· 3\.6k$/);
    expect(gaugeOf("steps", 7_200)).toMatch(/^██[░▒▓█]· 7\.2k$/);
    expect(gaugeOf("steps", 7_600)).toMatch(/^███[░▒▓█] 7\.6k$/);
  });

  it("keeps every candidate at plain ascii on tier 0", () => {
    for (const style of ["bare", "steps", "tile"] as const) {
      expect(gaugeOf(style, 7_600, tier0)).toMatch(/^[.:+#\d/k. ]+$/);
    }
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
  it("keeps calm flavors to a single cell and gives cockpit the bar", () => {
    expect(gaugeStyleFor("calm")).toBe("ramp");
    expect(gaugeStyleFor("cockpit")).toBe("bar");
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
