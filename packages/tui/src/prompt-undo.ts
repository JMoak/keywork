import type { Agent, Message } from "@keywork/engine";
import type { CheckpointsPort } from "./fork.ts";
import type {
  ReplayedSummary,
  RewindFiles,
  RewoundPrompt,
  ServedRewind,
  SessionAttachment,
  StagedRewind,
} from "./session-attachment.ts";

export interface StagedUndo {
  readonly filesNote: string;
  cancel(): Promise<void>;
}

export interface ReopenedUndo {
  readonly undo: StagedUndo;
  readonly summaries: readonly ReplayedSummary[];
  retell(bus: Agent["bus"]): void;
}

export type PromptUndoHook = (promptId: string) => Promise<StagedUndo | undefined>;

export interface PromptUndoSeams {
  attachment: SessionAttachment;
  checkpoints: CheckpointsPort | undefined;
  adopt(history: readonly Message[]): boolean;
}

export function promptUndo(seams: PromptUndoSeams): PromptUndoHook {
  const served = seams.attachment.rewindOnServer;
  if (served !== undefined) return servedUndo(served, seams.adopt);
  return async (promptId) => {
    const rewound = seams.attachment.rewindBefore?.(promptId);
    if (rewound === undefined) return undefined;
    if (!seams.adopt(rewound.history)) {
      rewound.restore();
      return undefined;
    }
    const files = await stageFiles(seams.checkpoints, rewound.checkpoint).catch((cause) => {
      seams.adopt(rewound.restore());
      throw cause;
    });
    const journaled = await journal(rewound, files).catch(async (cause) => {
      await files.restore();
      seams.adopt(rewound.restore());
      throw cause;
    });
    return {
      filesNote: files.note,
      cancel: async () => {
        await files.restore();
        seams.adopt(journaled === undefined ? rewound.restore() : await journaled.redo());
      },
    };
  };
}

export function reopenedUndo(seams: PromptUndoSeams): ReopenedUndo | undefined {
  const staged = seams.attachment.stagedRewind;
  const { checkpoints } = seams;
  if (staged === undefined) return undefined;
  if (staged.redoFiles !== undefined && checkpoints === undefined) return undefined;
  const { redoFiles } = staged;
  return {
    undo: {
      filesNote: redoFiles === undefined ? untouchedFiles.note : filesPutBack,
      cancel: async () => {
        if (redoFiles !== undefined) await checkpoints?.restoreTo(redoFiles);
        seams.adopt(await staged.redo());
      },
    },
    summaries: seams.attachment.summaries ?? [],
    retell: (bus) => staged.retell(bus),
  };
}

function servedUndo(
  rewind: (promptId: string) => Promise<ServedRewind | undefined>,
  adopt: (history: readonly Message[]) => boolean,
): PromptUndoHook {
  return async (promptId) => {
    const staged = await rewind(promptId);
    if (staged === undefined) return undefined;
    if (!adopt(staged.history)) {
      await staged.cancel();
      return undefined;
    }
    return {
      filesNote: staged.filesNote,
      cancel: async () => {
        adopt(await staged.cancel());
      },
    };
  };
}

interface StagedFiles extends RewindFiles {
  readonly note: string;
  restore(): Promise<void>;
}

const filesPutBack = "files put back";

const untouchedFiles: StagedFiles = {
  note: "files untouched",
  restoredTo: undefined,
  redoTree: undefined,
  restore: async () => {},
};

function journal(rewound: RewoundPrompt, files: StagedFiles): Promise<StagedRewind | undefined> {
  return rewound.journal?.(files) ?? Promise.resolve(undefined);
}

async function stageFiles(
  checkpoints: CheckpointsPort | undefined,
  checkpoint: string | undefined,
): Promise<StagedFiles> {
  if (checkpoints === undefined || checkpoint === undefined) return untouchedFiles;
  const left = await checkpoints.snapshot?.();
  await checkpoints.restoreTo(checkpoint);
  return {
    note: filesPutBack,
    restoredTo: checkpoint,
    redoTree: left,
    restore: async () => {
      if (left === undefined) await checkpoints.undo();
      else await checkpoints.restoreTo(left);
    },
  };
}
