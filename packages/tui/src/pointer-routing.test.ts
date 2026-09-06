import { describe, expect, it } from "vitest";
import { fullRect, type Rect, type Screen } from "./geometry.ts";
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

describe("PanePointer over interior seams", () => {
  it("drags an interior seam to retile the split and reports handling", () => {
    const { layout, pointer } = surfaceWith(["a", "b"]);
    expect(pointer.route({ type: "down", x: 60, y: 5, button: 0 })).toBe(true);
    pointer.route({ type: "drag", x: 72, y: 5, button: 0 });
    pointer.route({ type: "up", x: 72, y: 5, button: 0 });
    expect(layout.rects(screen).get("a")?.width).toBe(72);
  });

  it("lands on exactly the rectangle the keyboard verb produces", () => {
    const dragged = surfaceWith(["a", "b"]);
    dragged.pointer.route({ type: "down", x: 60, y: 5, button: 0 });
    dragged.pointer.route({ type: "drag", x: 66, y: 5, button: 0 });
    dragged.pointer.route({ type: "up", x: 66, y: 5, button: 0 });
    const keyed = surfaceWith(["a", "b"]);
    keyed.layout.focus("a");
    keyed.layout.resizeFocused(0.05);
    expect(dragged.layout.rects(screen).get("a")).toEqual(keyed.layout.rects(screen).get("a"));
  });

  it("reports nothing handled for a move over no target", () => {
    const { pointer } = surfaceWith(["a"]);
    expect(pointer.route({ type: "move", x: 200, y: 200 })).toBe(false);
  });
});

function seamedSurface(ids: string[]) {
  const layout = new Layout();
  for (const id of ids) layout.open(id, screen);
  const pointer = new PanePointer({
    layout,
    screen: () => screen,
    paneAt: () => undefined,
    changed: () => {},
    drawnRect: (rect, on) => drawnRect(rect, fullRect(on), { chrome: "seams", gap: 0 }),
  });
  return { layout, pointer, rect: (id: string) => layout.rects(screen).get(id) as Rect };
}

describe("PanePointer pane drag", () => {
  it("ghosts the source pane while lifted with no landing target", () => {
    const { pointer, rect } = surfaceWith(["a", "b"]);
    const own = rect("a");
    if (own === undefined) throw new Error("no rect");
    pointer.route({ type: "down", x: own.x + 2, y: own.y, button: 0 });
    pointer.route({ type: "drag", x: own.x + 5, y: own.y + 5, button: 0 });
    expect(pointer.draggingPane()).toBe("a");
    expect(pointer.dragPreview()).toEqual(own);
  });

  it("cancelDrag drops the lift and the release commits nothing", () => {
    const { pointer, rect } = surfaceWith(["a", "b"]);
    const own = rect("a");
    const other = rect("b");
    if (own === undefined || other === undefined) throw new Error("no rects");
    expect(pointer.cancelDrag()).toBe(false);
    pointer.route({ type: "down", x: own.x + 2, y: own.y, button: 0 });
    pointer.route({ type: "drag", x: other.x + 3, y: other.y + 3, button: 0 });
    expect(pointer.cancelDrag()).toBe(true);
    expect(pointer.dragPreview()).toBeUndefined();
    pointer.route({ type: "up", x: other.x + 3, y: other.y + 3, button: 0 });
    expect(rect("a")).toEqual(own);
    expect(rect("b")).toEqual(other);
  });

  it("a plain title-row click focuses without lifting", () => {
    const { layout, pointer, rect } = surfaceWith(["a", "b"]);
    const own = rect("b");
    if (own === undefined) throw new Error("no rect");
    pointer.route({ type: "down", x: own.x + 2, y: own.y, button: 0 });
    pointer.route({ type: "up", x: own.x + 2, y: own.y, button: 0 });
    expect(layout.focused()).toBe("b");
    expect(pointer.draggingPane()).toBeUndefined();
    expect(rect("b")).toEqual(own);
  });

  it("drops into a dock through the full gesture at the previewed slot", () => {
    const { layout, pointer, rect } = surfaceWith(["a", "b", "c"]);
    layout.focus("c");
    layout.dockFocused("left", screen);
    const grab = rect("a");
    const dock = rect("c");
    if (grab === undefined || dock === undefined) throw new Error("no rects");
    pointer.route({ type: "down", x: grab.x + 2, y: grab.y, button: 0 });
    pointer.route({ type: "drag", x: dock.x + 1, y: dock.y + dock.height - 1, button: 0 });
    const preview = pointer.dragPreview();
    pointer.route({ type: "up", x: dock.x + 1, y: dock.y + dock.height - 1, button: 0 });
    expect(layout.dock("left")?.panes).toEqual(["c", "a"]);
    expect(rect("a")).toEqual(preview);
  });

  it("reorders within a dock by dragging a title row into another band", () => {
    const { layout, pointer, rect } = surfaceWith(["a", "b", "c"]);
    for (const id of ["b", "c"]) {
      layout.focus(id);
      layout.dockFocused("left", screen);
    }
    expect(layout.dock("left")?.panes).toEqual(["b", "c"]);
    const grab = rect("b");
    if (grab === undefined) throw new Error("no rect");
    pointer.route({ type: "down", x: grab.x + 1, y: grab.y, button: 0 });
    pointer.route({ type: "drag", x: grab.x + 1, y: screen.height - 1, button: 0 });
    pointer.route({ type: "up", x: grab.x + 1, y: screen.height - 1, button: 0 });
    expect(layout.dock("left")?.panes).toEqual(["c", "b"]);
  });

  it("a drag swap lands on exactly the tree the keyboard swap produces", () => {
    const dragged = surfaceWith(["a", "b", "c"]);
    const from = dragged.rect("a");
    const onto = dragged.rect("b");
    if (from === undefined || onto === undefined) throw new Error("no rects");
    dragged.pointer.route({ type: "down", x: from.x + 2, y: from.y, button: 0 });
    dragged.pointer.route({ type: "drag", x: onto.x + 2, y: onto.y + 2, button: 0 });
    dragged.pointer.route({ type: "up", x: onto.x + 2, y: onto.y + 2, button: 0 });
    const keyed = surfaceWith(["a", "b", "c"]);
    keyed.layout.focus("a");
    keyed.layout.move("right", screen);
    expect(dragged.layout.toJSON()).toEqual(keyed.layout.toJSON());
  });
});

