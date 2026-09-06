import { describe, expect, it } from "vitest";
import { strokeMeasure, strokeRasterize, strokeRows, strokeSupports } from "./stroke-face.ts";
import { width } from "./width.ts";

describe("the stroke face", () => {
  it("scales its row count with the brush", () => {
    expect(strokeRows(1)).toBe(4);
    expect(strokeRows(2)).toBe(7);
    expect(strokeRows(3)).toBe(11);
  });

  it("measures words as unit widths times the brush plus one brush per glyph gap", () => {
    expect(strokeMeasure("m", 3)).toBe(15);
    expect(strokeMeasure("moak", 3)).toBe(63);
    expect(strokeMeasure("moak", 1)).toBe(21);
    expect(strokeMeasure("", 2)).toBe(0);
  });

  it("supports letters, digits and hyphens only", () => {
    expect(strokeSupports("auth-retry-2")).toBe(true);
    expect(strokeSupports("naïve")).toBe(false);
  });

  it("arches the M out of stepped half blocks at brush two", () => {
    expect(strokeRasterize(["m"], 2)).toEqual([
      " ▄██▄▄██▄",
      "███▀███▀██",
      "██  ██  ██",
      "██  ██  ██",
      "██  ██  ██",
      "██  ██  ██",
      "██  ██  ██",
    ]);
  });

  it("sets every line of a word inside its measured width", () => {
    for (const scale of [1, 2, 3]) {
      const lines = strokeRasterize(["session", "1"], scale);
      expect(lines).toHaveLength(strokeRows(scale));
      const measured = strokeMeasure("session", scale) + 3 * scale + strokeMeasure("1", scale);
      for (const line of lines) expect(width(line)).toBeLessThanOrEqual(measured);
      expect(lines.some((line) => line.includes("█"))).toBe(true);
    }
  });
});
