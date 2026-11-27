import type { EngineEvents, EventBus, TurnCompletion } from "../bus.ts";
import {
  type Message,
  messageText,
  type ToolCallPart,
  toolCalls,
  type Usage,
} from "../messages.ts";
import { isMemoryFlushEntry, isPromptEntry, type SessionEntry } from "./entries.ts";
import { replayJournalEntry } from "./journal.ts";
import type { SessionStore } from "./store.ts";
import { turnsAlong } from "./turn-facts.ts";
import { deliveryFieldOf } from "./turn-outcomes.ts";

const zeroUsage: Usage = { inputTokens: 0, outputTokens: 0 };

export function replaySession(store: SessionStore, bus: EventBus<EngineEvents>): void {
  const context = store.contextEntries();
  const inContext = new Set(context.map((entry) => entry.id));
  for (const entry of store.activePath()) {
    if (!inContext.has(entry.id)) replayJournalEntry(bus, entry);
  }
  const completions = completionsByPrompt(store.activePath());
  const pendingCalls = new Map<string, ToolCallPart>();
  let insideFlushTurn = false;
  let completion: TurnCompletion = {};
  for (const entry of context) {
    if (entry.type === "custom") replayJournalEntry(bus, entry);
    else if (isMemoryFlushEntry(entry)) insideFlushTurn = true;
    else if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant" && insideFlushTurn) {
        insideFlushTurn = false;
        continue;
      }
      if (isPromptEntry(entry)) completion = completions.get(entry.id) ?? {};
      replayMessage(bus, message, entry.usage ?? zeroUsage, pendingCalls, entry.id, completion);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      completion = {};
      replayUserText(bus, entry.summary);
    }
  }
}

function completionsByPrompt(path: readonly SessionEntry[]): Map<string, TurnCompletion> {
  return new Map(turnsAlong(path).map(({ prompt, facts }) => [prompt.id, deliveryFieldOf(facts)]));
}

function replayMessage(
  bus: EventBus<EngineEvents>,
  message: Message,
  usage: Usage,
  pendingCalls: Map<string, ToolCallPart>,
  entryId: string,
  completion: TurnCompletion,
): void {
  switch (message.role) {
    case "user":
      replayUserText(bus, messageText(message), entryId);
      return;
    case "assistant":
      replayAssistantMessage(bus, message, usage, pendingCalls, completion);
      return;
    case "tool":
      replayToolResults(bus, message, pendingCalls);
      return;
    default:
      return;
  }
}

function replayUserText(bus: EventBus<EngineEvents>, userText: string, entryId?: string): void {
  bus.emit("turn.started", { userText, replay: true, ...(entryId !== undefined && { entryId }) });
}

function replayAssistantMessage(
  bus: EventBus<EngineEvents>,
  message: Message,
  usage: Usage,
  pendingCalls: Map<string, ToolCallPart>,
  completion: TurnCompletion,
): void {
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "visible-thinking") {
      bus.emit("turn.delta", { delta: part, replay: true });
    }
    if (part.type === "tool-call") {
      bus.emit("turn.delta", { delta: { type: "tool-call", call: part }, replay: true });
      pendingCalls.set(part.callId, part);
    }
  }
  if (toolCalls(message).length === 0) {
    bus.emit("turn.completed", { message, usage, ...completion, replay: true });
  }
}

function replayToolResults(
  bus: EventBus<EngineEvents>,
  message: Message,
  pendingCalls: Map<string, ToolCallPart>,
): void {
  for (const part of message.parts) {
    if (part.type !== "tool-result") continue;
    const call = pendingCalls.get(part.callId);
    if (call !== undefined) {
      pendingCalls.delete(part.callId);
      bus.emit("tool.started", { call, replay: true });
    }
    bus.emit("tool.finished", {
      callId: part.callId,
      output: part.output,
      isError: part.isError,
      ...(part.spill !== undefined && { spill: part.spill }),
      ...(part.exitCode !== undefined && { exitCode: part.exitCode }),
      ...(part.fact !== undefined && { fact: part.fact }),
      replay: true,
    });
  }
}
