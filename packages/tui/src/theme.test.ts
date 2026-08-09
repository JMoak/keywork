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
});
