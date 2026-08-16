import { describe, expect, it } from "vitest";
import { Layout, type LayoutState, minPaneSize, type Rect, type Screen } from "./layout.ts";
import { paneChromeCost } from "./pane-chrome.ts";

const screen: Screen = { width: 120, height: 40 };

function layoutWith(...ids: string[]): Layout {
  const layout = new Layout();
  for (const id of ids) expect(layout.open(id, screen)).toBe(true);
  return layout;
}

function assertExactTiling(layout: Layout): void {
  const paneRects = [...layout.rects(screen).values()];
  for (const rect of paneRects) {
    expect(rect.width).toBeGreaterThanOrEqual(minPaneSize.width);
    expect(rect.height).toBeGreaterThanOrEqual(minPaneSize.height);
  }
  const idleMain = layout.emptyMainRect(screen);
  const rects = idleMain === undefined ? paneRects : [...paneRects, idleMain];
  const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  expect(area).toBe(screen.width * screen.height);
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

  it("tiles exactly for any sequence of opens, closes, docks, cycles, and resizes", () => {
    const layout = new Layout();
    const alive: string[] = [];
    const steps = 300;
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const sides = ["left", "right"] as const;
    const directions = ["left", "right", "up", "down"] as const;
    const paneBudget = 10;
    for (let step = 0; step < steps; step += 1) {
      const roll = alive.length === 0 ? 0 : alive.length >= paneBudget ? 0.95 : random();
      if (roll < 0.35) {
        const id = `p${step}`;
        if (layout.open(id, screen)) alive.push(id);
        const focusTarget = alive[Math.floor(random() * alive.length)] as string;
        layout.focus(focusTarget);
      } else if (roll < 0.45) {
        layout.dockFocused(sides[Math.floor(random() * sides.length)] ?? "left", screen);
      } else if (roll < 0.53) {
        layout.cycleFocused(screen);
      } else if (roll < 0.6) {
        layout.undockFocused(screen);
      } else if (roll < 0.66) {
        layout.zoomToggle();
      } else if (roll < 0.73) {
        layout.moveFocus(directions[Math.floor(random() * directions.length)] ?? "left", screen);
      } else if (roll < 0.79) {
        layout.move(directions[Math.floor(random() * directions.length)] ?? "left", screen);
      } else if (roll < 0.85) {
        layout.growDock(
          sides[Math.floor(random() * sides.length)] ?? "left",
          (random() - 0.5) * 0.4,
        );
      } else if (roll < 0.92) {
        layout.resizeFocused((random() - 0.5) * 0.4);
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
      expect(layout.rects(screen).has(layout.focused() as string)).toBe(true);
      expect([...layout.panes()].sort()).toEqual([...alive].sort());
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
    layout.move("right", screen);
    const rects = layout.rects(screen);
    expect((rects.get("a") as Rect).x).toBeGreaterThan((rects.get("b") as Rect).x);
    expect(layout.focused()).toBe("a");
  });
});

describe("Layout dock", () => {
  it("docks the focused pane into a full-height column", () => {
    const layout = layoutWith("a", "b");
    layout.focus("b");
    layout.dockFocused("left", screen);
    const rects = layout.rects(screen);
    expect(rects.get("b")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(rects.get("a")).toEqual({ x: 40, y: 0, width: 80, height: 40 });
    expect(layout.dock("left")).toEqual({ panes: ["b"], ratio: 1 / 3 });
    assertExactTiling(layout);
  });

  it("docks to the right edge when asked", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("right", screen);
    expect(layout.rects(screen).get("b")).toEqual({ x: 80, y: 0, width: 40, height: 40 });
    assertExactTiling(layout);
  });

  it("stacks additional docked panes vertically with equal heights", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("c");
    layout.dockFocused("left", screen);
    const rects = layout.rects(screen);
    expect(rects.get("b")).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    expect(rects.get("c")).toEqual({ x: 0, y: 20, width: 40, height: 20 });
    assertExactTiling(layout);
  });

  it("hosts independent docks on both edges at once", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("c");
    layout.dockFocused("right", screen);
    const rects = layout.rects(screen);
    expect(rects.get("b")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(rects.get("a")).toEqual({ x: 40, y: 0, width: 40, height: 40 });
    expect(rects.get("c")).toEqual({ x: 80, y: 0, width: 40, height: 40 });
    expect(layout.dock("left")).toEqual({ panes: ["b"], ratio: 1 / 3 });
    expect(layout.dock("right")).toEqual({ panes: ["c"], ratio: 1 / 3 });
    assertExactTiling(layout);
  });

  it("keeps its width and leaves the main area idle when the only pane is docked", () => {
    const layout = layoutWith("a");
    layout.dockFocused("left", screen);
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(layout.emptyMainRect(screen)).toEqual({ x: 40, y: 0, width: 80, height: 40 });
    expect(layout.panes()).toEqual(["a"]);
    assertExactTiling(layout);
  });

  it("keeps an idle main area between the docks when every pane is docked", () => {
    const layout = layoutWith("a", "b");
    layout.focus("a");
    layout.dockFocused("left", screen);
    layout.focus("b");
    layout.dockFocused("right", screen);
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(layout.rects(screen).get("b")).toEqual({ x: 80, y: 0, width: 40, height: 40 });
    expect(layout.emptyMainRect(screen)).toEqual({ x: 40, y: 0, width: 40, height: 40 });
    assertExactTiling(layout);
  });

  it("offers no idle main rect while a pane tiles the main area", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left", screen);
    expect(layout.emptyMainRect(screen)).toBeUndefined();
  });

  it("offers no idle main rect while a docked pane is zoomed", () => {
    const layout = layoutWith("a");
    layout.dockFocused("left", screen);
    layout.zoomToggle();
    expect(layout.emptyMainRect(screen)).toBeUndefined();
  });

  it("reclaims the full width when the dock empties through close", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left", screen);
    layout.close("b");
    expect(layout.dock("left")).toBeUndefined();
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
    expect(layout.focused()).toBe("a");
  });

  it("keeps a valid focus after closing the focused docked pane", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("c");
    layout.dockFocused("left", screen);
    layout.close("c");
    expect(layout.focused()).toBe("b");
    layout.close("b");
    expect(layout.focused()).toBe("a");
  });

  it("undocks the focused pane back into the main tiling", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left", screen);
    layout.undockFocused(screen);
    expect(layout.dock("left")).toBeUndefined();
    expect(layout.rects(screen).get("b")).toEqual({ x: 60, y: 0, width: 60, height: 40 });
    assertExactTiling(layout);
  });

  it("undocks into an empty main area as the sole pane", () => {
    const layout = layoutWith("a");
    layout.dockFocused("right", screen);
    layout.undockFocused(screen);
    expect(layout.dock("right")).toBeUndefined();
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
  });

  it("moves only the focused pane when docking to the other side", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("c");
    layout.dockFocused("left", screen);
    layout.dockFocused("right", screen);
    expect(layout.dock("left")).toEqual({ panes: ["b"], ratio: 1 / 3 });
    expect(layout.dock("right")).toEqual({ panes: ["c"], ratio: 1 / 3 });
    expect((layout.rects(screen).get("c") as Rect).x).toBe(80);
    assertExactTiling(layout);
  });

  it("treats docking to the pane's own side as a no-op", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left", screen);
    const before = layout.rects(screen);
    expect(layout.dockFocused("left", screen)).toBe(true);
    expect(layout.dock("left")).toEqual({ panes: ["b"], ratio: 1 / 3 });
    expect(layout.rects(screen)).toEqual(before);
  });

  it("resizes each dock independently within clamped bounds", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("c");
    layout.dockFocused("right", screen);
    layout.growDock("left", 1);
    expect((layout.rects(screen).get("b") as Rect).width).toBe(72);
    layout.growDock("left", -1);
    expect((layout.rects(screen).get("b") as Rect).width).toBe(6);
    expect((layout.rects(screen).get("c") as Rect).width).toBe(40);
    layout.growDock("right", 0.05);
    expect((layout.rects(screen).get("c") as Rect).width).toBe(46);
    expect((layout.rects(screen).get("b") as Rect).width).toBe(6);
    assertExactTiling(layout);
  });

  it("traverses focus between dock and main area", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("c");
    layout.dockFocused("left", screen);
    expect(layout.moveFocus("right", screen)).toBe("a");
    expect(layout.moveFocus("left", screen)).toBe("c");
  });

  it("zooms a docked pane to the full screen", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left", screen);
    layout.zoomToggle();
    expect(layout.rects(screen).get("b")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
    expect(layout.rects(screen).size).toBe(1);
  });

  it("opens next to a focused docked pane inside the dock", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left", screen);
    layout.open("c", screen);
    expect(layout.dock("left")).toEqual({ panes: ["b", "c"], ratio: 1 / 3 });
    expect(layout.focused()).toBe("c");
    assertExactTiling(layout);
  });
});

