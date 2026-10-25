import { join } from "node:path";
import { isJournalOnly, type SessionStore } from "@keywork/engine";
import type {
  EntryRefusal,
  LabelOutcome,
  LeafOutcome,
  Refusal,
  SessionEntries,
  SessionTreePort,
} from "@keywork/server";
import type { ServedSession } from "./serve-surfaces.ts";
import { newSessionFileName } from "./sessions/store.ts";

export interface TreeSeams {
  sessionDir: string;
  bound(id: string): Promise<ServedSession | undefined>;
  moveLeaf(id: string, entryId: string | null): Promise<LeafOutcome | Refusal | "unknown-entry">;
}

export function servedTree(seams: TreeSeams): SessionTreePort {
  const onStore = async <T>(
    id: string,
    act: (store: SessionStore) => T | Promise<T>,
  ): Promise<T | "missing"> => {
    const session = await seams.bound(id);
    return session === undefined ? "missing" : act(session.store);
  };
  return {
    entries: (id) => onStore(id, sessionEntriesOf),
    fork: (id, entryId) =>
      onStore(id, async (store): Promise<{ sessionId: string } | EntryRefusal> => {
        if (store.entry(entryId) === undefined) return "unknown-entry";
        const clone = await store.clone(join(seams.sessionDir, newSessionFileName()), entryId);
        return { sessionId: clone.header.id };
      }),
    label: (id, entryId, label) =>
      onStore(id, async (store): Promise<LabelOutcome | EntryRefusal> => {
        if (store.entry(entryId) === undefined) return "unknown-entry";
        await store.setLabel(entryId, label ?? undefined);
        return { entryId, label: store.labelFor(entryId) ?? null };
      }),
    moveLeaf: (id, entryId) => seams.moveLeaf(id, entryId),
  };
}

export function sessionEntriesOf(store: SessionStore): SessionEntries {
  const name = store.name();
  return {
    sessionId: store.header.id,
    ...(name !== undefined && { name }),
    leafId: store.leafId(),
    entries: store.entries(),
    labels: Object.fromEntries(store.labels()),
    activePath: store.activePath().map((entry) => entry.id),
    journal: store
      .entries()
      .filter(isJournalOnly)
      .map((entry) => entry.id),
  };
}
