import { describe, expect, it } from "vitest";
import type { GlyphSupport } from "../capability.ts";
import type { Rect, Screen } from "../geometry.ts";
import {
  anchorOutline,
  fieldOf,
  framedByOutline,
  innerRect,
  onOutline,
  outlineJoints,
  type SeamCell,
  type StrokeWeight,
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

function runsOf(view: unknown): Array<{ left: number; top: number; content: string; fg: string }> {
  const children = (view as { children?: Array<{ props: Record<string, unknown> }> }).children;
  return (children ?? []).map(({ props }) => ({
    left: props.left as number,
    top: props.top as number,
    content: props.content as string,
    fg: props.fg as string,
  }));
}

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

  it("thickens into heavy strokes on request, joining the light seams with mixed tees", () => {
    const pair = new Map([
      ["a", rect(1, 1, 3, 3)],
      ["b", rect(4, 1, 3, 3)],
    ]);
    const heavyRing = (cell: SeamCell): StrokeWeight => (cell.ring ? "heavy" : "light");
    const view = seamsView(
      seamCells(pair, fieldOf({ width: 8, height: 5 }, 1)),
      () => "#",
      tier1,
      heavyRing,
    );
    expect(runsOf(view).map((run) => run.content)).toEqual([
      "┏━━┯━━━┓",
      "┃",
      "│",
      "┃",
      "┃",
      "│",
      "┃",
      "┃",
      "│",
      "┃",
      "┗━━┷━━━┛",
    ]);
    const ascii = seamsView(
      seamCells(pair, fieldOf({ width: 8, height: 5 }, 1)),
      () => "#",
      tier0,
      heavyRing,
    );
    expect(runsOf(ascii).map((run) => run.content)[0]).toBe("+==+===+");
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

describe("the focus outline drawn as a frame", () => {
  const grid = new Map([
    ["tl", rect(1, 1, 3, 2)],
    ["tr", rect(4, 1, 3, 2)],
    ["bl", rect(1, 3, 3, 2)],
    ["br", rect(4, 3, 3, 2)],
  ]);
  const screen = { width: 8, height: 6 };

  function framedPicture(anchored: Rect, glyphs = tier1, navigating = false): string[] {
    const rows = Array.from({ length: screen.height }, () => Array(screen.width).fill(" "));
    const field = fieldOf(screen, 1);
    const outline = anchorOutline(anchored, field.field);
    const cells = framedByOutline(
      seamCells(grid, field),
      outline,
      (cell) => !(navigating && cell.ring),
    );
    const ring = new Set(cells.filter((cell) => cell.ring).map((cell) => `${cell.x},${cell.y}`));
    const ringAt = (x: number, y: number) => ring.has(`${x},${y}`);
    for (const { x, y, joints, ring: onRing } of cells) {
      const heavy =
        navigating && onRing
          ? {
              up: joints.up && ringAt(x, y - 1),
              down: joints.down && ringAt(x, y + 1),
              left: joints.left && ringAt(x - 1, y),
              right: joints.right && ringAt(x + 1, y),
            }
          : undefined;
      (rows[y] as string[])[x] = seamGlyph(joints, glyphs, heavy);
    }
    return rows.map((row) => row.join(""));
  }

  it("closes the outline with its own corners and lets the grid stop flush against it", () => {
    expect(framedPicture(rect(1, 1, 3, 2))).toEqual([
      "╭──╮───╮",
      "│  │   │",
      "╰──╯───┤",
      "│  │   │",
      "│  │   │",
      "╰──┴───╯",
    ]);
    expect(framedPicture(rect(4, 3, 3, 2))).toEqual([
      "╭──┬───╮",
      "│  │   │",
      "├──╭───╮",
      "│  │   │",
      "│  │   │",
      "╰──╰───╯",
    ]);
  });

  it("gives every outline cell only the outline's joints", () => {
    const outline = rect(2, 2, 4, 3);
    const joints = (up: boolean, down: boolean, left: boolean, right: boolean) => ({
      up,
      down,
      left,
      right,
    });
    expect(outlineJoints({ x: 2, y: 2 }, outline)).toEqual(joints(false, true, false, true));
    expect(outlineJoints({ x: 5, y: 4 }, outline)).toEqual(joints(true, false, true, false));
    expect(outlineJoints({ x: 3, y: 2 }, outline)).toEqual(joints(false, false, true, true));
    expect(outlineJoints({ x: 2, y: 3 }, outline)).toEqual(joints(true, true, false, false));
  });

  it("never draws an arm toward a cell that holds no line", () => {
    const field = fieldOf(screen, 1);
    for (const anchored of grid.values()) {
      const outline = anchorOutline(anchored, field.field);
      const cells = framedByOutline(seamCells(grid, field), outline);
      const lined = new Set(cells.map((cell) => `${cell.x},${cell.y}`));
      const onScreen = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < screen.width && y < screen.height;
      for (const { x, y, joints } of cells) {
        if (joints.up && onScreen(x, y - 1)) expect(lined.has(`${x},${y - 1}`)).toBe(true);
        if (joints.down && onScreen(x, y + 1)) expect(lined.has(`${x},${y + 1}`)).toBe(true);
        if (joints.left && onScreen(x - 1, y)) expect(lined.has(`${x - 1},${y}`)).toBe(true);
        if (joints.right && onScreen(x + 1, y)) expect(lined.has(`${x + 1},${y}`)).toBe(true);
      }
    }
  });

  it("lets the armed ring keep its grid joints and heavy stroke where the outline meets it", () => {
    expect(framedPicture(rect(1, 1, 3, 2), tier1, true)).toEqual([
      "┏━━┯━━━┓",
      "┃  │   ┃",
      "┠──╯───┨",
      "┃  │   ┃",
      "┃  │   ┃",
      "┗━━┷━━━┛",
    ]);
  });

  it("degrades to ascii corners and keeps the plus junctions at tier 0", () => {
    expect(framedPicture(rect(1, 1, 3, 2), tier0)).toEqual([
      "+--+---+",
      "|  |   |",
      "+--+---+",
      "|  |   |",
      "|  |   |",
      "+--+---+",
    ]);
  });
});

describe("per-arm stroke weights", () => {
  const arms = (up: boolean, down: boolean, left: boolean, right: boolean) => ({
    up,
    down,
    left,
    right,
  });
  const none = arms(false, false, false, false);

  it("thickens only the arms that carry a heavy line", () => {
    const cross = arms(true, true, true, true);
    expect(seamGlyph(cross, tier1, arms(false, false, true, true))).toBe("┿");
    expect(seamGlyph(cross, tier1, arms(false, false, true, false))).toBe("┽");
    expect(seamGlyph(arms(false, true, true, true), tier1, arms(false, false, true, true))).toBe(
      "┯",
    );
    expect(seamGlyph(arms(false, true, true, true), tier1, arms(false, true, false, false))).toBe(
      "┰",
    );
    expect(seamGlyph(arms(false, false, true, true), tier1, arms(false, false, true, false))).toBe(
      "╾",
    );
    expect(seamGlyph(arms(false, true, false, true), tier1, arms(false, false, false, true))).toBe(
      "┍",
    );
    expect(seamGlyph(arms(false, true, false, true), tier1, none)).toBe("╭");
  });

  it("covers every light and heavy arm combination", () => {
    const bits = [false, true];
    for (const up of bits) {
      for (const down of bits) {
        for (const left of bits) {
          for (const right of bits) {
            for (const heavyMask of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
              const joints = arms(up, down, left, right);
              const heavy = arms(
                up && (heavyMask & 1) !== 0,
                down && (heavyMask & 2) !== 0,
                left && (heavyMask & 4) !== 0,
                right && (heavyMask & 8) !== 0,
              );
              const glyph = seamGlyph(joints, tier1, heavy);
              if (up || down || left || right) {
                expect(glyph, JSON.stringify({ joints, heavy })).not.toBe(" ");
              }
            }
          }
        }
      }
    }
  });
});
