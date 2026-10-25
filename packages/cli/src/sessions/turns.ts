import {
  type ChangedPath,
  isPromptEntry,
  knownCostNanos,
  type MessageEntry,
  type SessionEntry,
  type SessionStore,
  sessionCost,
  type TurnTrees,
  turnsAlong,
} from "@keywork/engine";
import type { TurnRecord } from "@keywork/tui";

export interface TurnLedger {
  read(): Promise<TurnRecord[]>;
  settled(promptId: string): void;
}

export function turnRecordsOf(path: readonly SessionEntry[]): TurnRecord[] {
  return pathTurns(path).map(recordOf);
}

export function turnLedger(store: SessionStore, trees: TurnTrees | undefined): TurnLedger {
  const endings = new Map<string, Promise<string>>();
  const diffs = new Map<string, Promise<readonly ChangedPath[]>>();
  const diffBetween = (source: TurnTrees, from: string, to: string) => {
    const key = `${from}..${to}`;
    const known = diffs.get(key) ?? source.filesBetween(from, to).catch(() => []);
    diffs.set(key, known);
    return known;
  };
  return {
    settled: (promptId) => {
      if (trees !== undefined) endings.set(promptId, trees.snapshot());
    },
    read: async () => {
      const path = store.activePath();
      const turns = pathTurns(path);
      if (trees === undefined) return turns.map(recordOf);
      const frozen = frozenTurnFiles(path);
      let now: Promise<string> | undefined;
      const current = (): Promise<string> => {
        now ??= trees.snapshot();
        return now;
      };
      return Promise.all(
        turns.map(async (turn, at) => {
          const settled = frozen.get(turn.prompt.id);
          if (settled !== undefined) return { ...recordOf(turn), files: [...settled] };
          const from = turn.prompt.checkpoint;
          if (from === undefined) return { ...recordOf(turn), files: [] };
          const to = await (endings.get(turn.prompt.id) ?? nextCheckpoint(turns, at) ?? current());
          return { ...recordOf(turn), files: [...(await diffBetween(trees, from, to))] };
        }),
      );
    },
  };
}

function frozenTurnFiles(path: readonly SessionEntry[]): Map<string, readonly ChangedPath[]> {
  return new Map(
    turnsAlong(path).flatMap(({ prompt, facts }) =>
      facts === undefined ? [] : [[prompt.id, facts.files] as const],
    ),
  );
}

interface PathTurn {
  readonly turn: number;
  readonly prompt: MessageEntry;
  readonly modelId: string | undefined;
  readonly entries: SessionEntry[];
}

function pathTurns(path: readonly SessionEntry[]): PathTurn[] {
  const turns: PathTurn[] = [];
  let modelId: string | undefined;
  for (const entry of path) {
    if (isPromptEntry(entry)) {
      turns.push({ turn: turns.length + 1, prompt: entry, modelId, entries: [] });
      continue;
    }
    if (entry.type === "model_change") modelId = entry.modelId;
    turns.at(-1)?.entries.push(entry);
  }
  return turns;
}

function recordOf(turn: PathTurn): TurnRecord {
  const costNanos = knownCostNanos(sessionCost(turn.entries, turn.modelId));
  return {
    turn: turn.turn,
    promptId: turn.prompt.id,
    ...(costNanos !== undefined && { costNanos }),
  };
}

function nextCheckpoint(turns: readonly PathTurn[], at: number): Promise<string> | undefined {
  const tree = turns.slice(at + 1).find((turn) => turn.prompt.checkpoint !== undefined)
    ?.prompt.checkpoint;
  return tree === undefined ? undefined : Promise.resolve(tree);
}

export function firstCheckpointFrom(
  path: readonly SessionEntry[],
  prompt: MessageEntry,
): string | undefined {
  const from = path.findIndex((entry) => entry.id === prompt.id);
  if (from === -1) return prompt.checkpoint;
  for (const entry of path.slice(from)) {
    if (isPromptEntry(entry) && entry.checkpoint !== undefined) return entry.checkpoint;
  }
  return undefined;
}
