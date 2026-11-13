import { contextEntriesFor, contextMessages, isPromptEntry, type SessionEntry } from "./entries.ts";
import { type PathTurn, type TurnEnding, type TurnOutcome, turnsAlong } from "./turn-facts.ts";

export interface OutcomeMark extends TurnEnding {
  readonly index: number;
  readonly entryId: string;
}

export function outcomeMarksOf(
  path: readonly SessionEntry[],
  lastTurnRunning = false,
): OutcomeMark[] {
  const endings = turnEndingsAlong(path, lastTurnRunning);
  const marks: OutcomeMark[] = [];
  let index = 0;
  for (const entry of contextEntriesFor(path)) {
    const ending = endings.get(entry.id);
    if (ending !== undefined) marks.push({ index, entryId: entry.id, ...ending });
    index += contextMessages([entry]).length;
  }
  return marks;
}

function turnEndingsAlong(
  path: readonly SessionEntry[],
  lastTurnRunning: boolean,
): Map<string, TurnEnding> {
  const turns = turnsAlong(path);
  const ended = lastTurnRunning ? turns.slice(0, -1) : turns;
  const answered = answeredPrompts(path);
  const endings = new Map<string, TurnEnding>();
  for (const turn of ended) {
    const ending = endingOf(turn, answered.has(turn.prompt.id));
    if (ending !== undefined) endings.set(turn.prompt.id, ending);
  }
  return endings;
}

function endingOf({ facts }: PathTurn, answered: boolean): TurnEnding | undefined {
  if (facts === undefined) return answered ? undefined : { outcome: "shutdown" };
  const { outcome, error } = facts;
  if (!isTurnOutcome(outcome)) return undefined;
  return typeof error === "string" ? { outcome, error } : { outcome };
}

function isTurnOutcome(value: unknown): value is TurnOutcome {
  return turnOutcomes.some((known) => known === value);
}

function answeredPrompts(path: readonly SessionEntry[]): Set<string> {
  const answered = new Set<string>();
  let prompt: string | undefined;
  for (const entry of path) {
    if (isPromptEntry(entry)) prompt = entry.id;
    else if (prompt !== undefined && isAssistantEntry(entry)) answered.add(prompt);
  }
  return answered;
}

function isAssistantEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "assistant";
}

const turnOutcomes: readonly TurnOutcome[] = ["completed", "interrupted", "failed", "shutdown"];
