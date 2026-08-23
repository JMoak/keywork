import { fullRect, type Rect, type Screen } from "./geometry.ts";
import { type Arrangement, type DockSide, mainPanes } from "./layout-arrangement.ts";
import {
  collectRects,
  type LayoutNode,
  minHeight,
  minPaneSize,
  minWidth,
  type PaneId,
  retainLeaves,
} from "./layout-tree.ts";

export interface Regions {
  left?: Rect;
  main: Rect;
  right?: Rect;
}

export type Scene =
  | { readonly kind: "solo"; readonly id: PaneId }
  | { readonly kind: "tiled"; readonly arrangement: Arrangement; readonly regions: Regions };

export function sceneOf(
  arrangement: Arrangement,
  anchor: PaneId | undefined,
  screen: Screen,
): Scene {
  if (holds(arrangement, screen)) return tiled(arrangement, screen);
  const order = admissionOrder(arrangement);
  const first = anchor ?? order[0];
  if (first === undefined) return tiled(arrangement, screen);
  let shown = new Set([first]);
  if (!holds(retaining(arrangement, shown), screen)) return { kind: "solo", id: first };
  for (const id of order) {
    if (shown.has(id)) continue;
    const candidate = new Set([...shown, id]);
    if (holds(retaining(arrangement, candidate), screen)) shown = candidate;
  }
  return tiled(retaining(arrangement, shown), screen);
}

export type DockWeights = (id: PaneId) => number;

export const evenWeights: DockWeights = () => 1;

export function sceneRects(
  scene: Scene,
  screen: Screen,
  weightOf: DockWeights = evenWeights,
): Map<PaneId, Rect> {
  if (scene.kind === "solo") return new Map([[scene.id, fullRect(screen)]]);
  const rects = new Map<PaneId, Rect>();
  const { arrangement, regions } = scene;
  if (regions.left !== undefined) {
    stackVertically(arrangement.docks.left.panes, regions.left, rects, weightOf);
  }
  if (arrangement.tree !== undefined) collectRects(arrangement.tree, regions.main, rects);
  if (regions.right !== undefined) {
    stackVertically(arrangement.docks.right.panes, regions.right, rects, weightOf);
  }
  return rects;
}

export function dockSlotRects(rect: Rect, weights: readonly number[]): Rect[] {
  let y = rect.y;
  return integerShares(honestWeights(weights, rect.height), rect.height).map((height) => {
    const slot = { x: rect.x, y, width: rect.width, height };
    y += height;
    return slot;
  });
}

export function regionsOf(arrangement: Arrangement, screen: Screen): Regions {
  const { tree, docks } = arrangement;
  return carveColumns(
    fullRect(screen),
    docks.left.panes.length > 0 ? docks.left.ratio : undefined,
    docks.right.panes.length > 0 ? docks.right.ratio : undefined,
    tree === undefined ? minPaneSize.width : Math.max(minPaneSize.width, minWidth(tree)),
  );
}

export function holds(arrangement: Arrangement, screen: Screen): boolean {
  const regions = regionsOf(arrangement, screen);
  return (
    dockHolds(regions.left, arrangement.docks.left.panes.length) &&
    dockHolds(regions.right, arrangement.docks.right.panes.length) &&
    (arrangement.tree === undefined || treeHolds(regions.main, arrangement.tree))
  );
}

function honestWeights(weights: readonly number[], height: number): readonly number[] {
  const unit = height / sum(weights);
  const everySlotFits = weights.every((weight) => Math.floor(weight * unit) >= minPaneSize.height);
  return everySlotFits ? weights : weights.map(() => 1);
}

function integerShares(weights: readonly number[], height: number): number[] {
  const total = sum(weights);
  const floors = weights.map((weight) => Math.floor((weight * height) / total));
  const leftover = height - sum(floors);
  return floors.map((share, index) => (index < leftover ? share + 1 : share));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function tiled(arrangement: Arrangement, screen: Screen): Scene {
  return { kind: "tiled", arrangement, regions: regionsOf(arrangement, screen) };
}

function admissionOrder(arrangement: Arrangement): PaneId[] {
  return [
    ...mainPanes(arrangement),
    ...arrangement.docks.left.panes,
    ...arrangement.docks.right.panes,
  ];
}

function retaining(arrangement: Arrangement, shown: ReadonlySet<PaneId>): Arrangement {
  const keep = (id: PaneId): boolean => shown.has(id);
  const dock = (side: DockSide) => {
    const { panes, ratio, pins } = arrangement.docks[side];
    return { panes: panes.filter(keep), ratio, pins: panes.slice(0, pins).filter(keep).length };
  };
  return {
    tree: arrangement.tree === undefined ? undefined : retainLeaves(arrangement.tree, keep),
    docks: { left: dock("left"), right: dock("right") },
  };
}

function stackVertically(
  ids: readonly PaneId[],
  rect: Rect,
  into: Map<PaneId, Rect>,
  weightOf: DockWeights,
): void {
  const slots = dockSlotRects(rect, ids.map(weightOf));
  ids.forEach((id, index) => {
    into.set(id, slots[index] as Rect);
  });
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
