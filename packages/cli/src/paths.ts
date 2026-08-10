import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function projectKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

export function defaultSessionDir(cwd: string): string {
  return join(homedir(), ".keywork", "sessions", projectKey(cwd));
}

export function snapshotGitDir(cwd: string): string {
  return join(homedir(), ".keywork", "snapshots", projectKey(cwd));
}
