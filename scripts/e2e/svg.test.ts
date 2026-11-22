import { describe, expect, it } from "vitest";
import type { CapturedFrame, FrameColor, FrameSpan } from "./frame.ts";
import { frameToSvg } from "./svg.ts";

const color = (r: number, g: number, b: number, a = 1): FrameColor => ({ r, g, b, a });
const white = color(1, 1, 1);
const black = color(0, 0, 0);

const span = (text: string, overrides: Partial<FrameSpan> = {}): FrameSpan => ({
  text,
  fg: white,
  bg: black,
  attributes: 0,
  width: text.length,
  ...overrides,
});

const frameOf = (rows: FrameSpan[][]): CapturedFrame => ({
  cols: Math.max(...rows.map((spans) => spans.reduce((cells, s) => cells + s.width, 0))),
  rows: rows.length,
  lines: rows.map((spans) => ({ spans })),
});

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("frameToSvg", () => {
  it("escapes XML special characters in text", () => {
    const svg = frameToSvg(frameOf([[span('<a & "b">')]]));
    expect(svg).toContain("&lt;a &amp; &quot;b&quot;&gt;");
  });

  it("coalesces adjacent same-style spans into one text run", () => {
    const svg = frameToSvg(frameOf([[span("foo"), span("bar"), span("baz")]]));
    expect(count(svg, "<tspan")).toBe(1);
    expect(svg).toContain('textLength="75.6"');
    expect(svg).toContain(">foobarbaz</tspan>");
  });

  it("trims edge spaces from runs while preserving grid position", () => {
    const svg = frameToSvg(frameOf([[span("  hi  ")]]));
    expect(svg).toContain('<tspan x="16.8" textLength="16.8"');
    expect(svg).toContain(">hi</tspan>");
  });
});
