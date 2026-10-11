import { describe, expect, it } from "vitest";
import { keyworkNight, resolvePalette } from "./palette.ts";

describe("resolvePalette", () => {
  it("returns the keywork-night defaults untouched", () => {
    expect(resolvePalette()).toEqual(keyworkNight);
    expect(resolvePalette()).not.toBe(keyworkNight);
  });

  it("overrides one token and leaves every other token equal to the palette's", () => {
    const { accent, ...untouched } = resolvePalette({ accent: "#ff00ff" });
    const { accent: night, ...nightUntouched } = keyworkNight;
    expect(accent).toBe("#ff00ff");
    expect(accent).not.toBe(night);
    expect(untouched).toEqual(nightUntouched);
  });

  it("defaults the ramp to Tokyo Night violet, blue, cyan", () => {
    expect(resolvePalette().ramp).toEqual(["#bb9af7", "#7aa2f7", "#7dcfff"]);
  });

  it("starts the default ramp at the flat accent", () => {
    expect(resolvePalette().ramp[0]).toBe(keyworkNight.accent);
  });

  it("applies a ramp override wholesale", () => {
    const theme = resolvePalette({ ramp: ["#112233", "#445566"] });
    expect(theme.ramp).toEqual(["#112233", "#445566"]);
    expect(theme.accent).toBe(keyworkNight.accent);
  });

  it("accepts a one-stop ramp for flat single-accent themes", () => {
    expect(resolvePalette({ ramp: ["#ff00ff"] }).ramp).toEqual(["#ff00ff"]);
  });

  it("holds overrides to the shared theme token schema instead of a second validator", () => {
    expect(() => resolvePalette({ accent: "purple" })).toThrow(/#rrggbb/);
    expect(() => resolvePalette({ ramp: [] })).toThrow(/ramp/);
    expect(() => resolvePalette({ ramp: Array.from({ length: 7 }, () => "#112233") })).toThrow(
      /ramp/,
    );
  });
});
