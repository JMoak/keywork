import { describe, expect, it } from "vitest";
import { headline } from "./masthead.ts";

const tier = (glyphTier: 0 | 1 | 2) => ({ glyphTier, nerdFont: false });
const cells = (line: string) => Array.from(line).length;

describe("the masthead headline", () => {
  it("sets every word of a short slug in the half-block face", () => {
    const result = headline("auth-retry-fix", { width: 28, rows: 12, glyphs: tier(2) });
    expect(result.face).toBe("half-block");
    expect(result.words).toBe("auth retry fix");
    expect(result.lines).toHaveLength(11);
    expect(result.lines.filter((line) => line === "")).toHaveLength(2);
    expect(result.lines.every((line) => cells(line) <= 28)).toBe(true);
    expect(result.lines.join("")).toMatch(/[▀▄█]/);
  });

  it("renders a known word as a recognizable block bitmap", () => {
    const result = headline("hi", { width: 20, rows: 3, glyphs: tier(2) });
    expect(result.lines).toEqual(["█ █ ▀█▀", "█▀█  █ ", "▀ ▀ ▀▀▀"].map((line) => line.trimEnd()));
  });

  it("keeps the distinctive word when rows allow only one line", () => {
    const result = headline("auth-retry-fix", {
      width: 28,
      rows: 3,
      glyphs: tier(2),
      siblings: ["auth-login-fix"],
    });
    expect(result.words).toBe("retry");
    expect(result.lines).toHaveLength(3);
  });

  it("packs several words on one line when the width allows", () => {
    const result = headline("go-fix", { width: 40, rows: 3, glyphs: tier(2) });
    expect(result.words).toBe("go fix");
    expect(result.lines).toHaveLength(3);
  });

  it("falls to the full-block face at glyph tier 1", () => {
    const result = headline("ok", { width: 20, rows: 5, glyphs: tier(1) });
    expect(result.face).toBe("block");
    expect(result.lines).toHaveLength(5);
    expect(result.lines.join("")).toMatch(/█/);
    expect(result.lines.join("")).not.toMatch(/[▀▄]/);
  });

  it("falls to caps at glyph tier 0 and wraps words across lines", () => {
    const result = headline("auth-retry-fix", { width: 10, rows: 3, glyphs: tier(0) });
    expect(result.face).toBe("caps");
    expect(result.lines).toEqual(["AUTH RETRY", "FIX"]);
  });

  it("uses caps for titles the face cannot set", () => {
    const result = headline("ünïcode-title", { width: 30, rows: 6, glyphs: tier(2) });
    expect(result.face).toBe("caps");
    expect(result.lines).toEqual(["ÜNÏCODE TITLE"]);
  });

  it("sheds the arc prefix and sets the session's own words, separators gone", () => {
    const result = headline("mcp-hardening:sleep-wake", { width: 40, rows: 3, glyphs: tier(0) });
    expect(result.words).toBe("sleep wake");
    expect(result.lines).toEqual(["SLEEP WAKE"]);
  });

  it("falls to caps when any word is wider than the block face allows", () => {
    const result = headline("session-1", { width: 26, rows: 12, glyphs: tier(2) });
    expect(result.face).toBe("caps");
    expect(result.lines).toEqual(["SESSION 1"]);
    expect(headline("session-1", { width: 34, rows: 12, glyphs: tier(2) }).face).toBe("half-block");
  });

  it("ellipsizes a caps word the line cannot hold rather than overflowing", () => {
    const result = headline("implementation", { width: 9, rows: 3, glyphs: tier(2) });
    expect(result.face).toBe("caps");
    expect(result.lines).toEqual(["IMPLEMEN…"]);
  });

  it("never exceeds the frame at any geometry", () => {
    for (const width of [1, 3, 7, 12, 20, 28, 36]) {
      for (const rows of [0, 1, 2, 3, 5, 8, 14]) {
        for (const glyphTier of [0, 1, 2] as const) {
          const result = headline("auth-retry-fix-session", {
            width,
            rows,
            glyphs: tier(glyphTier),
          });
          expect(result.lines.length).toBeLessThanOrEqual(rows);
          expect(result.lines.every((line) => cells(line) <= width)).toBe(true);
        }
      }
    }
  });

  it("yields nothing when there is no room at all", () => {
    expect(headline("auth", { width: 0, rows: 5, glyphs: tier(2) }).lines).toEqual([]);
    expect(headline("auth", { width: 20, rows: 0, glyphs: tier(2) }).lines).toEqual([]);
  });
});
