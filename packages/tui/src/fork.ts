import { toError } from "@keywork/shared";
import { type PromptAnchor, promptAnchor } from "./backtrack.ts";
import type { ForkOutcome } from "./conversation-model.ts";
import type { SessionTreePort } from "./session-tree-pane.ts";

export interface CheckpointsPort {
  capture(): Promise<void>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  restoreTo(tree: string): Promise<void>;
}

export async function forkAtPrompt(
  trees: SessionTreePort | undefined,
  open: (sessionId: string | undefined, draft: string) => void,
  checkpoints: CheckpointsPort | undefined,
  sessionId: string | undefined,
  promptId: string,
  draft: string,
): Promise<ForkOutcome> {
  if (trees === undefined || sessionId === undefined) return { forked: false };
  const view = await trees.load(sessionId);
  if (view === undefined) return { forked: false };
  const anchor = promptAnchor(view.roots, promptId);
  if (anchor === undefined) return { forked: false };
  if (anchor.parentId === null) {
    open(undefined, draft);
    return { forked: true, note: await restoreForkedFiles(checkpoints, anchor) };
  }
  const forked = await trees.fork(sessionId, anchor.parentId);
  if (forked === undefined) return { forked: false };
  open(forked, draft);
  return { forked: true, note: await restoreForkedFiles(checkpoints, anchor) };
}

const unchangedFilesNote = "forked · files untouched";

async function restoreForkedFiles(
  checkpoints: CheckpointsPort | undefined,
  anchor: PromptAnchor,
): Promise<string> {
  if (checkpoints === undefined || anchor.checkpoint === undefined) return unchangedFilesNote;
  try {
    await checkpoints.restoreTo(anchor.checkpoint);
    return "files put back to that point";
  } catch (cause) {
    return `forked · file restore failed: ${toError(cause).message}`;
  }
}
