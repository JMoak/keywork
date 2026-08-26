import { describe, expect, it } from "vitest";
import type { GlyphSupport } from "../capability.ts";
import type { Rect, Screen } from "../geometry.ts";
import {
  anchorOutline,
  fieldOf,
  innerRect,
  onOutline,
  type SeamCell,
  seamCells,
  seamGlyph,
  seamsView,
} from "./seams.ts";

const tier1: GlyphSupport = { glyphTier: 1, nerdFont: false };
const tier0: GlyphSupport = { glyphTier: 0, nerdFont: false };

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function picture(rects: Map<string, Rect>, screen: Screen, glyphs = tier1): string[] {
  const rows = Array.from({ length: screen.height }, () => Array(screen.width).fill(" "));
  for (const cell of seamCells(rects, fieldOf(screen, 0))) {
    (rows[cell.y] as string[])[cell.x] = seamGlyph(cell.joints, glyphs);
  }
  return rows.map((row) => row.join(""));
}

describe("innerRect", () => {
  const screen = rect(0, 0, 10, 6);

  it("gives back a cell on each edge that meets a neighbour", () => {
    expect(innerRect(rect(0, 0, 5, 3), screen)).toEqual(rect(0, 0, 4, 2));
  });

  it("keeps every cell on the screen edge", () => {
    expect(innerRect(rect(5, 3, 5, 3), screen)).toEqual(rect(5, 3, 5, 3));
    expect(innerRect(rect(0, 0, 10, 6), screen)).toEqual(rect(0, 0, 10, 6));
  });
});

describe("seamCells", () => {
  it("draws nothing around a single pane", () => {
    const only = new Map([["a", rect(0, 0, 8, 4)]]);
    expect(seamCells(only, fieldOf({ width: 8, height: 4 }, 0))).toEqual([]);
  });

  it("draws one hairline between two side-by-side panes, running off both edges", () => {
    const pair = new Map([
      ["a", rect(0, 0, 4, 3)],
      ["b", rect(4, 0, 4, 3)],
    ]);
    expect(picture(pair, { width: 8, height: 3 })).toEqual(["   │    ", "   │    ", "   │    "]);
  });

  it("joins a four-way split with a cross and tees nothing else", () => {
    const grid = new Map([
      ["tl", rect(0, 0, 4, 3)],
      ["tr", rect(4, 0, 4, 3)],
      ["bl", rect(0, 3, 4, 3)],
      ["br", rect(4, 3, 4, 3)],
    ]);
    expect(picture(grid, { width: 8, height: 6 })).toEqual([
      "   │    ",
      "   │    ",
      "───┼────",
      "   │    ",
      "   │    ",
      "   │    ",
    ]);
  });

  it("tees into a full-height neighbour and tees left where a stepped seam ends", () => {
    const layout = new Map([
      ["left", rect(0, 0, 4, 6)],
      ["top", rect(4, 0, 6, 2)],
      ["bottom", rect(4, 2, 6, 4)],
    ]);
    expect(picture(layout, { width: 10, height: 6 })).toEqual([
      "   │      ",
      "   ├──────",
      "   │      ",
      "   │      ",
      "   │      ",
      "   │      ",
    ]);
    const stepped = new Map([
      ["a", rect(0, 0, 4, 2)],
      ["b", rect(4, 0, 4, 4)],
      ["c", rect(0, 2, 4, 2)],
    ]);
    expect(picture(stepped, { width: 8, height: 4 })).toEqual([
      "   │    ",
      "───┤    ",
      "   │    ",
      "   │    ",
    ]);
  });

  it("tees upward where a right seam ends on a shared bottom seam", () => {
    const layout = new Map([
      ["a", rect(0, 0, 4, 2)],
      ["b", rect(4, 0, 4, 2)],
      ["wide", rect(0, 2, 8, 2)],
    ]);
    expect(picture(layout, { width: 8, height: 4 })).toEqual([
      "   │    ",
      "───┴────",
      "        ",
      "        ",
    ]);
  });

  it("records who owns each cell and whether it sits on the ring", () => {
    const pair = new Map([
      ["a", rect(0, 0, 4, 2)],
      ["b", rect(4, 0, 4, 2)],
    ]);
    const [first] = seamCells(pair, fieldOf({ width: 8, height: 2 }, 0));
    expect(first?.owner).toBe("a");
    expect(first?.ring).toBe(false);
    const ringed = seamCells(
      new Map([["a", rect(1, 1, 6, 2)]]),
      fieldOf({ width: 8, height: 4 }, 1),
    );
    expect(ringed.every((cell) => cell.ring && cell.owner === undefined)).toBe(true);
  });

  it("degrades to ascii at tier 0", () => {
    const grid = new Map([
      ["tl", rect(0, 0, 3, 2)],
      ["tr", rect(3, 0, 3, 2)],
      ["bl", rect(0, 2, 3, 2)],
      ["br", rect(3, 2, 3, 2)],
    ]);
    expect(picture(grid, { width: 6, height: 4 }, tier0)).toEqual([
      "  |   ",
      "--+---",
      "  |   ",
      "  |   ",
    ]);
  });
});