describe("PanePointer title rows beside W4 grips", () => {
  it("row-split boundary columns grip for resize while the title row past them lifts", () => {
    const { layout, pointer } = seamedSurface(["a", "b"]);
    const boundary = (layout.rects(screen).get("b") as Rect).x;
    expect(pointer.route({ type: "down", x: boundary, y: 0, button: 0 })).toBe(true);
    pointer.route({ type: "drag", x: boundary + 6, y: 0, button: 0 });
    pointer.route({ type: "up", x: boundary + 6, y: 0, button: 0 });
    expect(pointer.draggingPane()).toBeUndefined();
    expect((layout.rects(screen).get("a") as Rect).width).toBe(boundary + 6);

    const title = layout.rects(screen).get("b") as Rect;
    pointer.route({ type: "down", x: title.x + 2, y: title.y, button: 0 });
    pointer.route({ type: "drag", x: title.x + 5, y: title.y + 4, button: 0 });
    expect(pointer.draggingPane()).toBe("b");
    pointer.cancelDrag();
  });

  it("a column-split boundary row resizes while the lower title row lifts", () => {
    const { layout, pointer } = seamedSurface(["a", "b", "c"]);
    const lower = layout.rects(screen).get("c") as Rect;
    const heightBefore = (layout.rects(screen).get("b") as Rect).height;
    expect(pointer.route({ type: "down", x: lower.x + 5, y: lower.y - 1, button: 0 })).toBe(true);
    pointer.route({ type: "drag", x: lower.x + 5, y: lower.y + 3, button: 0 });
    pointer.route({ type: "up", x: lower.x + 5, y: lower.y + 3, button: 0 });
    expect(pointer.draggingPane()).toBeUndefined();
    expect((layout.rects(screen).get("b") as Rect).height).toBeGreaterThan(heightBefore);

    const title = layout.rects(screen).get("c") as Rect;
    pointer.route({ type: "down", x: title.x + 5, y: title.y, button: 0 });
    pointer.route({ type: "drag", x: title.x + 5, y: title.y + 3, button: 0 });
    expect(pointer.draggingPane()).toBe("c");
    pointer.cancelDrag();
  });

  it("with gap chrome the lift listens on the drawn title row and ignores the gap", () => {
    const { pointer, rect } = surfaceWith(["a", "b"], new Map(), 2);
    const laid = rect("b");
    if (laid === undefined) throw new Error("no rect");
    const drawn = drawnRect(laid, fullRect(screen), { chrome: "regular", gap: 2 });
    pointer.route({ type: "down", x: laid.x, y: drawn.y, button: 0 });
    pointer.route({ type: "drag", x: laid.x, y: drawn.y + 2, button: 0 });
    expect(pointer.draggingPane()).toBeUndefined();
    pointer.route({ type: "up", x: laid.x, y: drawn.y + 2, button: 0 });
    pointer.route({ type: "down", x: drawn.x + 1, y: drawn.y, button: 0 });
    pointer.route({ type: "drag", x: drawn.x + 4, y: drawn.y + 4, button: 0 });
    expect(pointer.draggingPane()).toBe("b");
    pointer.cancelDrag();
  });
});

describe("PanePointer seam commits", () => {
  it("commits a seam drag on drag-end just as on up, then hands the next press back to the panes", () => {
    const { layout, pointer, changes } = surfaceWith(["a", "b"]);
    pointer.route({ type: "down", x: 60, y: 5, button: 0 });
    pointer.route({ type: "drag", x: 78, y: 5, button: 0 });
    expect(pointer.route({ type: "drag-end", x: 78, y: 5, button: 0 })).toBe(true);
    expect(layout.rects(screen).get("a")?.width).toBe(78);
    const liveRetiles = changes.length;
    pointer.route({ type: "down", x: 20, y: 5, button: 0 });
    expect(layout.focused()).toBe("a");
    expect(changes.length).toBe(liveRetiles + 1);
  });
});
