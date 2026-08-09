export type PaneId = string;
export type Orientation = "row" | "column";
export type Direction = "left" | "right" | "up" | "down";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutNode =
  | { kind: "leaf"; id: PaneId }
  | { kind: "split"; orientation: Orientation; first: LayoutNode; second: LayoutNode };

export interface Screen {
  width: number;
  height: number;
}

const terminalCellAspect = 2;

export class Layout {
  private tree: LayoutNode | undefined;
  private focusedId: PaneId | undefined;
  private zoomedId: PaneId | undefined;

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
    return this.tree === undefined ? [] : leafIds(this.tree);
  }

  open(id: PaneId, screen: Screen): void {
    if (this.panes().includes(id)) {
      this.focusedId = id;
      return;
    }
    this.zoomedId = undefined;
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
    if (this.tree === undefined) return;
    if (this.zoomedId === id) this.zoomedId = undefined;
    const remaining = removeLeaf(this.tree, id);
    this.tree = remaining;
    if (this.focusedId === id) {
      this.focusedId = remaining === undefined ? undefined : (leafIds(remaining)[0] as PaneId);
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
    if (from === undefined || to === undefined || this.tree === undefined) return false;
    this.tree = swapLeaves(this.tree, from, to);
    return true;
  }

  zoomToggle(): void {
    if (this.focusedId === undefined) return;
    this.zoomedId = this.zoomedId === this.focusedId ? undefined : this.focusedId;
  }

  rects(screen: Screen): Map<PaneId, Rect> {
    const result = new Map<PaneId, Rect>();
    if (this.tree === undefined) return result;
    if (this.zoomedId !== undefined && this.panes().includes(this.zoomedId)) {
      result.set(this.zoomedId, { x: 0, y: 0, width: screen.width, height: screen.height });
      return result;
    }
    collectRects(this.tree, { x: 0, y: 0, width: screen.width, height: screen.height }, result);
    return result;
  }

  private neighbor(direction: Direction, screen: Screen): PaneId | undefined {
    if (this.focusedId === undefined) return undefined;
    const rects = this.rects(screen);
    const origin = rects.get(this.focusedId);
    if (origin === undefined) return undefined;
    return nearestInDirection(this.focusedId, origin, rects, direction);
  }
}

function wideOrTall(rect: Rect): Orientation {
  return rect.width >= rect.height * terminalCellAspect ? "row" : "column";
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
    return { kind: "split", orientation, first: node, second: incoming };
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
  const [first, second] = divide(rect, node.orientation);
  collectRects(node.first, first, into);
  collectRects(node.second, second, into);
}

function divide(rect: Rect, orientation: Orientation): [Rect, Rect] {
  if (orientation === "row") {
    const firstWidth = Math.floor(rect.width / 2);
    return [
      { ...rect, width: firstWidth },
      { ...rect, x: rect.x + firstWidth, width: rect.width - firstWidth },
    ];
  }
  const firstHeight = Math.floor(rect.height / 2);
  return [
    { ...rect, height: firstHeight },
    { ...rect, y: rect.y + firstHeight, height: rect.height - firstHeight },
  ];
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
