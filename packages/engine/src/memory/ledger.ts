import { createHash } from "node:crypto";

export type LedgerOp = "create" | "edit" | "approve" | "discard" | "revert";
export type RevertOutcome = "reverted" | "needs-rebase";

export interface FileDelta {
  path: string;
  before: string | null;
  beforeHash: string | null;
  after: string | null;
  afterHash: string | null;
}

export interface LedgerEntry {
  id: string;
  op: LedgerOp;
  timestamp: string;
  deltas: readonly FileDelta[];
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function fileDelta(path: string, before: string | null, after: string | null): FileDelta {
  return {
    path,
    before,
    beforeHash: before === null ? null : contentHash(before),
    after,
    afterHash: after === null ? null : contentHash(after),
  };
}

export function invertDelta(delta: FileDelta): FileDelta {
  return {
    path: delta.path,
    before: delta.after,
    beforeHash: delta.afterHash,
    after: delta.before,
    afterHash: delta.beforeHash,
  };
}
