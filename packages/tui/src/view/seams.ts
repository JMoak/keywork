import { Box, Text } from "@opentui/core";
import type { GlyphSupport } from "../capability.ts";
import { contains, type Rect, type Screen } from "../geometry.ts";

export interface Joints {
  readonly up: boolean;
  readonly down: boolean;
  readonly left: boolean;
  readonly right: boolean;
}

export interface SeamCell {
  readonly x: number;
  readonly y: number;
  readonly joints: Joints;
  readonly owner: string | undefined;
  readonly ring: boolean;
}

export type SeamInk = (cell: SeamCell) => string;

export type StrokeWeight = "light" | "heavy";

export type SeamStroke = (cell: SeamCell) => StrokeWeight;

export function anchorOutline(anchored: Rect, field: Rect): Rect {
  const right =
    rightEdge(anchored) === rightEdge(field) ? rightEdge(field) + 1 : rightEdge(anchored);
  const bottom =
    bottomEdge(anchored) === bottomEdge(field) ? bottomEdge(field) + 1 : bottomEdge(anchored);
  return {
    x: anchored.x - 1,
    y: anchored.y - 1,
    width: right - anchored.x + 2,
    height: bottom - anchored.y + 2,
  };
}

export function onOutline(cell: { x: number; y: number }, outline: Rect): boolean {
  if (!contains(outline, cell.x, cell.y)) return false;
  return (
    cell.x === outline.x ||
    cell.x === rightEdge(outline) ||
    cell.y === outline.y ||
    cell.y === bottomEdge(outline)
  );
}

export function innerRect(rect: Rect, field: Rect): Rect {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width - (hasRightSeam(rect, field) ? 1 : 0),
    height: rect.height - (hasBottomSeam(rect, field) ? 1 : 0),
  };
}

export interface SeamField {
  readonly screen: Screen;
  readonly field: Rect;
}

export function seamCells(rects: ReadonlyMap<string, Rect>, field: SeamField): SeamCell[] {
  const { screen } = field;
  const lines = seamLines(rects, field);
  const cells: SeamCell[] = [];
  for (let y = 0; y < screen.height; y += 1) {
    for (let x = 0; x < screen.width; x += 1) {
      if (!lines.vertical.has(key(x, y)) && !lines.horizontal.has(key(x, y))) continue;
      cells.push({
        x,
        y,
        joints: jointsAt(lines, x, y),
        owner: paneAt(rects, x, y),
        ring: !contains(field.field, x, y),
      });
    }
  }
  return cells;
}

export function fieldOf(screen: Screen, inset: number): SeamField {
  return {
    screen,
    field: {
      x: inset,
      y: inset,
      width: Math.max(0, screen.width - 2 * inset),
      height: Math.max(0, screen.height - 2 * inset),
    },
  };
}

export function seamGlyph(joints: Joints, glyphs: GlyphSupport, heavy: Joints = noJoints): string {
  const shape = shapeOf(joints);
  const heavyAcross = heavy.left || heavy.right;
  const heavyAlong = heavy.up || heavy.down;
  if (glyphs.glyphTier < 1) return asciiGlyph(shape, heavyAcross);
  return weightedGlyphs[shape][weightIndex(heavyAcross, heavyAlong)];
}

export function seamsView(
  cells: readonly SeamCell[],
  ink: SeamInk,
  glyphs: GlyphSupport,
  stroke: SeamStroke = lightStroke,
) {
  return Box(
    { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: seamZIndex },
    ...seamRuns(cells, ink, glyphs, stroke).map((run) =>
      Text({
        position: "absolute",
        left: run.x,
        top: run.y,
        content: run.content,
        fg: run.ink,
      }),
    ),
  );
}

const seamZIndex = 2;
const noJoints: Joints = { up: false, down: false, left: false, right: false };
const lightStroke: SeamStroke = () => "light";

type Shape =
  | "vertical"
  | "horizontal"
  | "cross"
  | "teeRight"
  | "teeLeft"
  | "teeDown"
  | "teeUp"
  | "turnDownRight"
  | "turnDownLeft"
  | "turnUpRight"
  | "turnUpLeft"
  | "stubUp"
  | "stubDown"
  | "stubLeft"
  | "stubRight"
  | "none";

type WeightedGlyphs = readonly [light: string, across: string, along: string, both: string];

