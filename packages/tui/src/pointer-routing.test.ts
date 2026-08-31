import { describe, expect, it } from "vitest";
import { fullRect, type Screen } from "./geometry.ts";
import type { Chord } from "./keys.ts";
import { Layout } from "./layout.ts";
import type { Pane } from "./pane.ts";
import { drawnRect } from "./pane-geometry.ts";
import { PanePointer } from "./pointer-routing.ts";

const screen: Screen = { width: 120, height: 40 };

function surfaceWith(ids: string[], panes = new Map<string, Pane>(), gap = 0) {
  const layout = new Layout();
  for (const id of ids) layout.open(id, screen);
  const changes: number[] = [];
  const pointer = new PanePointer({
    layout,
    screen: () => screen,
    paneAt: (id) => panes.get(id),
    changed: () => changes.push(changes.length),
    drawnRect: (rect, on) => drawnRect(rect, fullRect(on), { chrome: "regular", gap }),
  });
  return { layout, pointer, changes, rect: (id: string) => layout.rects(screen).get(id) };
}

function keyedPane(id: string, seen: string[]): Pane {
  return {
    id,
    title: () => id,
    view: () => ({}) as never,
    handleKey: (chord: Chord) => {
      seen.push(chord.name);
      return true;
    },
  };
}

describe("PanePointer", () => {
  it("focuses the pane under a click and reports the change, but not on a plain move", () => {
    const { layout, pointer, changes, rect } = surfaceWith(["a", "b"]);
    const target = rect("b");
    if (target === undefined) throw new Error("no rect");
    pointer.route({ type: "move", x: target.x + 2, y: target.y + 2 });
    expect(changes).toEqual([]);
    pointer.route({ type: "down", x: target.x + 2, y: target.y + 2, button: 0 });
    expect(layout.focused()).toBe("b");
    expect(changes).toEqual([0]);
  });

  it("lifts a pane from its title row and swaps on drop, previewing the landing rect", () => {
    const { pointer, rect } = surfaceWith(["a", "b"]);
    const first = rect("a");
    const second = rect("b");
    if (first === undefined || second === undefined) throw new Error("no rects");
    pointer.route({ type: "down", x: first.x + 2, y: first.y, button: 0 });
    expect(pointer.draggingPane()).toBeUndefined();
    pointer.route({ type: "drag", x: second.x + 5, y: second.y + 5, button: 0 });
    expect(pointer.draggingPane()).toBe("a");
    expect(pointer.dragPreview()).toEqual(second);
    pointer.route({ type: "up", x: second.x + 5, y: second.y + 5, button: 0 });
    expect(pointer.dragPreview()).toBeUndefined();
    expect(rect("a")).toEqual(second);
    expect(rect("b")).toEqual(first);
  });

  it("turns wheel scrolls into direction keys for the pane underneath", () => {
    const seen: string[] = [];
    const panes = new Map<string, Pane>([["a", keyedPane("a", seen)]]);
    const { pointer, rect } = surfaceWith(["a"], panes);
    const target = rect("a");
    if (target === undefined) throw new Error("no rect");
    pointer.route({
      type: "scroll",
      x: target.x + 1,
      y: target.y + 1,
      scroll: { direction: "down", delta: 3 },
    });
    expect(seen).toEqual(["down", "down", "down"]);
  });

  it("drags a dock edge to resize the dock", () => {
    const { layout, pointer } = surfaceWith(["a", "b"]);
    layout.focus("b");
    layout.dockFocused("left", screen);
    const before = layout.dock("left")?.ratio ?? 0;
    const handle = layout.rects(screen).get("b");
    if (handle === undefined) throw new Error("no dock rect");
    const edge = handle.x + handle.width;
    pointer.route({ type: "down", x: edge, y: 5, button: 0 });
    pointer.route({ type: "drag", x: edge + 10, y: 5, button: 0 });
    pointer.route({ type: "up", x: edge + 10, y: 5, button: 0 });
    expect(layout.dock("left")?.ratio ?? 0).toBeGreaterThan(before);
  });
});

describe("PanePointer through gap cells", () => {
  it("hits nothing in the gap and measures local coordinates from the drawn rect", () => {
    const seen: Array<{ x: number; y: number }> = [];
    const pane: Pane = {
      id: "b",
      title: () => "b",
      view: () => ({}) as never,
      handleMouse: (local) => {
        seen.push(local);
        return true;
      },
    };
    const { layout, pointer, rect } = surfaceWith(["a", "b"], new Map([["b", pane]]), 2);
    const laid = rect("b");
    if (laid === undefined) throw new Error("no rect");
    layout.focus("a");
    pointer.route({ type: "down", x: laid.x, y: laid.y + 5, button: 0 });
    expect(layout.focused()).toBe("a");
    expect(seen).toEqual([]);
    pointer.route({ type: "down", x: laid.x + 2, y: laid.y + 5, button: 0 });
    expect(layout.focused()).toBe("b");
    expect(seen).toEqual([{ x: 0, y: 5 }]);
  });
});
