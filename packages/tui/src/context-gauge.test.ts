import { contextBudgetFor, readContext } from "@keywork/engine";
import { describe, expect, it } from "vitest";
import { contextGauge } from "./context-gauge.ts";
import { assumedGlyphs } from "./marks.ts";

const budget = contextBudgetFor(8_000);
const tier0 = { glyphTier: 0 as const, nerdFont: false };
function ramp(used: number, glyphs = assumedGlyphs): string {
  return contextGauge(readContext(used, budget), { style: "ramp", glyphs });
}

function bar(used: number, glyphs = assumedGlyphs): string {
  return contextGauge(readContext(used, budget), { style: "bar", glyphs });
}

describe("contextGauge steps", () => {
  const steps = (used: number, glyphs = assumedGlyphs) =>
    contextGauge(readContext(used, budget), { style: "steps", glyphs });

  it("keeps the rise legible in plain ascii at tier 0", () => {
    expect(steps(7_700, tier0)).toBe(".:+# context 7.7k");
  });
});

describe("contextGauge ramp", () => {
  it("steps through the density ramp at the real marks", () => {
    expect(ramp(1_000)).toBe("░ context 1k");
    expect(ramp(3_600)).toBe("▒ context 3.6k");
    expect(ramp(7_000)).toBe("▒ context 7k");
    expect(ramp(7_200)).toBe("▓ context 7.2k");
    expect(ramp(7_600)).toBe("█ context 7.6k");
  });
});

describe("contextGauge bar", () => {
  it("draws the used ink, the free track, and the two marks as cells", () => {
    expect(bar(400)).toBe("█░░░░░░░▒▓ context 400 of 8k");
    expect(bar(4_000)).toBe("█████░░░▒▓ context 4k of 8k");
    expect(bar(7_000)).toBe("█████████▓ context 7k of 8k");
    expect(bar(8_000)).toBe("██████████ context 8k of 8k");
  });

  it("stays honest past the window", () => {
    expect(bar(9_500)).toBe("██████████ context 9.5k of 8k");
  });
});
