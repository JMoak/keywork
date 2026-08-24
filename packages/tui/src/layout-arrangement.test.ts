import { describe, expect, it } from "vitest";
import {
  type Arrangement,
  dockedAt,
  dockRatioBounds,
  emptyArrangement,
  lifted,
  mainPanes,
  panesOf,
  reorderedInDock,
  sideOf,
  swapped,
  withDockRatio,
  withTree,
} from "./layout-arrangement.ts";
import { type LayoutNode, leaf, leafIds } from "./layout-tree.ts";

const tree: LayoutNode = {
  kind: "split",
  orientation: "row",
  ratio: 0.5,
  first: leaf("a"),
  second: leaf("b"),
};

const arrangement: Arrangement = dockedAt(
  dockedAt(withTree(emptyArrangement(), tree), "left", "l"),
  "right",
  "r",
);

describe("arrangement algebra", () => {
  it("lists panes left dock, main stage, right dock", () => {
    expect(panesOf(arrangement)).toEqual(["l", "a", "b", "r"]);
    expect(mainPanes(arrangement)).toEqual(["a", "b"]);
    expect(sideOf(arrangement, "l")).toBe("left");
    expect(sideOf(arrangement, "a")).toBeUndefined();
  });

  it("lifts a pane out of whichever home it has, leaving the original untouched", () => {
    expect(panesOf(lifted(arrangement, "l"))).toEqual(["a", "b", "r"]);
    expect(panesOf(lifted(arrangement, "a"))).toEqual(["l", "b", "r"]);
    expect(panesOf(lifted(arrangement, "ghost"))).toEqual(["l", "a", "b", "r"]);
    expect(panesOf(arrangement)).toEqual(["l", "a", "b", "r"]);
  });

  it("docks at a clamped index", () => {
    expect(dockedAt(arrangement, "left", "x", 0).docks.left.panes).toEqual(["x", "l"]);
    expect(dockedAt(arrangement, "left", "x", 99).docks.left.panes).toEqual(["l", "x"]);
  });

  it("reorders within a dock and stops at the ends", () => {
    const stacked = dockedAt(arrangement, "left", "m");
    expect(reorderedInDock(stacked, "left", "m", -1)?.docks.left.panes).toEqual(["m", "l"]);
    expect(reorderedInDock(stacked, "left", "m", 1)).toBeUndefined();
  });

  it("swaps homes across main and dock, and within one dock", () => {
    const crossed = swapped(arrangement, "a", "l");
    expect(crossed.docks.left.panes).toEqual(["a"]);
    expect(leafIds(crossed.tree as LayoutNode)).toEqual(["l", "b"]);
    const stacked = dockedAt(arrangement, "left", "m");
    expect(swapped(stacked, "l", "m").docks.left.panes).toEqual(["m", "l"]);
    expect(swapped(arrangement, "l", "r").docks).toMatchObject({
      left: { panes: ["r"] },
      right: { panes: ["l"] },
    });
  });

  it("clamps dock ratios to their bounds", () => {
    expect(withDockRatio(arrangement, "left", 5).docks.left.ratio).toBe(dockRatioBounds.max);
    expect(withDockRatio(arrangement, "right", -1).docks.right.ratio).toBe(dockRatioBounds.min);
  });
});
