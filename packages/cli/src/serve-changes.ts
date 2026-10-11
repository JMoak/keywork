import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type CheckpointReads, scopeContains, type ToolScope } from "@keywork/engine";
import { type ChangesSource, WorkspaceScopeError } from "@keywork/server";

export const sessionStartBaseline = "session start";

export function checkpointChanges(checkpoints: CheckpointReads, scope: ToolScope): ChangesSource {
  const workingFileAt = (path: string): string => {
    const target = resolve(scope.cwd, path);
    if (!scopeContains(scope, target)) throw new WorkspaceScopeError(path);
    return target;
  };
  return {
    label: sessionStartBaseline,
    changes: async () => checkpoints.changedSince(await checkpoints.baseline()),
    before: async (path) => checkpoints.contentAt(await checkpoints.baseline(), path),
    after: (path) => readFile(workingFileAt(path), "utf8").catch(() => undefined),
  };
}
