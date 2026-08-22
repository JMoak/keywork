import { launchPanes } from "../../packages/cli/src/main.ts";
import { defaultSessionDir } from "../../packages/cli/src/paths.ts";
import { fileWorkspaceRecall, selectWorkspace } from "../../packages/cli/src/workspaces.ts";
import type { ComposedWorld } from "./harness.ts";

export function liveWorld(cwd: string): ComposedWorld {
  const workspace = selectWorkspace(cwd, undefined, fileWorkspaceRecall(), console.warn);
  return {
    workspaceDir: cwd,
    sessionDir: defaultSessionDir(cwd, workspace),
    compose: (seams) => launchPanes({ cwd, workspace }, seams),
    dispose: () => {},
  };
}