describe("Layout cycle", () => {
  it("cycles the focused pane main → left → right → main", () => {
    const layout = layoutWith("a", "b");
    layout.focus("b");
    expect(layout.cycleFocused(screen)).toBe(true);
    expect(layout.dock("left")?.panes).toEqual(["b"]);
    expect(layout.cycleFocused(screen)).toBe(true);
    expect(layout.dock("left")).toBeUndefined();
    expect(layout.dock("right")?.panes).toEqual(["b"]);
    expect(layout.cycleFocused(screen)).toBe(true);
    expect(layout.dockSideOf("b")).toBeUndefined();
    expect(layout.panes()).toEqual(["a", "b"]);
    expect(layout.focused()).toBe("b");
    assertExactTiling(layout);
  });

  it("three cycles bring a pane home without disturbing either dock", () => {
    const layout = layoutWith("a", "b", "c", "d");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("c");
    layout.dockFocused("right", screen);
    layout.focus("d");
    for (const home of ["left", "right", undefined] as const) {
      expect(layout.cycleFocused(screen)).toBe(true);
      expect(layout.dockSideOf("d")).toBe(home);
      assertExactTiling(layout);
    }
    expect(layout.dock("left")?.panes).toEqual(["b"]);
    expect(layout.dock("right")?.panes).toEqual(["c"]);
    expect(layout.focused()).toBe("d");
  });
});

