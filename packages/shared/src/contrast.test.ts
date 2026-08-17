import { describe, expect, it } from "vitest";
import { apcaLc } from "./contrast.ts";

describe("apcaLc", () => {
  it("lands near the published APCA extremes", () => {
    expect(apcaLc("#ffffff", "#000000")).toBeGreaterThan(104);
    expect(apcaLc("#ffffff", "#000000")).toBeLessThan(110);
    expect(apcaLc("#000000", "#ffffff")).toBeGreaterThan(102);
    expect(apcaLc("#000000", "#ffffff")).toBeLessThan(108);
  });

  it("reads zero for ink on its own ground", () => {
    expect(apcaLc("#1a1b26", "#1a1b26")).toBe(0);
    expect(apcaLc("#808080", "#808080")).toBe(0);
  });

  it("grows as ink lightens on a dark ground", () => {
    const grays = ["#303030", "#606060", "#909090", "#c0c0c0", "#f0f0f0"];
    const readings = grays.map((gray) => apcaLc(gray, "#1a1b26"));
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeGreaterThan(readings[i - 1] ?? Number.NaN);
    }
  });

  it("clips near-identical pairs to zero instead of tiny noise", () => {
    expect(apcaLc("#1a1b26", "#1c1d28")).toBe(0);
  });

  it("rejects malformed hex", () => {
    expect(() => apcaLc("white", "#000000")).toThrow(/#rrggbb/);
    expect(() => apcaLc("#fff", "#000000")).toThrow(/#rrggbb/);
  });
});
