import { describe, expect, it } from "vitest";
import type { Rect } from "./geometry.ts";
import {
  attachAtEdge,
  collectRects,
  type LayoutNode,
  leaf,
  leafIds,
  minHeight,
  minPaneSize,
  minWidth,
  removeLeaf,
  resizeAroundLeaf,
  retainLeaves,
  splitLeaf,
  splitRatioBounds,
  steppedRatio,
  swapLeaves,
} from "./layout-tree.ts";

const row = (first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode => ({
  kind: "split",
  orientation: "row",
  ratio,
  first,
  second,
});
const column = (first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode => ({
  kind: "split",
  orientation: "column",
  ratio,
  first,
  second,
});

const tree = row(leaf("a"), column(leaf("b"), row(leaf("c"), leaf("d"))));

describe("node algebra", () => {
  it("lists leaves in reading order", () => {
    expect(leafIds(tree)).toEqual(["a", "b", "c", "d"]);
  });

  it("splits only the target leaf into a half split and leaves the rest untouched", () => {
    const grown = splitLeaf(tree, "b", leaf("e"), "column");
    expect(leafIds(grown)).toEqual(["a", "b", "e", "c", "d"]);
    expect(grown).toMatchObject({ second: { first: { kind: "split", ratio: 0.5 } } });
    expect(splitLeaf(tree, "ghost", leaf("e"), "row")).toEqual(tree);
  });

  it("removing a leaf collapses its parent split", () => {
    expect(removeLeaf(tree, "c")).toEqual(row(leaf("a"), column(leaf("b"), leaf("d"))));
    expect(removeLeaf(leaf("a"), "a")).toBeUndefined();
  });

  it("retaining a subset keeps the survivors' relative shape", () => {
    const kept = new Set(["a", "d"]);
    expect(retainLeaves(tree, (id) => kept.has(id))).toEqual(row(leaf("a"), leaf("d")));
    expect(retainLeaves(tree, () => false)).toBeUndefined();
  });

  it("swaps two leaves, and substitutes when only one is present", () => {
    expect(leafIds(swapLeaves(tree, "a", "d"))).toEqual(["d", "b", "c", "a"]);
    expect(leafIds(swapLeaves(tree, "b", "x"))).toEqual(["a", "x", "c", "d"]);
  });

  it("attaches an incoming leaf on the named edge of the whole tree", () => {
    expect(attachAtEdge(tree, "e", "left")).toEqual(row(leaf("e"), tree));
    expect(attachAtEdge(tree, "e", "down")).toEqual(column(tree, leaf("e")));
    expect(attachAtEdge(undefined, "e", "up")).toEqual(leaf("e"));
  });

  it("resizes the split directly around a leaf and clamps the ratio", () => {
    const grown = resizeAroundLeaf(tree, "a", 0.2);
    expect(grown).toMatchObject({ ratio: 0.7, second: { ratio: 0.5 } });
    const shrunk = resizeAroundLeaf(tree, "d", 5);
    expect(shrunk).toMatchObject({ second: { second: { ratio: splitRatioBounds.min } } });
  });

  it("sums minimums along the split axis and takes the max across it", () => {
    expect(minWidth(tree)).toBe(minPaneSize.width * 3);
    expect(minHeight(tree)).toBe(minPaneSize.height * 2);
  });

  it("tiles a rect exactly, honoring minimums before ratios", () => {
    const rect: Rect = { x: 0, y: 0, width: 16, height: 6 };
    const rects = new Map<string, Rect>();
    collectRects(row(leaf("a"), column(leaf("b"), leaf("c")), 0.9), rect, rects);
    expect(rects.get("a")).toEqual({ x: 0, y: 0, width: 11, height: 6 });
    expect(rects.get("b")).toEqual({ x: 11, y: 0, width: 5, height: 3 });
    expect(rects.get("c")).toEqual({ x: 11, y: 3, width: 5, height: 3 });
  });
});

describe("steppedRatio", () => {
  it("quantizes onto the shared keyboard lattice inside the bounds", () => {
    expect(steppedRatio(0.5583)).toBe(0.55);
    expect(steppedRatio(0.03)).toBe(splitRatioBounds.min);
    expect(steppedRatio(0.97)).toBe(splitRatioBounds.max);
    expect(steppedRatio(0.7000000001)).toBe(0.7);
  });
});