describe("Layout split ratios", () => {
  it("grows the focused pane along its parent split", () => {
    const layout = layoutWith("a", "b");
    layout.focus("b");
    layout.resizeFocused(0.1);
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 48, height: 40 });
    expect(layout.rects(screen).get("b")).toEqual({ x: 48, y: 0, width: 72, height: 40 });
    assertExactTiling(layout);
  });

  it("shrinks the focused pane with a negative delta", () => {
    const layout = layoutWith("a", "b");
    layout.focus("b");
    layout.resizeFocused(-0.1);
    expect((layout.rects(screen).get("b") as Rect).width).toBe(48);
    assertExactTiling(layout);
  });

  it("clamps the ratio so repeated growth stalls at the bounds", () => {
    const layout = layoutWith("a", "b");
    layout.focus("a");
    for (let i = 0; i < 50; i += 1) layout.resizeFocused(0.05);
    expect((layout.rects(screen).get("a") as Rect).width).toBe(108);
    layout.resizeFocused(0.05);
    expect((layout.rects(screen).get("a") as Rect).width).toBe(108);
    assertExactTiling(layout);
  });

  it("never collapses a pane below the minimum cells on a small screen", () => {
    const small: Screen = { width: 20, height: 4 };
    const layout = new Layout();
    layout.open("a", small);
    layout.open("b", small);
    layout.resizeFocused(10);
    const rects = layout.rects(small);
    expect((rects.get("a") as Rect).width).toBeGreaterThanOrEqual(5);
    expect((rects.get("b") as Rect).width).toBeGreaterThanOrEqual(5);
  });

  it("never collapses a pane below the minimum rows in a column split", () => {
    const tall: Screen = { width: 10, height: 12 };
    const layout = new Layout();
    layout.open("a", tall);
    layout.open("b", tall);
    layout.focus("a");
    layout.resizeFocused(10);
    expect((layout.rects(tall).get("b") as Rect).height).toBeGreaterThanOrEqual(3);
  });

  it("restores the identical tree and rects through zoom, ratios included", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("c");
    layout.resizeFocused(0.15);
    const tree = layout.root();
    const before = layout.rects(screen);
    layout.zoomToggle();
    layout.zoomToggle();
    expect(layout.root()).toEqual(tree);
    expect(layout.rects(screen)).toEqual(before);
  });

  it("keeps the adjusted ratio in place when panes swap", () => {
    const layout = layoutWith("a", "b");
    layout.focus("a");
    layout.resizeFocused(0.1);
    layout.move("right", screen);
    const rects = layout.rects(screen);
    expect((rects.get("b") as Rect).width).toBe(72);
    expect((rects.get("a") as Rect).width).toBe(48);
    assertExactTiling(layout);
  });

  it("stays gapless after resizing and closing panes", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.resizeFocused(0.2);
    layout.close("b");
    assertExactTiling(layout);
    layout.resizeFocused(0.1);
    assertExactTiling(layout);
  });

  it("ignores resize for a sole or docked pane", () => {
    const layout = layoutWith("a");
    layout.resizeFocused(0.2);
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
    layout.open("b", screen);
    layout.dockFocused("left", screen);
    const before = layout.rects(screen);
    layout.resizeFocused(0.2);
    expect(layout.rects(screen)).toEqual(before);
  });
});

