import type { Usage } from "../messages.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { toChatRequest } from "./chat-wire.ts";
import { ProviderStreamError } from "./errors.ts";
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
  private readonly baseUrl: string;
  private readonly authHeaders: AuthHeaders;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly extraBody: Readonly<Record<string, unknown>>;
  private readonly fetchFn: FetchLike;

  constructor(options: OpenAiCompatibleOptions) {
    this.name = options.name;
    this.modelId = options.model;
    this.baseUrl = options.baseUrl;
    this.authHeaders = options.authHeaders ?? bearerHeaders(options.apiKey);
    this.extraHeaders = options.extraHeaders ?? {};
    this.extraBody = options.extraBody ?? {};
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    const body = await postForStream(this.name, this.fetchFn, {
      url: `${this.baseUrl}/chat/completions`,
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
        ...this.extraHeaders,
      },
      body: JSON.stringify({ ...toChatRequest(request, this.modelId), ...this.extraBody }),
      signal: request.signal,
    });
    yield* assembleTurn(this.name, sseJsonEvents(this.name, body));
  }
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  cost?: number;
}

interface StreamEvent {
  error?: { message?: string } | string;
  choices?: { delta?: WireDelta }[];
  usage?: WireUsage | null;
}

interface WireDelta {
  content?: string | null;
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
): AsyncGenerator<TurnDelta> {
  const calls = new ToolCallAssembler(provider);
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  for await (const raw of events) {
    const event = raw as StreamEvent;
    if (event.error != null) {
      throw new ProviderStreamError(provider, describeErrorEvent(event.error));
    }
    if (event.usage != null) usage = usageFromWire(event.usage);
    const delta = event.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content !== "") {
      yield { type: "text", text: delta.content };
    }
    for (const fragment of delta?.tool_calls ?? []) {
      calls.add(fragment.index, {
        id: fragment.id,
        name: fragment.function?.name,
        argumentsJson: fragment.function?.arguments,
      });
    }
  }
  for (const call of calls.completed()) yield { type: "tool-call", call };
  yield { type: "done", usage };
}

function usageFromWire(wire: WireUsage): Usage {
  const cachedTokens = wire.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (wire.prompt_tokens ?? 0) - cachedTokens),
    outputTokens: wire.completion_tokens ?? 0,
    ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
    ...(typeof wire.cost === "number" && { costUsd: wire.cost }),
  };
}

function describeErrorEvent(error: NonNullable<StreamEvent["error"]>): string {
  if (typeof error === "string") return error;
  return error.message ?? JSON.stringify(error);
}
