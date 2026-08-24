import { describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import type { ProviderRequest, TurnDelta } from "../provider.ts";
import { ProviderEmptyResponseError, ProviderHttpError, ProviderStreamError } from "./errors.ts";
import { OpenAiResponsesProvider } from "./openai-responses.ts";
import { sseResponse } from "./stream-fixtures.ts";
import type { FetchLike } from "./transport.ts";

function provider(fetchFn: FetchLike, headers?: () => Promise<Record<string, string>>) {
  return new OpenAiResponsesProvider({
    name: "test",
    baseUrl: "https://example.test",
    model: "test-model",
    authHeaders: headers ?? (async () => ({ authorization: "Bearer token" })),
    fetchFn,
  });
}

const simpleRequest: ProviderRequest = {
  systemPrompt: "sys",
  messages: [textMessage("user", "hi")],
  tools: [],
};

async function collect(iterable: AsyncIterable<TurnDelta>): Promise<TurnDelta[]> {
  const deltas: TurnDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

describe("OpenAiResponsesProvider", () => {
  it("streams text deltas, completed items, and usage", async () => {
    const lines = [
      '{"type":"response.output_text.delta","delta":"Hel"}',
      '{"type":"response.output_text.delta","delta":"lo"}',
      '{"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","encrypted_content":"blob"}}',
      '{"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}',
      '{"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":9,"input_tokens_details":{"cached_tokens":3}}}}',
    ];
    const deltas = await collect(provider(async () => sseResponse(lines)).stream(simpleRequest));

    expect(deltas).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      {
        type: "redacted-thinking",
        part: {
          type: "redacted-thinking",
          data: '{"type":"reasoning","id":"rs_1","encrypted_content":"blob"}',
          owner: { provider: "test", model: "test-model" },
        },
      },
      {
        type: "tool-call",
        call: { type: "tool-call", callId: "c1", name: "bash", arguments: { command: "ls" } },
      },
      {
        type: "done",
        usage: { inputTokens: 7, outputTokens: 9, cacheReadInputTokens: 3 },
      },
    ]);
  });

  it("ignores reasoning items without encrypted content", async () => {
    const lines = [
      '{"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","summary":[]}}',
      '{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
    ];
    const deltas = await collect(provider(async () => sseResponse(lines)).stream(simpleRequest));
    expect(deltas).toEqual([{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }]);
  });

  it("streams a refusal as the model's text so the turn shows what it said", async () => {
    const lines = [
      '{"type":"response.refusal.delta","delta":"I can"}',
      '{"type":"response.refusal.delta","delta":"not help with that."}',
      '{"type":"response.refusal.done","refusal":"I cannot help with that."}',
      '{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
    ];
    const deltas = await collect(provider(async () => sseResponse(lines)).stream(simpleRequest));
    expect(deltas).toEqual([
      { type: "text", text: "I can" },
      { type: "text", text: "not help with that." },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  });

  it("fails the turn with the cut-off reason when the response is incomplete", async () => {
    const lines = [
      '{"type":"response.output_text.delta","delta":"partial"}',
      '{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":1,"output_tokens":9}}}',
    ];
    const seen: TurnDelta[] = [];
    const failure = await (async () => {
      try {
        for await (const delta of provider(async () => sseResponse(lines)).stream(simpleRequest)) {
          seen.push(delta);
        }
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();
    expect(seen).toEqual([{ type: "text", text: "partial" }]);
    expect(failure).toBeInstanceOf(ProviderStreamError);
    expect((failure as Error).message).toMatch(/cut off \(max_output_tokens\)/);
  });

  it("sends the request through the wire mapping with fresh auth headers", async () => {
    let sentUrl: string | undefined;
    let sentHeaders: Record<string, string> | undefined;
    let sentBody: string | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      sentUrl = url;
      sentHeaders = init?.headers as Record<string, string>;
      sentBody = init?.body as string;
      return sseResponse(['{"type":"response.completed","response":{"usage":{}}}']);
    };
    const headers = async () => ({
      authorization: "Bearer fresh",
      "chatgpt-account-id": "acct",
    });

    await collect(provider(fetchFn, headers).stream(simpleRequest));

    expect(sentUrl).toBe("https://example.test/responses");
    expect(sentHeaders).toMatchObject({
      authorization: "Bearer fresh",
      "chatgpt-account-id": "acct",
      accept: "text/event-stream",
    });
    expect(JSON.parse(sentBody ?? "{}")).toMatchObject({
      model: "test-model",
      store: false,
      stream: true,
      instructions: "sys",
    });
  });

  it("throws ProviderHttpError on a non-200 response", async () => {
    const failing = provider(async () => new Response("denied", { status: 401 }));
    await expect(collect(failing.stream(simpleRequest))).rejects.toThrow(ProviderHttpError);
  });

  it("fails with a typed transient error when the response has no body", async () => {
    const bodiless = provider(async () => new Response(null, { status: 200 }));
    await expect(collect(bodiless.stream(simpleRequest))).rejects.toThrow(
      ProviderEmptyResponseError,
    );
  });

  it("surfaces failed responses and error events as stream errors", async () => {
    const failed = [
      '{"type":"response.failed","response":{"error":{"message":"usage limit reached"}}}',
    ];
    await expect(
      collect(provider(async () => sseResponse(failed)).stream(simpleRequest)),
    ).rejects.toThrow(/usage limit reached/);

    const errored = ['{"type":"error","message":"stream broke"}'];
    await expect(
      collect(provider(async () => sseResponse(errored)).stream(simpleRequest)),
    ).rejects.toThrow(ProviderStreamError);
  });
});