describe("honest minimums", () => {
  it("derives its minimums from the pane chrome cost plus one content cell", () => {
    expect(minPaneSize).toEqual({
      width: paneChromeCost.columns + 1,
      height: paneChromeCost.rows + 1,
    });
  });

  it("the first pane always lands, even on a screen below minimums", () => {
    const tiny: Screen = { width: 4, height: 2 };
    const layout = new Layout();
    expect(layout.open("a", tiny)).toBe(true);
    expect(layout.rects(tiny).get("a")).toEqual({ x: 0, y: 0, width: 4, height: 2 });
  });

  it("refuses a split that cannot honor minimum pane sizes", () => {
    const small: Screen = { width: 9, height: 5 };
    const layout = new Layout();
    expect(layout.open("a", small)).toBe(true);
    expect(layout.open("b", small)).toBe(false);
    expect(layout.panes()).toEqual(["a"]);
    expect(layout.rects(small).get("a")).toEqual({ x: 0, y: 0, width: 9, height: 5 });
  });

  it("a refused open leaves zoom, focus, and geometry untouched", () => {
    const small: Screen = { width: 12, height: 5 };
    const layout = new Layout();
    layout.open("a", small);
    layout.open("b", small);
    layout.zoomToggle();
    const before = layout.rects(small);
    expect(layout.open("c", small)).toBe(false);
    expect(layout.zoomed()).toBe("b");
    expect(layout.focused()).toBe("b");
    expect(layout.rects(small)).toEqual(before);
  });

  it("refuses stacking the dock past its room", () => {
    const short: Screen = { width: 40, height: 8 };
    const layout = new Layout();
    layout.open("a", short);
    layout.open("b", short);
    layout.focus("b");
    layout.dockFocused("left", short);
    expect(layout.open("c", short)).toBe(true);
    expect(layout.open("d", short)).toBe(false);
    expect(layout.dock("left")?.panes).toEqual(["b", "c"]);
  });

  it("refuses a dock move that would overfill the target stack", () => {
    const short: Screen = { width: 40, height: 8 };
    const layout = new Layout();
    layout.open("a", short);
    layout.open("b", short);
    layout.focus("b");
    layout.dockFocused("left", short);
    layout.open("c", short);
    layout.focus("a");
    expect(layout.dockFocused("left", short)).toBe(false);
    expect(layout.dockSideOf("a")).toBeUndefined();
    expect(layout.dock("left")?.panes).toEqual(["b", "c"]);
  });

  it("refuses docking when the column cannot fit its minimum width", () => {
    const narrow: Screen = { width: 9, height: 10 };
    const layout = new Layout();
    layout.open("a", narrow);
    layout.open("b", narrow);
    expect(layout.dockFocused("right", narrow)).toBe(false);
    expect(layout.dockSideOf("b")).toBeUndefined();
  });

  it("refuses an undock whose landing split cannot honor minimums", () => {
    const tight: Screen = { width: 15, height: 5 };
    const layout = new Layout();
    expect(layout.open("a", tight)).toBe(true);
    expect(layout.open("b", tight)).toBe(true);
    layout.focus("b");
    expect(layout.dockFocused("left", tight)).toBe(true);
    layout.growDock("left", 0.07);
    expect(layout.undockFocused(tight)).toBe(false);
    expect(layout.dock("left")?.panes).toEqual(["b"]);
    expect(layout.rects(tight).size).toBe(2);
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

  it("clears the zoom when focus jumps to another pane", () => {
    const layout = layoutWith("a", "b");
    layout.zoomToggle();
    expect(layout.zoomed()).toBe("b");
    layout.focus("a");
    expect(layout.zoomed()).toBeUndefined();
    expect(layout.rects(screen).size).toBe(2);
  });

  it("keeps the zoom when re-focusing the zoomed pane", () => {
    const layout = layoutWith("a", "b");
    layout.zoomToggle();
    layout.focus("b");
    expect(layout.zoomed()).toBe("b");
  });
});

describe("degenerate screens", () => {
  it("never produces negative extents at tiny sizes", () => {
    const wide: Screen = { width: 200, height: 40 };
    const layout = new Layout();
    layout.open("a", wide);
    layout.open("b", wide);
    layout.open("c", wide);
    const tiny: Screen[] = [
      { width: 1, height: 40 },
      { width: 2, height: 2 },
      { width: 0, height: 0 },
    ];
    for (const size of tiny) {
      for (const rect of layout.rects(size).values()) {
        expect(rect.width).toBeGreaterThanOrEqual(0);
        expect(rect.height).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("keeps docks and main non-negative at width one", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("c");
    layout.dockFocused("right", screen);
    for (const rect of layout.rects({ width: 1, height: 10 }).values()) {
      expect(rect.width).toBeGreaterThanOrEqual(0);
      expect(rect.height).toBeGreaterThanOrEqual(0);
    }
  });

  it("opens into the empty main area when every pane is docked", () => {
    const layout = layoutWith("a");
    layout.dockFocused("left", screen);
    layout.open("b", screen);
    expect(layout.dock("left")?.panes).toEqual(["a"]);
    expect(layout.root()).toEqual({ kind: "leaf", id: "b" });
    expect(layout.focused()).toBe("b");
  });
});

describe("Layout move", () => {
  it("reorders a docked pane within its stack and stops at the ends", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("c");
    layout.dockFocused("left", screen);
    expect(layout.dock("left")?.panes).toEqual(["b", "c"]);
    expect(layout.move("up", screen)).toBe(true);
    expect(layout.dock("left")?.panes).toEqual(["c", "b"]);
    expect(layout.move("up", screen)).toBe(false);
    assertExactTiling(layout);
  });

  it("moves a docked pane inward onto its near edge of the main area", () => {
    const layout = layoutWith("a", "b");
    layout.focus("b");
    layout.dockFocused("left", screen);
    expect(layout.move("right", screen)).toBe(true);
    expect(layout.dockSideOf("b")).toBeUndefined();
    const rects = layout.rects(screen);
    expect((rects.get("b") as Rect).x).toBeLessThan((rects.get("a") as Rect).x);
    assertExactTiling(layout);
  });

  it("keeps a docked pane put when moved outward", () => {
    const layout = layoutWith("a", "b");
    layout.focus("b");
    layout.dockFocused("left", screen);
    expect(layout.move("left", screen)).toBe(false);
    expect(layout.dockSideOf("b")).toBe("left");
  });

  it("pushes an edge main pane into the adjacent dock", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("a");
    expect(layout.move("left", screen)).toBe(true);
    expect(layout.dock("left")?.panes).toEqual(["b", "a"]);
    expect(layout.dockSideOf("a")).toBe("left");
    assertExactTiling(layout);
  });

  it("promotes a main pane to the edge when nothing blocks it", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("a");
    expect(layout.move("up", screen)).toBe(true);
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 120, height: 20 });
    assertExactTiling(layout);
  });

  it("keeps the sole main pane put on an edge move", () => {
    const layout = layoutWith("a");
    expect(layout.move("left", screen)).toBe(false);
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
  });
});

