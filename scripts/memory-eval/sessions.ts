import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  type ContextInjection,
  journalEvents,
  type MemoryDecision,
  type Message,
  messageText,
  type SessionEntry,
  SessionStore,
  type ToolCallPart,
  toolCalls,
} from "../../packages/engine/src/index.ts";

export interface RecordedSession {
  name: string;
  turns: AssistantTurn[];
  results: ReadonlyMap<string, string>;
  decisions: ReadonlyMap<string, MemoryDecision>;
  deniedCalls: ReadonlySet<string>;
  actionInjections: string[];
}

export interface AssistantTurn {
  text: string;
  calls: ToolCallPart[];
  epoch: number;
}

export interface PlacedCall {
  call: ToolCallPart;
  turn: number;
}

export async function readSessions(dir: string): Promise<RecordedSession[]> {
  const files = (await sessionFiles(dir)).sort();
  const sessions: RecordedSession[] = [];
  for (const file of files) {
    const store = await SessionStore.open(file);
    sessions.push(recordedSession(sessionName(dir, file), store.activePath()));
  }
  return sessions;
}

export function recordedSession(name: string, path: readonly SessionEntry[]): RecordedSession {
  const turns: AssistantTurn[] = [];
  const results = new Map<string, string>();
  let epoch = 0;
  for (const entry of path) {
    if (entry.type === "compaction") epoch += 1;
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") turns.push(turnOf(entry.message, epoch));
    for (const [callId, output] of toolResultsOf(entry.message)) results.set(callId, output);
  }
  return { name, turns, results, ...journalOf(path) };
}

export function placedCalls(session: RecordedSession): PlacedCall[] {
  return session.turns.flatMap((turn, index) => turn.calls.map((call) => ({ call, turn: index })));
}

export function turnsAfter(session: RecordedSession, turn: number, count: number): AssistantTurn[] {
  return session.turns.slice(turn + 1, turn + 1 + count);
}

export function ridesAfter(session: RecordedSession, turn: number): number {
  const epoch = session.turns[turn]?.epoch;
  return session.turns.slice(turn + 1).filter((later) => later.epoch === epoch).length;
}

function turnOf(message: Message, epoch: number): AssistantTurn {
  return { text: messageText(message), calls: toolCalls(message), epoch };
}

function toolResultsOf(message: Message): [string, string][] {
  return message.parts.flatMap((part) =>
    part.type === "tool-result" ? [[part.callId, part.output] as [string, string]] : [],
  );
}

function journalOf(
  path: readonly SessionEntry[],
): Pick<RecordedSession, "decisions" | "deniedCalls" | "actionInjections"> {
  const decisions = new Map<string, MemoryDecision>();
  const deniedCalls = new Set<string>();
  const actionInjections: string[] = [];
  for (const event of journalEvents(path)) {
    if (event.type === "memory_decision" && event.decision.about.kind === "call")
      decisions.set(event.decision.about.callId, event.decision);
    if (event.type === "permission_decision" && event.decision.verdict === "denied")
      deniedCalls.add(event.decision.callId);
    if (event.type === "context_injection" && isActionInjection(event.injection))
      actionInjections.push(event.injection.id);
  }
  return { decisions, deniedCalls, actionInjections };
}

function isActionInjection(
  injection: ContextInjection,
): injection is ContextInjection & { id: string } {
  return injection.source === "memory-action" && injection.id !== undefined;
}

async function sessionFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function sessionName(dir: string, file: string): string {
  return relative(dir, file).slice(0, -".jsonl".length).split(sep).join("/");
}
