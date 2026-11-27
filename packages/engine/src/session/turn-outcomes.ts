import { contextEntriesFor, contextMessages, isPromptEntry, type SessionEntry } from "./entries.ts";
import {
  type PathTurn,
  type TurnEnding,
  type TurnFacts,
  type TurnOutcome,
  turnProgressAlong,
  turnsAlong,
} from "./turn-facts.ts";

export interface OutcomeMark extends TurnEnding {
  readonly index: number;
  readonly entryId: string;
  readonly delivery?: string | null;
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

export function deliveryFieldOf(facts: TurnFacts | undefined): { delivery?: string | null } {
  const delivery = facts?.delivery;
  return typeof delivery === "string" || delivery === null ? { delivery } : {};
}

type MarkedEnding = Omit<OutcomeMark, "index" | "entryId">;

function turnEndingsAlong(
  path: readonly SessionEntry[],
  lastTurnRunning: boolean,
): Map<string, MarkedEnding> {
  const turns = turnsAlong(path);
  const ended = lastTurnRunning ? turns.slice(0, -1) : turns;
  const unkept = settledBeforeOutcomes(path);
  const endings = new Map<string, MarkedEnding>();
  for (const turn of ended) {
    const ending = endingOf(turn, unkept.has(turn.prompt.id));
    if (ending !== undefined) endings.set(turn.prompt.id, ending);
  }
  return endings;
}

function endingOf({ facts }: PathTurn, unkept: boolean): MarkedEnding | undefined {
  if (facts === undefined) return unkept ? undefined : { outcome: "shutdown" };
  const { outcome, error } = facts;
  if (!isTurnOutcome(outcome)) return undefined;
  return {
    outcome,
    ...(typeof error === "string" && { error }),
    ...(outcome === "completed" && deliveryFieldOf(facts)),
  };
}

function isTurnOutcome(value: unknown): value is TurnOutcome {
  return turnOutcomes.some((known) => known === value);
}

function settledBeforeOutcomes(path: readonly SessionEntry[]): Set<string> {
  const kept = turnProgressAlong(path);
  return new Set([...answeredPrompts(path)].filter((prompt) => !kept.has(prompt)));
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