describe("Layout dock resize handles", () => {
  it("exposes a grab handle on the dock/main boundary", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left", screen);
    expect(layout.dockHandleAt(39, screen)).toBe("left");
    expect(layout.dockHandleAt(40, screen)).toBe("left");
    expect(layout.dockHandleAt(41, screen)).toBeUndefined();
  });

  it("drags the left dock edge to the pointer column", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left", screen);
    layout.dragDockEdge("left", 23, screen);
    expect((layout.rects(screen).get("b") as Rect).width).toBe(24);
    assertExactTiling(layout);
  });

  it("drags the right dock edge to the pointer column", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("right", screen);
    expect(layout.dockHandleAt(80, screen)).toBe("right");
    layout.dragDockEdge("right", 90, screen);
    expect(layout.rects(screen).get("b")).toEqual({ x: 90, y: 0, width: 30, height: 40 });
    assertExactTiling(layout);
  });
});

describe("serialization", () => {
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
    revived.load(state as NonNullable<typeof state>);

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

  it("migrates a v1 single-dock state into that side's dock, other side empty", () => {
    const state = Layout.parse({
      tree: { kind: "leaf", id: "a" },
      focused: "b",
      dock: { side: "right", panes: ["b"], ratio: 0.25 },
    });
    expect(state?.docks).toEqual({ right: { panes: ["b"], ratio: 0.25 } });
    const revived = new Layout();
    revived.load(state as LayoutState);
    expect(revived.dock("right")).toEqual({ panes: ["b"], ratio: 0.25 });
    expect(revived.dock("left")).toBeUndefined();
    expect(revived.focused()).toBe("b");
  });

  it("clamps out-of-bounds ratios on parse", () => {
    const state = Layout.parse({
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

  it("rejects corrupt shapes wholesale", () => {
    const leaf = { kind: "leaf", id: "a" };
    const corrupt: unknown[] = [
      null,
      "layout",
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
    for (const value of corrupt) expect(Layout.parse(value)).toBeUndefined();
  });
});
