import { clamp } from "./clamp.ts";
import { paneChromeCost } from "./pane-chrome.ts";

export type PaneId = string;
export type Orientation = "row" | "column";
export type Direction = "left" | "right" | "up" | "down";
export type DockSide = "left" | "right";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutNode =
  | { kind: "leaf"; id: PaneId }
  | {
      kind: "split";
      orientation: Orientation;
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };

export type SplitNode = Extract<LayoutNode, { kind: "split" }>;

export interface DockState {
  panes: PaneId[];
  ratio: number;
}

export interface DocksState {
  left?: DockState;
  right?: DockState;
}

export interface LayoutState {
  tree?: LayoutNode;
  focused?: PaneId;
  docks?: DocksState;
}

export interface Screen {
  width: number;
  height: number;
}

export type DropTarget =
  | { kind: "swap"; with: PaneId; rect: Rect }
  | { kind: "dock"; side: DockSide; index: number; rect: Rect }
  | { kind: "main"; rect: Rect };

export const dockSides: readonly DockSide[] = ["left", "right"];

const terminalCellAspect = 2;
const dockRatioBounds = { min: 0.05, max: 0.6 };
const defaultDockRatio = 1 / 3;
const splitRatioBounds = { min: 0.1, max: 0.9 };
const minContentCell = 1;

export const minPaneSize = {
  width: paneChromeCost.columns + minContentCell,
  height: paneChromeCost.rows + minContentCell,
} as const;

export class Layout {
  private tree: LayoutNode | undefined;
  private focusedId: PaneId | undefined;
  private zoomedId: PaneId | undefined;
  private docks: Record<DockSide, DockState> = freshDocks();

  static parse(value: unknown): LayoutState | undefined {
    if (!isRecord(value)) return undefined;
    const tree = value.tree === undefined ? undefined : parseNode(value.tree);
    if (value.tree !== undefined && tree === undefined) return undefined;
    const docksSource = value.docks ?? value.dock;
    const docks =
      docksSource === undefined
        ? undefined
        : value.docks !== undefined
          ? parseDocks(value.docks)
          : parseSingleDock(value.dock);
    if (docksSource !== undefined && docks === undefined) return undefined;
    const ids = [
      ...(docks?.left?.panes ?? []),
      ...(tree === undefined ? [] : leafIds(tree)),
      ...(docks?.right?.panes ?? []),
    ];
    if (ids.length === 0 || new Set(ids).size !== ids.length) return undefined;
    const focused = value.focused;
    if (focused !== undefined && (typeof focused !== "string" || !ids.includes(focused))) {
      return undefined;
    }
    return {
      ...(tree !== undefined && { tree }),
      ...(focused !== undefined && { focused }),
      ...(docks !== undefined && { docks }),
    };
  }

  toJSON(): LayoutState {
    const docks: DocksState = {
      ...(this.docks.left.panes.length > 0 && { left: snapshotDock(this.docks.left) }),
      ...(this.docks.right.panes.length > 0 && { right: snapshotDock(this.docks.right) }),
    };
    return {
      ...(this.tree !== undefined && { tree: cloneNode(this.tree) }),
      ...(this.focusedId !== undefined && { focused: this.focusedId }),
      ...((docks.left !== undefined || docks.right !== undefined) && { docks }),
    };
  }

  load(state: LayoutState): void {
    this.tree = state.tree === undefined ? undefined : cloneNode(state.tree);
    this.focusedId = state.focused;
    this.zoomedId = undefined;
    this.docks = {
      left: loadedDock(state.docks?.left),
      right: loadedDock(state.docks?.right),
    };
  }

  root(): LayoutNode | undefined {
    return this.tree;
  }

  focused(): PaneId | undefined {
    return this.focusedId;
  }

  zoomed(): PaneId | undefined {
    return this.zoomedId;
  }

  panes(): PaneId[] {
    return [...this.docks.left.panes, ...this.mainPanes(), ...this.docks.right.panes];
  }

  dock(side: DockSide): DockState | undefined {
    if (this.docks[side].panes.length === 0) return undefined;
    return snapshotDock(this.docks[side]);
  }

