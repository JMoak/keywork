import type { Chord } from "../keys.ts";
import type { Pane } from "../pane.ts";
import type { AppProbe } from "../probe.ts";
import { resolveTheme } from "../theme.ts";
import { parseWorkspaceState, type WorkspaceState } from "../workspace-state.ts";

export function mustParse(value: unknown): WorkspaceState {
  const state = parseWorkspaceState(value);
  if (state === undefined) throw new Error("expected a parseable workspace state");
  return state;
}

export function paneIds(probe: AppProbe): string[] {
  return probe.snapshot().panes.map((pane) => pane.id);
}

export function stubFilePane(
  id: string,
  path: string,
  handleKey?: (chord: Chord) => boolean,
): Pane {
  return {
    id,
    title: () => ` ${path} `,
    view: () => {
      throw new Error("probe panes are never rendered");
    },
    ...(handleKey !== undefined && { handleKey }),
  };
}

export function dockedIds(probe: AppProbe): string[] {
  return probe
    .snapshot()
    .panes.filter((pane) => pane.dock !== undefined)
    .map((pane) => pane.id);
}

export function dockOf(probe: AppProbe, id: string): "left" | "right" | undefined {
  return probe.snapshot().panes.find((pane) => pane.id === id)?.dock;
}

export function pinnedIds(probe: AppProbe): string[] {
  return probe
    .snapshot()
    .panes.filter((pane) => pane.pinned)
    .map((pane) => pane.id);
}

export function paneContext() {
  return { theme: resolveTheme(), focused: true, width: 60, height: 20 };
}

export function describePaneTree(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  const record = node as { props?: { content?: unknown }; children?: unknown[] };
  return {
    ...(record.props?.content !== undefined && { content: record.props.content }),
    ...(Array.isArray(record.children) && { children: record.children.map(describePaneTree) }),
  };
}
