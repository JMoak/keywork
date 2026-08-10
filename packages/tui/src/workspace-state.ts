import { Layout, type LayoutState, layoutStateIds } from "./layout.ts";
import type { Pane, PaneDescriptor } from "./pane.ts";

export const workspaceStateVersion = 1;

export type WorkspacePane = { id: string } & PaneDescriptor;

export interface WorkspaceState {
  version: typeof workspaceStateVersion;
  layout: LayoutState;
  panes: WorkspacePane[];
}

export function captureWorkspace(layout: Layout, panes: ReadonlyMap<string, Pane>): WorkspaceState {
  const described: WorkspacePane[] = [];
  for (const id of layout.panes()) {
    const descriptor = panes.get(id)?.describe?.();
    if (descriptor !== undefined) described.push({ id, ...descriptor });
  }
  return { version: workspaceStateVersion, layout: layout.toJSON(), panes: described };
}

export function parseWorkspaceState(value: unknown): WorkspaceState | undefined {
  if (!isRecord(value) || value.version !== workspaceStateVersion) return undefined;
  const layout = Layout.parse(value.layout);
  if (layout === undefined || !Array.isArray(value.panes)) return undefined;
  const knownIds = new Set(layoutStateIds(layout));
  const panes: WorkspacePane[] = [];
  for (const entry of value.panes) {
    const pane = parsePane(entry);
    if (pane === undefined || !knownIds.delete(pane.id)) return undefined;
    panes.push(pane);
  }
  return { version: workspaceStateVersion, layout, panes };
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
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
