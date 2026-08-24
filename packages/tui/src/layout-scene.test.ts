import { describe, expect, it } from "vitest";
import { dockedAt, emptyArrangement, withDockRatio, withTree } from "./layout-arrangement.ts";
import { dockSlotRects, holds, regionsOf, sceneOf, sceneRects } from "./layout-scene.ts";
import { type LayoutNode, leaf, minPaneSize } from "./layout-tree.ts";

const pair: LayoutNode = {
  kind: "split",
  orientation: "row",
  ratio: 0.5,
  first: leaf("a"),
  second: leaf("b"),
};

const main = withTree(emptyArrangement(), pair);
const docked = dockedAt(main, "left", "l");

describe("regions", () => {
  it("carves a dock column at its ratio and hands the rest to the main stage", () => {
    expect(regionsOf(docked, { width: 120, height: 40 })).toEqual({
      left: { x: 0, y: 0, width: 40, height: 40 },
      main: { x: 40, y: 0, width: 80, height: 40 },
    });
  });

  it("reserves the main stage's minimum first and scales docks into what is left", () => {
    const regions = regionsOf(docked, { width: 14, height: 10 });
    expect(regions.main.width).toBe(minPaneSize.width * 2);
    expect(regions.left?.width).toBe(4);
    expect(holds(docked, { width: 14, height: 10 })).toBe(false);
    expect(holds(docked, { width: 15, height: 10 })).toBe(true);
  });

  it("stacks dock slots with the spare rows going to the first slots", () => {
    const rect = { x: 0, y: 0, width: 10, height: 7 };
    expect(dockSlotRects(rect, [1, 1, 1])).toEqual([
      { x: 0, y: 0, width: 10, height: 3 },
      { x: 0, y: 3, width: 10, height: 2 },
      { x: 0, y: 5, width: 10, height: 2 },
    ]);
  });

  it("gives a half-weight slot half the rows of a full one when every slot still fits", () => {
    const rect = { x: 0, y: 0, width: 10, height: 30 };
    expect(dockSlotRects(rect, [0.5, 1]).map((slot) => slot.height)).toEqual([10, 20]);
    expect(dockSlotRects(rect, [1, 0.5, 1]).map((slot) => slot.height)).toEqual([12, 6, 12]);
  });

  it("falls back to even slots when a weighted slot would drop under the minimum height", () => {
    const tight = { x: 0, y: 0, width: 10, height: minPaneSize.height * 2 };
    expect(dockSlotRects(tight, [0.5, 1]).map((slot) => slot.height)).toEqual([
      minPaneSize.height,
      minPaneSize.height,
    ]);
  });
});

describe("the scene an arrangement makes on a screen", () => {
  it("tiles everything when the arrangement holds", () => {
    const scene = sceneOf(docked, "a", { width: 120, height: 40 });
    expect(scene.kind).toBe("tiled");
    expect([...sceneRects(scene, { width: 120, height: 40 }).keys()]).toEqual(["l", "a", "b"]);
  });

  it("admits the anchor first, then the main stage in reading order, then the docks", () => {
    const screen = { width: 14, height: 10 };
    expect([...sceneRects(sceneOf(docked, "a", screen), screen).keys()]).toEqual(["a", "b"]);
    expect([...sceneRects(sceneOf(docked, "l", screen), screen).keys()]).toEqual(["l", "a"]);
  });

  it("falls back to the anchor alone, full screen, when not even it can be tiled", () => {
    const screen = { width: 3, height: 2 };
    const scene = sceneOf(docked, "b", screen);
    expect(scene).toEqual({ kind: "solo", id: "b" });
    expect(sceneRects(scene, screen).get("b")).toEqual({ x: 0, y: 0, width: 3, height: 2 });
  });

  it("anchors on the first pane when no anchor is given", () => {
    const screen = { width: 3, height: 2 };
    expect(sceneOf(docked, undefined, screen)).toEqual({ kind: "solo", id: "a" });
  });

  it("ignores dock ratios that would starve the main stage", () => {
    const greedy = withDockRatio(docked, "left", 0.6);
    const screen = { width: 20, height: 10 };
    expect(holds(greedy, screen)).toBe(true);
    expect(regionsOf(greedy, screen).main.width).toBe(minPaneSize.width * 2);
  });
});
