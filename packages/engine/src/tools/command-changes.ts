import type { ChangedPath, TreeChanges } from "../checkpoints.ts";
import type { Tool } from "../tools.ts";
import { maxOutputChars } from "./command-run.ts";

export interface WorktreeChanges {
  snapshot(): Promise<string>;
  changesBetween(from: string, to: string): Promise<TreeChanges>;
}

export function reportingChanges(tool: Tool, worktree: WorktreeChanges | undefined): Tool {
  if (worktree === undefined) return tool;
  return {
    ...tool,
    execute: async (args, signal) => {
      const before = await snapshotOrNothing(worktree);
      const output = await tool.execute(args, signal);
      if (before === undefined) return output;
      const changes = await changesSince(worktree, before);
      return changes === undefined ? output : withChangeReport(output, changes);
    },
  };
}

export function changeReport(changes: TreeChanges): string | undefined {
  if (changes.files.length === 0) return undefined;
  const heading = `changed ${plural(changes.files.length, "file")} on disk:`;
  const listing = changes.files.map(listedPath).join("\n");
  const body =
    changes.patch.length > maxOutputChars
      ? `(diff is ${changes.patch.length} chars, over the ${maxOutputChars} cap; read the files for detail)`
      : changes.patch;
  return `${heading}\n${listing}\n\n${body}`;
}

function withChangeReport(output: string, changes: TreeChanges): string {
  const report = changeReport(changes);
  if (report === undefined) return output;
  return output === "" ? report : `${output}\n\n${report}`;
}

function snapshotOrNothing(worktree: WorktreeChanges): Promise<string | undefined> {
  return worktree.snapshot().catch(() => undefined);
}

async function changesSince(
  worktree: WorktreeChanges,
  before: string,
): Promise<TreeChanges | undefined> {
  const after = await snapshotOrNothing(worktree);
  if (after === undefined) return undefined;
  return worktree.changesBetween(before, after).catch(() => undefined);
}

function listedPath(change: ChangedPath): string {
  return `  ${change.path} +${change.added} -${change.deleted}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
