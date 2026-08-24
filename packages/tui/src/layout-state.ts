import { clamp } from "./clamp.ts";
import {
  type Arrangement,
  type DockState,
  defaultDockRatio,
  dockRatioBounds,
} from "./layout-arrangement.ts";
import {
  cloneNode,
  type LayoutNode,
  leafIds,
  type PaneId,
  splitRatioBounds,
} from "./layout-tree.ts";

export interface DocksState {
  left?: DockState;
  right?: DockState;
}

export interface LayoutState {
  tree?: LayoutNode;
  focused?: PaneId;
  docks?: DocksState;
}

export function parseLayoutState(value: unknown): LayoutState | undefined {
  if (!isRecord(value)) return undefined;
  const tree = value.tree === undefined ? undefined : parseNode(value.tree);
  if (value.tree !== undefined && tree === undefined) return undefined;
  const docks =
    value.docks !== undefined
      ? parseDocks(value.docks)
      : value.dock !== undefined
        ? parseSingleDock(value.dock)
        : undefined;
  if ((value.docks ?? value.dock) !== undefined && docks === undefined) return undefined;
  const state: LayoutState = {
    ...(tree !== undefined && { tree }),
    ...(docks !== undefined && { docks }),
  };
  const ids = layoutStateIds(state);
  if (ids.length === 0 || new Set(ids).size !== ids.length) return undefined;
  const focused = value.focused;
  if (focused === undefined) return state;
  if (typeof focused !== "string" || !ids.includes(focused)) return undefined;
  return { ...state, focused };
}

export function layoutStateIds(state: LayoutState): PaneId[] {
  return [
    ...(state.docks?.left?.panes ?? []),
    ...(state.tree === undefined ? [] : leafIds(state.tree)),
    ...(state.docks?.right?.panes ?? []),
  ];
}

export function layoutStateOf(arrangement: Arrangement, focused: PaneId | undefined): LayoutState {
  const { tree, docks } = arrangement;
  const persisted: DocksState = {
    ...(docks.left.panes.length > 0 && { left: snapshotDock(docks.left) }),
    ...(docks.right.panes.length > 0 && { right: snapshotDock(docks.right) }),
  };
  return {
    ...(tree !== undefined && { tree: cloneNode(tree) }),
    ...(focused !== undefined && { focused }),
    ...((persisted.left !== undefined || persisted.right !== undefined) && { docks: persisted }),
  };
}

export function arrangementOf(state: LayoutState): Arrangement {
  return {
    tree: state.tree === undefined ? undefined : cloneNode(state.tree),
    docks: { left: revivedDock(state.docks?.left), right: revivedDock(state.docks?.right) },
  };
}

function snapshotDock(dock: DockState): DockState {
  return { panes: [...dock.panes], ratio: dock.ratio, pins: dock.pins };
}

function revivedDock(dock: DockState | undefined): DockState {
  return {
    panes: [...(dock?.panes ?? [])],
    ratio: dock?.ratio ?? defaultDockRatio,
    pins: dock?.pins ?? 0,
  };
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
  return { panes: [...panes], ratio, pins: parsePins(value.pins, panes.length) };
}

function parsePins(value: unknown, paneCount: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return 0;
  return clamp(value, 0, paneCount);
}

function parseRatio(value: unknown, bounds: { min: number; max: number }): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return clamp(value, bounds.min, bounds.max);
}

function isPaneId(value: unknown): value is PaneId {
  return typeof value === "string" && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
