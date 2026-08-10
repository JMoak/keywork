import { describe, expect, it } from "vitest";
import { Layout, type Rect, type Screen } from "./layout.ts";

const screen: Screen = { width: 120, height: 40 };

function layoutWith(...ids: string[]): Layout {
  const layout = new Layout();
  for (const id of ids) layout.open(id, screen);
  return layout;
}

function assertExactTiling(layout: Layout): void {
  const rects = [...layout.rects(screen).values()];
  const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  expect(area).toBe(screen.width * screen.height);
  for (const rect of rects) {
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  }
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      expect(overlaps(rects[i] as Rect, rects[j] as Rect)).toBe(false);
    }
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("Layout dwindle tiling", () => {
  it("fills the whole screen with one pane", () => {
    const layout = layoutWith("a");
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
  });

  it("splits a wide pane side by side, then a tall region stacked", () => {
    const layout = layoutWith("a", "b", "c");
    const rects = layout.rects(screen);
    expect(rects.get("a")).toEqual({ x: 0, y: 0, width: 60, height: 40 });
    expect(rects.get("b")).toEqual({ x: 60, y: 0, width: 60, height: 20 });
    expect(rects.get("c")).toEqual({ x: 60, y: 20, width: 60, height: 20 });
  });

  it("tiles exactly for any sequence of opens, closes, docks, and undocks", () => {
    const layout = new Layout();
    const alive: string[] = [];
    const steps = 200;
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let step = 0; step < steps; step += 1) {
      const roll = alive.length === 0 ? 0 : random();
      if (roll < 0.5) {
        const id = `p${step}`;
        layout.open(id, screen);
        alive.push(id);
        const focusTarget = alive[Math.floor(random() * alive.length)] as string;
        layout.focus(focusTarget);
      } else if (roll < 0.65) {
        layout.dockFocused(random() < 0.5 ? "left" : "right");
      } else if (roll < 0.8) {
        layout.undockFocused(screen);
      } else {
        const victim = alive.splice(Math.floor(random() * alive.length), 1)[0] as string;
        layout.close(victim);
      }
      if (alive.length === 0) {
        expect(layout.rects(screen).size).toBe(0);
        expect(layout.focused()).toBeUndefined();
        continue;
      }
      assertExactTiling(layout);
      expect(alive).toContain(layout.focused());
    }
  });

  it("keeps a valid focus after closing the focused pane", () => {
    const layout = layoutWith("a", "b", "c");
    layout.close(layout.focused() as string);
    expect(layout.panes()).toContain(layout.focused());
  });

  it("refocuses instead of duplicating an already-open pane", () => {
    const layout = layoutWith("a", "b");
    layout.open("a", screen);
    expect(layout.panes()).toEqual(["a", "b"]);
    expect(layout.focused()).toBe("a");
  });
});

describe("Layout navigation", () => {
  it("moves focus geometrically", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("a");
    expect(layout.moveFocus("right", screen)).toBe("b");
    expect(layout.moveFocus("down", screen)).toBe("c");
    expect(layout.moveFocus("left", screen)).toBe("a");
  });

  it("returns undefined at an edge and keeps focus", () => {
    const layout = layoutWith("a", "b");
    layout.focus("a");
    expect(layout.moveFocus("left", screen)).toBeUndefined();
    expect(layout.focused()).toBe("a");
  });

  it("swaps panes directionally while keeping focus on the moved pane", () => {
    const layout = layoutWith("a", "b");
    layout.focus("a");
    layout.swap("right", screen);
    const rects = layout.rects(screen);
    expect((rects.get("a") as Rect).x).toBeGreaterThan((rects.get("b") as Rect).x);
    expect(layout.focused()).toBe("a");
  });
});

