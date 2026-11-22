import { describe, expect, it } from "vitest";
import { apcaLc } from "./contrast.ts";

describe("apcaLc", () => {
  it("lands near the published APCA extremes", () => {
    expect(apcaLc("#ffffff", "#000000")).toBeGreaterThan(104);
    expect(apcaLc("#ffffff", "#000000")).toBeLessThan(110);
    expect(apcaLc("#000000", "#ffffff")).toBeGreaterThan(102);
    expect(apcaLc("#000000", "#ffffff")).toBeLessThan(108);
  });

  it("clips near-identical pairs to zero instead of tiny noise", () => {
    expect(apcaLc("#1a1b26", "#1c1d28")).toBe(0);
  });
});
