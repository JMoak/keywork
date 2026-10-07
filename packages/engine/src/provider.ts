import type { ModelCapabilities } from "./capabilities.ts";
import type { Message, RedactedThinkingPart, ToolCallPart, Usage } from "./messages.ts";

export type TurnDelta =
  | { type: "text"; text: string }
  | { type: "tool-call"; call: ToolCallPart }
  | { type: "redacted-thinking"; part: RedactedThinkingPart }
  | { type: "visible-thinking"; text: string }
  | { type: "progress"; text: string }
  | { type: "done"; usage: Usage; responseId?: string; cacheMiss?: CacheMiss };

export type DoneDelta = Extract<TurnDelta, { type: "done" }>;

export interface CacheMiss {
  cause: string;
  missedTokens?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof effortLevels)[number];

export interface EffortChange {
  before: number;
  level: EffortLevel;
}

export interface ToolAddition {
  before: number;
  tools: readonly ToolDefinition[];
}

export interface CacheDiagnostics {
  previousResponseId: string | null;
}

export interface ProviderRequest {
  systemPrompt: string;
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
  thinking?: boolean;
  effort?: EffortLevel;
  effortChanges?: readonly EffortChange[];
  toolAdditions?: readonly ToolAddition[];
  cacheDiagnostics?: CacheDiagnostics;
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

export function effortInForce(request: ProviderRequest): EffortLevel | undefined {
  return request.effortChanges?.at(-1)?.level ?? request.effort;
}

export function isEffortLevel(word: string): word is EffortLevel {
  return (effortLevels as readonly string[]).includes(word);
}
