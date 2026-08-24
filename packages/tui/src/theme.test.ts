import { describe, expect, it } from "vitest";
import { keyworkNight, resolveTheme } from "./theme.ts";

describe("resolveTheme", () => {
  it("returns the keywork-night defaults untouched", () => {
    expect(resolveTheme()).toEqual(keyworkNight);
    expect(resolveTheme()).not.toBe(keyworkNight);
  });

  it("overrides one token and leaves every other token equal to the palette's", () => {
    const { accent, ...untouched } = resolveTheme({ accent: "#ff00ff" });
    const { accent: night, ...nightUntouched } = keyworkNight;
    expect(accent).toBe("#ff00ff");
    expect(accent).not.toBe(night);
    expect(untouched).toEqual(nightUntouched);
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

  it("holds overrides to the shared flavor token schema instead of a second validator", () => {
    expect(() => resolveTheme({ accent: "purple" })).toThrow(/#rrggbb/);
    expect(() => resolveTheme({ ramp: [] })).toThrow(/ramp/);
    expect(() => resolveTheme({ ramp: Array.from({ length: 7 }, () => "#112233") })).toThrow(
      /ramp/,
    );
  });
});
