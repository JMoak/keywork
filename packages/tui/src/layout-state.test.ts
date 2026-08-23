import { describe, expect, it } from "vitest";
import { Layout, type LayoutState, type Screen } from "./layout.ts";
import { layoutStateIds, parseLayoutState } from "./layout-state.ts";

const screen: Screen = { width: 120, height: 40 };

function layoutWith(...ids: string[]): Layout {
  const layout = new Layout();
  for (const id of ids) expect(layout.open(id, screen)).toBe(true);
  return layout;
}

describe("layout serialization", () => {
  it("round-trips tree shape, ratios, both docks, and focus through JSON", () => {
    const layout = layoutWith("a", "b", "c", "d");
    layout.resizeFocused(0.15);
    layout.focus("d");
    layout.dockFocused("right", screen);
    layout.growDock("right", 0.1);
    layout.focus("c");
    layout.dockFocused("left", screen);
    layout.focus("b");

    const state = Layout.parse(JSON.parse(JSON.stringify(layout.toJSON())));
    expect(state).toBeDefined();
    const revived = new Layout();
    revived.load(state as LayoutState);

    expect(revived.toJSON()).toEqual(layout.toJSON());
    expect(revived.focused()).toBe("b");
    expect(revived.dock("left")).toEqual(layout.dock("left"));
    expect(revived.dock("right")).toEqual(layout.dock("right"));
    expect([...revived.rects(screen)]).toEqual([...layout.rects(screen)]);
  });

  it("never serializes zoom", () => {
    const layout = layoutWith("a", "b");
    layout.zoomToggle();
    const revived = new Layout();
    revived.load(layout.toJSON());
    expect(revived.zoomed()).toBeUndefined();
  });

  it("hands out a copy of its state, so later mutations do not leak back", () => {
    const layout = layoutWith("a", "b");
    const state = layout.toJSON();
    layout.close("b");
    expect(layoutStateIds(state)).toEqual(["a", "b"]);
  });

  it("migrates a v1 single-dock state into that side's dock, other side empty", () => {
    const state = parseLayoutState({
      tree: { kind: "leaf", id: "a" },
      focused: "b",
      dock: { side: "right", panes: ["b"], ratio: 0.25 },
    });
    expect(state?.docks).toEqual({ right: { panes: ["b"], ratio: 0.25, pins: 0 } });
    const revived = new Layout();
    revived.load(state as LayoutState);
    expect(revived.dock("right")).toEqual({ panes: ["b"], ratio: 0.25, pins: 0 });
    expect(revived.dock("left")).toBeUndefined();
    expect(revived.focused()).toBe("b");
  });

  it("clamps out-of-bounds ratios on parse", () => {
    const state = parseLayoutState({
      tree: {
        kind: "split",
        orientation: "row",
        ratio: 0.99,
        first: { kind: "leaf", id: "a" },
        second: { kind: "leaf", id: "b" },
      },
      docks: { left: { panes: ["c"], ratio: 0.9 }, right: { panes: ["d"], ratio: 0.01 } },
    });
    expect(state?.tree).toMatchObject({ ratio: 0.9 });
    expect(state?.docks?.left?.ratio).toBe(0.6);
    expect(state?.docks?.right?.ratio).toBe(0.05);
  });

  it("lists ids left dock first, then the tree in reading order, then the right dock", () => {
    const state = parseLayoutState({
      tree: {
        kind: "split",
        orientation: "row",
        ratio: 0.5,
        first: { kind: "leaf", id: "a" },
        second: { kind: "leaf", id: "b" },
      },
      docks: { left: { panes: ["l"], ratio: 0.3 }, right: { panes: ["r"], ratio: 0.3 } },
    });
    expect(layoutStateIds(state as LayoutState)).toEqual(["l", "a", "b", "r"]);
  });

  it("rejects corrupt shapes wholesale", () => {
    const leaf = { kind: "leaf", id: "a" };
    const corrupt: unknown[] = [
      null,
      "layout",
      [],
      {},
      { tree: { kind: "widget", id: "a" } },
      { tree: { kind: "leaf", id: "" } },
      { tree: { kind: "split", orientation: "diagonal", ratio: 0.5, first: leaf, second: leaf } },
      { tree: { kind: "split", orientation: "row", ratio: "half", first: leaf, second: leaf } },
      {
        tree: {
          kind: "split",
          orientation: "row",
          ratio: 0.5,
          first: leaf,
          second: { kind: "leaf", id: "a" },
        },
      },
      { tree: leaf, dock: { side: "top", panes: ["b"], ratio: 0.3 } },
      { tree: leaf, dock: { side: "left", panes: [], ratio: 0.3 } },
      { tree: leaf, docks: {} },
      { tree: leaf, docks: { top: { panes: ["b"], ratio: 0.3 } } },
      { tree: leaf, docks: { left: { panes: [], ratio: 0.3 } } },
      { tree: leaf, docks: { left: { panes: ["b"], ratio: "wide" } } },
      { tree: leaf, docks: { left: { panes: ["a"], ratio: 0.3 } } },
      {
        tree: leaf,
        docks: { left: { panes: ["b"], ratio: 0.3 }, right: { panes: ["b"], ratio: 0.3 } },
      },
      { tree: leaf, focused: "ghost" },
      { tree: leaf, focused: 7 },
    ];
    for (const value of corrupt) expect(parseLayoutState(value)).toBeUndefined();
  });
});
