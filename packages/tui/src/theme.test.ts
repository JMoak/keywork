import { describe, expect, it } from "vitest";
import { keyworkNight, resolveTheme } from "./theme.ts";

describe("resolveTheme", () => {
  it("returns the keywork-night defaults untouched", () => {
    expect(resolveTheme()).toEqual(keyworkNight);
    expect(resolveTheme()).not.toBe(keyworkNight);
  });

  it("applies overrides per token", () => {
    const theme = resolveTheme({ accent: "#ff00ff" });
    expect(theme.accent).toBe("#ff00ff");
    expect(theme.border).toBe(keyworkNight.border);
  });

  it("rejects unknown tokens with the token named", () => {
    expect(() => resolveTheme({ acent: "#ff00ff" })).toThrow(/Unknown theme token "acent"/);
  });

  it("rejects malformed colors", () => {
    expect(() => resolveTheme({ accent: "purple" })).toThrow(/#rrggbb/);
  });

  it("defaults the ramp to Tokyo Night violet, blue, cyan", () => {
    expect(resolveTheme().ramp).toEqual(["#bb9af7", "#7aa2f7", "#7dcfff"]);
  });

  it("starts the default ramp at the flat accent", () => {
    expect(resolveTheme().ramp[0]).toBe(keyworkNight.accent);
  });

  it("applies a ramp override wholesale", () => {
    const theme = resolveTheme({ ramp: ["#112233", "#445566"] });
    expect(theme.ramp).toEqual(["#112233", "#445566"]);
    expect(theme.accent).toBe(keyworkNight.accent);
  });

  it("accepts a one-stop ramp for flat single-accent themes", () => {
    expect(resolveTheme({ ramp: ["#ff00ff"] }).ramp).toEqual(["#ff00ff"]);
  });

  it("rejects a ramp that is empty, oversized, or not an array", () => {
    expect(() => resolveTheme({ ramp: [] })).toThrow(/1-6 #rrggbb stops/);
    expect(() => resolveTheme({ ramp: Array.from({ length: 7 }, () => "#112233") })).toThrow(
      /1-6 #rrggbb stops/,
    );
    expect(() => resolveTheme({ ramp: "#112233" })).toThrow(/1-6 #rrggbb stops/);
  });

  it("rejects malformed ramp stops", () => {
    expect(() => resolveTheme({ ramp: ["#112233", "teal"] })).toThrow(/#rrggbb/);
  });

  it("rejects a color token given a stop list", () => {
    expect(() => resolveTheme({ accent: ["#112233"] })).toThrow(/#rrggbb/);
  });
});
