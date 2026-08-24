import { Layout, type LayoutState, layoutStateIds } from "./layout.ts";
import type { Pane, PaneDescriptor } from "./pane.ts";

export const workspaceStateVersion = 2;

const readableVersions: ReadonlySet<unknown> = new Set([1, workspaceStateVersion]);

export type WorkspacePane = { id: string } & PaneDescriptor;

export interface WorkspaceState {
  version: typeof workspaceStateVersion;
  layout: LayoutState;
  panes: WorkspacePane[];
  held: WorkspacePane[];
}

export function captureWorkspace(
  layout: Layout,
  panes: ReadonlyMap<string, Pane>,
  held: Iterable<string> = [],
): WorkspaceState {
  return {
    version: workspaceStateVersion,
    layout: layout.toJSON(),
    panes: describedPanes(layout.panes(), panes),
    held: describedPanes(held, panes),
  };
}

export function parseWorkspaceState(value: unknown): WorkspaceState | undefined {
  if (!isRecord(value) || !readableVersions.has(value.version)) return undefined;
  const layout = Layout.parse(value.layout);
  if (layout === undefined || !Array.isArray(value.panes)) return undefined;
  const heldEntries = value.held ?? [];
  if (!Array.isArray(heldEntries)) return undefined;
  const layoutIds = new Set(layoutStateIds(layout));
  const unclaimed = new Set(layoutIds);
  const panes = parsePanes(value.panes, (id) => unclaimed.delete(id));
  const held = parsePanes(heldEntries, (id) => !layoutIds.has(id));
  if (panes === undefined || held === undefined || hasDuplicateIds(held)) return undefined;
  return { version: workspaceStateVersion, layout, panes, held };
}

function describedPanes(ids: Iterable<string>, panes: ReadonlyMap<string, Pane>): WorkspacePane[] {
  const described: WorkspacePane[] = [];
  for (const id of ids) {
    const descriptor = panes.get(id)?.describe?.();
    if (descriptor !== undefined) described.push({ id, ...descriptor });
  }
  return described;
}

function parsePanes(
  entries: readonly unknown[],
  admits: (id: string) => boolean,
): WorkspacePane[] | undefined {
  const panes: WorkspacePane[] = [];
  for (const entry of entries) {
    const pane = parsePane(entry);
    if (pane === undefined || !admits(pane.id)) return undefined;
    panes.push(pane);
  }
  return panes;
}

function hasDuplicateIds(panes: readonly WorkspacePane[]): boolean {
  return new Set(panes.map((pane) => pane.id)).size !== panes.length;
}

function parsePane(value: unknown): WorkspacePane | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return undefined;
  switch (value.kind) {
    case "conversation":
      if (value.sessionId !== undefined && typeof value.sessionId !== "string") return undefined;
      return {
        id: value.id,
        kind: "conversation",
        ...(value.sessionId !== undefined && { sessionId: value.sessionId }),
      };
    case "file":
      if (typeof value.path !== "string" || value.path === "") return undefined;
      return { id: value.id, kind: "file", path: value.path };
    case "browser":
      if (typeof value.root !== "string" || value.root === "") return undefined;
      return { id: value.id, kind: "browser", root: value.root };
    case "session-tree":
      if (value.sessionId !== undefined && typeof value.sessionId !== "string") return undefined;
      return {
        id: value.id,
        kind: "session-tree",
        ...(value.sessionId !== undefined && { sessionId: value.sessionId }),
      };
    case "arcs":
      if (value.arc !== undefined && typeof value.arc !== "string") return undefined;
      return { id: value.id, kind: "arcs", ...(value.arc !== undefined && { arc: value.arc }) };
    case "arc":
      if (typeof value.arc !== "string" || value.arc === "") return undefined;
      return { id: value.id, kind: "arc", arc: value.arc };
    case "memory":
      return parseMemoryPane(value);
    case "mcp":
      return { id: value.id, kind: "mcp" };
    default:
      return undefined;
  }
}

function parseMemoryPane(value: Record<string, unknown>): WorkspacePane | undefined {
  const id = value.id;
  if (typeof id !== "string") return undefined;
  const lens = value.lens;
  if (lens !== undefined && lens !== "garden" && lens !== "note" && lens !== "ledger")
    return undefined;
  if (value.note !== undefined && typeof value.note !== "string") return undefined;
  if (value.query !== undefined && typeof value.query !== "string") return undefined;
  return {
    id,
    kind: "memory",
    ...(lens !== undefined && { lens }),
    ...(typeof value.note === "string" && { note: value.note }),
    ...(typeof value.query === "string" && { query: value.query }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
