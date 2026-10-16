import { describe, expect, it } from "vitest";
import { countOccurrences, toUnixEol, utf8Prefix } from "./text.ts";

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

describe("utf8Prefix", () => {
  it("keeps text within the cap whole and cuts longer text back to a character boundary", () => {
    expect(utf8Prefix("short", 8)).toEqual({ text: "short", truncated: false });
    expect(utf8Prefix("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
    expect(utf8Prefix("a€b", 2)).toEqual({ text: "a", truncated: true });
    expect(utf8Prefix("a€b", 4)).toEqual({ text: "a€", truncated: true });
  });
});
