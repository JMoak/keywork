import { describe, expect, it } from "vitest";
import { type Message, textMessage } from "../messages.ts";
import type { ProviderRequest, TurnDelta } from "../provider.ts";
import {
  AnthropicApiError,
  AnthropicProvider,
  anthropicHeaders,
  anthropicVersion,
  defaultMaxOutputTokens,
} from "./anthropic.ts";
import { ProviderHttpError, ProviderStreamError } from "./errors.ts";
import { rawSseResponse } from "./stream-fixtures.ts";
import type { FetchLike } from "./transport.ts";

const secretKey = "sk-ant-api03-EXAMPLE-not-a-real-key";

function provider(fetchFn: FetchLike, options: { apiKey?: string; maxTokens?: number } = {}) {
  return new AnthropicProvider({
    name: "anthropic",
    baseUrl: "https://api.example.test/v1",
    model: "claude-test",
    apiKey: options.apiKey ?? secretKey,
    ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
    fetchFn,
  });
}

const simpleRequest: ProviderRequest = {
  systemPrompt: "sys",
  messages: [textMessage("user", "hi")],
  tools: [],
};

function events(...frames: ReadonlyArray<readonly [event: string, data: object]>): Response {
  return rawSseResponse(
    frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
  );
}

const messageStart = (usage: object) =>
  ["message_start", { type: "message_start", message: { usage } }] as const;
const blockStart = (index: number, content_block: object) =>
  ["content_block_start", { type: "content_block_start", index, content_block }] as const;
const blockDelta = (index: number, delta: object) =>
  ["content_block_delta", { type: "content_block_delta", index, delta }] as const;
const blockStop = (index: number) =>
  ["content_block_stop", { type: "content_block_stop", index }] as const;
const messageDelta = (stop_reason: string, usage: object) =>
  ["message_delta", { type: "message_delta", delta: { stop_reason }, usage }] as const;
const messageStop = ["message_stop", { type: "message_stop" }] as const;

