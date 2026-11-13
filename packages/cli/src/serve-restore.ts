import {
  type ChangedPath,
  messageText,
  pathsTouchedFromTurn,
  restorePointOf,
  type TurnSession,
  type TurnTrees,
} from "@keywork/engine";
import type {
  OtherSessionFiles,
  RestoreCandidate,
  RestorePreview,
  RestoreScope,
} from "@keywork/server";
import { pathsTouchedSince } from "./serve-changes.ts";

export interface NeighbourSession extends TurnSession {
  id: string;
  title: string;
}

export interface RestoreAsk {
  turn: number;
  scope: RestoreScope;
}

export async function restorePreviewOf(
  trees: TurnTrees | undefined,
  session: TurnSession,
  { turn, scope }: RestoreAsk,
  neighbours: () => Promise<readonly NeighbourSession[]>,
): Promise<RestorePreview | "unknown-turn"> {
  const point = restorePointOf(session.store.activePath(), turn);
  if (point === undefined) return "unknown-turn";
  const prompt = { entryId: point.prompt.id, text: messageText(point.prompt.message) };
  const preview = { turn, prompt, undoneTurns: point.undoneTurns, scope, files: [], others: [] };
  if (trees === undefined || point.files === undefined) return preview;
  const now = await trees.snapshot();
  const touched = await pathsTouchedFromTurn(trees, session, turn, now);
  const files = (await trees.filesBetween(now, point.files)).map((file) =>
    candidateOf(file, touched, scope),
  );
  const goingBack = new Set(files.filter((file) => file.goesBack).map((file) => file.path));
  const since = point.prompt.timestamp;
  const others = await Promise.all(
    (await neighbours()).map((other) => filesTakenFrom(trees, other, since, now, goingBack)),
  );
  return { ...preview, files, others: others.filter((other) => other.paths.length > 0) };
}

export async function sessionPathsFromTurn(
  trees: TurnTrees,
  session: TurnSession,
  turn: number,
): Promise<readonly string[]> {
  return [...(await pathsTouchedFromTurn(trees, session, turn, await trees.snapshot()))].sort();
}

function candidateOf(
  file: ChangedPath,
  touched: ReadonlySet<string>,
  scope: RestoreScope,
): RestoreCandidate {
  const sessionTouched = touched.has(file.path);
  return { ...file, touched: sessionTouched, goesBack: scope === "everything" || sessionTouched };
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
