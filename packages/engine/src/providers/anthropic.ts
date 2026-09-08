import type { ProviderStateOwner, Usage } from "../messages.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { ProviderStreamError } from "./errors.ts";
import { toMessagesRequest } from "./messages-wire.ts";
import { sseJsonEvents } from "./sse.ts";
import { type FetchLike, postForStream } from "./transport.ts";
import { ToolCallAssembler } from "./wire-parts.ts";

export const anthropicVersion = "2023-06-01";

export const defaultMaxOutputTokens = 32_000;

export interface AnthropicOptions {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  maxTokens?: number | undefined;
  extraHeaders?: Readonly<Record<string, string>> | undefined;
  extraBody?: Readonly<Record<string, unknown>> | undefined;
  fetchFn?: FetchLike | undefined;
}

export function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "anthropic-version": anthropicVersion,
    ...(apiKey !== undefined && { "x-api-key": apiKey }),
  };
}

export class AnthropicApiError extends ProviderStreamError {
  readonly transient: boolean;

  constructor(
    provider: string,
    readonly errorType: string,
    message: string,
  ) {
    super(provider, `${errorType}: ${message}`);
    this.name = "AnthropicApiError";
    this.transient = transientErrorTypes.has(errorType);
  }
}

export class AnthropicProvider implements Provider {
  readonly name: string;
  readonly modelId: string;
  private readonly owner: ProviderStateOwner;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly maxTokens: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly extraBody: Readonly<Record<string, unknown>>;
  private readonly fetchFn: FetchLike;

  constructor(options: AnthropicOptions) {
    this.name = options.name;
    this.modelId = options.model;
    this.owner = { provider: options.name, model: options.model };
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.maxTokens = options.maxTokens ?? defaultMaxOutputTokens;
    this.extraHeaders = options.extraHeaders ?? {};
    this.extraBody = options.extraBody ?? {};
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    const body = await postForStream(this.name, this.fetchFn, {
      url: `${this.baseUrl}/messages`,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...anthropicHeaders(this.apiKey),
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        ...toMessagesRequest(request, this.modelId, this.owner, { maxTokens: this.maxTokens }),
        ...this.extraBody,
      }),
      signal: request.signal,
    });
    yield* assembleTurn(this.name, this.owner, sseJsonEvents(this.name, body));
  }
}

const transientErrorTypes = new Set(["overloaded_error", "api_error", "rate_limit_error"]);

const cutOffStopReasons = new Set(["max_tokens", "model_context_window_exceeded"]);

interface StreamEvent {
  type?: string;
  index?: number;
  content_block?: WireBlock;
  delta?: WireDelta;
  message?: { usage?: WireUsage };
  usage?: WireUsage;
  error?: { type?: string; message?: string };
}

interface WireBlock {
  type?: string;
  id?: string;
  name?: string;
  data?: string;
}

interface WireDelta {
  type?: string;
  text?: string;
  partial_json?: string;
  thinking?: string;
  signature?: string;
  stop_reason?: string | null;
}

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

async function* assembleTurn(
  provider: string,
  owner: ProviderStateOwner,
  events: AsyncIterable<unknown>,
): AsyncGenerator<TurnDelta> {
  const calls = new ToolCallAssembler(provider);
  const thinking = new Map<number, ThinkingBlock>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  for await (const raw of events) {
    const event = raw as StreamEvent;
    const index = event.index ?? 0;
    switch (event.type) {
      case "message_start":
        usage = mergeUsage(usage, event.message?.usage);
        break;
      case "content_block_start":
        openBlock(event.content_block, index, calls, thinking);
        break;
      case "content_block_delta": {
        const shown = shownDelta(event.delta);
        if (shown !== undefined) yield shown;
        extendBlock(event.delta, index, calls, thinking);
        break;
      }
      case "content_block_stop":
        yield* closeBlock(index, owner, calls, thinking);
        break;
      case "message_delta":
        usage = mergeUsage(usage, event.usage);
        assertNotCutOff(provider, event.delta?.stop_reason);
        break;
      case "error":
        throw new AnthropicApiError(
          provider,
          event.error?.type ?? "unknown_error",
          event.error?.message ?? "unknown stream error",
        );
      default:
        break;
    }
  }
  yield { type: "done", usage };
}

function openBlock(
  block: WireBlock | undefined,
  index: number,
  calls: ToolCallAssembler,
  thinking: Map<number, ThinkingBlock>,
): void {
  switch (block?.type) {
    case "tool_use":
      calls.add(index, { id: block.id, name: block.name });
      return;
    case "thinking":
      thinking.set(index, { type: "thinking", thinking: "", signature: "" });
      return;
    case "redacted_thinking":
      thinking.set(index, { type: "redacted_thinking", data: block.data ?? "" });
      return;
    default:
      return;
  }
}

function shownDelta(delta: WireDelta | undefined): TurnDelta | undefined {
  if (delta?.type === "text_delta" && delta.text) return { type: "text", text: delta.text };
  if (delta?.type === "thinking_delta" && delta.thinking) {
    return { type: "visible-thinking", text: delta.thinking };
  }
  return undefined;
}

function extendBlock(
  delta: WireDelta | undefined,
  index: number,
  calls: ToolCallAssembler,
  thinking: Map<number, ThinkingBlock>,
): void {
  const open = thinking.get(index);
  switch (delta?.type) {
    case "input_json_delta":
      calls.add(index, { argumentsJson: delta.partial_json });
      return;
    case "thinking_delta":
      if (open?.type === "thinking") open.thinking += delta.thinking ?? "";
      return;
    case "signature_delta":
      if (open?.type === "thinking") open.signature += delta.signature ?? "";
      return;
    default:
      return;
  }
}

function* closeBlock(
  index: number,
  owner: ProviderStateOwner,
  calls: ToolCallAssembler,
  thinking: Map<number, ThinkingBlock>,
): Generator<TurnDelta> {
  const call = calls.take(index);
  if (call !== undefined) yield { type: "tool-call", call };
  const block = thinking.get(index);
  if (block === undefined) return;
  thinking.delete(index);
  yield {
    type: "redacted-thinking",
    part: { type: "redacted-thinking", data: JSON.stringify(block), owner },
  };
}

function mergeUsage(current: Usage, wire: WireUsage | undefined): Usage {
  if (wire === undefined) return current;
  const cacheCreation = wire.cache_creation_input_tokens ?? current.cacheCreationInputTokens;
  const cacheRead = wire.cache_read_input_tokens ?? current.cacheReadInputTokens;
  return {
    inputTokens: wire.input_tokens ?? current.inputTokens,
    outputTokens: wire.output_tokens ?? current.outputTokens,
    ...(cacheCreation !== undefined &&
      cacheCreation > 0 && { cacheCreationInputTokens: cacheCreation }),
    ...(cacheRead !== undefined && cacheRead > 0 && { cacheReadInputTokens: cacheRead }),
  };
}

function assertNotCutOff(provider: string, stopReason: string | null | undefined): void {
  if (stopReason === undefined || stopReason === null) return;
  if (cutOffStopReasons.has(stopReason)) {
    throw new ProviderStreamError(provider, `response cut off (${stopReason})`);
  }
  if (stopReason === "refusal") {
    throw new ProviderStreamError(provider, "response declined by the model (refusal)");
  }
}
