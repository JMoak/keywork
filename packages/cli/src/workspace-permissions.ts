import { statSync } from "node:fs";
import { homedir } from "node:os";
import { PermissionLedger, type PermissionResolver } from "@keywork/engine";
import { GrantStore } from "@keywork/shared";
import { workspaceIdentity, workspacePermissionsFile } from "./paths.ts";

export interface WorkspacePermissionsOptions {
  cwd: string;
  projectTrusted: boolean;
  workspaceSlug?: string | undefined;
  userRoot?: string | undefined;
  user?: PermissionResolver | undefined;
}

export function workspacePermissions(options: WorkspacePermissionsOptions): PermissionLedger {
  return new PermissionLedger({
    trusted: options.projectTrusted,
    workspace: new GrantStore({ file: grantFileOf(options) }),
    root: options.cwd,
    user: options.user,
  });
}

export function workspacePermissionsRecordedAt(
  options: Pick<WorkspacePermissionsOptions, "cwd" | "workspaceSlug" | "userRoot">,
): Date | undefined {
  return statSync(grantFileOf(options), { throwIfNoEntry: false })?.mtime;
}

function grantFileOf(
  options: Pick<WorkspacePermissionsOptions, "cwd" | "workspaceSlug" | "userRoot">,
): string {
  const identity = workspaceIdentity(options.cwd, options.workspaceSlug);
  return workspacePermissionsFile(identity, options.userRoot ?? homedir());
}
