import type { Message, ToolCallPart, Usage } from "./messages.ts";

export type TurnDelta =
  | { type: "text"; text: string }
  | { type: "tool-call"; call: ToolCallPart }
  | { type: "done"; usage: Usage };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ProviderRequest {
  systemPrompt: string;
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
}

export interface Provider {
  name: string;
  stream(request: ProviderRequest): AsyncIterable<TurnDelta>;
}
