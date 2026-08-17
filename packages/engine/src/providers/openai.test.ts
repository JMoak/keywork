import { describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import type { ProviderRequest, TurnDelta } from "../provider.ts";
import {
  type FetchLike,
  OpenAiCompatibleProvider,
  ProviderHttpError,
  ProviderStreamError,
} from "./openai.ts";

function sseResponse(lines: string[], chunkSize = 7): Response {
  return rawSseResponse(lines.map((line) => `data: ${line}\n\n`).join(""), chunkSize);
}

function rawSseResponse(raw: string, chunkSize = 7): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < raw.length; at += chunkSize) {
        controller.enqueue(encoder.encode(raw.slice(at, at + chunkSize)));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function provider(fetchFn: FetchLike): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    name: "test",
    baseUrl: "https://example.test/v1",
    apiKey: "key",
    model: "test-model",
    fetchFn,
  });
}

const emptyRequest: ProviderRequest = {
  systemPrompt: "sys",
  messages: [textMessage("user", "hi")],
  tools: [],
};

async function collect(iterable: AsyncIterable<TurnDelta>): Promise<TurnDelta[]> {
  const deltas: TurnDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

describe("OpenAiCompatibleProvider", () => {
  it("reassembles text, fragmented tool calls, and usage from a chunked stream", async () => {
    const lines = [
      '{"choices":[{"delta":{"content":"Hel"}}]}',
      '{"choices":[{"delta":{"content":"lo"}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":"{\\"comm"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"echo hi\\"}"}}]}}]}',
      '{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":9}}',
      "[DONE]",
    ];
    const deltas = await collect(provider(async () => sseResponse(lines)).stream(emptyRequest));

    expect(deltas).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      {
        type: "tool-call",
        call: {
          type: "tool-call",
          callId: "c1",
          name: "bash",
          arguments: { command: "echo hi" },
        },
      },
      { type: "done", usage: { inputTokens: 7, outputTokens: 9 } },
    ]);
  });

  it("sends the neutral conversation in OpenAI wire shape", async () => {
    let sentBody: string | undefined;
    const fetchFn: FetchLike = async (_url, init) => {
      sentBody = init?.body as string;
      return sseResponse(["[DONE]"]);
    };
    const request: ProviderRequest = {
      systemPrompt: "be brief",
      messages: [
        textMessage("user", "list files"),
        {
          role: "assistant",
          parts: [{ type: "tool-call", callId: "c1", name: "bash", arguments: { command: "ls" } }],
        },
        {
          role: "tool",
          parts: [{ type: "tool-result", callId: "c1", output: "a.txt", isError: false }],
        },
      ],
      tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
    };

    await collect(provider(fetchFn).stream(request));

    const body = JSON.parse(sentBody as string);
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "list files" },
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "bash", description: "run", parameters: { type: "object" } },
      },
    ]);
  });

  it("surfaces HTTP failures with status and body", async () => {
    const failing = provider(async () => new Response("quota exceeded", { status: 429 }));

    await expect(collect(failing.stream(emptyRequest))).rejects.toThrow(ProviderHttpError);
    await expect(collect(failing.stream(emptyRequest))).rejects.toThrow(/429.*quota exceeded/s);
  });

  it("keeps unparseable tool arguments as raw text for the model to see", async () => {
    const lines = [
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":"{broken"}}]}}]}',
      "[DONE]",
    ];
    const deltas = await collect(provider(async () => sseResponse(lines)).stream(emptyRequest));

    expect(deltas[0]).toMatchObject({ call: { arguments: "{broken" } });
  });

  it("fails the turn when the stream carries a mid-stream error event", async () => {
    const lines = [
      '{"choices":[{"delta":{"content":"partial"}}]}',
      '{"error":{"message":"model overloaded"}}',
    ];
    const streaming = provider(async () => sseResponse(lines));

    await expect(collect(streaming.stream(emptyRequest))).rejects.toThrow(ProviderStreamError);
    await expect(collect(streaming.stream(emptyRequest))).rejects.toThrow(/model overloaded/);
  });

  it("skips keepalives, comments, and malformed lines without dropping real events", async () => {
    const raw = [
      ": keep-alive",
      "data:",
      "data: {broken json",
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      "data: [DONE]",
    ]
      .map((line) => `${line}\n\n`)
      .join("");
    const deltas = await collect(provider(async () => rawSseResponse(raw)).stream(emptyRequest));

    expect(deltas).toEqual([
      { type: "text", text: "hi" },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("keeps a final event that arrives without a trailing newline", async () => {
    const raw =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":9}}';
    const deltas = await collect(provider(async () => rawSseResponse(raw)).stream(emptyRequest));

    expect(deltas).toEqual([
      { type: "text", text: "hi" },
      { type: "done", usage: { inputTokens: 7, outputTokens: 9 } },
    ]);
  });

  it("synthesizes a stable callId when the stream never provides one", async () => {
    const lines = [
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bash","arguments":"{}"}}]}}]}',
      "[DONE]",
    ];
    const deltas = await collect(provider(async () => sseResponse(lines)).stream(emptyRequest));

    expect(deltas[0]).toMatchObject({ call: { callId: "call_0", name: "bash" } });
  });

  it("sets the tool name once even when duplicate-index fragments repeat it", async () => {
    const lines = [
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":"{\\"a\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":"1}"}}]}}]}',
      "[DONE]",
    ];
    const deltas = await collect(provider(async () => sseResponse(lines)).stream(emptyRequest));

    expect(deltas[0]).toMatchObject({
      call: { callId: "c1", name: "bash", arguments: { a: 1 } },
    });
  });

  it("fails the turn when the stream buffer exceeds the size ceiling", async () => {
    const endless = `data: {"choices":[${"x".repeat(1_100_000)}`;
    const streaming = provider(async () => rawSseResponse(endless, 65_536));

    await expect(collect(streaming.stream(emptyRequest))).rejects.toThrow(ProviderStreamError);
    await expect(collect(streaming.stream(emptyRequest))).rejects.toThrow(/size ceiling/);
  });

  it("splits cached prompt tokens out and captures a metered cost when reported", async () => {
    const lines = [
      '{"choices":[{"delta":{"content":"hi"}}]}',
      '{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":60},"cost":0.00123}}',
      "[DONE]",
    ];
    const deltas = await collect(provider(async () => sseResponse(lines)).stream(emptyRequest));

    expect(deltas.at(-1)).toEqual({
      type: "done",
      usage: {
        inputTokens: 40,
        outputTokens: 9,
        cacheReadInputTokens: 60,
        costUsd: 0.00123,
      },
    });
  });

  it("opts into cost accounting only on openrouter.ai, never on other hosts", async () => {
    const bodies: string[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(init?.body as string);
      return sseResponse(["[DONE]"]);
    };
    await collect(provider(fetchFn).stream(emptyRequest));
    const openrouter = new OpenAiCompatibleProvider({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "key",
      model: "some/model",
      fetchFn,
    });
    await collect(openrouter.stream(emptyRequest));

    expect(JSON.parse(bodies[0] as string).usage).toBeUndefined();
    expect(JSON.parse(bodies[1] as string).usage).toEqual({ include: true });
  });

  it("exposes the configured model id for cost accounting", () => {
    expect(provider(async () => sseResponse(["[DONE]"])).modelId).toBe("test-model");
  });

  it("fails the turn when accumulated tool-call arguments exceed the size ceiling", async () => {
    const fragment = (piece: string) =>
      `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"arguments":"${piece}"}}]}}]}`;
    const lines = [
      fragment("x".repeat(400_000)),
      fragment("x".repeat(400_000)),
      fragment("x".repeat(400_000)),
    ];
    const streaming = provider(async () => sseResponse(lines, 65_536));

    await expect(collect(streaming.stream(emptyRequest))).rejects.toThrow(/size ceiling/);
  });
});
