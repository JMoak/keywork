import { describe, expect, it } from "vitest";
import { keyworkNight, resolvePalette } from "./palette.ts";

describe("resolvePalette", () => {
  it("overrides one token and leaves every other token equal to the palette's", () => {
    const { accent, ...untouched } = resolvePalette({ accent: "#ff00ff" });
    const { accent: night, ...nightUntouched } = keyworkNight;
    expect(accent).toBe("#ff00ff");
    expect(accent).not.toBe(night);
    expect(untouched).toEqual(nightUntouched);
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