describe("Layout dock", () => {
  it("docks the focused pane into a full-height column", () => {
    const layout = layoutWith("a", "b");
    layout.focus("b");
    layout.dockFocused("left");
    const rects = layout.rects(screen);
    expect(rects.get("b")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(rects.get("a")).toEqual({ x: 40, y: 0, width: 80, height: 40 });
    expect(layout.dock()).toEqual({ side: "left", panes: ["b"] });
    assertExactTiling(layout);
  });

  it("locks the dock to the right edge when asked", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("right");
    expect(layout.rects(screen).get("b")).toEqual({ x: 80, y: 0, width: 40, height: 40 });
    assertExactTiling(layout);
  });

  it("stacks additional docked panes vertically with equal heights", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left");
    layout.focus("c");
    layout.dockFocused("left");
    const rects = layout.rects(screen);
    expect(rects.get("b")).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    expect(rects.get("c")).toEqual({ x: 0, y: 20, width: 40, height: 20 });
    assertExactTiling(layout);
  });

  it("covers the whole screen when the only pane is docked", () => {
    const layout = layoutWith("a");
    layout.dockFocused("left");
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
    expect(layout.panes()).toEqual(["a"]);
  });

  it("reclaims the full width when the dock empties through close", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left");
    layout.close("b");
    expect(layout.dock()).toBeUndefined();
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
    expect(layout.focused()).toBe("a");
  });

  it("keeps a valid focus after closing the focused docked pane", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left");
    layout.focus("c");
    layout.dockFocused("left");
    layout.close("c");
    expect(layout.focused()).toBe("b");
    layout.close("b");
    expect(layout.focused()).toBe("a");
  });

  it("undocks the focused pane back into the main tiling", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left");
    layout.undockFocused(screen);
    expect(layout.dock()).toBeUndefined();
    expect(layout.rects(screen).get("b")).toEqual({ x: 60, y: 0, width: 60, height: 40 });
    assertExactTiling(layout);
  });

  it("undocks into an empty main area as the sole pane", () => {
    const layout = layoutWith("a");
    layout.dockFocused("right");
    layout.undockFocused(screen);
    expect(layout.dock()).toBeUndefined();
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
  });

  it("moves the whole dock when redocking to the other side", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left");
    layout.dockFocused("right");
    expect(layout.dock()).toEqual({ side: "right", panes: ["b"] });
    expect((layout.rects(screen).get("b") as Rect).x).toBe(80);
  });

  it("resizes the dock within clamped bounds", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left");
    layout.growDock(1);
    expect((layout.rects(screen).get("b") as Rect).width).toBe(72);
    layout.growDock(-1);
    expect((layout.rects(screen).get("b") as Rect).width).toBe(18);
    layout.growDock(0.05);
    expect((layout.rects(screen).get("b") as Rect).width).toBe(24);
    assertExactTiling(layout);
  });

  it("traverses focus between dock and main area", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("c");
    layout.dockFocused("left");
    expect(layout.moveFocus("right", screen)).toBe("a");
    expect(layout.moveFocus("left", screen)).toBe("c");
  });

  it("zooms a docked pane to the full screen", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left");
    layout.zoomToggle();
    expect(layout.rects(screen).get("b")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
    expect(layout.rects(screen).size).toBe(1);
  });

  it("opens next to a focused docked pane inside the dock", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left");
    layout.open("c", screen);
    expect(layout.dock()).toEqual({ side: "left", panes: ["b", "c"] });
    expect(layout.focused()).toBe("c");
    assertExactTiling(layout);
  });
});

describe("Layout zoom", () => {
  it("zooms the focused pane to the full screen and restores exactly", () => {
    const layout = layoutWith("a", "b", "c");
    const before = layout.rects(screen);
    layout.focus("b");
    layout.zoomToggle();
    expect(layout.rects(screen).get("b")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
    expect(layout.rects(screen).size).toBe(1);
    layout.zoomToggle();
    expect(layout.rects(screen)).toEqual(before);
  });

  it("clears the zoom when opening a new pane", () => {
    const layout = layoutWith("a", "b");
    layout.zoomToggle();
    layout.open("c", screen);
    expect(layout.zoomed()).toBeUndefined();
    expect(layout.rects(screen).size).toBe(3);
  });
});
