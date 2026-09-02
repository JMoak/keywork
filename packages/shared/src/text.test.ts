import { describe, expect, it } from "vitest";
import { countOccurrences, toUnixEol } from "./text.ts";

describe("toUnixEol", () => {
  it("normalizes crlf and leaves bare newlines alone", () => {
    expect(toUnixEol("a\r\nb\nc\r\n")).toBe("a\nb\nc\n");
    expect(toUnixEol("plain")).toBe("plain");
  });
});

describe("countOccurrences", () => {
  it("counts non-overlapping matches", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abcabc", "abc")).toBe(2);
    expect(countOccurrences("abc", "z")).toBe(0);
  });
});
