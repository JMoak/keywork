import type { EngineEvents, EventBus } from "../bus.ts";
import { isMemoryFlushPrompt } from "../memory/flush.ts";
import {
  type Message,
  messageText,
  type ToolCallPart,
  toolCalls,
  type Usage,
} from "../messages.ts";
import { replayJournalEntry } from "./journal.ts";
import type { SessionStore } from "./store.ts";

const zeroUsage: Usage = { inputTokens: 0, outputTokens: 0 };

export function replaySession(store: SessionStore, bus: EventBus<EngineEvents>): void {
  const context = store.contextEntries();
  const inContext = new Set(context.map((entry) => entry.id));
  for (const entry of store.activePath()) {
    if (!inContext.has(entry.id)) replayJournalEntry(bus, entry);
  }
  const pendingCalls = new Map<string, ToolCallPart>();
  let insideFlushTurn = false;
  for (const entry of context) {
    if (entry.type === "custom") replayJournalEntry(bus, entry);
    else if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user" && isMemoryFlushPrompt(messageText(message))) {
        insideFlushTurn = true;
        continue;
      }
      if (message.role === "assistant" && insideFlushTurn) {
        insideFlushTurn = false;
        continue;
      }
      replayMessage(bus, message, entry.usage ?? zeroUsage, pendingCalls);
    } else if (entry.type === "compaction" || entry.type === "branch_summary")
      replayUserText(bus, entry.summary);
  }
}

function replayMessage(
  bus: EventBus<EngineEvents>,
  message: Message,
  usage: Usage,
  pendingCalls: Map<string, ToolCallPart>,
): void {
  switch (message.role) {
    case "user":
      replayUserText(bus, messageText(message));
      return;
    case "assistant":
      replayAssistantMessage(bus, message, usage, pendingCalls);
      return;
    case "tool":
      replayToolResults(bus, message, pendingCalls);
      return;
    default:
      return;
  }
}

function replayUserText(bus: EventBus<EngineEvents>, userText: string): void {
  bus.emit("turn.started", { userText, replay: true });
}

function replayAssistantMessage(
  bus: EventBus<EngineEvents>,
  message: Message,
  usage: Usage,
  pendingCalls: Map<string, ToolCallPart>,
): void {
  for (const part of message.parts) {
    if (part.type === "text") bus.emit("turn.delta", { delta: part, replay: true });
    if (part.type === "tool-call") {
      bus.emit("turn.delta", { delta: { type: "tool-call", call: part }, replay: true });
      pendingCalls.set(part.callId, part);
    }
  }
  if (toolCalls(message).length === 0) {
    bus.emit("turn.completed", { message, usage, replay: true });
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
      replay: true,
    });
  }
}
