import { clamp } from "./clamp.ts";
import { type LayoutNode, leafIds, type PaneId, removeLeaf, swapLeaves } from "./layout-tree.ts";

export type DockSide = "left" | "right";

export interface DockState {
  readonly panes: readonly PaneId[];
  readonly ratio: number;
}

export interface Arrangement {
  readonly tree: LayoutNode | undefined;
  readonly docks: Readonly<Record<DockSide, DockState>>;
}

export const dockSides: readonly DockSide[] = ["left", "right"];
export const dockRatioBounds = { min: 0.05, max: 0.6 };
export const defaultDockRatio = 1 / 3;

export function emptyArrangement(): Arrangement {
  return { tree: undefined, docks: { left: emptyDock, right: emptyDock } };
}

export function panesOf(arrangement: Arrangement): PaneId[] {
  return [
    ...arrangement.docks.left.panes,
    ...mainPanes(arrangement),
    ...arrangement.docks.right.panes,
  ];
}

export function mainPanes(arrangement: Arrangement): PaneId[] {
  return arrangement.tree === undefined ? [] : leafIds(arrangement.tree);
}

export function sideOf(arrangement: Arrangement, id: PaneId): DockSide | undefined {
  return dockSides.find((side) => arrangement.docks[side].panes.includes(id));
}

export function otherSide(side: DockSide): DockSide {
  return side === "left" ? "right" : "left";
}

export function withTree(arrangement: Arrangement, tree: LayoutNode | undefined): Arrangement {
  return { ...arrangement, tree };
}

export function withDockRatio(
  arrangement: Arrangement,
  side: DockSide,
  ratio: number,
): Arrangement {
  const dock = arrangement.docks[side];
  return withDock(arrangement, side, {
    ...dock,
    ratio: clamp(ratio, dockRatioBounds.min, dockRatioBounds.max),
  });
}

export function lifted(arrangement: Arrangement, id: PaneId): Arrangement {
  const side = sideOf(arrangement, id);
  if (side !== undefined) {
    const dock = arrangement.docks[side];
    return withDock(arrangement, side, {
      ...dock,
      panes: dock.panes.filter((pane) => pane !== id),
    });
  }
  if (arrangement.tree === undefined) return arrangement;
  return withTree(arrangement, removeLeaf(arrangement.tree, id));
}

export function dockedAt(
  arrangement: Arrangement,
  side: DockSide,
  id: PaneId,
  index = arrangement.docks[side].panes.length,
): Arrangement {
  const dock = arrangement.docks[side];
  const panes = [...dock.panes];
  panes.splice(clamp(index, 0, panes.length), 0, id);
  return withDock(arrangement, side, { ...dock, panes });
}

export function reorderedInDock(
  arrangement: Arrangement,
  side: DockSide,
  id: PaneId,
  step: -1 | 1,
): Arrangement | undefined {
  const dock = arrangement.docks[side];
  const from = dock.panes.indexOf(id);
  const displaced = from < 0 ? undefined : dock.panes[from + step];
  if (displaced === undefined) return undefined;
  const panes = [...dock.panes];
  panes[from] = displaced;
  panes[from + step] = id;
  return withDock(arrangement, side, { ...dock, panes });
}

export function swapped(arrangement: Arrangement, one: PaneId, other: PaneId): Arrangement {
  const exchange = (pane: PaneId): PaneId => (pane === one ? other : pane === other ? one : pane);
  const { tree, docks } = arrangement;
  return {
    tree: tree === undefined ? undefined : swapLeaves(tree, one, other),
    docks: {
      left: { ...docks.left, panes: docks.left.panes.map(exchange) },
      right: { ...docks.right, panes: docks.right.panes.map(exchange) },
    },
  };
}

const emptyDock: DockState = { panes: [], ratio: defaultDockRatio };

function withDock(arrangement: Arrangement, side: DockSide, dock: DockState): Arrangement {
  return { ...arrangement, docks: { ...arrangement.docks, [side]: dock } };
}
