import type { ToolCallPart, Usage } from "../messages.ts";
import type { Provider, ProviderRequest, TurnDelta } from "../provider.ts";
import { toChatRequest } from "./chat-wire.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
  fetchFn?: FetchLike;
}

export class ProviderHttpError extends Error {
  constructor(
    provider: string,
    readonly status: number,
    body: string,
  ) {
    super(`${provider} request failed (${status}): ${body.slice(0, 500)}`);
    this.name = "ProviderHttpError";
  }
}

export class OpenAiCompatibleProvider implements Provider {
  readonly name: string;
  private readonly options: Required<Omit<OpenAiCompatibleOptions, "extraHeaders">> & {
    extraHeaders: Record<string, string>;
  };

  constructor(options: OpenAiCompatibleOptions) {
    this.name = options.name;
    this.options = { extraHeaders: {}, fetchFn: fetch, ...options };
  }

  async *stream(request: ProviderRequest): AsyncIterable<TurnDelta> {
    const response = await this.options.fetchFn(`${this.options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
        ...this.options.extraHeaders,
      },
      body: JSON.stringify(toChatRequest(request, this.options.model)),
      ...(request.signal !== undefined && { signal: request.signal }),
    });
    if (!response.ok) {
      throw new ProviderHttpError(this.name, response.status, await response.text());
    }
    if (response.body === null) throw new Error(`${this.name} returned an empty response body`);
    yield* assembleTurn(sseData(response.body));
  }
}

interface StreamEvent {
  choices?: { delta?: WireDelta }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
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

async function* assembleTurn(events: AsyncIterable<unknown>): AsyncGenerator<TurnDelta> {
  const pending = new Map<number, PendingCall>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  for await (const raw of events) {
    const event = raw as StreamEvent;
    if (event.usage != null) {
      usage = {
        inputTokens: event.usage.prompt_tokens ?? 0,
        outputTokens: event.usage.completion_tokens ?? 0,
      };
    }
    const delta = event.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content !== "") {
      yield { type: "text", text: delta.content };
    }
    for (const fragment of delta?.tool_calls ?? []) accumulate(pending, fragment);
  }
  for (const [, call] of [...pending].sort(([a], [b]) => a - b)) {
    yield { type: "tool-call", call: completedCall(call) };
  }
  yield { type: "done", usage };
}

function accumulate(pending: Map<number, PendingCall>, fragment: ToolCallFragment): void {
  const existing = pending.get(fragment.index) ?? { id: "", name: "", argumentsJson: "" };
  pending.set(fragment.index, {
    id: fragment.id ?? existing.id,
    name: existing.name + (fragment.function?.name ?? ""),
    argumentsJson: existing.argumentsJson + (fragment.function?.arguments ?? ""),
  });
}

function completedCall(call: PendingCall): ToolCallPart {
  return { type: "tool-call", callId: call.id, name: call.name, arguments: parseArgs(call) };
}

function parseArgs(call: PendingCall): unknown {
  if (call.argumentsJson.trim() === "") return {};
  try {
    return JSON.parse(call.argumentsJson);
  } catch {
    return call.argumentsJson;
  }
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data);
    }
  }
}
