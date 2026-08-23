import { describe, expect, it } from "vitest";
import { encloses, fullRect } from "./geometry.ts";
import { type DropTarget, Layout, minPaneSize, type Rect, type Screen } from "./layout.ts";
import { paneChromeCost } from "./pane-chrome.ts";

const screen: Screen = { width: 120, height: 40 };

function layoutWith(...ids: string[]): Layout {
  const layout = new Layout();
  for (const id of ids) expect(layout.open(id, screen)).toBe(true);
  return layout;
}

function assertExactTiling(layout: Layout, on: Screen = screen): void {
  const paneRects = [...layout.rects(on).values()];
  const full = fullRect(on);
  for (const rect of paneRects) {
    expect(encloses(full, rect)).toBe(true);
    if (paneRects.length === 1 && rect.width === full.width && rect.height === full.height)
      continue;
    expect(rect.width).toBeGreaterThanOrEqual(minPaneSize.width);
    expect(rect.height).toBeGreaterThanOrEqual(minPaneSize.height);
  }
  const idleMain = layout.emptyMainRect(on);
  const rects = idleMain === undefined ? paneRects : [...paneRects, idleMain];
  const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  expect(area).toBe(on.width * on.height);
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

  it("tiles exactly for any sequence of opens, closes, docks, cycles, resizes, and screen changes", () => {
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
    const screens: Screen[] = [
      screen,
      { width: 80, height: 24 },
      { width: 40, height: 12 },
      { width: 20, height: 8 },
      { width: 9, height: 5 },
      screen,
    ];
    let on = screen;
    const paneBudget = 10;
    for (let step = 0; step < steps; step += 1) {
      if (random() < 0.1) on = screens[Math.floor(random() * screens.length)] ?? screen;
      const roll = alive.length === 0 ? 0 : alive.length >= paneBudget ? 0.98 : random();
      if (roll < 0.35) {
        const id = `p${step}`;
        if (layout.open(id, on)) alive.push(id);
        const focusTarget = alive[Math.floor(random() * alive.length)] as string;
        layout.focus(focusTarget);
      } else if (roll < 0.45) {
        layout.dockFocused(sides[Math.floor(random() * sides.length)] ?? "left", on);
      } else if (roll < 0.53) {
        layout.cycleFocused(on);
      } else if (roll < 0.6) {
        layout.undockFocused(on);
      } else if (roll < 0.66) {
        layout.zoomToggle();
      } else if (roll < 0.73) {
        layout.moveFocus(directions[Math.floor(random() * directions.length)] ?? "left", on);
      } else if (roll < 0.79) {
        layout.move(directions[Math.floor(random() * directions.length)] ?? "left", on);
      } else if (roll < 0.85) {
        layout.growDock(
          sides[Math.floor(random() * sides.length)] ?? "left",
          (random() - 0.5) * 0.4,
        );
      } else if (roll < 0.92) {
        layout.resizeFocused((random() - 0.5) * 0.4);
      } else if (roll < 0.96) {
        const dragged = layout.focused() as string;
        const target = layout.dropTargetAt(
          dragged,
          Math.floor(random() * on.width),
          Math.floor(random() * on.height),
          on,
        );
        if (target !== undefined) expect(layout.applyDrop(dragged, target, on)).toBe(true);
      } else {
        const victim = alive.splice(Math.floor(random() * alive.length), 1)[0] as string;
        layout.close(victim);
      }
      if (alive.length === 0) {
        expect(layout.rects(on).size).toBe(0);
        expect(layout.focused()).toBeUndefined();
        continue;
      }
      assertExactTiling(layout, on);
      expect(alive).toContain(layout.focused());
      expect(layout.rects(on).has(layout.focused() as string)).toBe(true);
      expect([...layout.rects(on).keys()].every((id) => alive.includes(id))).toBe(true);
      if (layout.zoomed() === undefined) expect(layout.rects(screen).size).toBe(alive.length);
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
    expect(layout.dock("left")).toEqual({ panes: ["b"], ratio: 1 / 3, pins: 0 });
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
    expect(layout.dock("left")).toEqual({ panes: ["b"], ratio: 1 / 3, pins: 0 });
    expect(layout.dock("right")).toEqual({ panes: ["c"], ratio: 1 / 3, pins: 0 });
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
    expect(layout.dock("left")).toEqual({ panes: ["b"], ratio: 1 / 3, pins: 0 });
    expect(layout.dock("right")).toEqual({ panes: ["c"], ratio: 1 / 3, pins: 0 });
    expect((layout.rects(screen).get("c") as Rect).x).toBe(80);
    assertExactTiling(layout);
  });

  it("treats docking to the pane's own side as a no-op", () => {
    const layout = layoutWith("a", "b");
    layout.dockFocused("left", screen);
    const before = layout.rects(screen);
    expect(layout.dockFocused("left", screen)).toBe(true);
    expect(layout.dock("left")).toEqual({ panes: ["b"], ratio: 1 / 3, pins: 0 });
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
    expect(layout.dock("left")).toEqual({ panes: ["b", "c"], ratio: 1 / 3, pins: 0 });
    expect(layout.focused()).toBe("c");
    assertExactTiling(layout);
  });
});

