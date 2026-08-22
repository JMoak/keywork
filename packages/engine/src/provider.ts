import type { ModelCapabilities } from "./capabilities.ts";
import type { Message, RedactedThinkingPart, ToolCallPart, Usage } from "./messages.ts";

export type TurnDelta =
  | { type: "text"; text: string }
  | { type: "tool-call"; call: ToolCallPart }
  | { type: "redacted-thinking"; part: RedactedThinkingPart }
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
  modelId?: string | undefined;
  capabilities?: ModelCapabilities | undefined;
  stream(request: ProviderRequest): AsyncIterable<TurnDelta>;
}

export function declaredContextWindow(provider: Provider): number | undefined {
  return provider.capabilities?.contextWindow;
}
