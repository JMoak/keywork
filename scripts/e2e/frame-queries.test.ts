import { describe, expect, it } from "vitest";
import { columnOf, paneTitleCount, rowOf } from "./frame-queries.ts";

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
  it("fail loudly when the marker is absent", () => {
    expect(() => rowOf(frame, "session-99")).toThrow('no frame line contains "session-99"');
    expect(() => columnOf(frame, "session-99")).toThrow('no frame line contains "session-99"');
  });
});