async function collect(iterable: AsyncIterable<TurnDelta>): Promise<TurnDelta[]> {
  const deltas: TurnDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

async function failureOf(iterable: AsyncIterable<TurnDelta>): Promise<unknown> {
  try {
    await collect(iterable);
    return undefined;
  } catch (cause) {
    return cause;
  }
}

describe("AnthropicProvider", () => {
  it("streams text, keeps thinking as owned provider state, and completes tool calls in block order", async () => {
    const response = events(
      messageStart({
        input_tokens: 40,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 10,
        output_tokens: 1,
      }),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      blockDelta(0, { type: "thinking_delta", thinking: "Consider ls." }),
      blockDelta(0, { type: "signature_delta", signature: "sig==" }),
      blockStop(0),
      blockStart(1, { type: "text", text: "" }),
      blockDelta(1, { type: "text_delta", text: "Let me " }),
      blockDelta(1, { type: "text_delta", text: "look." }),
      blockStop(1),
      blockStart(2, { type: "redacted_thinking", data: "opaque" }),
      blockStop(2),
      blockStart(3, { type: "tool_use", id: "toolu_1", name: "bash", input: {} }),
      blockDelta(3, { type: "input_json_delta", partial_json: '{"command":' }),
      blockDelta(3, { type: "input_json_delta", partial_json: '"ls"}' }),
      blockStop(3),
      ["ping", { type: "ping" }],
      messageDelta("tool_use", { output_tokens: 12 }),
      messageStop,
    );
    const deltas = await collect(provider(async () => response).stream(simpleRequest));
    const owner = { provider: "anthropic", model: "claude-test" };

    expect(deltas).toEqual([
      { type: "visible-thinking", text: "Consider ls." },
      {
        type: "redacted-thinking",
        part: {
          type: "redacted-thinking",
          data: '{"type":"thinking","thinking":"Consider ls.","signature":"sig=="}',
          owner,
        },
      },
      { type: "text", text: "Let me " },
      { type: "text", text: "look." },
      {
        type: "redacted-thinking",
        part: {
          type: "redacted-thinking",
          data: '{"type":"redacted_thinking","data":"opaque"}',
          owner,
        },
      },
      {
        type: "tool-call",
        call: { type: "tool-call", callId: "toolu_1", name: "bash", arguments: { command: "ls" } },
      },
      {
        type: "done",
        usage: {
          inputTokens: 40,
          outputTokens: 12,
          cacheCreationInputTokens: 30,
          cacheReadInputTokens: 10,
        },
      },
    ]);
  });

  it("sends the key as x-api-key beside the pinned version header, never as a bearer token", async () => {
    let sent: { url: string; init: RequestInit | undefined } | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      sent = { url, init };
      return events(
        messageStart({ input_tokens: 1, output_tokens: 1 }),
        messageDelta("end_turn", { output_tokens: 1 }),
        messageStop,
      );
    };
    await collect(provider(fetchFn).stream(simpleRequest));

    expect(sent?.url).toBe("https://api.example.test/v1/messages");
    const headers = sent?.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(secretKey);
    expect(headers["anthropic-version"]).toBe(anthropicVersion);
    expect(headers.authorization).toBeUndefined();
    expect(headers.accept).toBe("text/event-stream");
    const body = JSON.parse(sent?.init?.body as string);
    expect(body).toMatchObject({
      model: "claude-test",
      max_tokens: defaultMaxOutputTokens,
      stream: true,
      cache_control: { type: "ephemeral" },
      system: "sys",
    });
  });

  it("asks for thinking only when the request opts in and leaves the default body byte-identical", async () => {
    const bodies: string[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(init?.body as string);
      return events(messageDelta("end_turn", { output_tokens: 1 }), messageStop);
    };
    const anthropic = provider(fetchFn);
    await collect(anthropic.stream(simpleRequest));
    await collect(anthropic.stream({ ...simpleRequest, thinking: true }));
    await collect(anthropic.stream(simpleRequest));

    const [before, opted, after] = bodies;
    expect(after).toBe(before);
    expect(before).not.toContain("thinking");
    expect(JSON.parse(opted as string).thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  it("lets a decorated body override the output ceiling and omits the key header when there is none", async () => {
    let sent: RequestInit | undefined;
    const fetchFn: FetchLike = async (_url, init) => {
      sent = init;
      return events(messageDelta("end_turn", { output_tokens: 1 }), messageStop);
    };
    const proxy = new AnthropicProvider({
      name: "proxy",
      baseUrl: "http://localhost:4000/v1",
      model: "claude-test",
      extraBody: { max_tokens: 2048 },
      fetchFn,
    });
    await collect(proxy.stream(simpleRequest));

    const headers = sent?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe(anthropicVersion);
    expect(JSON.parse(sent?.body as string).max_tokens).toBe(2048);
  });

  it("fails the turn naming the cut-off reason when the model hits its output ceiling", async () => {
    const response = events(
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "partial" }),
      blockStop(0),
      messageDelta("max_tokens", { output_tokens: 9 }),
      messageStop,
    );
    const failure = await failureOf(provider(async () => response).stream(simpleRequest));
    expect(failure).toBeInstanceOf(ProviderStreamError);
    expect((failure as Error).message).toMatch(/cut off \(max_tokens\)/);
  });

  it("surfaces a refusal stop as a stream failure instead of an empty success", async () => {
    const response = events(messageDelta("refusal", { output_tokens: 0 }), messageStop);
    const failure = await failureOf(provider(async () => response).stream(simpleRequest));
    expect((failure as Error).message).toMatch(/refusal/);
  });

  it("turns an in-stream overload into a transient error the retry layer can act on", async () => {
    const response = events([
      "error",
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ]);
    const failure = await failureOf(provider(async () => response).stream(simpleRequest));
    expect(failure).toBeInstanceOf(AnthropicApiError);
    expect(failure).toMatchObject({ transient: true, errorType: "overloaded_error" });
    expect((failure as Error).message).toBe(
      "anthropic stream failed: overloaded_error: Overloaded",
    );
  });

  it("keeps invalid_request errors non-transient", async () => {
    const response = events([
      "error",
      { type: "error", error: { type: "invalid_request_error", message: "bad" } },
    ]);
    const failure = await failureOf(provider(async () => response).stream(simpleRequest));
    expect(failure).toMatchObject({ transient: false });
  });

  it("never lets the key into an HTTP failure, even when the server echoes the header name", async () => {
    const fetchFn: FetchLike = async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        { status: 401, headers: { "retry-after": "3" } },
      );
    const failure = await failureOf(provider(fetchFn).stream(simpleRequest));

    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect(failure).toMatchObject({ status: 401, retryAfter: "3" });
    expect(String(failure)).not.toContain(secretKey);
    expect(JSON.stringify(failure)).not.toContain(secretKey);
    expect((failure as Error).stack ?? "").not.toContain(secretKey);
  });

  it("replays only the current turn's owned thinking and drops another model's", async () => {
    const owner = { provider: "anthropic", model: "claude-test" };
    const foreign = { provider: "codex", model: "gpt-x" };
    const ownedBlock = JSON.stringify({ type: "thinking", thinking: "", signature: "s1" });
    const history: Message[] = [
      textMessage("user", "earlier"),
      {
        role: "assistant",
        parts: [
          {
            type: "redacted-thinking",
            data: JSON.stringify({ type: "thinking", thinking: "", signature: "old" }),
            owner,
          },
          { type: "text", text: "earlier answer" },
        ],
      },
      textMessage("user", "now"),
      {
        role: "assistant",
        parts: [
          { type: "redacted-thinking", data: ownedBlock, owner },
          { type: "redacted-thinking", data: '{"type":"reasoning"}', owner: foreign },
          { type: "tool-call", callId: "toolu_9", name: "bash", arguments: { command: "pwd" } },
        ],
      },
      {
        role: "tool",
        parts: [{ type: "tool-result", callId: "toolu_9", output: "/src", isError: false }],
      },
    ];
    let sent: RequestInit | undefined;
    const fetchFn: FetchLike = async (_url, init) => {
      sent = init;
      return events(messageDelta("end_turn", { output_tokens: 1 }), messageStop);
    };
    await collect(provider(fetchFn).stream({ systemPrompt: "", messages: history, tools: [] }));

    expect(JSON.parse(sent?.body as string).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
      { role: "user", content: [{ type: "text", text: "now" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "s1" },
          { type: "tool_use", id: "toolu_9", name: "bash", input: { command: "pwd" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "/src" }],
      },
    ]);
  });
});

describe("anthropicHeaders", () => {
  it("pins the protocol version and adds the key only when one exists", () => {
    expect(anthropicHeaders(undefined)).toEqual({ "anthropic-version": anthropicVersion });
    expect(anthropicHeaders("k")).toEqual({
      "anthropic-version": anthropicVersion,
      "x-api-key": "k",
    });
  });
});
