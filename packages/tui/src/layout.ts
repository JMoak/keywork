import { clamp } from "./clamp.ts";

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

export interface Screen {
  width: number;
  height: number;
}

const terminalCellAspect = 2;
const dockRatioBounds = { min: 0.15, max: 0.6 };
const defaultDockRatio = 1 / 3;
const splitRatioBounds = { min: 0.1, max: 0.9 };
const minPaneWidth = 5;
const minPaneHeight = 3;

export class Layout {
  private tree: LayoutNode | undefined;
  private focusedId: PaneId | undefined;
  private zoomedId: PaneId | undefined;
  private dockIds: PaneId[] = [];
  private dockEdge: DockSide = "left";
  private dockRatio = defaultDockRatio;

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
    return [...this.mainPanes(), ...this.dockIds];
  }

  dock(): { side: DockSide; panes: PaneId[]; ratio: number } | undefined {
    if (this.dockIds.length === 0) return undefined;
    return { side: this.dockEdge, panes: [...this.dockIds], ratio: this.dockRatio };
  }

  open(id: PaneId, screen: Screen): void {
    if (this.panes().includes(id)) {
      this.focusedId = id;
      return;
    }
    this.zoomedId = undefined;
    if (
      this.focusedId !== undefined &&
      this.dockIds.includes(this.focusedId) &&
      this.tree !== undefined
    ) {
      this.dockIds.splice(this.dockIds.indexOf(this.focusedId) + 1, 0, id);
      this.focusedId = id;
      return;
    }
    const leaf: LayoutNode = { kind: "leaf", id };
    if (this.tree === undefined || this.focusedId === undefined) {
      this.tree = leaf;
      this.focusedId = id;
      return;
    }
    const target = this.focusedId;
    const targetRect = this.rects(screen).get(target) as Rect;
    this.tree = splitLeaf(this.tree, target, leaf, wideOrTall(targetRect));
    this.focusedId = id;
  }

  close(id: PaneId): void {
    if (this.zoomedId === id) this.zoomedId = undefined;
    const dockIndex = this.dockIds.indexOf(id);
    if (dockIndex >= 0) {
      this.dockIds.splice(dockIndex, 1);
      if (this.focusedId === id) {
        this.focusedId =
          this.dockIds[Math.min(dockIndex, this.dockIds.length - 1)] ?? this.mainPanes()[0];
      }
      return;
    }
    if (this.tree === undefined) return;
    this.tree = removeLeaf(this.tree, id);
    if (this.focusedId === id) {
      this.focusedId = this.mainPanes()[0] ?? this.dockIds[0];
    }
  }

  focus(id: PaneId): void {
    if (this.panes().includes(id)) this.focusedId = id;
  }

  moveFocus(direction: Direction, screen: Screen): PaneId | undefined {
    const neighbor = this.neighbor(direction, screen);
    if (neighbor !== undefined) this.focusedId = neighbor;
    return neighbor;
  }

  swap(direction: Direction, screen: Screen): boolean {
    const from = this.focusedId;
    const to = this.neighbor(direction, screen);
    if (from === undefined || to === undefined) return false;
    if (this.tree !== undefined) this.tree = swapLeaves(this.tree, from, to);
    this.dockIds = this.dockIds.map((id) => (id === from ? to : id === to ? from : id));
    return true;
  }

  zoomToggle(): void {
    if (this.focusedId === undefined) return;
    this.zoomedId = this.zoomedId === this.focusedId ? undefined : this.focusedId;
  }

  dockFocused(side: DockSide): void {
    const id = this.focusedId;
    if (id === undefined) return;
    this.zoomedId = undefined;
    this.dockEdge = side;
    if (this.dockIds.includes(id)) return;
    if (this.tree !== undefined) this.tree = removeLeaf(this.tree, id);
    this.dockIds.push(id);
  }

  undockFocused(screen: Screen): void {
    const id = this.focusedId;
    if (id === undefined) return;
    const dockIndex = this.dockIds.indexOf(id);
    if (dockIndex < 0) return;
    this.zoomedId = undefined;
    this.dockIds.splice(dockIndex, 1);
    const leaf: LayoutNode = { kind: "leaf", id };
    const target = this.largestMainLeaf(screen);
    if (this.tree === undefined || target === undefined) {
      this.tree = leaf;
      return;
    }
    this.tree = splitLeaf(this.tree, target.id, leaf, wideOrTall(target.rect));
  }

  growDock(delta: number): void {
    this.dockRatio = clamp(this.dockRatio + delta, dockRatioBounds.min, dockRatioBounds.max);
  }

  resizeFocused(delta: number): void {
    if (this.focusedId === undefined || this.tree === undefined) return;
    this.tree = resizeAroundLeaf(this.tree, this.focusedId, delta);
  }

  rects(screen: Screen): Map<PaneId, Rect> {
    const result = new Map<PaneId, Rect>();
    const full: Rect = { x: 0, y: 0, width: screen.width, height: screen.height };
    if (this.zoomedId !== undefined && this.panes().includes(this.zoomedId)) {
      result.set(this.zoomedId, full);
      return result;
    }
    if (this.dockIds.length === 0) {
      if (this.tree !== undefined) collectRects(this.tree, full, result);
      return result;
    }
    if (this.tree === undefined) {
      stackVertically(this.dockIds, full, result);
      return result;
    }
    const [dockRect, mainRect] = splitAtDock(full, this.dockEdge, this.dockRatio);
    stackVertically(this.dockIds, dockRect, result);
    collectRects(this.tree, mainRect, result);
    return result;
  }

  private mainPanes(): PaneId[] {
    return this.tree === undefined ? [] : leafIds(this.tree);
  }

  private largestMainLeaf(screen: Screen): { id: PaneId; rect: Rect } | undefined {
    if (this.tree === undefined) return undefined;
    const rects = this.rects(screen);
    let best: { id: PaneId; rect: Rect } | undefined;
    for (const id of leafIds(this.tree)) {
      const rect = rects.get(id) as Rect;
      if (best === undefined || area(rect) > area(best.rect)) best = { id, rect };
    }
    return best;
  }

  private neighbor(direction: Direction, screen: Screen): PaneId | undefined {
    if (this.focusedId === undefined) return undefined;
    const rects = this.rects(screen);
    const origin = rects.get(this.focusedId);
    if (origin === undefined) return undefined;
    return nearestInDirection(this.focusedId, origin, rects, direction);
  }
}

