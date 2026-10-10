import type { ProviderStateOwner, Usage } from "../messages.ts";
import type { CacheMiss, Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { claudeBetasFor, maxOutputTokensFor } from "./claude-models.ts";
import { ProviderStreamError } from "./errors.ts";
import { showsProgressUpdates, toMessagesRequest } from "./messages-wire.ts";
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

export function anthropicHeaders(
  apiKey: string | undefined,
  betas: readonly string[] = [],
): Record<string, string> {
  return {
    "anthropic-version": anthropicVersion,
    ...(apiKey !== undefined && { "x-api-key": apiKey }),
    ...(betas.length > 0 && { "anthropic-beta": betas.join(",") }),
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
    this.maxTokens = options.maxTokens ?? maxOutputTokensFor(options.model, defaultMaxOutputTokens);
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
        ...anthropicHeaders(this.apiKey, claudeBetasFor(this.modelId)),
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        ...toMessagesRequest(request, this.modelId, this.owner, { maxTokens: this.maxTokens }),
        ...this.extraBody,
      }),
      signal: request.signal,
    });
    const blocks = new BlockAssembly(
      this.name,
      showsProgressUpdates(this.modelId, request.thinking === true),
    );
    yield* assembleTurn(this.name, this.owner, blocks, sseJsonEvents(this.name, body));
  }
}

const transientErrorTypes = new Set(["overloaded_error", "api_error", "rate_limit_error"]);

const cutOffStopReasons = new Set(["max_tokens", "model_context_window_exceeded"]);

interface StreamEvent {
  type?: string;
  index?: number;
  content_block?: WireBlock;
  delta?: WireDelta;
  message?: WireMessageStart;
  usage?: WireUsage;
  error?: { type?: string; message?: string };
}

interface WireMessageStart {
  id?: string;
  usage?: WireUsage;
  diagnostics?: { cache_miss_reason?: WireCacheMissReason | null } | null;
}

interface WireCacheMissReason {
  type?: string;
  cache_missed_input_tokens?: number;
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

type ResponseFacts = { responseId?: string; cacheMiss?: CacheMiss };

async function* assembleTurn(
  provider: string,
  owner: ProviderStateOwner,
  blocks: BlockAssembly,
  events: AsyncIterable<unknown>,
): AsyncGenerator<TurnDelta> {
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let facts: ResponseFacts = {};
  for await (const raw of events) {
    const event = raw as StreamEvent;
    const index = event.index ?? 0;
    switch (event.type) {
      case "message_start":
        usage = mergeUsage(usage, event.message?.usage);
        facts = responseFacts(event.message);
        break;
      case "content_block_start":
        blocks.open(event.content_block, index);
        break;
      case "content_block_delta": {
        const shown = blocks.extend(event.delta, index);
        if (shown !== undefined) yield shown;
        break;
      }
      case "content_block_stop":
        yield* blocks.close(index, owner);
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
  yield { type: "done", usage, ...facts };
}

class BlockAssembly {
  private readonly calls: ToolCallAssembler;
  private readonly thinking = new Map<number, ThinkingBlock>();

  constructor(
    provider: string,
    private readonly progressUpdates: boolean,
  ) {
    this.calls = new ToolCallAssembler(provider);
  }

  open(block: WireBlock | undefined, index: number): void {
    switch (block?.type) {
      case "tool_use":
        this.calls.add(index, { id: block.id, name: block.name });
        return;
      case "thinking":
        this.thinking.set(index, { type: "thinking", thinking: "", signature: "" });
        return;
      case "redacted_thinking":
        this.thinking.set(index, { type: "redacted_thinking", data: block.data ?? "" });
        return;
      default:
        return;
    }
  }

  extend(delta: WireDelta | undefined, index: number): TurnDelta | undefined {
    const open = this.thinking.get(index);
    switch (delta?.type) {
      case "text_delta":
        return delta.text ? { type: "text", text: delta.text } : undefined;
      case "input_json_delta":
        this.calls.add(index, { argumentsJson: delta.partial_json });
        return undefined;
      case "thinking_delta":
        if (open?.type === "thinking") open.thinking += delta.thinking ?? "";
        return delta.thinking && !this.progressUpdates
          ? { type: "visible-thinking", text: delta.thinking }
          : undefined;
      case "signature_delta":
        if (open?.type === "thinking") open.signature += delta.signature ?? "";
        return undefined;
      default:
        return undefined;
    }
  }

  *close(index: number, owner: ProviderStateOwner): Generator<TurnDelta> {
    const call = this.calls.take(index);
    if (call !== undefined) yield { type: "tool-call", call };
    const block = this.thinking.get(index);
    if (block === undefined) return;
    this.thinking.delete(index);
    if (this.progressUpdates && block.type === "thinking" && block.thinking !== "") {
      yield { type: "progress", text: block.thinking };
    }
    yield {
      type: "redacted-thinking",
      part: { type: "redacted-thinking", data: JSON.stringify(block), owner },
    };
  }
}

function responseFacts(message: WireMessageStart | undefined): ResponseFacts {
  const cacheMiss = cacheMissOf(message?.diagnostics?.cache_miss_reason);
  return {
    ...(message?.id !== undefined && { responseId: message.id }),
    ...(cacheMiss !== undefined && { cacheMiss }),
  };
}

function cacheMissOf(reason: WireCacheMissReason | null | undefined): CacheMiss | undefined {
  const type = reason?.type;
  if (type === undefined || !type.endsWith("_changed")) return undefined;
  const missedTokens = reason?.cache_missed_input_tokens;
  return {
    cause: type.replaceAll("_", " "),
    ...(missedTokens !== undefined && { missedTokens }),
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
