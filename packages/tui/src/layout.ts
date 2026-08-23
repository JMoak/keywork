import {
  area,
  contains,
  type Direction,
  isWide,
  nearestInDirection,
  type Rect,
  type Screen,
} from "./geometry.ts";
import {
  type Arrangement,
  arrivalIndex,
  type DockSide,
  type DockState,
  dockedAt,
  dockSides,
  emptyArrangement,
  isPinned,
  lifted,
  mainPanes,
  otherSide,
  panesOf,
  pinnedInDock,
  reorderedInDock,
  sideOf,
  swapped,
  unpinnedInDock,
  withDockRatio,
  withTree,
} from "./layout-arrangement.ts";
import {
  type DockWeights,
  dockSlotRects,
  evenWeights,
  holds,
  type Scene,
  sceneOf,
  sceneRects,
} from "./layout-scene.ts";
import {
  arrangementOf,
  type LayoutState,
  layoutStateOf,
  parseLayoutState,
} from "./layout-state.ts";
import {
  attachAtEdge,
  type LayoutNode,
  leaf,
  type Orientation,
  type PaneId,
  removeLeaf,
  resizeAroundLeaf,
  splitLeaf,
  swapLeaves,
} from "./layout-tree.ts";

export type { Direction, Rect, Screen } from "./geometry.ts";
export type { DockSide, DockState } from "./layout-arrangement.ts";
export type { DockWeights } from "./layout-scene.ts";
export { type DocksState, type LayoutState, layoutStateIds } from "./layout-state.ts";
export { type LayoutNode, minPaneSize, type Orientation, type PaneId } from "./layout-tree.ts";

export type DropTarget =
  | { kind: "swap"; with: PaneId; rect: Rect }
  | { kind: "dock"; side: DockSide; index: number; rect: Rect }
  | { kind: "main"; rect: Rect };

export interface LayoutOptions {
  dockWeight?: DockWeights;
}

export class Layout {
  private arrangement: Arrangement = emptyArrangement();
  private focusedId: PaneId | undefined;
  private zoomedId: PaneId | undefined;
  private trail: PaneId[] = [];
  private readonly weightOf: DockWeights;

  constructor(options: LayoutOptions = {}) {
    this.weightOf = options.dockWeight ?? evenWeights;
  }

  static parse(value: unknown): LayoutState | undefined {
    return parseLayoutState(value);
  }

  toJSON(): LayoutState {
    return layoutStateOf(this.arrangement, this.focusedId);
  }

  load(state: LayoutState): void {
    this.arrangement = arrangementOf(state);
    this.trail = [];
    this.focusOn(state.focused);
    this.zoomedId = undefined;
  }

  root(): LayoutNode | undefined {
    return this.arrangement.tree;
  }

  focused(): PaneId | undefined {
    return this.focusedId;
  }

  recentlyFocused(): PaneId[] {
    return [...this.trail];
  }

  zoomed(): PaneId | undefined {
    return this.zoomedId;
  }

  panes(): PaneId[] {
    return panesOf(this.arrangement);
  }

  dock(side: DockSide): DockState | undefined {
    const dock = this.arrangement.docks[side];
    if (dock.panes.length === 0) return undefined;
    return { panes: [...dock.panes], ratio: dock.ratio, pins: dock.pins };
  }

  dockSideOf(id: PaneId): DockSide | undefined {
    return sideOf(this.arrangement, id);
  }

  pinned(id: PaneId): boolean {
    return isPinned(this.arrangement, id);
  }

  pinFocused(): boolean {
    const id = this.focusedId;
    const side = id === undefined ? undefined : this.dockSideOf(id);
    if (id === undefined || side === undefined) return false;
    this.arrangement = pinnedInDock(this.arrangement, side, id);
    return true;
  }

  unpinFocused(): boolean {
    const id = this.focusedId;
    const side = id === undefined ? undefined : this.dockSideOf(id);
    if (id === undefined || side === undefined) return false;
    this.arrangement = unpinnedInDock(this.arrangement, side, id);
    return true;
  }

  open(id: PaneId, screen: Screen, beside: PaneId | undefined = this.focusedId): boolean {
    if (this.panes().includes(id)) {
      this.focusOn(id);
      return true;
    }
    const anchor = beside !== undefined && this.panes().includes(beside) ? beside : this.focusedId;
    const tree = this.arrangement.tree;
    const anchorDock = anchor === undefined ? undefined : this.dockSideOf(anchor);
    if (anchor !== undefined && anchorDock !== undefined && tree !== undefined) {
      return this.openInDock(id, anchorDock, anchor, screen);
    }
    if (tree === undefined || anchor === undefined) {
      this.arrangement = withTree(this.arrangement, leaf(id));
      this.zoomedId = undefined;
      this.focusOn(id);
      return true;
    }
    const orientation = splitOrientation(this.tiledRects(screen).get(anchor));
    const grown = splitLeaf(tree, anchor, leaf(id), orientation);
    return this.commitFocusing(withTree(this.arrangement, grown), id, screen);
  }

