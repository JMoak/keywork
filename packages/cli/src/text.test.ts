import { describe, expect, it } from "vitest";
import { clip, firstLine } from "./text.ts";

describe("text clipping", () => {
  it("clips over the limit with an ellipsis and leaves short text alone", () => {
    expect(clip("abcdef", 4)).toBe("abcd…");
    expect(clip("abcd", 4)).toBe("abcd");
  });

  it("firstLine keeps only the first line", () => {
    expect(firstLine("head\nbody", 80)).toBe("head");
    expect(firstLine("", 80)).toBe("");
    expect(firstLine("a long head", 6)).toBe("a long…");
  });
});
