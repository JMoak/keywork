import type { ProviderStateOwner, Usage } from "../messages.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { ProviderHttpError, ProviderStreamError } from "./errors.ts";
import type { AuthHeaders, FetchLike } from "./openai.ts";
import { toResponsesRequest } from "./responses-wire.ts";
import { sseJsonEvents } from "./sse.ts";

export interface OpenAiResponsesOptions {
  name: string;
  baseUrl: string;
  model: string;
  authHeaders: AuthHeaders;
  extraHeaders?: Readonly<Record<string, string>> | undefined;
  fetchFn?: FetchLike | undefined;
}

export class OpenAiResponsesProvider implements Provider {
  readonly name: string;
  readonly modelId: string;
  private readonly owner: ProviderStateOwner;
  private readonly baseUrl: string;
  private readonly authHeaders: AuthHeaders;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly fetchFn: FetchLike;

  constructor(options: OpenAiResponsesOptions) {
    this.name = options.name;
    this.modelId = options.model;
    this.owner = { provider: options.name, model: options.model };
    this.baseUrl = options.baseUrl;
    this.authHeaders = options.authHeaders;
    this.extraHeaders = options.extraHeaders ?? {};
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    const response = await this.fetchFn(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(await this.authHeaders()),
        ...this.extraHeaders,
      },
      body: JSON.stringify(toResponsesRequest(request, this.modelId, this.owner)),
      ...(request.signal !== undefined && { signal: request.signal }),
    });
    if (!response.ok) {
      throw new ProviderHttpError(this.name, response.status, await response.text());
    }
    if (response.body === null) throw new Error(`${this.name} returned an empty response body`);
    yield* assembleTurn(this.name, this.owner, sseJsonEvents(this.name, response.body));
  }
}

interface StreamEvent {
  type?: string;
  delta?: string;
  item?: OutputItem;
  message?: string;
  response?: {
    usage?: WireUsage;
    error?: { message?: string } | null;
  };
}

interface OutputItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string;
}

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

async function* assembleTurn(
  provider: string,
  owner: ProviderStateOwner,
  events: AsyncIterable<unknown>,
): AsyncGenerator<TurnDelta> {
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  for await (const raw of events) {
    const event = raw as StreamEvent;
    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string" && event.delta !== "") {
          yield { type: "text", text: event.delta };
        }
        break;
      case "response.output_item.done":
        yield* completedItem(event.item, owner);
        break;
      case "response.completed":
      case "response.incomplete":
        usage = toUsage(event.response?.usage);
        break;
      case "response.failed":
        throw new ProviderStreamError(
          provider,
          event.response?.error?.message ?? "response failed",
        );
      case "error":
        throw new ProviderStreamError(provider, event.message ?? "unknown stream error");
      default:
        break;
    }
  }
  yield { type: "done", usage };
}

function* completedItem(
  item: OutputItem | undefined,
  owner: ProviderStateOwner,
): Generator<TurnDelta> {
  if (item === undefined) return;
  if (item.type === "function_call") {
    yield {
      type: "tool-call",
      call: {
        type: "tool-call",
        callId: item.call_id ?? "",
        name: item.name ?? "",
        arguments: parseArguments(item.arguments ?? ""),
      },
    };
  }
  if (item.type === "reasoning" && typeof item.encrypted_content === "string") {
    yield {
      type: "redacted-thinking",
      part: { type: "redacted-thinking", data: JSON.stringify(item), owner },
    };
  }
}

function parseArguments(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toUsage(usage: WireUsage | undefined): Usage {
  const cachedTokens = usage?.input_tokens_details?.cached_tokens;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(cachedTokens !== undefined && cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
  };
}