function splitAtDock(full: Rect, side: DockSide, ratio: number): [Rect, Rect] {
  const dockWidth = clamp(
    Math.round(full.width * ratio),
    Math.min(1, full.width),
    Math.max(1, full.width - 1),
  );
  const mainWidth = full.width - dockWidth;
  if (side === "left") {
    return [
      { ...full, width: dockWidth },
      { ...full, x: full.x + dockWidth, width: mainWidth },
    ];
  }
  return [
    { ...full, x: full.x + mainWidth, width: dockWidth },
    { ...full, width: mainWidth },
  ];
}

function stackVertically(ids: PaneId[], rect: Rect, into: Map<PaneId, Rect>): void {
  const base = Math.floor(rect.height / ids.length);
  const extra = rect.height % ids.length;
  let y = rect.y;
  ids.forEach((id, index) => {
    const height = base + (index < extra ? 1 : 0);
    into.set(id, { x: rect.x, y, width: rect.width, height });
    y += height;
  });
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
  if (node.kind === "leaf") return minPaneWidth;
  const first = minWidth(node.first);
  const second = minWidth(node.second);
  return node.orientation === "row" ? first + second : Math.max(first, second);
}

function minHeight(node: LayoutNode): number {
  if (node.kind === "leaf") return minPaneHeight;
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
): PaneId | undefined {
  const fromCenter = center(from);
  let best: { id: PaneId; distance: number } | undefined;
  for (const [id, rect] of rects) {
    if (id === fromId || !isInDirection(from, rect, direction)) continue;
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
