import { describe, expect, it } from "vitest";
import { applyMasks, defaultMasks, diffFrames, type MaskRule } from "./mask.ts";

const mask = (text: string) => applyMasks(text, defaultMasks);

describe("applyMasks", () => {
  it("returns the input untouched when no rule matches", () => {
    expect(mask("│ session tree │")).toBe("│ session tree │");
  });

  it("masks epoch-millisecond ids, padded to the original length", () => {
    expect(mask("id 1786408428061 done")).toBe("id <EPOCH-MS>··· done");
  });

  it("masks session file stems before their epoch prefix can match", () => {
    const masked = mask("1786408428061-0004-17208.jsonl");
    expect(masked).toBe("<SESSION>···············.jsonl");
    expect(masked).not.toContain("<EPOCH-MS>");
  });

  it("masks dates", () => {
    expect(mask("saved 2026-08-15 ok")).toBe("saved <DATE>···· ok");
  });

  it("masks clock times with and without seconds", () => {
    expect(mask("at 12:34:56")).toBe("at <TIME>··");
    expect(mask("at 09:41 sharp")).toBe("at <TIME sharp");
  });

  it("masks relative ages", () => {
    expect(mask("edited 3m ago")).toBe("edited <AGE>·");
    expect(mask("edited 2h ago")).toBe("edited <AGE>·");
    expect(mask("took 5s total")).toBe("took <A total");
  });

  it("preserves the length of a realistic frame line", () => {
    const line = "│ 2026-08-15 12:34 1786408428061-0004-17208 3m ago │";
    const masked = mask(line);
    expect(masked.length).toBe(line.length);
    expect(masked).toContain("<DATE>");
    expect(masked).toContain("<SESSION>");
    expect(masked).toContain("<AGE>");
    expect(masked).not.toMatch(/\d/);
  });

  it("leaves digits embedded in identifiers alone", () => {
    expect(mask("pane 12 of 34 v1.2.3")).toBe("pane 12 of 34 v1.2.3");
  });

  it("applies custom rules with the same padding behavior", () => {
    const rules: readonly MaskRule[] = [{ pattern: /world/g, replacement: "<W>" }];
    expect(applyMasks("hello world", rules)).toBe("hello <W>··");
  });

  it("masks every occurrence, not just the first", () => {
    expect(mask("12:34 and 23:45")).toBe("<TIME and <TIME");
  });
});

describe("diffFrames", () => {
  it("returns undefined for identical frames", () => {
    expect(diffFrames("a\nb\nc", "a\nb\nc")).toBeUndefined();
  });

  it("reports the line, both variants, and a caret at the first differing column", () => {
    const diff = diffFrames("abc\ndef", "abc\ndXf");
    expect(diff).toBeDefined();
    const lines = (diff ?? "").split("\n");
    expect(lines[0]).toBe("line 2, col 2");
    expect(lines[1]).toBe("  expected: def");
    expect(lines[2]).toBe("  actual:   dXf");
    expect(lines[3]).toBe(`${" ".repeat("  expected: ".length + 1)}^`);
  });

  it("marks missing lines when frames have different heights", () => {
    const diff = diffFrames("a", "a\nb");
    expect(diff).toContain("line 2, col 1");
    expect(diff).toContain("  expected: (missing)");
    expect(diff).toContain("  actual:   b");
  });

  it("points at the first extra character when one line is a prefix of the other", () => {
    const diff = diffFrames("ab", "abc");
    expect(diff).toContain("line 1, col 3");
  });

  it("reports every mismatching line", () => {
    const diff = diffFrames("a\nb\nc", "a\nX\nY") ?? "";
    expect(diff).toContain("line 2, col 1");
    expect(diff).toContain("line 3, col 1");
  });
});