  dockSideOf(id: PaneId): DockSide | undefined {
    return dockSides.find((side) => this.docks[side].panes.includes(id));
  }

  open(id: PaneId, screen: Screen): boolean {
    if (this.panes().includes(id)) {
      this.focusedId = id;
      return true;
    }
    const focused = this.focusedId;
    const focusedDock = focused === undefined ? undefined : this.dockSideOf(focused);
    if (focused !== undefined && focusedDock !== undefined && this.tree !== undefined) {
      return this.openInDock(id, focusedDock, focused, screen);
    }
    if (this.tree === undefined || focused === undefined) {
      this.zoomedId = undefined;
      this.tree = { kind: "leaf", id };
      this.focusedId = id;
      return true;
    }
    const targetRect = this.tiledRects(screen).get(focused) as Rect;
    const grown = splitLeaf(this.tree, focused, { kind: "leaf", id }, wideOrTall(targetRect));
    if (!this.fits({ tree: grown, ...this.counts() }, screen)) return false;
    this.zoomedId = undefined;
    this.tree = grown;
    this.focusedId = id;
    return true;
  }

  close(id: PaneId): void {
    if (this.zoomedId === id) this.zoomedId = undefined;
    const side = this.dockSideOf(id);
    if (side !== undefined) {
      const panes = this.docks[side].panes;
      const index = panes.indexOf(id);
      panes.splice(index, 1);
      if (this.focusedId === id) {
        this.focusedId =
          panes[Math.min(index, panes.length - 1)] ??
          this.mainPanes()[0] ??
          this.docks[otherSide(side)].panes[0];
      }
      return;
    }
    if (this.tree === undefined) return;
    this.tree = removeLeaf(this.tree, id);
    if (this.focusedId === id) {
      this.focusedId = this.mainPanes()[0] ?? this.docks.left.panes[0] ?? this.docks.right.panes[0];
    }
  }

  focus(id: PaneId): void {
    if (!this.panes().includes(id)) return;
    if (this.zoomedId !== undefined && this.zoomedId !== id) this.zoomedId = undefined;
    this.focusedId = id;
  }

  moveFocus(direction: Direction, screen: Screen): PaneId | undefined {
    const neighbor = this.neighbor(direction, screen);
    if (neighbor !== undefined) this.focusedId = neighbor;
    return neighbor;
  }

  dropTargetAt(dragged: PaneId, x: number, y: number, screen: Screen): DropTarget | undefined {
    if (!this.panes().includes(dragged)) return undefined;
    if (this.zoomedId !== undefined && this.panes().includes(this.zoomedId)) return undefined;
    const regions = this.regionsFor({ tree: this.tree, ...this.counts() }, screen);
    const side = dockSides.find((candidate) => {
      const region = regions[candidate];
      return region !== undefined && x >= region.x && x < region.x + region.width;
    });
    if (side !== undefined)
      return this.dockDropTarget(dragged, side, y, regions[side] as Rect, screen);
    return this.mainDropTarget(dragged, x, y, regions.main, screen);
  }

