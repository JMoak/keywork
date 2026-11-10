import type { ModelCapabilities } from "./capabilities.ts";
import type { Message, RedactedThinkingPart, ToolCallPart, Usage } from "./messages.ts";

export type TurnDelta =
  | { type: "text"; text: string }
  | { type: "tool-call"; call: ToolCallPart }
  | { type: "redacted-thinking"; part: RedactedThinkingPart }
  | { type: "visible-thinking"; text: string }
  | { type: "progress"; text: string }
  | {
      type: "done";
      usage: Usage;
      responseId?: string;
      cacheMiss?: CacheMiss;
      receipt?: ProviderResponseReceipt;
    };

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

export interface OpenRouterRouting {
  only: readonly string[];
  ignore?: readonly string[];
  maxPrice: { prompt: number; completion: number; request: number };
}

export interface ProviderResponseReceipt {
  usageReported: boolean;
  requestedModel?: string;
  servedModel?: string;
  servedProvider?: string;
  requestId?: string;
  responseId?: string;
  finishReason?: string;
  costUsd?: number;
}

export interface ProviderRequestSupport {
  maxOutputTokens?: true;
  singleAttempt?: true;
  openRouterRouting?: true;
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
  maxOutputTokens?: number;
  retry?: "never";
  openRouterRouting?: OpenRouterRouting;
  onResponse?: ((receipt: ProviderResponseReceipt) => void) | undefined;
  signal?: AbortSignal;
}

export interface Provider {
  name: string;
  modelId?: string | undefined;
  capabilities?: ModelCapabilities | undefined;
  requestSupport?: ProviderRequestSupport | undefined;
  stream(request: ProviderRequest): AsyncIterable<TurnDelta>;
}

export class ProviderRequestControlError extends Error {
  readonly transient = false;

  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderRequestControlError";
  }
}

export function assertRequestControls(provider: Provider, request: ProviderRequest): void {
  if (request.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
      throw new ProviderRequestControlError(
        provider.name,
        "maxOutputTokens must be a positive safe integer",
      );
    }
    if (provider.requestSupport?.maxOutputTokens !== true) {
      throw new ProviderRequestControlError(
        provider.name,
        "bounded output is not supported by this transport",
      );
    }
  }
  if (request.retry === "never" && provider.requestSupport?.singleAttempt !== true) {
    throw new ProviderRequestControlError(
      provider.name,
      "single-attempt dispatch is not supported by this transport",
    );
  }
  if (
    request.openRouterRouting !== undefined &&
    provider.requestSupport?.openRouterRouting !== true
  ) {
    throw new ProviderRequestControlError(
      provider.name,
      "bounded OpenRouter routing is not supported by this transport",
    );
  }
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
