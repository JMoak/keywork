import type { Message } from "@keywork/engine";
import type { CheckpointsPort } from "./fork.ts";
import type { SessionAttachment } from "./session-attachment.ts";

export interface StagedUndo {
  readonly filesNote: string;
  cancel(): Promise<void>;
}

export type PromptUndoHook = (promptId: string) => Promise<StagedUndo | undefined>;

export interface PromptUndoSeams {
  attachment: SessionAttachment;
  checkpoints: CheckpointsPort | undefined;
  adopt(history: readonly Message[]): boolean;
}

export function promptUndo(seams: PromptUndoSeams): PromptUndoHook {
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
    return {
      filesNote: files.note,
      cancel: async () => {
        await files.restore();
        seams.adopt(rewound.restore());
      },
    };
  };
}

interface StagedFiles {
  note: string;
  restore(): Promise<void>;
}

const untouchedFiles: StagedFiles = { note: "files untouched", restore: async () => {} };

async function stageFiles(
  checkpoints: CheckpointsPort | undefined,
  checkpoint: string | undefined,
): Promise<StagedFiles> {
  if (checkpoints === undefined || checkpoint === undefined) return untouchedFiles;
  const left = await checkpoints.snapshot?.();
  await checkpoints.restoreTo(checkpoint);
  return {
    note: "files put back",
    restore: async () => {
      if (left === undefined) await checkpoints.undo();
      else await checkpoints.restoreTo(left);
    },
  };
}
