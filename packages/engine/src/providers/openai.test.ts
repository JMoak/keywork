import { describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import type { ProviderRequest, TurnDelta } from "../provider.ts";
import {
  ProviderEmptyResponseError,
  ProviderEmptyStreamError,
  ProviderHttpError,
  ProviderStreamError,
} from "./errors.ts";
import { OpenAiCompatibleProvider } from "./openai.ts";
import { RetryingProvider } from "./retry.ts";
import { rawSseResponse, sseResponse } from "./stream-fixtures.ts";
import type { FetchLike } from "./transport.ts";

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

const stoppedChunk = '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}';

function stoppedStream(): Response {
  return sseResponse([stoppedChunk, "[DONE]"]);
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
      return stoppedStream();
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

  it("fails with a typed transient error when the response has no body", async () => {
    const bodiless = provider(async () => new Response(null, { status: 200 }));

    await expect(collect(bodiless.stream(emptyRequest))).rejects.toThrow(
      ProviderEmptyResponseError,
    );
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

  it("merges registration body decorations into the request without touching the defaults", async () => {
    const bodies: string[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(init?.body as string);
      return stoppedStream();
    };
    await collect(provider(fetchFn).stream(emptyRequest));
    const decorated = new OpenAiCompatibleProvider({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "key",
      model: "some/model",
      extraBody: { usage: { include: true } },
      fetchFn,
    });
    await collect(decorated.stream(emptyRequest));

    expect(JSON.parse(bodies[0] as string).usage).toBeUndefined();
    expect(JSON.parse(bodies[1] as string)).toMatchObject({
      model: "some/model",
      usage: { include: true },
    });
  });

  it("sends a bearer header for an api key and no authorization at all without one", async () => {
    const headers: Record<string, string>[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      headers.push(init?.headers as Record<string, string>);
      return stoppedStream();
    };
    await collect(provider(fetchFn).stream(emptyRequest));
    const local = new OpenAiCompatibleProvider({
      name: "ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3",
      fetchFn,
    });
    await collect(local.stream(emptyRequest));

    expect(headers[0]?.authorization).toBe("Bearer key");
    expect(headers[1]).not.toHaveProperty("authorization");
  });

  it("exposes the configured model id for cost accounting", () => {
    expect(provider(async () => stoppedStream()).modelId).toBe("test-model");
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

  it("keeps the account id out of a surfaced provider rejection", async () => {
    const body =
      '{"error":{"message":"This model is unavailable for free.","code":404},"user_id":"user_2fAkE0000iD0000fAkE0000xx"}';
    const rejecting = provider(async () => new Response(body, { status: 404 }));

    const failure = await collect(rejecting.stream(emptyRequest)).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect((failure as Error).message).toBe(
      'test request failed (404): {"error":{"message":"This model is unavailable for free.","code":404},"user_id":"[redacted]"}',
    );
  });
});

const zeroUsage = { inputTokens: 0, outputTokens: 0 };

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] });
}

function streamOf(lines: readonly string[]): Promise<TurnDelta[]> {
  return collect(provider(async () => sseResponse(lines)).stream(emptyRequest));
}

describe("OpenAiCompatibleProvider reasoning", () => {
  it("streams OpenRouter reasoning as visible thinking without doubling its reasoning_details", async () => {
    const detail = (text: string) => [
      { type: "reasoning.text", text, format: "unknown", index: 0 },
    ];
    const deltas = await streamOf([
      chunk({
        role: "assistant",
        content: "",
        reasoning: "221 = 13",
        reasoning_details: detail("221 = 13"),
      }),
      chunk({
        role: "assistant",
        content: "",
        reasoning: " × 17.",
        reasoning_details: detail(" × 17."),
      }),
      chunk({ role: "assistant", content: "Not prime." }),
      chunk({ role: "assistant", content: "", reasoning: null }, "stop"),
      "[DONE]",
    ]);

    expect(deltas).toEqual([
      { type: "visible-thinking", text: "221 = 13" },
      { type: "visible-thinking", text: " × 17." },
      { type: "text", text: "Not prime." },
      { type: "done", usage: zeroUsage },
    ]);
  });

  it("streams reasoning_content from DeepSeek, vLLM, and llama.cpp style servers", async () => {
    const deltas = await streamOf([
      chunk({ role: "assistant", reasoning_content: "Multiply first." }),
      chunk({ content: "391" }, "stop"),
      "[DONE]",
    ]);

    expect(deltas).toEqual([
      { type: "visible-thinking", text: "Multiply first." },
      { type: "text", text: "391" },
      { type: "done", usage: zeroUsage },
    ]);
  });

  it("shows reasoning once when a server sends it under both names", async () => {
    const deltas = await streamOf([
      chunk({ reasoning: "Same words.", reasoning_content: "Same words." }),
      chunk({ content: "ok" }, "stop"),
    ]);

    expect(deltas.filter((delta) => delta.type === "visible-thinking")).toEqual([
      { type: "visible-thinking", text: "Same words." },
    ]);
  });

  it("leaves encrypted reasoning_details alone", async () => {
    const encrypted = [{ type: "reasoning.encrypted", data: "opaque==", index: 0 }];
    const deltas = await streamOf([
      chunk({ reasoning_details: encrypted }),
      chunk({ content: "ok" }, "stop"),
    ]);

    expect(deltas).toEqual([
      { type: "text", text: "ok" },
      { type: "done", usage: zeroUsage },
    ]);
  });
});

describe("OpenAiCompatibleProvider empty streams", () => {
  it("fails a stream that ends with nothing produced and no finish reason", async () => {
    const failure = await streamOf([chunk({ role: "assistant" }), "[DONE]"]).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ProviderEmptyStreamError);
    expect(failure).toBeInstanceOf(ProviderStreamError);
    expect(failure).toMatchObject({
      transient: true,
      message: "test stream failed: ended with no reply and no finish reason",
    });
  });

  it("fails a stream that only ever sent keepalive comments", async () => {
    const keepalive = provider(async () => rawSseResponse(": OPENROUTER PROCESSING\n\n"));

    await expect(collect(keepalive.stream(emptyRequest))).rejects.toThrow(ProviderEmptyStreamError);
  });

  it("fails a stream that reasoned and then dropped without a reply or finish reason", async () => {
    const reasoned = provider(async () => sseResponse([chunk({ reasoning: "Let me think." })]));

    await expect(collect(reasoned.stream(emptyRequest))).rejects.toThrow(ProviderEmptyStreamError);
  });

  it("completes a legitimately empty reply that carries a finish reason", async () => {
    const deltas = await streamOf([chunk({ role: "assistant", content: "" }, "stop"), "[DONE]"]);

    expect(deltas).toEqual([{ type: "done", usage: zeroUsage }]);
  });

  it("completes a stream that reported usage without a finish reason", async () => {
    const deltas = await streamOf([
      '{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":0}}',
      "[DONE]",
    ]);

    expect(deltas).toEqual([{ type: "done", usage: { inputTokens: 5, outputTokens: 0 } }]);
  });

  it("retries an empty stream when nothing reached the caller yet", async () => {
    let attempts = 0;
    const flaky = new RetryingProvider(
      provider(async () => {
        attempts += 1;
        return attempts === 1
          ? sseResponse(["[DONE]"])
          : sseResponse([chunk({ content: "hi" }, "stop")]);
      }),
      { sleep: async () => {} },
    );

    expect(await collect(flaky.stream(emptyRequest))).toEqual([
      { type: "text", text: "hi" },
      { type: "done", usage: zeroUsage },
    ]);
    expect(attempts).toBe(2);
  });
});
