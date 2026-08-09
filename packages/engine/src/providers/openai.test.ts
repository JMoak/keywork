import { describe, expect, it } from "vitest";
import { textMessage } from "../messages.ts";
import type { ProviderRequest, TurnDelta } from "../provider.ts";
import { type FetchLike, OpenAiCompatibleProvider, ProviderHttpError } from "./openai.ts";

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
});
