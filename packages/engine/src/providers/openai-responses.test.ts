import { describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import type { ProviderRequest, TurnDelta } from "../provider.ts";
import { ProviderHttpError, ProviderStreamError } from "./errors.ts";
import type { FetchLike } from "./openai.ts";
import { OpenAiResponsesProvider } from "./openai-responses.ts";

function sseResponse(lines: string[], chunkSize = 7): Response {
  const raw = lines.map((line) => `data: ${line}\n\n`).join("");
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
