import { describe, expect, it } from "vitest";
import { type CapturedFrame, FrameAttributes, type FrameColor, type FrameSpan } from "./frame.ts";
import { frameToSvg } from "./svg.ts";

const color = (r: number, g: number, b: number, a = 1): FrameColor => ({ r, g, b, a });
const white = color(1, 1, 1);
const black = color(0, 0, 0);
const blue = color(0, 0, 1);
const red = color(1, 0, 0);

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
  it("is deterministic for identical frames", () => {
    const build = () => frameOf([[span("hello")], [span("world", { fg: red })]]);
    expect(frameToSvg(build())).toBe(frameToSvg(build()));
  });

  it("derives dimensions from grid size and cell metrics", () => {
    const svg = frameToSvg(frameOf([[span("0123456789")], [span(" ".repeat(10))]]));
    expect(svg).toContain('width="84" height="34"');
    expect(svg).toContain('viewBox="0 0 84 34"');
  });

  it("honors custom metrics and font options", () => {
    const svg = frameToSvg(frameOf([[span("0123456789")]]), {
      fontFamily: "monospace",
      fontSize: 16,
      cellWidth: 10,
      cellHeight: 20,
    });
    expect(svg).toContain('width="100" height="20"');
    expect(svg).toContain('font-family="monospace"');
    expect(svg).toContain('font-size="16"');
  });

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

  it("keeps differently styled spans as separate runs", () => {
    const svg = frameToSvg(frameOf([[span("err", { fg: red }), span("ok")]]));
    expect(count(svg, "<tspan")).toBe(2);
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('fill="#ffffff"');
  });

  it("emits one background rect per run of same-bg cells across fg changes", () => {
    const svg = frameToSvg(
      frameOf([
        [span("A", { fg: red, bg: blue }), span("B", { fg: white, bg: blue }), span("  ")],
        [span("    ")],
      ]),
    );
    expect(count(svg, "<rect")).toBe(2);
    expect(svg).toContain('width="16.8" height="17" fill="#0000ff"');
  });

  it("paints the dominant background as the canvas and elides matching cells", () => {
    const svg = frameToSvg(frameOf([[span("        ", { bg: blue }), span("x", { bg: black })]]));
    expect(svg).toContain('<rect width="100%" height="100%" fill="#0000ff"/>');
    expect(count(svg, 'fill="#000000"')).toBe(1);
  });

  it("emits no elements for space cells on the default background", () => {
    const svg = frameToSvg(frameOf([[span("    ")], [span("    ")]]));
    expect(count(svg, "<rect")).toBe(1);
    expect(svg).not.toContain("<text");
  });

  it("trims edge spaces from runs while preserving grid position", () => {
    const svg = frameToSvg(frameOf([[span("  hi  ")]]));
    expect(svg).toContain('<tspan x="16.8" textLength="16.8"');
    expect(svg).toContain(">hi</tspan>");
  });

  it("converts unit-float colors to hex and rgba", () => {
    const svg = frameToSvg(
      frameOf([[span("x", { fg: color(1, 0.5, 0), bg: color(0, 0, 1, 0.5) }), span("        ")]]),
    );
    expect(svg).toContain('fill="#ff8000"');
    expect(svg).toContain('fill="rgba(0, 0, 255, 0.5)"');
  });

  it("renders bold, dim, italic, and underline attributes", () => {
    const svg = frameToSvg(
      frameOf([
        [
          span("b", { attributes: FrameAttributes.BOLD }),
          span("d", { attributes: FrameAttributes.DIM }),
          span("i", { attributes: FrameAttributes.ITALIC }),
          span("u", { attributes: FrameAttributes.UNDERLINE }),
        ],
      ]),
    );
    expect(svg).toContain('font-weight="bold"');
    expect(svg).toContain('opacity="0.6"');
    expect(svg).toContain('font-style="italic"');
    expect(svg).toContain('text-decoration="underline"');
  });

  it("silently ignores unsupported attribute bits", () => {
    const blink = 1 << 4;
    const svg = frameToSvg(frameOf([[span("a", { attributes: blink }), span("b")]]));
    expect(count(svg, "<tspan")).toBe(1);
    expect(svg).not.toContain("font-weight");
    expect(svg).not.toContain("opacity");
  });

  it("skips text runs with fully transparent foreground", () => {
    const svg = frameToSvg(frameOf([[span("ghost", { fg: color(1, 1, 1, 0) })]]));
    expect(svg).not.toContain("<text");
  });
});
