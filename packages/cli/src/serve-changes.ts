import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  scopeContains,
  sessionBaseline,
  sessionFilesAt,
  type ToolScope,
  type TurnSession,
  type TurnTrees,
  turnFactsOf,
} from "@keywork/engine";
import {
  type ChangesSource,
  FileTooLargeError,
  maxFileBytes,
  WorkspaceScopeError,
} from "@keywork/server";

export const sessionStartBaseline = "session start";

export interface CheckpointTrees extends TurnTrees {
  contentAt(tree: string, path: string): Promise<string | undefined>;
}

export function sessionChanges(
  trees: CheckpointTrees,
  scope: ToolScope,
  session: TurnSession,
): ChangesSource {
  const after = (path: string) => readWorkingFile(workingFileAt(scope, path), path);
  return {
    label: sessionStartBaseline,
    changes: async () => sessionFilesAt(trees, session, await trees.snapshot()),
    before: async (path) => {
      const baseline = sessionBaseline(session);
      return baseline === undefined ? after(path) : trees.contentAt(baseline, path);
    },
    after,
  };
}

export async function pathsTouchedSince(
  trees: TurnTrees,
  session: TurnSession,
  since: string,
  tree: string,
): Promise<ReadonlySet<string>> {
  const settled = session.store.entries().flatMap((entry) => {
    const facts = turnFactsOf(entry);
    return facts === undefined || entry.timestamp <= since ? [] : facts.files;
  });
  const open = session.openCheckpoint?.();
  const running = open === undefined ? [] : await trees.filesBetween(open, tree);
  return new Set([...settled, ...running].map((file) => file.path));
}

function workingFileAt(scope: ToolScope, path: string): string {
  const target = resolve(scope.cwd, path);
  if (!scopeContains(scope, target)) throw new WorkspaceScopeError(path);
  return target;
}

async function readWorkingFile(target: string, shown: string): Promise<string | undefined> {
  const info = await stat(target).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  if (info.size > maxFileBytes) throw new FileTooLargeError(shown, info.size);
  return readFile(target, "utf8").catch(() => undefined);
}
