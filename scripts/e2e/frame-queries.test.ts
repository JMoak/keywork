import { describe, expect, it } from "vitest";
import { columnOf, frameLine, occurrences, paneTitleCount, rowOf } from "./frame-queries.ts";

const frame = [
  "╭──────────────────────────────────────────╮",
  "│╭─ session tree ────╮╭─ session-1 ───────╮│",
  "││ ░ no sessions yet ││ › session-2 said hi││",
  "│╰───────────────────╯╰───────────────────╯│",
  "│╭─ ░ session-2 ─────╮╭─ session-12 ──────╮│",
  "│╰───────────────────╯╰───────────────────╯│",
  "╰──────────────────────────────────────────╯",
].join("\n");

describe("paneTitleCount", () => {
  it("counts session pane title rows, with or without a gauge glyph", () => {
    expect(paneTitleCount(frame)).toBe(3);
  });

  it("ignores session names mentioned in transcript text and the tree title", () => {
    expect(paneTitleCount("│ › session-2 said hi │\n│╭─ session tree ─╮│")).toBe(0);
  });
});

describe("rowOf and columnOf", () => {
  it("locate the first line holding a marker", () => {
    expect(rowOf(frame, "session-12")).toBe(4);
    expect(columnOf(frame, "session-12")).toBe(25);
  });

  it("fail loudly when the marker is absent", () => {
    expect(() => rowOf(frame, "session-99")).toThrow('no frame line contains "session-99"');
    expect(() => columnOf(frame, "session-99")).toThrow('no frame line contains "session-99"');
  });
});

describe("frameLine and occurrences", () => {
  it("read one line by index and an empty string past the end", () => {
    expect(frameLine(frame, 0)).toBe("╭──────────────────────────────────────────╮");
    expect(frameLine(frame, 99)).toBe("");
  });

  it("count non-overlapping marker occurrences", () => {
    expect(occurrences(frame, "session-")).toBe(4);
    expect(occurrences("aaaa", "aa")).toBe(2);
  });
});
