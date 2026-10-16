import type { Message, Usage } from "../messages.ts";
import type { ToolDefinition } from "../provider.ts";
import { estimateConversationTokens, estimateTextTokens } from "./compaction.ts";
import { type ContextBudget, type ContextReading, readContext } from "./context-budget.ts";

export type ContextBasis = "reported" | "estimated";

export interface ContextPart {
  readonly tokens: number;
  readonly basis: ContextBasis;
}

export interface ContextParts {
  readonly system: ContextPart;
  readonly tools: ContextPart;
  readonly injected: ContextPart;
  readonly conversation: ContextPart;
  readonly free: ContextPart;
}

export interface ContextThresholds {
  readonly flushAt: number;
  readonly compactAt: number;
}

export interface ContextMap {
  readonly parts: ContextParts;
  readonly thresholds: ContextThresholds;
}

export interface AgentContext extends ContextReading, ContextMap {}

export interface ReportedContext {
  readonly tokens: number;
  readonly messages: number;
}

export interface RequestAnatomy {
  readonly systemPrompt: string;
  readonly injected: readonly string[];
  readonly tools: readonly ToolDefinition[];
  readonly history: readonly Message[];
  readonly reported: ReportedContext | undefined;
}

export interface AnatomySource {
  anatomy(): RequestAnatomy;
}

export function readAgentContext(agent: AnatomySource, budget: ContextBudget): AgentContext {
  const anatomy = agent.anatomy();
  const reading = readContext(estimateConversationTokens(anatomy.history), budget);
  return { ...reading, ...contextMapOf(anatomy, reading) };
}

export function contextMapOf(anatomy: RequestAnatomy, reading: ContextReading): ContextMap {
  const prompt = estimateTextTokens(anatomy.systemPrompt);
  const injected = Math.min(prompt, sum(anatomy.injected.map(estimateTextTokens)));
  const tools = sum(anatomy.tools.map(definitionTokens));
  const conversation = conversationPart(anatomy, prompt + tools);
  const filled = prompt + tools + conversation.tokens;
  const uncountedBySettler = filled - reading.used;
  return {
    parts: {
      system: estimated(prompt - injected),
      tools: estimated(tools),
      injected: estimated(injected),
      conversation,
      free: { tokens: Math.max(0, reading.window - filled), basis: conversation.basis },
    },
    thresholds: {
      flushAt: reading.flushAt + uncountedBySettler,
      compactAt: reading.compactAt + uncountedBySettler,
    },
  };
}

export function reportedContextOf(usage: Usage, messages: number): ReportedContext | undefined {
  const prompt =
    usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  return prompt === 0 ? undefined : { tokens: prompt + usage.outputTokens, messages };
}

function conversationPart(anatomy: RequestAnatomy, fixed: number): ContextPart {
  const { reported, history } = anatomy;
  if (reported === undefined || reported.messages > history.length) {
    return estimated(estimateConversationTokens(history));
  }
  const since = estimateConversationTokens(history.slice(reported.messages));
  return { tokens: Math.max(0, reported.tokens - fixed) + since, basis: "reported" };
}

function definitionTokens({ name, description, parameters }: ToolDefinition): number {
  return estimateTextTokens(JSON.stringify({ name, description, parameters }));
}

function estimated(tokens: number): ContextPart {
  return { tokens, basis: "estimated" };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
