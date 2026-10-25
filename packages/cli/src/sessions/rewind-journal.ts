import {
  type CustomEntry,
  replaySession,
  type SessionEntry,
  type SessionStore,
} from "@keywork/engine";
import type { RewoundPrompt, StagedRewind } from "@keywork/tui";

export const restoreEntryTypes = { restore: "restore", undone: "restore-undone" } as const;

export interface RestoreFacts {
  readonly from: string | null;
  readonly files: string | undefined;
  readonly redo: string | undefined;
  readonly turn?: number | undefined;
}

export interface JournaledRestore {
  readonly id: string;
  readonly from: string | null;
  readonly redoFiles: string | undefined;
}

export async function journalRestore(
  store: SessionStore,
  facts: RestoreFacts,
): Promise<JournaledRestore> {
  const recorded = await store.appendCustom(restoreEntryTypes.restore, {
    ...(facts.turn !== undefined && { turn: facts.turn }),
    from: facts.from,
    files: facts.files ?? null,
    redo: facts.redo ?? null,
  });
  return { id: recorded.id, from: facts.from, redoFiles: facts.redo };
}

export function unsettledRestoreOf(store: SessionStore): JournaledRestore | undefined {
  const restore = unsettledRestore(store.activePath());
  const facts = restore === undefined ? undefined : redoFactsOf(restore.data);
  return restore === undefined || facts === undefined ? undefined : { id: restore.id, ...facts };
}

export async function undoRestore(store: SessionStore, restore: JournaledRestore): Promise<void> {
  branchTo(store, restore.from);
  await store.appendCustom(restoreEntryTypes.undone, { restore: restore.id });
}

export function journaledRewind(
  store: SessionStore,
  rewound: RewoundPrompt,
  from: string | null,
  changed: () => void,
): RewoundPrompt {
  return {
    ...rewound,
    journal: async ({ restoredTo, redoTree }) => {
      const restore = await journalRestore(store, { from, files: restoredTo, redo: redoTree });
      changed();
      return stagedRewind(store, restore, changed);
    },
  };
}

export function stagedRewindOf(store: SessionStore, changed: () => void): StagedRewind | undefined {
  const restore = unsettledRestoreOf(store);
  return restore === undefined ? undefined : stagedRewind(store, restore, changed);
}

function stagedRewind(
  store: SessionStore,
  restore: JournaledRestore,
  changed: () => void,
): StagedRewind {
  return {
    redoFiles: restore.redoFiles,
    redo: async () => {
      await undoRestore(store, restore);
      changed();
      return store.messages();
    },
    retell: (bus) => {
      const staged = store.leafId();
      branchTo(store, restore.from);
      replaySession(store, bus);
      branchTo(store, staged);
    },
  };
}

function unsettledRestore(path: readonly SessionEntry[]): CustomEntry | undefined {
  for (const entry of [...path].reverse()) {
    if (entry.type === "message") return undefined;
    if (entry.type === "custom" && entry.customType === restoreEntryTypes.restore) return entry;
  }
  return undefined;
}

function redoFactsOf(data: unknown): Omit<JournaledRestore, "id"> | undefined {
  const { from, files, redo } = (data ?? {}) as Record<string, unknown>;
  if (from !== null && typeof from !== "string") return undefined;
  if (typeof redo === "string") return { from, redoFiles: redo };
  return files === null ? { from, redoFiles: undefined } : undefined;
}

function branchTo(store: SessionStore, entryId: string | null): void {
  if (entryId === null) store.resetLeaf();
  else store.branch(entryId);
}
