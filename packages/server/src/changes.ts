import {
  type CheckpointReads,
  type EngineEvents,
  type EventBus,
  followMutations,
} from "@keywork/engine";
import type { ChangedFile, ChangedFileNote, SessionChanges } from "./host.ts";

export interface ChangeSource {
  checkpoints: CheckpointReads;
  readWorkingFile(path: string): Promise<string | undefined>;
}

export const changedFileSideCap = 1 << 20;

export const sessionStartBaseline = "session start";

export async function changedFilesOf(source: ChangeSource): Promise<SessionChanges> {
  const files = await source.checkpoints.changedSince(await source.checkpoints.baseline());
  return { baseline: sessionStartBaseline, files };
}

export async function changedFileOf(source: ChangeSource, path: string): Promise<ChangedFile> {
  const [before, after] = await Promise.all([
    source.checkpoints.baseline().then((tree) => source.checkpoints.contentAt(tree, path)),
    source.readWorkingFile(path),
  ]);
  if (isBinary(before) || isBinary(after)) {
    return { path, before: null, after: null, note: "binary", truncated: false };
  }
  return {
    path,
    before: capped(before),
    after: capped(after),
    ...noteFor(before, after),
    truncated: exceedsCap(before) || exceedsCap(after),
  };
}

export function announceChanges(
  bus: EventBus<EngineEvents>,
  source: ChangeSource,
  announce: (paths: readonly string[]) => void,
): () => Promise<void> {
  let refreshing: Promise<void> = Promise.resolve();
  const stop = followMutations(bus, () => {
    refreshing = refreshing
      .then(() => changedFilesOf(source))
      .then(({ files }) => announce(files.map((file) => file.path)))
      .catch(() => undefined);
  });
  return async () => {
    stop();
    await refreshing;
  };
}

function noteFor(
  before: string | undefined,
  after: string | undefined,
): { note: ChangedFileNote } | Record<never, never> {
  if (before === undefined && after === undefined) return { note: "unreadable" };
  if (before === undefined) return { note: "new" };
  if (after === undefined) return { note: "deleted" };
  return {};
}

function isBinary(content: string | undefined): boolean {
  return content?.includes("\0") === true;
}

function exceedsCap(content: string | undefined): boolean {
  return content !== undefined && content.length > changedFileSideCap;
}

function capped(content: string | undefined): string | null {
  return content === undefined ? null : content.slice(0, changedFileSideCap);
}
