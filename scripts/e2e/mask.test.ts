import { describe, expect, it } from "vitest";
import { applyMasks, defaultMasks, diffFrames, type MaskRule } from "./mask.ts";

const mask = (text: string) => applyMasks(text, defaultMasks);

describe("applyMasks", () => {
  it("masks session file stems before their epoch prefix can match", () => {
    const masked = mask("1786408428061-0004-17208.jsonl");
    expect(masked).toBe("<SESSION>···············.jsonl");
    expect(masked).not.toContain("<EPOCH-MS>");
  });

  it("preserves the length of a realistic frame line", () => {
    const line = "│ 2026-08-15 12:34 1786408428061-0004-17208 3m ago │";
    const masked = mask(line);
    expect(masked.length).toBe(line.length);
    expect(masked).toContain("<DATE>");
    expect(masked).toContain("<SESSION>");
    expect(masked).toContain("~");
    expect(masked).not.toMatch(/\d/);
  });

  it("leaves digits embedded in identifiers alone", () => {
    expect(mask("pane 12 of 34 v1.2.3")).toBe("pane 12 of 34 v1.2.3");
  });

  it("refuses a placeholder longer than its match instead of truncating it", () => {
    const rules: readonly MaskRule[] = [{ pattern: /\d+s/g, replacement: "<AGE>" }];
    expect(() => applyMasks("took 5s", rules)).toThrow(/longer than its match/);
  });
});

describe("diffFrames", () => {
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
});
