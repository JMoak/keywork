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
  const identity = workspaceIdentity(options.cwd, options.workspaceSlug);
  const file = workspacePermissionsFile(identity, options.userRoot ?? homedir());
  return new PermissionLedger({
    trusted: options.projectTrusted,
    workspace: new GrantStore({ file }),
    root: options.cwd,
    user: options.user,
  });
}
