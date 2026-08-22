import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionEscrow, SessionPort } from "./session-attachment.ts";
import { parseWorkspaceState, type WorkspacePane, type WorkspaceState } from "./workspace-state.ts";

export interface WorkspacePort {
  load(): Promise<unknown>;
  save(state: WorkspaceState): void;
  seal(): void;
}

export interface RestoreSources {
  workspace?: WorkspacePort;
  sessions?: SessionPort;
}

export type RestorePlan =
  | { kind: "fresh" }
  | { kind: "restore"; state: WorkspaceState }
  | { kind: "failed"; cause: unknown };

export async function loadRestorePlan(
  sources: RestoreSources,
  escrow: SessionEscrow,
): Promise<RestorePlan> {
  if (sources.workspace === undefined) return { kind: "fresh" };
  try {
    const state = parseWorkspaceState(await sources.workspace.load());
    if (state === undefined) return { kind: "fresh" };
    const panes: WorkspacePane[] = [];
    for (const pane of state.panes) {
      if (await restorable(pane, sources.sessions, escrow)) panes.push(pane);
    }
    return panes.length === 0 ? { kind: "fresh" } : { kind: "restore", state: { ...state, panes } };
  } catch (cause) {
    return { kind: "failed", cause };
  }
}

export function statKind(path: string) {
  return statSync(path, { throwIfNoEntry: false });
}

async function restorable(
  pane: WorkspacePane,
  sessions: SessionPort | undefined,
  escrow: SessionEscrow,
): Promise<boolean> {
  switch (pane.kind) {
    case "conversation": {
      if (pane.sessionId === undefined) return true;
      const attachment = await sessions?.open(pane.sessionId);
      if (attachment === undefined) return false;
      escrow.hold(pane.sessionId, attachment);
      return true;
    }
    case "file":
      return statKind(resolve(process.cwd(), pane.path))?.isFile() === true;
    case "browser":
      return statKind(resolve(process.cwd(), pane.root))?.isDirectory() === true;
    case "session-tree":
    case "arcs":
    case "memory":
    case "mcp":
      return true;
  }
}