  openAtEdge(id: PaneId, edge: DockSide, screen: Screen): boolean {
    if (this.panes().includes(id)) return false;
    const landing = attachAtEdge(this.arrangement.tree, id, edge);
    return this.commitFocusing(withTree(this.arrangement, landing), id, screen);
  }

  close(id: PaneId): void {
    if (!this.panes().includes(id)) return;
    const side = this.dockSideOf(id);
    const slot = side === undefined ? -1 : this.arrangement.docks[side].panes.indexOf(id);
    this.arrangement = lifted(this.arrangement, id);
    this.trail = this.trail.filter((pane) => pane !== id);
    if (this.zoomedId === id) this.zoomedId = undefined;
    if (this.focusedId === id) this.focusOn(this.heirAfterClosing(side, slot));
  }

  focus(id: PaneId): void {
    if (!this.panes().includes(id)) return;
    if (this.zoomedId !== undefined && this.zoomedId !== id) this.zoomedId = undefined;
    this.focusOn(id);
  }

  moveFocus(direction: Direction, screen: Screen): PaneId | undefined {
    const neighbor = this.neighbor(direction, screen);
    if (neighbor !== undefined) this.focusOn(neighbor);
    return neighbor;
  }

  zoomToggle(): void {
    if (this.focusedId === undefined) return;
    this.zoomedId = this.zoomedId === this.focusedId ? undefined : this.focusedId;
  }

  move(direction: Direction, screen: Screen): boolean {
    const id = this.focusedId;
    if (id === undefined) return false;
    const side = this.dockSideOf(id);
    const moved =
      side === undefined
        ? this.moveInMain(id, direction, screen)
        : this.moveDocked(id, side, direction, screen);
    if (moved) this.zoomedId = undefined;
    return moved;
  }

  dockFocused(side: DockSide, screen: Screen): boolean {
    const id = this.focusedId;
    if (id === undefined) return false;
    if (this.dockSideOf(id) === side) return true;
    return this.commit(this.landedInDock(id, side), screen);
  }

  undockFocused(screen: Screen): boolean {
    const id = this.focusedId;
    const from = id === undefined ? undefined : this.dockSideOf(id);
    if (id === undefined || from === undefined) return false;
    const remaining = lifted(this.arrangement, id);
    const landing = this.landingFor(id, remaining.tree, from, screen);
    return this.commit(withTree(remaining, landing), screen);
  }

  cycleFocused(screen: Screen): boolean {
    if (this.focusedId === undefined) return false;
    const from = this.dockSideOf(this.focusedId);
    if (from === undefined) return this.dockFocused("left", screen);
    if (from === "left") return this.dockFocused("right", screen);
    return this.undockFocused(screen);
  }

  growDock(side: DockSide, delta: number): void {
    const ratio = this.arrangement.docks[side].ratio + delta;
    this.arrangement = withDockRatio(this.arrangement, side, ratio);
  }

  dragDockEdge(side: DockSide, x: number, screen: Screen): void {
    if (screen.width <= 0) return;
    const width = side === "left" ? x + 1 : screen.width - x;
    this.arrangement = withDockRatio(this.arrangement, side, width / screen.width);
  }

  dockHandleAt(x: number, screen: Screen): DockSide | undefined {
    const scene = this.scene(screen);
    if (scene.kind !== "tiled") return undefined;
    const { left, right } = scene.regions;
    if (left !== undefined && (x === rightEdge(left) || x === rightEdge(left) + 1)) return "left";
    if (right !== undefined && (x === right.x || x === right.x - 1)) return "right";
    return undefined;
  }

  resizeFocused(delta: number): void {
    const tree = this.arrangement.tree;
    if (this.focusedId === undefined || tree === undefined) return;
    this.arrangement = withTree(this.arrangement, resizeAroundLeaf(tree, this.focusedId, delta));
  }

  dropTargetAt(dragged: PaneId, x: number, y: number, screen: Screen): DropTarget | undefined {
    if (!this.panes().includes(dragged)) return undefined;
    const scene = this.scene(screen);
    if (scene.kind !== "tiled") return undefined;
    for (const side of dockSides) {
      const region = scene.regions[side];
      if (region !== undefined && x >= region.x && x < region.x + region.width) {
        return this.dockDropTarget(dragged, side, y, region, screen);
      }
    }
    return this.mainDropTarget(dragged, x, y, scene, screen);
  }

