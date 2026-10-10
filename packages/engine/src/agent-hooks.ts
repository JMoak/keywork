import type { Message, ToolCallPart } from "./messages.ts";
import type { Tool } from "./tools.ts";

export interface AgentHooks {
  tools?(): readonly Tool[];
  systemPrompt?(base: string): Promise<string>;
  toolCall?(call: ToolCallPart): Promise<ToolCallRuling>;
  messageAppended?(message: Message): void;
}

export type ToolCallRuling =
  | { kind: "proceed"; call: ToolCallPart }
  | { kind: "refuse"; reason: string };

export function proceedWith(call: ToolCallPart): ToolCallRuling {
  return { kind: "proceed", call };
}

export function toolsThroughHooks(base: () => readonly Tool[], hooks: AgentHooks): () => Tool[] {
  return () => [...base(), ...(hooks.tools?.() ?? [])];
}
