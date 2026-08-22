import { describe, expect, it } from "vitest";
import {
  area,
  center,
  contains,
  encloses,
  fullRect,
  isWide,
  nearestInDirection,
  type Rect,
} from "./geometry.ts";

const rect: Rect = { x: 2, y: 3, width: 4, height: 2 };

describe("rects", () => {
  it("contain their interior and exclude the far edges", () => {
    expect(contains(rect, 2, 3)).toBe(true);
    expect(contains(rect, 5, 4)).toBe(true);
    expect(contains(rect, 6, 4)).toBe(false);
    expect(contains(rect, 1, 3)).toBe(false);
  });

  it("enclose rects that lie fully inside them", () => {
    const screen = fullRect({ width: 10, height: 5 });
    expect(encloses(screen, rect)).toBe(true);
    expect(encloses(screen, { ...rect, x: 7 })).toBe(false);
    expect(encloses(screen, { x: 0, y: 0, width: 0, height: 0 })).toBe(true);
  });

  it("measure area, center, and terminal-aspect wideness", () => {
    expect(area(rect)).toBe(8);
    expect(center(rect)).toEqual({ x: 4, y: 4 });
    expect(isWide({ x: 0, y: 0, width: 8, height: 4 })).toBe(true);
    expect(isWide({ x: 0, y: 0, width: 7, height: 4 })).toBe(false);
  });
});

describe("nearestInDirection", () => {
  const origin: Rect = { x: 10, y: 10, width: 10, height: 5 };
  const candidates: [string, Rect][] = [
    ["far-right", { x: 40, y: 10, width: 10, height: 5 }],
    ["near-right", { x: 20, y: 10, width: 10, height: 5 }],
    ["above", { x: 10, y: 0, width: 10, height: 5 }],
    ["overlapping", { x: 15, y: 10, width: 10, height: 5 }],
  ];

  it("picks the closest rect that lies wholly in the direction", () => {
    expect(nearestInDirection(origin, candidates, "right")).toBe("near-right");
    expect(nearestInDirection(origin, candidates, "up")).toBe("above");
    expect(nearestInDirection(origin, candidates, "down")).toBeUndefined();
  });

  it("weighs rows twice as far as columns, like terminal cells", () => {
    const rows: [string, Rect][] = [
      ["right-4", { x: 24, y: 10, width: 10, height: 5 }],
      ["right-3-down-1", { x: 23, y: 15, width: 10, height: 5 }],
    ];
    expect(nearestInDirection(origin, rows, "right")).toBe("right-4");
  });
});
