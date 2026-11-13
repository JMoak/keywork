import type { Usage } from "../messages.ts";
import {
  assertRequestControls,
  type Provider,
  type ProviderRequest,
  type ProviderRequestSupport,
  type ProviderResponseReceipt,
  type TurnDelta,
} from "../provider.ts";
import { toChatRequest } from "./chat-wire.ts";
import { ProviderEmptyStreamError, ProviderStreamError } from "./errors.ts";
import { boundedOpenRouterBody, openRouterRequestSupport } from "./openrouter-limits.ts";
import { sseJsonEvents } from "./sse.ts";
import { type AuthHeaders, bearerHeaders, type FetchLike, postForStream } from "./transport.ts";
import { ToolCallAssembler } from "./wire-parts.ts";

export interface OpenAiCompatibleOptions {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  authHeaders?: AuthHeaders | undefined;
  extraHeaders?: Readonly<Record<string, string>> | undefined;
  extraBody?: Readonly<Record<string, unknown>> | undefined;
  fetchFn?: FetchLike | undefined;
}

export class OpenAiCompatibleProvider implements Provider {
  readonly name: string;
  readonly modelId: string;
  readonly requestSupport: ProviderRequestSupport | undefined;
  private readonly baseUrl: string;
  private readonly authHeaders: AuthHeaders;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly extraBody: Readonly<Record<string, unknown>>;
  private readonly fetchFn: FetchLike;

  constructor(options: OpenAiCompatibleOptions) {
    this.name = options.name;
    this.modelId = options.model;
    this.requestSupport = openRouterRequestSupport(options.baseUrl);
    this.baseUrl = options.baseUrl;
    this.authHeaders = options.authHeaders ?? bearerHeaders(options.apiKey);
    this.extraHeaders = options.extraHeaders ?? {};
    this.extraBody = options.extraBody ?? {};
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    assertRequestControls(this, request);
    const wire = boundedOpenRouterBody(
      this.name,
      this.modelId,
      request,
      toChatRequest(request, this.modelId),
      this.extraBody,
    );
    const receipt: ProviderResponseReceipt | undefined =
      request.maxOutputTokens !== undefined || request.onResponse !== undefined
        ? { usageReported: false, requestedModel: this.modelId }
        : undefined;
    const body = await postForStream(this.name, this.fetchFn, {
      url: `${this.baseUrl}/chat/completions`,
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
        ...this.extraHeaders,
      },
      body: JSON.stringify(wire),
      signal: request.signal,
      singleAttempt: request.retry === "never",
      onHeaders: (headers) => {
        const requestId = headers.get("x-request-id");
        if (receipt !== undefined && requestId !== null) {
          receipt.requestId = requestId;
          request.onResponse?.({ ...receipt });
        }
      },
    });
    yield* assembleTurn(this.name, sseJsonEvents(this.name, body), receipt, request.onResponse);
  }
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  cost?: number;
}

interface StreamEvent {
  id?: string;
  model?: string;
  provider?: string;
  error?: { message?: string } | string;
  choices?: { delta?: WireDelta; finish_reason?: string | null }[];
  usage?: WireUsage | null;
}

interface WireDelta {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCallFragment[];
}

interface ToolCallFragment {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

async function* assembleTurn(
  provider: string,
  events: AsyncIterable<unknown>,
  receipt?: ProviderResponseReceipt,
  onResponse?: ProviderRequest["onResponse"],
): AsyncGenerator<TurnDelta> {
  const turn = new TurnAssembly(provider);
  for await (const raw of events) {
    const event = raw as StreamEvent;
    if (receipt !== undefined) updateReceipt(receipt, event, onResponse);
    yield* turn.absorb(event);
  }
  yield* turn.finish(receipt);
}

class TurnAssembly {
  private readonly calls: ToolCallAssembler;
  private usage: Usage | undefined;
  private finished = false;
  private answered = false;

  constructor(private readonly provider: string) {
    this.calls = new ToolCallAssembler(provider);
  }