  applyDrop(dragged: PaneId, target: DropTarget, screen: Screen): boolean {
    if (!this.panes().includes(dragged)) return false;
    switch (target.kind) {
      case "swap":
        return this.swapPanes(dragged, target.with);
      case "dock":
        return this.commitFocusing(
          this.landedInDock(dragged, target.side, target.index),
          dragged,
          screen,
        );
      case "main":
        if (this.dockSideOf(dragged) === undefined || this.arrangement.tree !== undefined) {
          return false;
        }
        return this.commitFocusing(
          withTree(lifted(this.arrangement, dragged), leaf(dragged)),
          dragged,
          screen,
        );
    }
  }

  rects(screen: Screen): Map<PaneId, Rect> {
    return sceneRects(this.scene(screen), screen, this.weightOf);
  }

  emptyMainRect(screen: Screen): Rect | undefined {
    const scene = this.scene(screen);
    if (scene.kind !== "tiled" || scene.arrangement.tree !== undefined) return undefined;
    const { left, right } = scene.arrangement.docks;
    if (left.panes.length === 0 && right.panes.length === 0) return undefined;
    return scene.regions.main;
  }

  private scene(screen: Screen): Scene {
    if (this.zoomedId !== undefined) return { kind: "solo", id: this.zoomedId };
    return this.tiledScene(screen);
  }

  private tiledScene(screen: Screen): Scene {
    return sceneOf(this.arrangement, this.focusedId, screen);
  }

  private tiledRects(screen: Screen): Map<PaneId, Rect> {
    return sceneRects(this.tiledScene(screen), screen, this.weightOf);
  }

  private commit(candidate: Arrangement, screen: Screen): boolean {
    if (!holds(candidate, screen)) return false;
    this.arrangement = candidate;
    this.zoomedId = undefined;
    return true;
  }

  private commitFocusing(candidate: Arrangement, id: PaneId, screen: Screen): boolean {
    if (!this.commit(candidate, screen)) return false;
    this.focusOn(id);
    return true;
  }

  private focusOn(id: PaneId | undefined): void {
    this.focusedId = id;
    if (id === undefined) return;
    this.trail = [id, ...this.trail.filter((pane) => pane !== id)];
  }

  private heirAfterClosing(side: DockSide | undefined, slot: number): PaneId | undefined {
    const { docks } = this.arrangement;
    const main = mainPanes(this.arrangement);
    if (side === undefined) return main[0] ?? docks.left.panes[0] ?? docks.right.panes[0];
    const stack = docks[side].panes;
    return stack[Math.min(slot, stack.length - 1)] ?? main[0] ?? docks[otherSide(side)].panes[0];
  }

  private openInDock(id: PaneId, side: DockSide, after: PaneId, screen: Screen): boolean {
    const index = this.arrangement.docks[side].panes.indexOf(after) + 1;
    return this.commitFocusing(dockedAt(this.arrangement, side, id, index), id, screen);
  }

  private landingFor(
    id: PaneId,
    tree: LayoutNode | undefined,
    from: DockSide,
    screen: Screen,
  ): LayoutNode {
    if (tree === undefined) return leaf(id);
    const target = this.largestVisibleMainLeaf(screen);
    if (target === undefined) return attachAtEdge(tree, id, from);
    return splitLeaf(tree, target.id, leaf(id), splitOrientation(target.rect));
  }

  private largestVisibleMainLeaf(screen: Screen): { id: PaneId; rect: Rect } | undefined {
    const main = new Set(mainPanes(this.arrangement));
    let best: { id: PaneId; rect: Rect } | undefined;
    for (const [id, rect] of this.tiledRects(screen)) {
      if (!main.has(id)) continue;
      if (best === undefined || area(rect) > area(best.rect)) best = { id, rect };
    }
    return best;
  }

  private dockDropTarget(
    dragged: PaneId,
    side: DockSide,
    y: number,
    region: Rect,
    screen: Screen,
  ): DropTarget | undefined {
    if (!holds(dockedAt(lifted(this.arrangement, dragged), side, dragged), screen))
      return undefined;
    const remaining = lifted(this.arrangement, dragged).docks[side];
    const slots = remaining.panes.length + 1;
    const wanted = Math.floor(((y - region.y) / region.height) * slots);
    const index = this.pinned(dragged) ? remaining.pins : arrivalIndex(remaining, wanted);
    const stacked = [...remaining.panes];
    stacked.splice(index, 0, dragged);
    const rect = dockSlotRects(region, stacked.map(this.weightOf))[index] as Rect;
    return { kind: "dock", side, index, rect };
  }

