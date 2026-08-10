import { describe, expect, it } from "vitest";
import { textMessage } from "../../messages.ts";
import type { ProviderRequest, TurnDelta } from "../../provider.ts";
import { type FetchLike, ProviderHttpError, ProviderStreamError } from "../openai.ts";
import { BedrockExceptionError, BedrockProvider } from "./bedrock.ts";
import { chunkedStream, concatBytes, eventFrame, exceptionFrame } from "./frame-fixtures.ts";

const fixedNow = new Date("2025-01-02T03:04:05Z");

function provider(fetchFn: FetchLike, model = "amazon.nova-lite-v1:0"): BedrockProvider {
  return new BedrockProvider({
    region: "us-east-1",
    model,
    credentials: { accessKeyId: "id", secretAccessKey: "secret" },
    fetchFn,
    clock: () => fixedNow,
  });
}

function frameResponse(frames: Uint8Array[], chunkSize = 7): Response {
  return new Response(chunkedStream(concatBytes(...frames), chunkSize), { status: 200 });
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

describe("BedrockProvider", () => {
  it("reassembles text, tool use split across many deltas, and usage", async () => {
    const inputPieces = ['{"comm', "and", '":"echo', ' hi"}'];
    const frames = [
      eventFrame("messageStart", { role: "assistant" }),
      eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hel" } }),
      eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "lo" } }),
      eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
      eventFrame("contentBlockStart", {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: "t1", name: "bash" } },
      }),
      ...inputPieces.map((input) =>
        eventFrame("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input } } }),
      ),
      eventFrame("contentBlockStop", { contentBlockIndex: 1 }),
      eventFrame("messageStop", { stopReason: "tool_use" }),
      eventFrame("metadata", { usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 } }),
    ];
    const deltas = await collect(provider(async () => frameResponse(frames)).stream(emptyRequest));

    expect(deltas).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      {
        type: "tool-call",
        call: { type: "tool-call", callId: "t1", name: "bash", arguments: { command: "echo hi" } },
      },
      { type: "done", usage: { inputTokens: 7, outputTokens: 9 } },
    ]);
  });

  it("sends the neutral conversation in Converse wire shape to the signed regional endpoint", async () => {
    let sentUrl: string | undefined;
    let sentBody: string | undefined;
    let sentHeaders: Record<string, string> | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      sentUrl = url;
      sentBody = init?.body as string;
      sentHeaders = init?.headers as Record<string, string>;
      return frameResponse([eventFrame("messageStop", { stopReason: "end_turn" })]);
    };
    const request: ProviderRequest = {
      systemPrompt: "be brief",
      messages: [
        textMessage("user", "list files"),
        {
          role: "assistant",
          parts: [
            { type: "thinking", thinking: "quietly", signature: "sig" },
            { type: "tool-call", callId: "t1", name: "bash", arguments: { command: "ls" } },
          ],
        },
        {
          role: "tool",
          parts: [{ type: "tool-result", callId: "t1", output: "a.txt", isError: true }],
        },
        {
          role: "user",
          parts: [
            { type: "text", text: "see" },
            { type: "image", mediaType: "image/png", data: "aGk=" },
          ],
        },
      ],
      tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
    };

    await collect(provider(fetchFn).stream(request));

    expect(sentUrl).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse-stream",
    );
    expect(JSON.parse(sentBody as string)).toEqual({
      system: [{ text: "be brief" }],
      messages: [
        { role: "user", content: [{ text: "list files" }] },
        {
          role: "assistant",
          content: [{ toolUse: { toolUseId: "t1", name: "bash", input: { command: "ls" } } }],
        },
        {
          role: "user",
          content: [
            { toolResult: { toolUseId: "t1", content: [{ text: "a.txt" }], status: "error" } },
          ],
        },
        {
          role: "user",
          content: [{ text: "see" }, { image: { format: "png", source: { bytes: "aGk=" } } }],
        },
      ],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "bash",
              description: "run",
              inputSchema: { json: { type: "object" } },
            },
          },
        ],
      },
    });
    expect(sentHeaders?.["x-amz-date"]).toBe("20250102T030405Z");
    expect(sentHeaders?.authorization).toContain(
      "Credential=id/20250102/us-east-1/bedrock/aws4_request",
    );
    expect(sentHeaders?.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it("folds system-role messages into the Converse system blocks", async () => {
    let sentBody: string | undefined;
    const fetchFn: FetchLike = async (_url, init) => {
      sentBody = init?.body as string;
      return frameResponse([]);
    };
    const request: ProviderRequest = {
      systemPrompt: "",
      messages: [textMessage("system", "obey"), textMessage("user", "hi")],
      tools: [],
    };

    await collect(provider(fetchFn).stream(request));

    expect(JSON.parse(sentBody as string)).toEqual({
      system: [{ text: "obey" }],
      messages: [{ role: "user", content: [{ text: "hi" }] }],
    });
  });

  it("surfaces HTTP failures with status and body", async () => {
    const failing = provider(async () => new Response("denied", { status: 403 }));

    await expect(collect(failing.stream(emptyRequest))).rejects.toThrow(ProviderHttpError);
    await expect(collect(failing.stream(emptyRequest))).rejects.toThrow(/403.*denied/s);
  });

  it("classifies a mid-stream throttlingException as transient", async () => {
    const frames = [
      eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "partial" } }),
      exceptionFrame("throttlingException", "slow down"),
    ];
    const throttled = provider(async () => frameResponse(frames));

    const failure = await collect(throttled.stream(emptyRequest)).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(BedrockExceptionError);
    expect(failure).toMatchObject({ transient: true, exceptionType: "throttlingException" });
    expect((failure as Error).message).toMatch(/slow down/);
  });

  it("classifies a validationException as non-transient", async () => {
    const frames = [exceptionFrame("validationException", "bad input")];
    const failure = await collect(
      provider(async () => frameResponse(frames)).stream(emptyRequest),
    ).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ transient: false, exceptionType: "validationException" });
  });

  it("drops usage already received when the stream ends in an exception", async () => {
    const frames = [
      eventFrame("metadata", { usage: { inputTokens: 7, outputTokens: 9 } }),
      exceptionFrame("modelStreamErrorException", "stream broke"),
    ];

    await expect(
      collect(provider(async () => frameResponse(frames)).stream(emptyRequest)),
    ).rejects.toThrow(BedrockExceptionError);
  });

  it("fails the turn on a corrupted frame mid-stream", async () => {
    const good = eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hi" } });
    const corrupted = eventFrame("messageStop", { stopReason: "end_turn" });
    corrupted[13] = (corrupted[13] ?? 0) ^ 0xff;

    await expect(
      collect(provider(async () => frameResponse([good, corrupted])).stream(emptyRequest)),
    ).rejects.toThrow(ProviderStreamError);
  });

  it("completes an empty turn with zero usage", async () => {
    const frames = [
      eventFrame("messageStart", { role: "assistant" }),
      eventFrame("messageStop", { stopReason: "end_turn" }),
    ];
    const deltas = await collect(provider(async () => frameResponse(frames)).stream(emptyRequest));

    expect(deltas).toEqual([{ type: "done", usage: { inputTokens: 0, outputTokens: 0 } }]);
  });

  it("keeps unparseable tool-use input as raw text for the model to see", async () => {
    const frames = [
      eventFrame("contentBlockStart", {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: "t1", name: "bash" } },
      }),
      eventFrame("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { toolUse: { input: "{broken" } },
      }),
    ];
    const deltas = await collect(provider(async () => frameResponse(frames)).stream(emptyRequest));

    expect(deltas[0]).toMatchObject({ call: { arguments: "{broken" } });
  });

  it("synthesizes a stable callId when the stream never provides one", async () => {
    const frames = [
      eventFrame("contentBlockStart", {
        contentBlockIndex: 2,
        start: { toolUse: { name: "bash" } },
      }),
    ];
    const deltas = await collect(provider(async () => frameResponse(frames)).stream(emptyRequest));

    expect(deltas[0]).toMatchObject({ call: { callId: "call_2", name: "bash", arguments: {} } });
  });

  it("fails the turn when accumulated tool-use input exceeds the size ceiling", async () => {
    const piece = "x".repeat(400_000);
    const frames = [
      eventFrame("contentBlockStart", {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: "t1", name: "bash" } },
      }),
      ...[piece, piece, piece].map((input) =>
        eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input } } }),
      ),
    ];
    const oversized = provider(async () => frameResponse(frames, 65_536));

    await expect(collect(oversized.stream(emptyRequest))).rejects.toThrow(/size ceiling/);
  });

  it("stops mid-stream when the request is aborted", async () => {
    const controller = new AbortController();
    const fetchFn: FetchLike = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(
            eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "first" } }),
          );
          init?.signal?.addEventListener("abort", () => {
            streamController.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(body, { status: 200 });
    };
    const request: ProviderRequest = { ...emptyRequest, signal: controller.signal };

    const seen: TurnDelta[] = [];
    const failure = await (async () => {
      try {
        for await (const delta of provider(fetchFn).stream(request)) {
          seen.push(delta);
          controller.abort();
        }
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();

    expect(seen).toEqual([{ type: "text", text: "first" }]);
    expect((failure as DOMException).name).toBe("AbortError");
  });

  it("rejects a region that does not look like an AWS region", () => {
    expect(
      () =>
        new BedrockProvider({
          region: "evil.example.com",
          model: "amazon.nova-lite-v1:0",
          credentials: { accessKeyId: "id", secretAccessKey: "secret" },
        }),
    ).toThrow(/region must look like/);
  });
});