const weightedGlyphs: Record<Shape, WeightedGlyphs> = {
  vertical: ["│", "│", "┃", "┃"],
  horizontal: ["─", "━", "─", "━"],
  cross: ["┼", "┿", "╂", "╋"],
  teeRight: ["├", "┝", "┠", "┣"],
  teeLeft: ["┤", "┥", "┨", "┫"],
  teeDown: ["┬", "┯", "┰", "┳"],
  teeUp: ["┴", "┷", "┸", "┻"],
  turnDownRight: ["╭", "┍", "┎", "┏"],
  turnDownLeft: ["╮", "┑", "┒", "┓"],
  turnUpRight: ["╰", "┕", "┖", "┗"],
  turnUpLeft: ["╯", "┙", "┚", "┛"],
  stubUp: ["╵", "╵", "╹", "╹"],
  stubDown: ["╷", "╷", "╻", "╻"],
  stubLeft: ["╴", "╸", "╴", "╸"],
  stubRight: ["╶", "╺", "╶", "╺"],
  none: [" ", " ", " ", " "],
};

const asciiGlyphs: Record<Shape, string> = {
  vertical: "|",
  horizontal: "-",
  cross: "+",
  teeRight: "+",
  teeLeft: "+",
  teeDown: "+",
  teeUp: "+",
  turnDownRight: "+",
  turnDownLeft: "+",
  turnUpRight: "+",
  turnUpLeft: "+",
  stubUp: "|",
  stubDown: "|",
  stubLeft: "-",
  stubRight: "-",
  none: " ",
};

const asciiHeavyAcross: Partial<Record<Shape, string>> = {
  horizontal: "=",
  stubLeft: "=",
  stubRight: "=",
};

function weightIndex(across: boolean, along: boolean): 0 | 1 | 2 | 3 {
  return across && along ? 3 : along ? 2 : across ? 1 : 0;
}

function asciiGlyph(shape: Shape, heavyAcross: boolean): string {
  return (heavyAcross ? asciiHeavyAcross[shape] : undefined) ?? asciiGlyphs[shape];
}

function shapeOf({ up, down, left, right }: Joints): Shape {
  if (up && down) {
    if (left && right) return "cross";
    if (right) return "teeRight";
    if (left) return "teeLeft";
    return "vertical";
  }
  if (left && right) {
    if (down) return "teeDown";
    if (up) return "teeUp";
    return "horizontal";
  }
  if (down && right) return "turnDownRight";
  if (down && left) return "turnDownLeft";
  if (up && right) return "turnUpRight";
  if (up && left) return "turnUpLeft";
  if (up) return "stubUp";
  if (down) return "stubDown";
  if (left) return "stubLeft";
  if (right) return "stubRight";
  return "none";
}

interface SeamLines {
  readonly vertical: Set<string>;
  readonly horizontal: Set<string>;
  readonly through: Set<string>;
  readonly screen: Screen;
}

function seamLines(rects: ReadonlyMap<string, Rect>, field: SeamField): SeamLines {
  const lines: SeamLines = {
    vertical: new Set(),
    horizontal: new Set(),
    through: new Set(),
    screen: field.screen,
  };
  for (const rect of rects.values()) addPaneSeams(lines, rect, field);
  addRing(lines, field);
  return lines;
}

function addPaneSeams(lines: SeamLines, rect: Rect, { field, screen }: SeamField): void {
  const reachesTop = rect.y === field.y;
  const reachesBottom = bottomEdge(rect) === bottomEdge(field);
  const reachesLeft = rect.x === field.x;
  const reachesRight = rightEdge(rect) === rightEdge(field);
  if (hasRightSeam(rect, field)) {
    const x = rightEdge(rect);
    const from = reachesTop ? Math.max(0, field.y - 1) : rect.y;
    const to = reachesBottom
      ? Math.min(screen.height - 1, bottomEdge(field) + 1)
      : bottomEdge(rect);
    for (let y = from; y <= to; y += 1) lines.vertical.add(key(x, y));
    if (reachesTop && field.y === 0) lines.through.add(key(x, 0));
    if (reachesBottom && bottomEdge(field) === screen.height - 1) {
      lines.through.add(key(x, screen.height - 1));
    }
  }
  if (hasBottomSeam(rect, field)) {
    const y = bottomEdge(rect);
    const from = reachesLeft ? Math.max(0, field.x - 1) : rect.x;
    const to = reachesRight ? Math.min(screen.width - 1, rightEdge(field) + 1) : rightEdge(rect);
    for (let x = from; x <= to; x += 1) lines.horizontal.add(key(x, y));
    if (reachesLeft && field.x === 0) lines.through.add(key(0, y));
    if (reachesRight && rightEdge(field) === screen.width - 1) {
      lines.through.add(key(screen.width - 1, y));
    }
  }
}

