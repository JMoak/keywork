import { canonicalPath } from "@keywork/shared";
import { managedHomeFolder, workspaceIdentity } from "../paths.ts";
import { runningServerAmong, workspaceTicketFile } from "../serve.ts";
import type { NodeWorkspace } from "./config.ts";
import { coreArgs, launchArgv, type SelfLaunch, workspaceServeArgs } from "./launch.ts";
import type { UnitSpec } from "./supervisor.ts";

export const coreUnitName = "core";

export interface WorkspaceUnit {
  workspace: NodeWorkspace;
  identity: string;
  ticket: string;
  spec: UnitSpec;
}

export const supervisorEnv = "KEYWORK_NODE_SUPERVISOR";

export function coreUnit(launch: SelfLaunch, stateDir: string, supervisorPid: number): UnitSpec {
  return {
    name: coreUnitName,
    argv: launchArgv(launch, coreArgs),
    cwd: stateDir,
    env: { [supervisorEnv]: String(supervisorPid) },
  };
}

export function workspaceUnit(
  workspace: NodeWorkspace,
  launch: SelfLaunch,
  userRoot: string,
  fetcher: typeof fetch,
): WorkspaceUnit {
  if (
    workspace.home &&
    canonicalPath(workspace.cwd) !== canonicalPath(managedHomeFolder(userRoot))
  ) {
    throw new Error("A personal home must use the dedicated managed home folder.");
  }
  const slug = workspace.slug ?? undefined;
  const identity = workspaceIdentity(workspace.cwd, slug);
  const ticket = workspaceTicketFile(workspace.cwd, slug, userRoot);
  return {
    workspace,
    identity,
    ticket,
    spec: {
      name: workspaceUnitName(identity),
      argv: launchArgv(launch, workspaceServeArgs(workspace.slug, workspace.home === true)),
      cwd: workspace.cwd,
      occupied: async () => (await runningServerAmong([ticket], fetcher)) !== undefined,
    },
  };
}

export function workspaceUnitName(identity: string): string {
  return `workspace:${identity}`;
}