  applyDrop(dragged: PaneId, target: DropTarget, screen: Screen): boolean {
    if (!this.panes().includes(dragged)) return false;
    switch (target.kind) {
      case "swap":
        return this.swapPanes(dragged, target.with);
      case "dock":
        return this.dropIntoDock(dragged, target.side, target.index, screen);
      case "main":
        return this.dropIntoEmptyMain(dragged, screen);
    }
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

  zoomToggle(): void {
    if (this.focusedId === undefined) return;
    this.zoomedId = this.zoomedId === this.focusedId ? undefined : this.focusedId;
  }

  dockFocused(side: DockSide, screen: Screen): boolean {
    const id = this.focusedId;
    if (id === undefined) return false;
    const from = this.dockSideOf(id);
    if (from === side) return true;
    const tree =
      from === undefined && this.tree !== undefined ? removeLeaf(this.tree, id) : this.tree;
    const counts = this.counts();
    counts[side] += 1;
    if (from !== undefined) counts[from] -= 1;
    if (!this.fits({ tree, ...counts }, screen)) return false;
    this.zoomedId = undefined;
    if (from === undefined) this.tree = tree;
    else this.docks[from].panes.splice(this.docks[from].panes.indexOf(id), 1);
    this.docks[side].panes.push(id);
    return true;
  }

  undockFocused(screen: Screen): boolean {
    const id = this.focusedId;
    if (id === undefined) return false;
    const from = this.dockSideOf(id);
    if (from === undefined) return false;
    const counts = this.counts();
    counts[from] -= 1;
    const landing = this.undockLanding(id, screen);
    if (!this.fits({ tree: landing, ...counts }, screen)) return false;
    this.zoomedId = undefined;
    this.docks[from].panes.splice(this.docks[from].panes.indexOf(id), 1);
    this.tree = landing;
    return true;
  }

  cycleFocused(screen: Screen): boolean {
    if (this.focusedId === undefined) return false;
    const from = this.dockSideOf(this.focusedId);
    if (from === undefined) return this.dockFocused("left", screen);
    if (from === "left") return this.dockFocused("right", screen);
    return this.undockFocused(screen);
  }

  growDock(side: DockSide, delta: number): void {
    this.docks[side].ratio = clamp(
      this.docks[side].ratio + delta,
      dockRatioBounds.min,
      dockRatioBounds.max,
    );
  }

  dockHandleAt(x: number, screen: Screen): DockSide | undefined {
    if (this.zoomedId !== undefined && this.panes().includes(this.zoomedId)) return undefined;
    const regions = this.regionsFor({ tree: this.tree, ...this.counts() }, screen);
    const left = regions.left;
    if (left !== undefined && (x === rightEdge(left) || x === rightEdge(left) + 1)) return "left";
    const right = regions.right;
    if (right !== undefined && (x === right.x || x === right.x - 1)) return "right";
    return undefined;
  }

  dragDockEdge(side: DockSide, x: number, screen: Screen): void {
    if (screen.width <= 0) return;
    const width = side === "left" ? x + 1 : screen.width - x;
    this.docks[side].ratio = clamp(width / screen.width, dockRatioBounds.min, dockRatioBounds.max);
  }

  emptyMainRect(screen: Screen): Rect | undefined {
    if (this.tree !== undefined) return undefined;
    if (this.zoomedId !== undefined && this.panes().includes(this.zoomedId)) return undefined;
    if (this.docks.left.panes.length === 0 && this.docks.right.panes.length === 0) return undefined;
    return this.regionsFor({ tree: this.tree, ...this.counts() }, screen).main;
  }

  resizeFocused(delta: number): void {
    if (this.focusedId === undefined || this.tree === undefined) return;
    this.tree = resizeAroundLeaf(this.tree, this.focusedId, delta);
  }

  rects(screen: Screen): Map<PaneId, Rect> {
    const full: Rect = { x: 0, y: 0, width: screen.width, height: screen.height };
    if (this.zoomedId !== undefined && this.panes().includes(this.zoomedId)) {
      return new Map([[this.zoomedId, full]]);
    }
    return this.tiledRects(screen);
  }

  private tiledRects(screen: Screen): Map<PaneId, Rect> {
    const result = new Map<PaneId, Rect>();
    const regions = this.regionsFor({ tree: this.tree, ...this.counts() }, screen);
    if (regions.left !== undefined) stackVertically(this.docks.left.panes, regions.left, result);
    if (this.tree !== undefined) collectRects(this.tree, regions.main, result);
    if (regions.right !== undefined) stackVertically(this.docks.right.panes, regions.right, result);
    return result;
  }

  private regionsFor(
    candidate: { tree: LayoutNode | undefined } & DockCounts,
    screen: Screen,
  ): Regions {
    return carveColumns(
      { x: 0, y: 0, width: screen.width, height: screen.height },
      candidate.left > 0 ? this.docks.left.ratio : undefined,
      candidate.right > 0 ? this.docks.right.ratio : undefined,
      candidate.tree === undefined
        ? minPaneSize.width
        : Math.max(minPaneSize.width, minWidth(candidate.tree)),
    );
  }

  private fits(candidate: { tree: LayoutNode | undefined } & DockCounts, screen: Screen): boolean {
    const regions = this.regionsFor(candidate, screen);
    return (
      dockHolds(regions.left, candidate.left) &&
      dockHolds(regions.right, candidate.right) &&
      (candidate.tree === undefined || treeHolds(regions.main, candidate.tree))
    );
  }

  private openInDock(id: PaneId, side: DockSide, after: PaneId, screen: Screen): boolean {
    const counts = this.counts();
    counts[side] += 1;
    if (!this.fits({ tree: this.tree, ...counts }, screen)) return false;
    this.zoomedId = undefined;
    const panes = this.docks[side].panes;
    panes.splice(panes.indexOf(after) + 1, 0, id);
    this.focusedId = id;
    return true;
  }

  private undockLanding(id: PaneId, screen: Screen): LayoutNode {
    const leaf: LayoutNode = { kind: "leaf", id };
    const target = this.largestMainLeaf(screen);
    if (this.tree === undefined || target === undefined) return leaf;
    return splitLeaf(this.tree, target.id, leaf, wideOrTall(target.rect));
  }

  private counts(): DockCounts {
    return { left: this.docks.left.panes.length, right: this.docks.right.panes.length };
  }

  private mainPanes(): PaneId[] {
    return this.tree === undefined ? [] : leafIds(this.tree);
  }

  private largestMainLeaf(screen: Screen): { id: PaneId; rect: Rect } | undefined {
    if (this.tree === undefined) return undefined;
    const rects = this.tiledRects(screen);
    let best: { id: PaneId; rect: Rect } | undefined;
    for (const id of leafIds(this.tree)) {
      const rect = rects.get(id) as Rect;
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
    if (!this.dropFits(dragged, side, screen)) return undefined;
    const slots = this.docks[side].panes.filter((id) => id !== dragged).length + 1;
    const index = clamp(Math.floor(((y - region.y) / region.height) * slots), 0, slots - 1);
    return { kind: "dock", side, index, rect: stackSlotRect(region, slots, index) };
  }

  private mainDropTarget(
    dragged: PaneId,
    x: number,
    y: number,
    main: Rect,
    screen: Screen,
  ): DropTarget | undefined {
    if (this.tree === undefined) {
      if (this.dockSideOf(dragged) === undefined) return undefined;
      if (!this.dropFits(dragged, undefined, screen)) return undefined;
      return { kind: "main", rect: main };
    }
    const rects = this.tiledRects(screen);
    for (const id of this.mainPanes()) {
      const rect = rects.get(id) as Rect;
      if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) {
        return id === dragged ? undefined : { kind: "swap", with: id, rect };
      }
    }
    return undefined;
  }

  private dropFits(dragged: PaneId, intoDock: DockSide | undefined, screen: Screen): boolean {
    const from = this.dockSideOf(dragged);
    const counts = this.counts();
    if (from !== undefined) counts[from] -= 1;
    if (intoDock !== undefined) counts[intoDock] += 1;
    const lifted =
      from === undefined && this.tree !== undefined ? removeLeaf(this.tree, dragged) : this.tree;
    const landed =
      intoDock === undefined && lifted === undefined
        ? ({ kind: "leaf", id: dragged } as const)
        : lifted;
    return this.fits({ tree: landed, ...counts }, screen);
  }

  private swapPanes(dragged: PaneId, other: PaneId): boolean {
    if (dragged === other || !this.panes().includes(other)) return false;
    const draggedDock = this.dockSideOf(dragged);
    const otherDock = this.dockSideOf(other);
    if (draggedDock === undefined && otherDock === undefined) {
      if (this.tree === undefined) return false;
      this.tree = swapLeaves(this.tree, dragged, other);
    } else if (draggedDock !== undefined && otherDock !== undefined) {
      const draggedPanes = this.docks[draggedDock].panes;
      const otherPanes = this.docks[otherDock].panes;
      const draggedAt = draggedPanes.indexOf(dragged);
      const otherAt = otherPanes.indexOf(other);
      draggedPanes[draggedAt] = other;
      otherPanes[otherAt] = dragged;
    } else {
      const docked = draggedDock !== undefined ? dragged : other;
      const mained = draggedDock !== undefined ? other : dragged;
      if (this.tree === undefined) return false;
      this.tree = replaceLeaf(this.tree, mained, docked);
      const panes = this.docks[(draggedDock ?? otherDock) as DockSide].panes;
      panes[panes.indexOf(docked)] = mained;
    }
    this.zoomedId = undefined;
    this.focusedId = dragged;
    return true;
  }

  private dropIntoDock(dragged: PaneId, side: DockSide, index: number, screen: Screen): boolean {
    if (!this.dropFits(dragged, side, screen)) return false;
    const from = this.dockSideOf(dragged);
    if (from === undefined) {
      this.tree = this.tree === undefined ? undefined : removeLeaf(this.tree, dragged);
    } else {
      const panes = this.docks[from].panes;
      panes.splice(panes.indexOf(dragged), 1);
    }
    const panes = this.docks[side].panes;
    panes.splice(clamp(index, 0, panes.length), 0, dragged);
    this.zoomedId = undefined;
    this.focusedId = dragged;
    return true;
  }

  private dropIntoEmptyMain(dragged: PaneId, screen: Screen): boolean {
    const from = this.dockSideOf(dragged);
    if (from === undefined || this.tree !== undefined) return false;
    if (!this.dropFits(dragged, undefined, screen)) return false;
    const panes = this.docks[from].panes;
    panes.splice(panes.indexOf(dragged), 1);
    this.tree = { kind: "leaf", id: dragged };
    this.zoomedId = undefined;
    this.focusedId = dragged;
    return true;
  }

  private moveDocked(id: PaneId, side: DockSide, direction: Direction, screen: Screen): boolean {
    if (direction === "up" || direction === "down") {
      return reorder(this.docks[side].panes, id, direction);
    }
    const inward = side === "left" ? direction === "right" : direction === "left";
    return inward && this.landInMain(id, side, screen);
  }

  private landInMain(id: PaneId, from: DockSide, screen: Screen): boolean {
    const landing = edgeAttached(this.tree, id, from);
    const counts = this.counts();
    counts[from] -= 1;
    if (!this.fits({ tree: landing, ...counts }, screen)) return false;
    this.docks[from].panes.splice(this.docks[from].panes.indexOf(id), 1);
    this.tree = landing;
    return true;
  }

  private moveInMain(id: PaneId, direction: Direction, screen: Screen): boolean {
    const mainNeighbor = this.neighbor(direction, screen, (candidate) =>
      this.mainPanes().includes(candidate),
    );
    if (mainNeighbor !== undefined && this.tree !== undefined) {
      this.tree = swapLeaves(this.tree, id, mainNeighbor);
      return true;
    }
    if ((direction === "left" || direction === "right") && this.docks[direction].panes.length > 0) {
      return this.pushIntoDock(id, direction, screen);
    }
    return this.moveToEdge(id, direction, screen);
  }

  private pushIntoDock(id: PaneId, side: DockSide, screen: Screen): boolean {
    const tree = this.tree === undefined ? undefined : removeLeaf(this.tree, id);
    const counts = this.counts();
    counts[side] += 1;
    if (!this.fits({ tree, ...counts }, screen)) return false;
    const index = this.dockInsertionIndex(id, side, screen);
    this.tree = tree;
    this.docks[side].panes.splice(index, 0, id);
    return true;
  }

  private dockInsertionIndex(id: PaneId, side: DockSide, screen: Screen): number {
    const rects = this.tiledRects(screen);
    const origin = rects.get(id);
    const panes = this.docks[side].panes;
    if (origin === undefined) return panes.length;
    const originCenter = origin.y + origin.height / 2;
    const below = panes.findIndex((pane) => {
      const rect = rects.get(pane);
      return rect !== undefined && originCenter < rect.y + rect.height / 2;
    });
    return below === -1 ? panes.length : below;
  }

  private moveToEdge(id: PaneId, direction: Direction, screen: Screen): boolean {
    if (this.tree === undefined) return false;
    const remaining = removeLeaf(this.tree, id);
    if (remaining === undefined) return false;
    const landing = edgeAttached(remaining, id, direction);
    if (!this.fits({ tree: landing, ...this.counts() }, screen)) return false;
    this.tree = landing;
    return true;
  }

  private neighbor(
    direction: Direction,
    screen: Screen,
    eligible: (id: PaneId) => boolean = () => true,
  ): PaneId | undefined {
    if (this.focusedId === undefined) return undefined;
    const rects = this.rects(screen);
    const origin = rects.get(this.focusedId);
    if (origin === undefined) return undefined;
    return nearestInDirection(this.focusedId, origin, rects, direction, eligible);
  }
}

export function layoutStateIds(state: LayoutState): PaneId[] {
  return [
    ...(state.docks?.left?.panes ?? []),
    ...(state.tree === undefined ? [] : leafIds(state.tree)),
    ...(state.docks?.right?.panes ?? []),
  ];
}

interface DockCounts {
  left: number;
  right: number;
}

interface Regions {
  left?: Rect;
  main: Rect;
  right?: Rect;
}

function carveColumns(
  full: Rect,
  leftRatio: number | undefined,
  rightRatio: number | undefined,
  mainReserve: number,
): Regions {
  if (leftRatio === undefined && rightRatio === undefined) return { main: full };
  const [leftWidth, rightWidth] = fittedDockWidths(
    leftRatio === undefined ? 0 : preferredDockWidth(full.width, leftRatio),
    rightRatio === undefined ? 0 : preferredDockWidth(full.width, rightRatio),
    full.width,
    mainReserve,
  );
  const mainWidth = full.width - leftWidth - rightWidth;
  return {
    ...(leftRatio !== undefined && { left: { ...full, width: leftWidth } }),
    main: { ...full, x: full.x + leftWidth, width: mainWidth },
    ...(rightRatio !== undefined && {
      right: { ...full, x: full.x + leftWidth + mainWidth, width: rightWidth },
    }),
  };
}

function preferredDockWidth(screenWidth: number, ratio: number): number {
  return Math.max(minPaneSize.width, Math.round(screenWidth * ratio));
}

function fittedDockWidths(
  left: number,
  right: number,
  room: number,
  mainReserve: number,
): [number, number] {
  const available = Math.max(0, room - mainReserve);
  const wanted = left + right;
  if (wanted <= available) return [left, right];
  if (available === 0 || wanted === 0) return [0, 0];
  const scaledLeft = Math.floor((left * available) / wanted);
  return [scaledLeft, available - scaledLeft];
}

function dockHolds(rect: Rect | undefined, count: number): boolean {
  if (count === 0) return true;
  return (
    rect !== undefined &&
    rect.width >= minPaneSize.width &&
    Math.floor(rect.height / count) >= minPaneSize.height
  );
}

function treeHolds(rect: Rect, tree: LayoutNode): boolean {
  return minWidth(tree) <= rect.width && minHeight(tree) <= rect.height;
}

function rightEdge(rect: Rect): number {
  return rect.x + rect.width - 1;
}

function reorder(panes: PaneId[], id: PaneId, direction: "up" | "down"): boolean {
  const from = panes.indexOf(id);
  const to = from + (direction === "down" ? 1 : -1);
  if (from < 0 || to < 0 || to >= panes.length) return false;
  const displaced = panes[to] as PaneId;
  panes[to] = id;
  panes[from] = displaced;
  return true;
}

function edgeAttached(tree: LayoutNode | undefined, id: PaneId, edge: Direction): LayoutNode {
  const leaf: LayoutNode = { kind: "leaf", id };
  if (tree === undefined) return leaf;
  const orientation: Orientation = edge === "left" || edge === "right" ? "row" : "column";
  const leafFirst = edge === "left" || edge === "up";
  return {
    kind: "split",
    orientation,
    ratio: 0.5,
    first: leafFirst ? leaf : tree,
    second: leafFirst ? tree : leaf,
  };
}

function stackVertically(ids: PaneId[], rect: Rect, into: Map<PaneId, Rect>): void {
  ids.forEach((id, index) => {
    into.set(id, stackSlotRect(rect, ids.length, index));
  });
}

function stackSlotRect(rect: Rect, slots: number, index: number): Rect {
  const base = Math.floor(rect.height / slots);
  const extra = rect.height % slots;
  return {
    x: rect.x,
    y: rect.y + index * base + Math.min(index, extra),
    width: rect.width,
    height: base + (index < extra ? 1 : 0),
  };
}

function freshDocks(): Record<DockSide, DockState> {
  return { left: loadedDock(undefined), right: loadedDock(undefined) };
}

function loadedDock(dock: DockState | undefined): DockState {
  return { panes: [...(dock?.panes ?? [])], ratio: dock?.ratio ?? defaultDockRatio };
}

function snapshotDock(dock: DockState): DockState {
  return { panes: [...dock.panes], ratio: dock.ratio };
}

function otherSide(side: DockSide): DockSide {
  return side === "left" ? "right" : "left";
}

function parseNode(value: unknown): LayoutNode | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "leaf") {
    return isPaneId(value.id) ? { kind: "leaf", id: value.id } : undefined;
  }
  if (value.kind !== "split") return undefined;
  const orientation = value.orientation;
  if (orientation !== "row" && orientation !== "column") return undefined;
  const ratio = parseRatio(value.ratio, splitRatioBounds);
  const first = parseNode(value.first);
  const second = parseNode(value.second);
  if (ratio === undefined || first === undefined || second === undefined) return undefined;
  return { kind: "split", orientation, ratio, first, second };
}

