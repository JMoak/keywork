import { describe, expect, it } from "vitest";
import {
  quadrantMeasure,
  quadrantRasterize,
  quadrantRowsPerLine,
  quadrantSupports,
} from "./quadrant-face.ts";

describe("the quadrant face", () => {
  it("renders a known word at double horizontal resolution", () => {
    expect(quadrantRasterize(["hi"])).toEqual(["▌ ▌▜▘", "▛▀▌▐", "▌ ▌▟▖"]);
  });

  it("measures half the subpixel width, gaps included", () => {
    expect(quadrantMeasure("session")).toBe(20);
    expect(quadrantMeasure("hi")).toBe(5);
    expect(quadrantMeasure("i")).toBe(2);
    expect(quadrantMeasure("")).toBe(0);
  });

  it("keeps rasterized width at the measured cells", () => {
    for (const word of ["session", "auth", "retry", "tiling", "keywork", "0123456789"]) {
      const lines = quadrantRasterize([word]);
      expect(lines).toHaveLength(quadrantRowsPerLine);
      expect(Math.max(...lines.map((line) => line.length))).toBe(quadrantMeasure(word));
    }
  });

  it("joins words at the cell level so every letter carves identically", () => {
    const [alone] = quadrantRasterize(["habit"]);
    const paired = quadrantRasterize(["fold", "habit"])[0] ?? "";
    expect(paired.endsWith(alone ?? "")).toBe(true);
  });

  it("supports the slug alphabet and refuses the rest", () => {
    expect(quadrantSupports("keywork42")).toBe(true);
    expect(quadrantSupports("naïve")).toBe(false);
  });
});
