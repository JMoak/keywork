import type { ChangedPath } from "../checkpoints.ts";
import {
  type CustomEntry,
  isPromptEntry,
  type MessageEntry,
  type SessionEntry,
} from "./entries.ts";
import type { SessionStore } from "./store.ts";

export const turnFactsType = "turn_facts";

export type FileChange = Pick<ChangedPath, "path" | "added" | "deleted">;

export interface ChangeTotals {
  readonly files: number;
  readonly added: number;
  readonly deleted: number;
}

export interface TurnFacts {
  readonly prompt: string;
  readonly checkpoint?: string;
  readonly settled?: string;
  readonly files: readonly FileChange[];
  readonly session?: ChangeTotals;
}

export interface TurnTrees {
  snapshot(): Promise<string>;
  filesBetween(from: string, to: string): Promise<readonly ChangedPath[]>;
}

export interface TurnSession {
  readonly store: SessionStore;
  openCheckpoint?(): string | undefined;
}

export interface PathTurn {
  readonly turn: number;
  readonly prompt: MessageEntry;
  readonly facts: TurnFacts | undefined;
}

export function recordTurnFacts(store: SessionStore, facts: TurnFacts): Promise<CustomEntry> {
  return store.appendCustom(turnFactsType, facts);
}

export function turnFactsOf(entry: SessionEntry): TurnFacts | undefined {
  if (entry.type !== "custom" || entry.customType !== turnFactsType) return undefined;
  return isTurnFacts(entry.data) ? entry.data : undefined;
}

export function turnsAlong(path: readonly SessionEntry[]): PathTurn[] {
  const facts = new Map<string, TurnFacts>();
  for (const entry of path) {
    const found = turnFactsOf(entry);
    if (found !== undefined) facts.set(found.prompt, found);
  }
  return path
    .filter(isPromptEntry)
    .map((prompt, index) => ({ turn: index + 1, prompt, facts: facts.get(prompt.id) }));
}

export function latestSessionTotals(path: readonly SessionEntry[]): ChangeTotals | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    const totals = entry === undefined ? undefined : turnFactsOf(entry)?.session;
    if (totals !== undefined) return totals;
  }
  return undefined;
}

export function totalsOf(files: readonly FileChange[]): ChangeTotals {
  return {
    files: files.length,
    added: files.reduce((total, file) => total + file.added, 0),
    deleted: files.reduce((total, file) => total + file.deleted, 0),
  };
}

export async function settledTurnFacts(
  trees: TurnTrees,
  store: SessionStore,
  prompt: string,
  checkpoint: string | undefined,
): Promise<TurnFacts> {
  if (checkpoint === undefined) return { prompt, files: [] };
  const settled = await trees.snapshot();
  const files = (await trees.filesBetween(checkpoint, settled)).map(fileChangeOf);
  const session = await sessionFilesAt(trees, { store, openCheckpoint: () => checkpoint }, settled);
  return { prompt, checkpoint, settled, files, session: totalsOf(session) };
}

export async function sessionFilesAt(
  trees: TurnTrees,
  session: TurnSession,
  tree: string,
): Promise<ChangedPath[]> {
  const baseline = sessionBaseline(session);
  if (baseline === undefined) return [];
  const touched = await turnsTouching(trees, session, tree);
  return (await trees.filesBetween(baseline, tree)).flatMap((file) => {
    const turn = touched.get(file.path);
    return turn === undefined ? [] : [{ ...fileChangeOf(file), turn }];
  });
}

export function sessionBaseline(session: TurnSession): string | undefined {
  const first = turnsAlong(session.store.activePath()).find(
    (turn) => turn.prompt.checkpoint !== undefined,
  );
  return first?.prompt.checkpoint ?? session.openCheckpoint?.();
}

export function fileChangeOf({ path, added, deleted }: ChangedPath): FileChange {
  return { path, added, deleted };
}

async function turnsTouching(
  trees: TurnTrees,
  session: TurnSession,
  tree: string,
): Promise<Map<string, number>> {
  const turns = turnsAlong(session.store.activePath());
  const touched = new Map<string, number>();
  for (const [index, turn] of turns.entries()) {
    const open = index === turns.length - 1 ? session.openCheckpoint?.() : undefined;
    const files = await filesOfTurn(trees, turn, turns.slice(index + 1), open, tree);
    for (const file of files) touched.set(file.path, turn.turn);
  }
  return touched;
}

async function filesOfTurn(
  trees: TurnTrees,
  turn: PathTurn,
  later: readonly PathTurn[],
  open: string | undefined,
  tree: string,
): Promise<readonly FileChange[]> {
  if (turn.facts !== undefined) return turn.facts.files;
  const from = turn.prompt.checkpoint ?? open;
  if (from === undefined) return [];
  const until = later.find((next) => next.prompt.checkpoint !== undefined)?.prompt.checkpoint;
  return trees.filesBetween(from, until ?? tree);
}

function isTurnFacts(data: unknown): data is TurnFacts {
  if (typeof data !== "object" || data === null) return false;
  const { prompt, files } = data as { prompt?: unknown; files?: unknown };
  return typeof prompt === "string" && Array.isArray(files);
}
