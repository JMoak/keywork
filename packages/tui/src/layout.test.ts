import { describe, expect, it } from "vitest";
import { encloses, fullRect } from "./geometry.ts";
import { type DropTarget, Layout, minPaneSize, type Rect, type Screen } from "./layout.ts";

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

describe("Layout dock weights", () => {
  function weighted(): Layout {
    const layout = new Layout({ dockWeight: (id) => (id.startsWith("half") ? 0.5 : 1) });
    for (const id of ["main", "full", "half"]) expect(layout.open(id, screen)).toBe(true);
    for (const id of ["full", "half"]) {
      layout.focus(id);
      layout.dockFocused("left", screen);
    }
    return layout;
  }

  it("gives a half-weight pane half the rows of a full one in the same dock", () => {
    const layout = weighted();
    const rects = layout.rects(screen);
    expect(rects.get("full")?.height).toBe(27);
    expect(rects.get("half")?.height).toBe(13);
    expect(rects.get("half")?.y).toBe(27);
    assertExactTiling(layout);
  });

  it("keeps every dock slot at the minimum height by evening out weights when space is short", () => {
    const layout = weighted();
    const tight: Screen = { width: 60, height: 8 };
    const rects = layout.rects(tight);
    expect(rects.get("full")?.height).toBe(rects.get("half")?.height);
    assertExactTiling(layout, tight);
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
});

describe("honest minimums", () => {
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

  it("refuses docking when the column cannot fit its minimum width", () => {
    const narrow: Screen = { width: 9, height: 10 };
    const layout = new Layout();
    layout.open("a", narrow);
    layout.open("b", narrow);
    expect(layout.dockFocused("right", narrow)).toBe(false);
    expect(layout.dockSideOf("b")).toBeUndefined();
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

  it("refuses to open another pane into a screen that is already too small", () => {
    const layout = layoutWith("a", "b", "c", "d");
    expect(layout.open("e", small)).toBe(false);
    expect(layout.panes()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("Layout focus trail and placed opens", () => {
  it("remembers focus most-recent-first and forgets closed panes", () => {
    const layout = layoutWith("a", "b", "c");
    expect(layout.recentlyFocused()).toEqual(["c", "b", "a"]);
    layout.focus("a");
    expect(layout.recentlyFocused()).toEqual(["a", "c", "b"]);
    layout.close("c");
    expect(layout.recentlyFocused()).toEqual(["a", "b"]);
    layout.load(layout.toJSON());
    expect(layout.recentlyFocused()).toEqual(["a", "b"]);
  });

  it("bounces between the two most recent panes", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("a");
    expect(layout.focusPrevious()).toBe("c");
    expect(layout.focusPrevious()).toBe("a");
    expect(layout.focusPrevious()).toBe("c");
    expect(layout.recentlyFocused()).toEqual(["c", "a", "b"]);
  });

  it("focuses the most recently used pane when the focused one closes", () => {
    const layout = layoutWith("a", "b", "c", "d");
    layout.focus("a");
    layout.focus("d");
    layout.close("d");
    expect(layout.focused()).toBe("a");
    layout.close("a");
    expect(layout.focused()).toBe("c");
  });

  it("keeps the recent list through a save and drops ids the layout no longer has", () => {
    const layout = layoutWith("a", "b", "c");
    layout.focus("a");
    const saved = layout.toJSON();
    expect(saved.recent).toEqual(["a", "c", "b"]);
    const parsed = Layout.parse({ ...saved, recent: ["ghost", "c", 7, "c", "a"] });
    expect(parsed?.recent).toEqual(["c", "a"]);
    const restored = new Layout();
    restored.load(parsed ?? {});
    expect(restored.focused()).toBe("a");
    expect(restored.focusPrevious()).toBe("c");
  });

  it("opens beside a named pane instead of the focused one, splitting by its shape", () => {
    const layout = layoutWith("a", "b");
    layout.focus("b");
    expect(layout.open("c", screen, "a")).toBe(true);
    expect(layout.focused()).toBe("c");
    const rects = layout.rects(screen);
    const a = rects.get("a");
    const c = rects.get("c");
    expect(a !== undefined && c !== undefined && a.x === c.x && c.y > a.y).toBe(true);
    assertExactTiling(layout);
  });

  it("opens at a main edge as a full-height column next to that side's dock", () => {
    const layout = layoutWith("a", "b", "c");
    expect(layout.openAtEdge("edge", "left", screen)).toBe(true);
    expect(layout.focused()).toBe("edge");
    const rect = layout.rects(screen).get("edge");
    expect(rect).toEqual({ x: 0, y: 0, width: 60, height: 40 });
    expect(layout.openAtEdge("edge", "right", screen)).toBe(false);
    assertExactTiling(layout);
  });
});

describe("interior split borders", () => {
  it("finds a handle on the boundary cells and drags the split onto the ratio lattice", () => {
    const layout = layoutWith("a", "b");
    expect(layout.splitHandleAt(60, 5, screen)).toEqual({ path: [] });
    expect(layout.splitHandleAt(59, 5, screen)).toEqual({ path: [] });
    expect(layout.splitHandleAt(58, 5, screen)).toBeUndefined();
    layout.dragSplitHandle({ path: [] }, 71, 5, screen);
    expect(layout.rects(screen).get("a")?.width).toBe(72);
    assertExactTiling(layout);
  });

  it("resolves nested handles and leaves the lower pane's title row for pane gestures", () => {
    const layout = layoutWith("a", "b", "c");
    expect(layout.splitHandleAt(70, 19, screen)).toEqual({ path: ["second"] });
    expect(layout.splitHandleAt(70, 20, screen)).toBeUndefined();
    layout.dragSplitHandle({ path: ["second"] }, 70, 23, screen);
    expect(layout.rects(screen).get("b")?.height).toBe(24);
    assertExactTiling(layout);
  });

  it("reaches the same widths by drag and by keyboard, in both directions", () => {
    const dragged = new Set<number>();
    for (let x = 10; x < 110; x += 1) {
      const layout = layoutWith("a", "b");
      layout.dragSplitHandle({ path: [] }, x, 5, screen);
      dragged.add(layout.rects(screen).get("a")?.width ?? 0);
    }
    const keyed = new Set<number>();
    for (let steps = -20; steps <= 20; steps += 1) {
      const layout = layoutWith("a", "b");
      layout.focus("a");
      for (let i = 0; i < Math.abs(steps); i += 1) {
        layout.resizeFocused(steps > 0 ? 0.05 : -0.05);
      }
      keyed.add(layout.rects(screen).get("a")?.width ?? 0);
    }
    expect([...dragged].sort((l, r) => l - r)).toEqual([...keyed].sort((l, r) => l - r));
  });

  it("holds the tiling invariant and the min-size floor at every dragged position on a nested seam", () => {
    const heights = new Set<number>();
    for (let y = 0; y < screen.height; y += 1) {
      const layout = layoutWith("a", "b", "c");
      layout.dragSplitHandle({ path: ["second"] }, 70, y, screen);
      assertExactTiling(layout);
      heights.add(layout.rects(screen).get("b")?.height ?? 0);
    }
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(minPaneSize.height);
    expect(heights.size).toBeGreaterThan(1);
  });
});

describe("Layout drag commits are keyboard-reachable", () => {
  const directions = ["left", "right", "up", "down"] as const;
  const sides = ["left", "right"] as const;

  function cloned(layout: Layout): Layout {
    const state = Layout.parse(JSON.parse(JSON.stringify(layout.toJSON())));
    if (state === undefined) throw new Error("layout state did not round-trip");
    const copy = new Layout();
    copy.load(state);
    return copy;
  }

  function keyOf(layout: Layout): string {
    const { recent: _history, ...arrangement } = layout.toJSON();
    return JSON.stringify(arrangement);
  }

  function keyboardSteps(layout: Layout): ((on: Layout) => void)[] {
    return [
      ...layout.panes().map((id) => (on: Layout) => on.focus(id)),
      ...directions.map((direction) => (on: Layout) => void on.move(direction, screen)),
      ...sides.map((side) => (on: Layout) => void on.dockFocused(side, screen)),
      (on: Layout) => void on.undockFocused(screen),
      (on: Layout) => void on.cycleFocused(screen),
    ];
  }

  function keyboardReaches(start: Layout, goal: string): boolean {
    const seen = new Set([keyOf(start)]);
    let frontier = [start];
    while (frontier.length > 0 && seen.size < 6000) {
      const next: Layout[] = [];
      for (const state of frontier) {
        for (const step of keyboardSteps(state)) {
          const candidate = cloned(state);
          step(candidate);
          const key = keyOf(candidate);
          if (key === goal) return true;
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(candidate);
        }
      }
      frontier = next;
    }
    return false;
  }

  function expectParity(layout: Layout, dragged: string, x: number, y: number): string | undefined {
    const target = layout.dropTargetAt(dragged, x, y, screen);
    if (target === undefined) return undefined;
    const landed = cloned(layout);
    expect(landed.applyDrop(dragged, target, screen)).toBe(true);
    expect(keyboardReaches(cloned(layout), keyOf(landed))).toBe(true);
    return target.kind;
  }

  it("matches the keyboard tree for each drop kind on hand-built layouts", () => {
    const swap = layoutWith("a", "b", "c");
    expect(expectParity(swap, "a", 90, 5)).toBe("swap");

    const dockInsert = layoutWith("a", "b", "c");
    dockInsert.focus("c");
    dockInsert.dockFocused("left", screen);
    const slot = dockInsert.rects(screen).get("c") as Rect;
    expect(expectParity(dockInsert, "a", slot.x + 1, slot.y + slot.height - 1)).toBe("dock");

    const reorder = layoutWith("a", "b", "c");
    for (const id of ["b", "c"]) {
      reorder.focus(id);
      reorder.dockFocused("left", screen);
    }
    expect(expectParity(reorder, "b", 1, screen.height - 1)).toBe("dock");

    const crossSwap = layoutWith("a", "b", "c");
    crossSwap.focus("c");
    crossSwap.dockFocused("left", screen);
    const mainRect = crossSwap.rects(screen).get("b") as Rect;
    expect(expectParity(crossSwap, "c", mainRect.x + 1, mainRect.y + 1)).toBe("swap");

    const emptyMain = layoutWith("a");
    emptyMain.dockFocused("left", screen);
    const main = emptyMain.emptyMainRect(screen) as Rect;
    expect(expectParity(emptyMain, "a", main.x + 5, main.y + 5)).toBe("main");
  });

  it("matches the keyboard tree for random drags over random arrangements", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const kindsSeen = new Set<string>();
    let commits = 0;
    for (let round = 0; round < 30; round += 1) {
      const layout = new Layout();
      const count = 2 + Math.floor(random() * 3);
      const panes = Array.from({ length: count }, (_, at) => `p${at}`);
      for (const id of panes) expect(layout.open(id, screen)).toBe(true);
      for (let shuffle = 0; shuffle < 5; shuffle += 1) {
        layout.focus(panes[Math.floor(random() * count)] as string);
        const roll = random();
        if (roll < 0.4) layout.dockFocused(sides[Math.floor(random() * 2)] ?? "left", screen);
        else if (roll < 0.7) {
          layout.move(directions[Math.floor(random() * 4)] ?? "left", screen);
        } else layout.undockFocused(screen);
      }
      const dragged = panes[Math.floor(random() * count)] as string;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const kind = expectParity(
          layout,
          dragged,
          Math.floor(random() * screen.width),
          Math.floor(random() * screen.height),
        );
        if (kind !== undefined) {
          kindsSeen.add(kind);
          commits += 1;
          break;
        }
      }
    }
    expect(commits).toBeGreaterThanOrEqual(20);
    expect(kindsSeen).toContain("swap");
    expect(kindsSeen).toContain("dock");
  });
});