describe("the outer ring", () => {
  function ringPicture(rects: Map<string, Rect>, screen: Screen, anchored?: Rect): string[] {
    const rows = Array.from({ length: screen.height }, () => Array(screen.width).fill(" "));
    const field = fieldOf(screen, 1);
    const outline = anchored === undefined ? undefined : anchorOutline(anchored, field.field);
    for (const cell of seamCells(rects, field)) {
      const glyph = seamGlyph(cell.joints, tier1);
      const lit = outline !== undefined && onOutline(cell, outline);
      (rows[cell.y] as string[])[cell.x] = lit ? "#" : glyph;
    }
    return rows.map((row) => row.join(""));
  }

  it("frames the whole viewport with rounded corners and joins seams into it", () => {
    const pair = new Map([
      ["a", rect(1, 1, 3, 3)],
      ["b", rect(4, 1, 3, 3)],
    ]);
    expect(ringPicture(pair, { width: 8, height: 5 })).toEqual([
      "╭──┬───╮",
      "│  │   │",
      "│  │   │",
      "│  │   │",
      "╰──┴───╯",
    ]);
  });

  it("lights exactly the focused pane's outline, corners in, nothing past them", () => {
    const grid = new Map([
      ["tl", rect(1, 1, 3, 2)],
      ["tr", rect(4, 1, 3, 2)],
      ["bl", rect(1, 3, 3, 2)],
      ["br", rect(4, 3, 3, 2)],
    ]);
    expect(ringPicture(grid, { width: 8, height: 6 }, rect(1, 1, 3, 2))).toEqual([
      "####───╮",
      "#  #   │",
      "####───┤",
      "│  │   │",
      "│  │   │",
      "╰──┴───╯",
    ]);
    expect(ringPicture(grid, { width: 8, height: 6 }, rect(4, 3, 3, 2))).toEqual([
      "╭──┬───╮",
      "│  │   │",
      "├──#####",
      "│  #   #",
      "│  #   #",
      "╰──#####",
    ]);
  });
});

describe("seamsView", () => {
  function runsOf(
    view: unknown,
  ): Array<{ left: number; top: number; content: string; fg: string }> {
    const children = (view as { children?: Array<{ props: Record<string, unknown> }> }).children;
    return (children ?? []).map(({ props }) => ({
      left: props.left as number,
      top: props.top as number,
      content: props.content as string,
      fg: props.fg as string,
    }));
  }

  it("merges same-ink neighbours on a row into one run and splits at ink changes", () => {
    const grid = new Map([
      ["tl", rect(0, 0, 3, 2)],
      ["tr", rect(3, 0, 3, 2)],
      ["bl", rect(0, 2, 3, 2)],
      ["br", rect(3, 2, 3, 2)],
    ]);
    const field = fieldOf({ width: 6, height: 4 }, 0);
    const outline = anchorOutline(rect(3, 2, 3, 2), field.field);
    const ink = (cell: SeamCell) => (onOutline(cell, outline) ? "#focus" : "#rest");
    const runs = runsOf(seamsView(seamCells(grid, field), ink, tier1));
    expect(runs).toEqual([
      { left: 2, top: 0, content: "│", fg: "#rest" },
      { left: 0, top: 1, content: "──", fg: "#rest" },
      { left: 2, top: 1, content: "┼───", fg: "#focus" },
      { left: 2, top: 2, content: "│", fg: "#focus" },
      { left: 2, top: 3, content: "│", fg: "#focus" },
    ]);
  });
});
