import type { EngineEvents, EventBus } from "../bus.ts";
import { type Message, messageText, toolCalls, type Usage } from "../messages.ts";
import type { SessionStore } from "./store.ts";

const zeroUsage: Usage = { inputTokens: 0, outputTokens: 0 };

export function replaySession(store: SessionStore, bus: EventBus<EngineEvents>): void {
  for (const entry of store.contextEntries()) {
    if (entry.type === "message") replayMessage(bus, entry.message, entry.usage ?? zeroUsage);
    else if (entry.type === "compaction" || entry.type === "branch_summary")
      replayUserText(bus, entry.summary);
  }
}

function replayMessage(bus: EventBus<EngineEvents>, message: Message, usage: Usage): void {
  switch (message.role) {
    case "user":
      replayUserText(bus, messageText(message));
      return;
    case "assistant":
      replayAssistantMessage(bus, message, usage);
      return;
    case "tool":
      replayToolResults(bus, message);
      return;
    default:
      return;
  }
}

function replayUserText(bus: EventBus<EngineEvents>, userText: string): void {
  bus.emit("turn.started", { userText, replay: true });
}

function replayAssistantMessage(bus: EventBus<EngineEvents>, message: Message, usage: Usage): void {
  for (const part of message.parts) {
    if (part.type === "text") bus.emit("turn.delta", { delta: part, replay: true });
    if (part.type === "tool-call") {
      bus.emit("turn.delta", { delta: { type: "tool-call", call: part }, replay: true });
      bus.emit("tool.started", { call: part, replay: true });
    }
  }
  if (toolCalls(message).length === 0) {
    bus.emit("turn.completed", { message, usage, replay: true });
  }
}

function replayToolResults(bus: EventBus<EngineEvents>, message: Message): void {
  for (const part of message.parts) {
    if (part.type !== "tool-result") continue;
    bus.emit("tool.finished", {
      callId: part.callId,
      output: part.output,
      isError: part.isError,
      replay: true,
    });
  }
}
