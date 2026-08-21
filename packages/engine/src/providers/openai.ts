import type { ToolCallPart, Usage } from "../messages.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { toChatRequest } from "./chat-wire.ts";
import { ProviderHttpError, ProviderStreamError } from "./errors.ts";
import { sseJsonEvents } from "./sse.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type AuthHeaders = () => Promise<Record<string, string>>;

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

export { ProviderHttpError, ProviderStreamError } from "./errors.ts";

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
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await this.authHeaders()),
        ...this.extraHeaders,
      },
      body: JSON.stringify({ ...toChatRequest(request, this.modelId), ...this.extraBody }),
      ...(request.signal !== undefined && { signal: request.signal }),
    });
    if (!response.ok) {
      throw new ProviderHttpError(this.name, response.status, await response.text());
    }
    if (response.body === null) throw new Error(`${this.name} returned an empty response body`);
    yield* assembleTurn(this.name, sseJsonEvents(this.name, response.body));
  }
}

export function bearerHeaders(apiKey: string | undefined): AuthHeaders {
  const headers = apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };
  return async () => headers;
}

const maxToolArgumentBytes = 1_048_576;

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

interface PendingCall {
  id: string;
  name: string;
  argumentsJson: string;
}

async function* assembleTurn(
  provider: string,
  events: AsyncIterable<unknown>,
): AsyncGenerator<TurnDelta> {
  const pending = new Map<number, PendingCall>();
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
    for (const fragment of delta?.tool_calls ?? []) accumulate(provider, pending, fragment);
  }
  for (const [index, call] of [...pending].sort(([a], [b]) => a - b)) {
    yield { type: "tool-call", call: completedCall(index, call) };
  }
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

function accumulate(
  provider: string,
  pending: Map<number, PendingCall>,
  fragment: ToolCallFragment,
): void {
  const existing = pending.get(fragment.index) ?? { id: "", name: "", argumentsJson: "" };
  const argumentsJson = existing.argumentsJson + (fragment.function?.arguments ?? "");
  if (argumentsJson.length > maxToolArgumentBytes) {
    throw new ProviderStreamError(provider, "tool-call arguments exceeded the size ceiling");
  }
  pending.set(fragment.index, {
    id: existing.id !== "" ? existing.id : (fragment.id ?? ""),
    name: existing.name !== "" ? existing.name : (fragment.function?.name ?? ""),
    argumentsJson,
  });
}

function completedCall(index: number, call: PendingCall): ToolCallPart {
  return {
    type: "tool-call",
    callId: call.id !== "" ? call.id : `call_${index}`,
    name: call.name,
    arguments: parseArgs(call),
  };
}

function parseArgs(call: PendingCall): unknown {
  if (call.argumentsJson.trim() === "") return {};
  try {
    return JSON.parse(call.argumentsJson);
  } catch {
    return call.argumentsJson;
  }
}