  *absorb(event: StreamEvent): Generator<TurnDelta> {
    if (event.error != null) {
      throw new ProviderStreamError(this.provider, describeErrorEvent(event.error));
    }
    if (event.usage != null) this.usage = usageFromWire(event.usage);
    const choice = event.choices?.[0];
    if (typeof choice?.finish_reason === "string") this.finished = true;
    yield* this.absorbDelta(choice?.delta);
  }

  *finish(receipt: ProviderResponseReceipt | undefined): Generator<TurnDelta> {
    if (this.endedEmpty()) throw new ProviderEmptyStreamError(this.provider);
    for (const call of this.calls.completed()) yield { type: "tool-call", call };
    yield {
      type: "done",
      usage: this.usage ?? { inputTokens: 0, outputTokens: 0 },
      ...(receipt !== undefined && { receipt: { ...receipt } }),
    };
  }

  private *absorbDelta(delta: WireDelta | undefined): Generator<TurnDelta> {
    const reasoning = reasoningOf(delta);
    if (reasoning !== undefined) yield { type: "visible-thinking", text: reasoning };
    if (typeof delta?.content === "string" && delta.content !== "") {
      this.answered = true;
      yield { type: "text", text: delta.content };
    }
    for (const fragment of delta?.tool_calls ?? []) {
      this.answered = true;
      this.calls.add(fragment.index, {
        id: fragment.id,
        name: fragment.function?.name,
        argumentsJson: fragment.function?.arguments,
      });
    }
  }

  private endedEmpty(): boolean {
    return !this.finished && !this.answered && this.usage === undefined;
  }
}

const reasoningAliases = ["reasoning", "reasoning_content"] as const;

function reasoningOf(delta: WireDelta | undefined): string | undefined {
  return reasoningAliases
    .map((alias) => delta?.[alias])
    .find((text): text is string => typeof text === "string" && text !== "");
}

function updateReceipt(
  receipt: ProviderResponseReceipt,
  event: StreamEvent,
  onResponse: ProviderRequest["onResponse"],
): void {
  const updated: ProviderResponseReceipt = {
    ...receipt,
    ...(typeof event.id === "string" && { responseId: event.id }),
    ...(typeof event.model === "string" && { servedModel: event.model }),
    ...(typeof event.provider === "string" && { servedProvider: event.provider }),
    ...(typeof event.usage?.cost === "number" &&
      Number.isFinite(event.usage.cost) &&
      event.usage.cost >= 0 && { costUsd: event.usage.cost }),
    ...(typeof event.choices?.[0]?.finish_reason === "string" && {
      finishReason: event.choices[0].finish_reason,
    }),
    ...(event.usage !== undefined &&
      event.usage !== null && {
        usageReported: completeUsage(event.usage),
      }),
  };
  if (JSON.stringify(updated) === JSON.stringify(receipt)) return;
  Object.assign(receipt, updated);
  onResponse?.({ ...receipt });
}

function usageFromWire(wire: WireUsage): Usage {
  const cachedTokens = wire.prompt_tokens_details?.cached_tokens ?? 0;
  const writtenTokens = wire.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (wire.prompt_tokens ?? 0) - cachedTokens - writtenTokens),
    outputTokens: wire.completion_tokens ?? 0,
    ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
    ...(writtenTokens > 0 && { cacheCreationInputTokens: writtenTokens }),
    ...(typeof wire.cost === "number" &&
      Number.isFinite(wire.cost) &&
      wire.cost >= 0 && { costUsd: wire.cost }),
  };
}

function validCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function completeUsage(usage: WireUsage): boolean {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const written = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  return (
    validCount(usage.prompt_tokens) &&
    validCount(usage.completion_tokens) &&
    validCount(cached) &&
    validCount(written) &&
    cached + written <= (usage.prompt_tokens ?? 0)
  );
}

function describeErrorEvent(error: NonNullable<StreamEvent["error"]>): string {
  if (typeof error === "string") return error;
  return error.message ?? JSON.stringify(error);
}
