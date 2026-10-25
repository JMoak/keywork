import { formatCostNanos } from "@keywork/engine";
import type { ChangedFile } from "./diff-model.ts";
import { pluralize } from "./pluralize.ts";

export interface TurnRecord {
  readonly turn: number;
  readonly promptId: string;
  readonly costNanos?: number;
  readonly files?: readonly ChangedFile[];
}

export type TurnLedgerReader = () => Promise<readonly TurnRecord[]>;

export interface RestoreReach {
  readonly turns: number;
  readonly files: number | undefined;
}

export function modelTurns(
  records: readonly TurnRecord[],
  shellPrompts: ReadonlySet<string>,
): TurnRecord[] {
  const turns: TurnRecord[] = [];
  for (const record of records) {
    const previous = turns.at(-1);
    if (!shellPrompts.has(record.promptId)) turns.push({ ...record, turn: turns.length + 1 });
    else if (previous !== undefined) turns[turns.length - 1] = withShellFiles(previous, record);
  }
  return turns;
}

export function ledgerFacts(record: TurnRecord): string {
  const files = record.files ?? [];
  return [
    `turn ${record.turn}`,
    ...(files.length === 0 ? [] : [pluralize(files.length, "file"), lineCounts(totalOf(files))]),
    ...(record.costNanos === undefined ? [] : [formatCostNanos(record.costNanos)]),
  ].join(" · ");
}

export function ledgerFileLines(record: TurnRecord): string[] {
  return (record.files ?? []).map((file) => `${file.path}  ${lineCounts(file)}`);
}

export function ledgerHint(record: TurnRecord): string {
  const files = (record.files ?? []).length > 0 ? "enter files · " : "";
  return `turn ${record.turn} · ${files}u restores to before · f forks here · shift+tab older · esc done`;
}

export function restoreReach(records: readonly TurnRecord[], turn: number): RestoreReach {
  const undone = records.filter((record) => record.turn >= turn);
  const known = undone.every((record) => record.files !== undefined);
  const paths = new Set(undone.flatMap((record) => (record.files ?? []).map((file) => file.path)));
  return { turns: undone.length, files: known ? paths.size : undefined };
}

export function restoreQuestion(turn: number, prompt: string, reach: RestoreReach): string {
  return `restore to before turn ${turn}, "${excerpt(prompt)}"? ${goingBack(reach)} · /redo brings them back · y restores · any other key keeps it`;
}

export function restoredNotice(turn: number, undoneTurns: number, filesNote: string): string {
  return [
    `restored to before turn ${turn}`,
    `${pluralize(undoneTurns, "turn")} went back`,
    filesNote,
    "your prompt is back in the composer",
    "/redo brings it all back",
  ].join(" · ");
}

export function forkedNotice(turn: number): string {
  return `forked after turn ${turn} · the fork opens as its own session · files untouched`;
}

export const restoreKeptNotice = "left as it was · nothing restored";

function goingBack(reach: RestoreReach): string {
  const turns = pluralize(reach.turns, "turn");
  if (reach.files === undefined || reach.files === 0) {
    return `${turns} ${reach.turns === 1 ? "goes" : "go"} back`;
  }
  return `${turns} and ${pluralize(reach.files, "file")} go back`;
}

function lineCounts(counts: Pick<ChangedFile, "added" | "deleted">): string {
  return `+${counts.added} -${counts.deleted}`;
}

function totalOf(files: readonly ChangedFile[]): Pick<ChangedFile, "added" | "deleted"> {
  return files.reduce(
    (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
    { added: 0, deleted: 0 },
  );
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > excerptLimit ? `${flat.slice(0, excerptLimit - 1)}…` : flat;
}

const excerptLimit = 40;

function withShellFiles(turn: TurnRecord, shell: TurnRecord): TurnRecord {
  if (turn.files === undefined || shell.files === undefined) return turn;
  const byPath = new Map(turn.files.map((file) => [file.path, file]));
  for (const file of shell.files) {
    const known = byPath.get(file.path);
    byPath.set(
      file.path,
      known === undefined
        ? file
        : { ...known, added: known.added + file.added, deleted: known.deleted + file.deleted },
    );
  }
  return { ...turn, files: [...byPath.values()] };
}
