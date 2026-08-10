import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "@keywork/shared";

export function projectKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

export function defaultSessionDir(cwd: string): string {
  return join(homedir(), ".keywork", "sessions", projectKey(cwd));
}

export function snapshotGitDir(cwd: string): string {
  return join(homedir(), ".keywork", "snapshots", projectKey(cwd));
}

export type WorkspaceIdentity = string;

export function workspaceIdentity(cwd: string): WorkspaceIdentity {
  const workspace = openWorkspace(cwd);
  return workspace === undefined ? projectKey(cwd) : declaredIdentity(workspace.root);
}

export function workspaceStateFile(identity: WorkspaceIdentity): string {
  return join(homedir(), ".keywork", "workspaces", `${identity}.json`);
}

function declaredIdentity(root: string): string {
  return createHash("sha256").update(`workspace:${root}`).digest("hex").slice(0, 12);
}