describe("Layout pins", () => {
  function dockedLeft(...ids: string[]): Layout {
    const layout = layoutWith("main", ...ids);
    for (const id of ids) {
      layout.focus(id);
      layout.dockFocused("left", screen);
    }
    return layout;
  }

  it("pins move to the head of their dock in pin order and unpin drops to the free head", () => {
    const layout = dockedLeft("a", "b", "c");
    layout.focus("c");
    expect(layout.pinFocused()).toBe(true);
    expect(layout.dock("left")).toEqual({ panes: ["c", "a", "b"], ratio: 1 / 3, pins: 1 });
    layout.focus("b");
    layout.pinFocused();
    expect(layout.dock("left")?.panes).toEqual(["c", "b", "a"]);
    expect(layout.pinned("c") && layout.pinned("b") && !layout.pinned("a")).toBe(true);
    layout.focus("c");
    expect(layout.unpinFocused()).toBe(true);
    expect(layout.dock("left")).toEqual({ panes: ["b", "c", "a"], ratio: 1 / 3, pins: 1 });
    assertExactTiling(layout);
  });

  it("refuses to pin a main-area pane and pinning twice is a no-op", () => {
    const layout = dockedLeft("a");
    layout.focus("main");
    expect(layout.pinFocused()).toBe(false);
    expect(layout.unpinFocused()).toBe(false);
    layout.focus("a");
    layout.pinFocused();
    layout.pinFocused();
    expect(layout.dock("left")).toEqual({ panes: ["a"], ratio: 1 / 3, pins: 1 });
  });

  it("moves within the pinned group or within the free group, never across", () => {
    const layout = dockedLeft("a", "b", "c", "d");
    layout.focus("c");
    layout.pinFocused();
    layout.focus("d");
    layout.pinFocused();
    expect(layout.dock("left")?.panes).toEqual(["c", "d", "a", "b"]);
    layout.focus("d");
    expect(layout.move("down", screen)).toBe(false);
    expect(layout.move("up", screen)).toBe(true);
    expect(layout.dock("left")?.panes).toEqual(["d", "c", "a", "b"]);
    layout.focus("a");
    expect(layout.move("up", screen)).toBe(false);
    expect(layout.move("down", screen)).toBe(true);
    expect(layout.dock("left")?.panes).toEqual(["d", "c", "b", "a"]);
    expect(layout.dock("left")?.pins).toBe(2);
  });

  it("lands arrivals below the pins however they arrive", () => {
    const layout = dockedLeft("a");
    layout.focus("a");
    layout.pinFocused();
    expect(layout.open("opened", screen)).toBe(true);
    expect(layout.dock("left")?.panes).toEqual(["a", "opened"]);
    layout.focus("main");
    expect(layout.move("left", screen)).toBe(true);
    expect(layout.dock("left")?.panes[0]).toBe("a");
    expect(layout.open("fresh", screen)).toBe(true);
    layout.dockFocused("left", screen);
    const region = layout.rects(screen).get("a") as Rect;
    const target = layout.dropTargetAt("fresh", region.x, region.y, screen) as DropTarget;
    expect(target.kind).toBe("dock");
    expect(layout.applyDrop("fresh", target, screen)).toBe(true);
    expect(layout.dock("left")?.panes[0]).toBe("a");
    expect(layout.pinned("a")).toBe(true);
    assertExactTiling(layout);
  });

  it("carries the pin across docks and sheds it in the main area", () => {
    const layout = dockedLeft("a", "b");
    layout.focus("b");
    layout.pinFocused();
    layout.focus("main");
    layout.dockFocused("right", screen);
    layout.focus("b");
    expect(layout.cycleFocused(screen)).toBe(true);
    expect(layout.dock("right")).toEqual({ panes: ["b", "main"], ratio: 1 / 3, pins: 1 });
    expect(layout.dock("left")).toEqual({ panes: ["a"], ratio: 1 / 3, pins: 0 });
    expect(layout.cycleFocused(screen)).toBe(true);
    expect(layout.dockSideOf("b")).toBeUndefined();
    expect(layout.pinned("b")).toBe(false);
    layout.dockFocused("left", screen);
    expect(layout.dock("left")).toEqual({ panes: ["a", "b"], ratio: 1 / 3, pins: 0 });
  });

  it("closing a pinned pane releases its slot", () => {
    const layout = dockedLeft("a", "b");
    layout.focus("a");
    layout.pinFocused();
    layout.close("a");
    expect(layout.dock("left")).toEqual({ panes: ["b"], ratio: 1 / 3, pins: 0 });
  });

  it("round-trips pins through the persisted state and clamps nonsense", () => {
    const layout = dockedLeft("a", "b");
    layout.focus("b");
    layout.pinFocused();
    const saved = JSON.parse(JSON.stringify(layout.toJSON()));
    const revived = new Layout();
    revived.load(Layout.parse(saved) as ReturnType<typeof Layout.parse> & object);
    expect(revived.dock("left")).toEqual({ panes: ["b", "a"], ratio: 1 / 3, pins: 1 });
    const nonsense = Layout.parse({ ...saved, docks: { left: { ...saved.docks.left, pins: 9 } } });
    expect(nonsense?.docks?.left?.pins).toBe(2);
    const absent = Layout.parse({ ...saved, docks: { left: { panes: ["b", "a"], ratio: 0.3 } } });
    expect(absent?.docks?.left?.pins).toBe(0);
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
  it("keeps every rect inside the screen at tiny sizes", () => {
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
      const rects = layout.rects(size);
      expect(rects.has("c")).toBe(true);
      for (const rect of rects.values()) expect(encloses(fullRect(size), rect)).toBe(true);
    }
  });

  it("keeps docks and main inside the screen at width one", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("c");
    layout.dockFocused("right", screen);
    const slim: Screen = { width: 1, height: 10 };
    for (const rect of layout.rects(slim).values()) {
      expect(encloses(fullRect(slim), rect)).toBe(true);
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

describe("Layout drag & drop", () => {
  it("targets a sibling main pane for a swap and applies it", () => {
    const layout = layoutWith("a", "b", "c");
    const before = layout.rects(screen);
    const target = layout.dropTargetAt("a", 90, 5, screen);
    expect(target).toEqual({ kind: "swap", with: "b", rect: before.get("b") });
    expect(layout.applyDrop("a", target as DropTarget, screen)).toBe(true);
    const after = layout.rects(screen);
    expect(after.get("a")).toEqual(before.get("b"));
    expect(after.get("b")).toEqual(before.get("a"));
    expect(layout.focused()).toBe("a");
    assertExactTiling(layout);
  });

  it("hovering the dragged pane's own rect offers no target", () => {
    const layout = layoutWith("a", "b");
    expect(layout.dropTargetAt("a", 10, 10, screen)).toBeUndefined();
  });

  it("targets a dock insertion slot whose rect is the landing geometry", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("c");
    layout.dockFocused("left", screen);
    const dockRect = layout.rects(screen).get("c") as Rect;
    const target = layout.dropTargetAt(
      "a",
      dockRect.x + 1,
      dockRect.y + dockRect.height - 1,
      screen,
    );
    expect(target).toMatchObject({ kind: "dock", side: "left", index: 1 });
    expect((target as DropTarget).rect.y).toBe(dockRect.y + Math.floor(dockRect.height / 2));
    expect(layout.applyDrop("a", target as DropTarget, screen)).toBe(true);
    expect(layout.dock("left")?.panes).toEqual(["c", "a"]);
    expect(layout.focused()).toBe("a");
    assertExactTiling(layout);
  });

  it("reorders within a dock by dropping into another slot band", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("b");
    layout.dockFocused("left", screen);
    layout.focus("c");
    layout.dockFocused("left", screen);
    expect(layout.dock("left")?.panes).toEqual(["b", "c"]);
    const target = layout.dropTargetAt("b", 1, screen.height - 1, screen);
    expect(target).toMatchObject({ kind: "dock", side: "left", index: 1 });
    expect(layout.applyDrop("b", target as DropTarget, screen)).toBe(true);
    expect(layout.dock("left")?.panes).toEqual(["c", "b"]);
    assertExactTiling(layout);
  });

  it("swaps a docked pane with a main pane, exchanging their homes", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("c");
    layout.dockFocused("left", screen);
    const mainRect = layout.rects(screen).get("b") as Rect;
    const target = layout.dropTargetAt("c", mainRect.x + 1, mainRect.y + 1, screen);
    expect(target).toEqual({ kind: "swap", with: "b", rect: mainRect });
    expect(layout.applyDrop("c", target as DropTarget, screen)).toBe(true);
    expect(layout.dockSideOf("b")).toBe("left");
    expect(layout.dockSideOf("c")).toBeUndefined();
    expect(layout.rects(screen).get("c")).toEqual(mainRect);
    assertExactTiling(layout);
  });

  it("lands a lone docked pane back into an empty main area", () => {
    const layout = layoutWith("a");
    layout.dockFocused("left", screen);
    const main = layout.emptyMainRect(screen) as Rect;
    const target = layout.dropTargetAt("a", main.x + 5, 5, screen);
    expect(target).toEqual({ kind: "main", rect: main });
    expect(layout.applyDrop("a", target as DropTarget, screen)).toBe(true);
    expect(layout.dockSideOf("a")).toBeUndefined();
    expect(layout.rects(screen).get("a")).toEqual({ x: 0, y: 0, width: 120, height: 40 });
    assertExactTiling(layout);
  });

  it("offers no dock target when the dock cannot hold another pane", () => {
    const short: Screen = { width: 120, height: 8 };
    const layout = new Layout();
    for (const id of ["a", "b", "c", "d"]) expect(layout.open(id, short)).toBe(true);
    layout.focus("b");
    layout.dockFocused("left", short);
    layout.focus("c");
    layout.dockFocused("left", short);
    expect(layout.dock("left")?.panes).toEqual(["b", "c"]);
    expect(layout.dropTargetAt("a", 1, 4, short)).toBeUndefined();
  });

  it("offers no target while a pane is zoomed", () => {
    const layout = layoutWith("a", "b");
    layout.zoomToggle();
    expect(layout.dropTargetAt("a", 90, 10, screen)).toBeUndefined();
  });
});

describe("screens too small for the arrangement", () => {
  const small: Screen = { width: 14, height: 6 };

  it("hides the panes that cannot keep their minimum size and keeps the focused one", () => {
    const layout = layoutWith("a", "b", "c", "d");
    expect([...layout.rects(small).keys()].sort()).toEqual(["a", "b", "d"]);
    assertExactTiling(layout, small);
    expect(layout.panes()).toEqual(["a", "b", "c", "d"]);
  });

  it("shows the whole arrangement again, untouched, once the screen grows back", () => {
    const layout = layoutWith("a", "b", "c", "d");
    const before = layout.rects(screen);
    const tree = layout.root();
    expect(layout.rects(small).size).toBe(3);
    expect(layout.root()).toEqual(tree);
    expect(layout.rects(screen)).toEqual(before);
  });

  it("gives the focused pane the whole screen when not even one pane can be tiled", () => {
    const layout = layoutWith("a", "b", "c", "d");
    const tiny: Screen = { width: 4, height: 2 };
    expect(layout.rects(tiny)).toEqual(new Map([["d", { x: 0, y: 0, width: 4, height: 2 }]]));
    expect(layout.emptyMainRect(tiny)).toBeUndefined();
  });

  it("brings a hidden pane back on screen when it takes focus", () => {
    const layout = layoutWith("a", "b", "c", "d");
    layout.focus("c");
    expect([...layout.rects(small).keys()].sort()).toEqual(["a", "b", "c"]);
    assertExactTiling(layout, small);
  });

  it("keeps the main stage and yields the dock when both cannot fit", () => {
    const layout = layoutWith("a", "b", "c");
    layout.dockFocused("left", screen);
    layout.focus("a");
    const narrow: Screen = { width: 14, height: 10 };
    expect([...layout.rects(narrow).keys()].sort()).toEqual(["a", "b"]);
    assertExactTiling(layout, narrow);
  });

  it("navigates only among the panes on screen", () => {
    const layout = layoutWith("a", "b", "c", "d");
    layout.focus("b");
    expect(layout.moveFocus("down", small)).toBe("c");
    expect(layout.rects(small).has("d")).toBe(false);
  });

  it("refuses to open another pane into a screen that is already too small", () => {
    const layout = layoutWith("a", "b", "c", "d");
    expect(layout.open("e", small)).toBe(false);
    expect(layout.panes()).toEqual(["a", "b", "c", "d"]);
  });
});
