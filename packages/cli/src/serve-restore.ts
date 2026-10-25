import { messageText, restorePointOf, type TurnSession, type TurnTrees } from "@keywork/engine";
import type { OtherSessionFiles, RestorePreview } from "@keywork/server";
import { pathsTouchedSince } from "./serve-changes.ts";

export interface NeighbourSession extends TurnSession {
  id: string;
  title: string;
}

export async function restorePreviewOf(
  trees: TurnTrees | undefined,
  session: TurnSession,
  turn: number,
  neighbours: () => Promise<readonly NeighbourSession[]>,
): Promise<RestorePreview | "unknown-turn"> {
  const point = restorePointOf(session.store.activePath(), turn);
  if (point === undefined) return "unknown-turn";
  const prompt = { entryId: point.prompt.id, text: messageText(point.prompt.message) };
  const preview = { turn, prompt, undoneTurns: point.undoneTurns, files: [], others: [] };
  if (trees === undefined || point.files === undefined) return preview;
  const now = await trees.snapshot();
  const files = await trees.filesBetween(now, point.files);
  const goingBack = new Set(files.map((file) => file.path));
  const since = point.prompt.timestamp;
  const others = await Promise.all(
    (await neighbours()).map((other) => filesTakenFrom(trees, other, since, now, goingBack)),
  );
  return { ...preview, files, others: others.filter((other) => other.paths.length > 0) };
}

async function filesTakenFrom(
  trees: TurnTrees,
  other: NeighbourSession,
  since: string,
  now: string,
  goingBack: ReadonlySet<string>,
): Promise<OtherSessionFiles> {
  const touched = await pathsTouchedSince(trees, other, since, now);
  const paths = [...touched].filter((path) => goingBack.has(path)).sort();
  return { sessionId: other.id, title: other.title, paths };
}
