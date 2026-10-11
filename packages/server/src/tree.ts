import type { EngineEvents, SessionStore, TreeChangeReason } from "@keywork/engine";
import type { SessionEntries } from "./host.ts";

export function entriesOf(store: SessionStore): SessionEntries {
  const name = store.name();
  return {
    sessionId: store.header.id,
    ...(name !== undefined && { name }),
    leafId: store.leafId(),
    entries: store.entries(),
    labels: Object.fromEntries(store.labels()),
    activePath: store.activePath().map((entry) => entry.id),
  };
}

export function moveLeafOf(store: SessionStore, entryId: string | null): boolean {
  if (entryId === null) {
    store.resetLeaf();
    return true;
  }
  if (store.entry(entryId) === undefined) return false;
  store.branch(entryId);
  return true;
}

export function treeChange(
  store: SessionStore,
  reason: TreeChangeReason,
  detail: { entryId?: string; forkedTo?: string } = {},
): EngineEvents["session.tree"] {
  return {
    sessionId: store.header.id,
    leafId: store.leafId(),
    reason,
    ...(detail.entryId !== undefined && { entryId: detail.entryId }),
    ...(detail.forkedTo !== undefined && { forkedTo: detail.forkedTo }),
  };
}