function parseDocks(value: unknown): DocksState | undefined {
  if (!isRecord(value)) return undefined;
  const left = value.left === undefined ? undefined : parseDock(value.left);
  if (value.left !== undefined && left === undefined) return undefined;
  const right = value.right === undefined ? undefined : parseDock(value.right);
  if (value.right !== undefined && right === undefined) return undefined;
  if (left === undefined && right === undefined) return undefined;
  return {
    ...(left !== undefined && { left }),
    ...(right !== undefined && { right }),
  };
}

function parseSingleDock(value: unknown): DocksState | undefined {
  if (!isRecord(value)) return undefined;
  const side = value.side;
  if (side !== "left" && side !== "right") return undefined;
  const dock = parseDock(value);
  if (dock === undefined) return undefined;
  return side === "left" ? { left: dock } : { right: dock };
}

function parseDock(value: unknown): DockState | undefined {
  if (!isRecord(value)) return undefined;
  const panes = value.panes;
  if (!Array.isArray(panes) || panes.length === 0 || !panes.every(isPaneId)) return undefined;
  const ratio = parseRatio(value.ratio, dockRatioBounds);
  if (ratio === undefined) return undefined;
  return { panes: [...panes], ratio };
}

function parseRatio(value: unknown, bounds: { min: number; max: number }): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return clamp(value, bounds.min, bounds.max);
}

