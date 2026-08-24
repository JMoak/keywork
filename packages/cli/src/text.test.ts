import { describe, expect, it } from "vitest";
import { clip, compactJson, excerpt, firstLine } from "./text.ts";

describe("text clipping", () => {
  it("clips over the limit with an ellipsis and leaves short text alone", () => {
    expect(clip("abcdef", 4)).toBe("abcd…");
    expect(clip("abcd", 4)).toBe("abcd");
  });

  it("excerpt flattens newlines before clipping", () => {
    expect(excerpt("one\ntwo\nthree", 9)).toBe("one two t…");
    expect(excerpt("one\ntwo", 80)).toBe("one two");
  });

  it("firstLine keeps only the first line", () => {
    expect(firstLine("head\nbody", 80)).toBe("head");
    expect(firstLine("", 80)).toBe("");
    expect(firstLine("a long head", 6)).toBe("a long…");
  });

  it("compactJson renders a value on one line within the limit", () => {
    expect(compactJson({ command: "ls" }, 80)).toBe('{"command":"ls"}');
    expect(compactJson({ command: "x".repeat(100) }, 10)).toBe('{"command"…');
    expect(compactJson(undefined, 80)).toBe("");
  });
});