function addRing(lines: SeamLines, { field, screen }: SeamField): void {
  const top = field.y > 0;
  const bottom = bottomEdge(field) < screen.height - 1;
  const left = field.x > 0;
  const right = rightEdge(field) < screen.width - 1;
  const rows = {
    from: top ? field.y - 1 : field.y,
    to: bottom ? bottomEdge(field) + 1 : bottomEdge(field),
  };
  const cols = {
    from: left ? field.x - 1 : field.x,
    to: right ? rightEdge(field) + 1 : rightEdge(field),
  };
  for (let y = rows.from; y <= rows.to; y += 1) {
    if (left) lines.vertical.add(key(field.x - 1, y));
    if (right) lines.vertical.add(key(rightEdge(field) + 1, y));
  }
  for (let x = cols.from; x <= cols.to; x += 1) {
    if (top) lines.horizontal.add(key(x, field.y - 1));
    if (bottom) lines.horizontal.add(key(x, bottomEdge(field) + 1));
  }
}

function jointsAt(lines: SeamLines, x: number, y: number): Joints {
  const { vertical, horizontal, through, screen } = lines;
  const onVertical = vertical.has(key(x, y));
  const onHorizontal = horizontal.has(key(x, y));
  const runsOff = through.has(key(x, y));
  const seamAt = (px: number, py: number): boolean =>
    vertical.has(key(px, py)) || horizontal.has(key(px, py));
  return {
    up: onVertical ? (runsOff && y === 0) || seamAt(x, y - 1) : vertical.has(key(x, y - 1)),
    down: onVertical
      ? (runsOff && y === screen.height - 1) || seamAt(x, y + 1)
      : vertical.has(key(x, y + 1)),
    left: onHorizontal ? (runsOff && x === 0) || seamAt(x - 1, y) : horizontal.has(key(x - 1, y)),
    right: onHorizontal
      ? (runsOff && x === screen.width - 1) || seamAt(x + 1, y)
      : horizontal.has(key(x + 1, y)),
  };
}

function paneAt(rects: ReadonlyMap<string, Rect>, x: number, y: number): string | undefined {
  for (const [id, rect] of rects) if (contains(rect, x, y)) return id;
  return undefined;
}

interface SeamRun {
  readonly x: number;
  readonly y: number;
  readonly content: string;
  readonly ink: string;
}

function seamRuns(
  cells: readonly SeamCell[],
  ink: SeamInk,
  glyphs: GlyphSupport,
  stroke: SeamStroke,
): SeamRun[] {
  const heavy = new Set(
    cells.filter((cell) => stroke(cell) === "heavy").map((cell) => key(cell.x, cell.y)),
  );
  const runs: SeamRun[] = [];
  for (const cell of cells) {
    const cellInk = ink(cell);
    const glyph = seamGlyph(cell.joints, glyphs, heavyJoints(cell, heavy));
    const last = runs.at(-1);
    if (last !== undefined && extendsRun(last, cell, cellInk)) {
      runs[runs.length - 1] = { ...last, content: last.content + glyph };
    } else {
      runs.push({ x: cell.x, y: cell.y, ink: cellInk, content: glyph });
    }
  }
  return runs;
}

function heavyJoints({ x, y, joints }: SeamCell, heavy: ReadonlySet<string>): Joints {
  if (!heavy.has(key(x, y))) return noJoints;
  return {
    up: joints.up && heavy.has(key(x, y - 1)),
    down: joints.down && heavy.has(key(x, y + 1)),
    left: joints.left && heavy.has(key(x - 1, y)),
    right: joints.right && heavy.has(key(x + 1, y)),
  };
}

function extendsRun(run: SeamRun, cell: SeamCell, ink: string): boolean {
  return run.y === cell.y && run.ink === ink && run.x + [...run.content].length === cell.x;
}

function hasRightSeam(rect: Rect, field: Rect): boolean {
  return rect.width > 0 && rightEdge(rect) < rightEdge(field);
}

function hasBottomSeam(rect: Rect, field: Rect): boolean {
  return rect.height > 0 && bottomEdge(rect) < bottomEdge(field);
}

function rightEdge(rect: Rect): number {
  return rect.x + rect.width - 1;
}

function bottomEdge(rect: Rect): number {
  return rect.y + rect.height - 1;
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}
