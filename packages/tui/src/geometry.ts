export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Screen {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Direction = "left" | "right" | "up" | "down";

const terminalCellAspect = 2;

export function fullRect(screen: Screen): Rect {
  return { x: 0, y: 0, width: screen.width, height: screen.height };
}

export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function encloses(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function area(rect: Rect): number {
  return rect.width * rect.height;
}

export function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function isWide(rect: Rect): boolean {
  return rect.width >= rect.height * terminalCellAspect;
}

export function nearestInDirection<Id>(
  from: Rect,
  candidates: Iterable<readonly [Id, Rect]>,
  direction: Direction,
): Id | undefined {
  const origin = center(from);
  let best: { id: Id; distance: number } | undefined;
  for (const [id, rect] of candidates) {
    if (!liesInDirection(from, rect, direction)) continue;
    const distance = cellDistance(origin, center(rect));
    if (best === undefined || distance < best.distance) best = { id, distance };
  }
  return best?.id;
}

function liesInDirection(from: Rect, candidate: Rect, direction: Direction): boolean {
  switch (direction) {
    case "left":
      return candidate.x + candidate.width <= from.x;
    case "right":
      return candidate.x >= from.x + from.width;
    case "up":
      return candidate.y + candidate.height <= from.y;
    case "down":
      return candidate.y >= from.y + from.height;
  }
}

function cellDistance(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + ((a.y - b.y) * terminalCellAspect) ** 2;
}