  private landedInDock(id: PaneId, side: DockSide, index?: number): Arrangement {
    const pinned = this.pinned(id);
    const landed = dockedAt(lifted(this.arrangement, id), side, id, index);
    return pinned ? pinnedInDock(landed, side, id) : landed;
  }

  private mainDropTarget(
    dragged: PaneId,
    x: number,
    y: number,
    scene: Extract<Scene, { kind: "tiled" }>,
    screen: Screen,
  ): DropTarget | undefined {
    if (this.arrangement.tree === undefined) {
      if (this.dockSideOf(dragged) === undefined) return undefined;
      const landed = withTree(lifted(this.arrangement, dragged), leaf(dragged));
      return holds(landed, screen) ? { kind: "main", rect: scene.regions.main } : undefined;
    }
    const main = new Set(mainPanes(this.arrangement));
    for (const [id, rect] of sceneRects(scene, screen)) {
      if (!main.has(id) || !contains(rect, x, y)) continue;
      return id === dragged ? undefined : { kind: "swap", with: id, rect };
    }
    return undefined;
  }

  private swapPanes(dragged: PaneId, other: PaneId): boolean {
    if (dragged === other || !this.panes().includes(other)) return false;
    this.arrangement = swapped(this.arrangement, dragged, other);
    this.zoomedId = undefined;
    this.focusOn(dragged);
    return true;
  }

  private moveDocked(id: PaneId, side: DockSide, direction: Direction, screen: Screen): boolean {
    if (direction === "up" || direction === "down") {
      const reordered = reorderedInDock(this.arrangement, side, id, direction === "down" ? 1 : -1);
      if (reordered === undefined) return false;
      this.arrangement = reordered;
      return true;
    }
    const inward = side === "left" ? direction === "right" : direction === "left";
    if (!inward) return false;
    const landing = attachAtEdge(this.arrangement.tree, id, side);
    return this.commit(withTree(lifted(this.arrangement, id), landing), screen);
  }

  private moveInMain(id: PaneId, direction: Direction, screen: Screen): boolean {
    const tree = this.arrangement.tree;
    if (tree === undefined) return false;
    const main = mainPanes(this.arrangement);
    const mainNeighbor = this.neighbor(direction, screen, (candidate) => main.includes(candidate));
    if (mainNeighbor !== undefined) {
      this.arrangement = withTree(this.arrangement, swapLeaves(tree, id, mainNeighbor));
      return true;
    }
    if (direction === "left" || direction === "right") {
      if (this.arrangement.docks[direction].panes.length > 0) {
        return this.pushIntoDock(id, direction, screen);
      }
    }
    const remaining = removeLeaf(tree, id);
    if (remaining === undefined) return false;
    return this.commit(withTree(this.arrangement, attachAtEdge(remaining, id, direction)), screen);
  }

  private pushIntoDock(id: PaneId, side: DockSide, screen: Screen): boolean {
    const index = this.dockInsertionIndex(id, side, screen);
    return this.commit(dockedAt(lifted(this.arrangement, id), side, id, index), screen);
  }

  private dockInsertionIndex(id: PaneId, side: DockSide, screen: Screen): number {
    const rects = this.tiledRects(screen);
    const origin = rects.get(id);
    const panes = this.arrangement.docks[side].panes;
    if (origin === undefined) return panes.length;
    const originCenter = origin.y + origin.height / 2;
    const below = panes.findIndex((pane) => {
      const rect = rects.get(pane);
      return rect !== undefined && originCenter < rect.y + rect.height / 2;
    });
    return below === -1 ? panes.length : below;
  }

  private neighbor(
    direction: Direction,
    screen: Screen,
    eligible: (id: PaneId) => boolean = () => true,
  ): PaneId | undefined {
    const focused = this.focusedId;
    if (focused === undefined) return undefined;
    const rects = this.rects(screen);
    const origin = rects.get(focused);
    if (origin === undefined) return undefined;
    const candidates = [...rects].filter(([id]) => id !== focused && eligible(id));
    return nearestInDirection(origin, candidates, direction);
  }
}

function splitOrientation(rect: Rect | undefined): Orientation {
  return rect !== undefined && isWide(rect) ? "row" : "column";
}

function rightEdge(rect: Rect): number {
  return rect.x + rect.width - 1;
}