function isPaneId(value: unknown): value is PaneId {
  return typeof value === "string" && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneNode(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return { ...node };
  return { ...node, first: cloneNode(node.first), second: cloneNode(node.second) };
}

function wideOrTall(rect: Rect): Orientation {
  return rect.width >= rect.height * terminalCellAspect ? "row" : "column";
}

function area(rect: Rect): number {
  return rect.width * rect.height;
}

function leafIds(node: LayoutNode): PaneId[] {
  if (node.kind === "leaf") return [node.id];
  return [...leafIds(node.first), ...leafIds(node.second)];
}

function splitLeaf(
  node: LayoutNode,
  target: PaneId,
  incoming: LayoutNode,
  orientation: Orientation,
): LayoutNode {
  if (node.kind === "leaf") {
    if (node.id !== target) return node;
    return { kind: "split", orientation, ratio: 0.5, first: node, second: incoming };
  }
  return {
    ...node,
    first: splitLeaf(node.first, target, incoming, orientation),
    second: splitLeaf(node.second, target, incoming, orientation),
  };
}

function removeLeaf(node: LayoutNode, id: PaneId): LayoutNode | undefined {
  if (node.kind === "leaf") return node.id === id ? undefined : node;
  const first = removeLeaf(node.first, id);
  const second = removeLeaf(node.second, id);
  if (first === undefined) return second;
  if (second === undefined) return first;
  return { ...node, first, second };
}

function replaceLeaf(node: LayoutNode, from: PaneId, to: PaneId): LayoutNode {
  if (node.kind === "leaf") return node.id === from ? { kind: "leaf", id: to } : node;
  return {
    ...node,
    first: replaceLeaf(node.first, from, to),
    second: replaceLeaf(node.second, from, to),
  };
}

function swapLeaves(node: LayoutNode, left: PaneId, right: PaneId): LayoutNode {
  if (node.kind === "leaf") {
    if (node.id === left) return { kind: "leaf", id: right };
    if (node.id === right) return { kind: "leaf", id: left };
    return node;
  }
  return {
    ...node,
    first: swapLeaves(node.first, left, right),
    second: swapLeaves(node.second, left, right),
  };
}

function collectRects(node: LayoutNode, rect: Rect, into: Map<PaneId, Rect>): void {
  if (node.kind === "leaf") {
    into.set(node.id, rect);
    return;
  }
  const [first, second] = divide(rect, node);
  collectRects(node.first, first, into);
  collectRects(node.second, second, into);
}

function divide(rect: Rect, split: SplitNode): [Rect, Rect] {
  if (split.orientation === "row") {
    const width = divideExtent(
      rect.width,
      split.ratio,
      minWidth(split.first),
      minWidth(split.second),
    );
    return [
      { ...rect, width },
      { ...rect, x: rect.x + width, width: rect.width - width },
    ];
  }
  const height = divideExtent(
    rect.height,
    split.ratio,
    minHeight(split.first),
    minHeight(split.second),
  );
  return [
    { ...rect, height },
    { ...rect, y: rect.y + height, height: rect.height - height },
  ];
}

function divideExtent(total: number, ratio: number, minFirst: number, minSecond: number): number {
  if (total <= 1) return Math.max(0, total);
  const preferred = clamp(Math.round(total * ratio), minFirst, total - minSecond);
  return clamp(preferred, 1, total - 1);
}

function minWidth(node: LayoutNode): number {
  if (node.kind === "leaf") return minPaneSize.width;
  const first = minWidth(node.first);
  const second = minWidth(node.second);
  return node.orientation === "row" ? first + second : Math.max(first, second);
}

function minHeight(node: LayoutNode): number {
  if (node.kind === "leaf") return minPaneSize.height;
  const first = minHeight(node.first);
  const second = minHeight(node.second);
  return node.orientation === "column" ? first + second : Math.max(first, second);
}

function resizeAroundLeaf(node: LayoutNode, id: PaneId, delta: number): LayoutNode {
  if (node.kind === "leaf") return node;
  if (isLeafOf(node.first, id)) return withRatio(node, node.ratio + delta);
  if (isLeafOf(node.second, id)) return withRatio(node, node.ratio - delta);
  return {
    ...node,
    first: resizeAroundLeaf(node.first, id, delta),
    second: resizeAroundLeaf(node.second, id, delta),
  };
}

function isLeafOf(node: LayoutNode, id: PaneId): boolean {
  return node.kind === "leaf" && node.id === id;
}

function withRatio(split: SplitNode, ratio: number): SplitNode {
  return { ...split, ratio: clamp(ratio, splitRatioBounds.min, splitRatioBounds.max) };
}

function nearestInDirection(
  fromId: PaneId,
  from: Rect,
  rects: Map<PaneId, Rect>,
  direction: Direction,
  eligible: (id: PaneId) => boolean = () => true,
): PaneId | undefined {
  const fromCenter = center(from);
  let best: { id: PaneId; distance: number } | undefined;
  for (const [id, rect] of rects) {
    if (id === fromId || !eligible(id) || !isInDirection(from, rect, direction)) continue;
    const distance = squaredDistance(fromCenter, center(rect));
    if (best === undefined || distance < best.distance) best = { id, distance };
  }
  return best?.id;
}

function isInDirection(from: Rect, candidate: Rect, direction: Direction): boolean {
  switch (direction) {
    case "left":
      return candidate.x + candidate.width <= from.x;
    case "right":
      return candidate.x >= from.x + from.width;
    case "up":
      return candidate.y + candidate.height <= from.y;
    case "down":
      return candidate.y >= from.y + from.height;
  }
}

function center(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function squaredDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - b.x) ** 2 + ((a.y - b.y) * terminalCellAspect) ** 2;
}
