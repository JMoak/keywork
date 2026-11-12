import { describe, expect, it } from "vitest";
import { withDeclaredCapabilities } from "../capabilities.ts";
import {
  type Provider,
  type ProviderRequest,
  ProviderRequestControlError,
  type ProviderResponseReceipt,
  type TurnDelta,
} from "../provider.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock/bedrock.ts";
import { OpenAiCompatibleProvider } from "./openai.ts";
import { OpenAiResponsesProvider } from "./openai-responses.ts";
import { RetryingProvider } from "./retry.ts";
import { sseResponse } from "./stream-fixtures.ts";
import type { FetchLike } from "./transport.ts";

const request: ProviderRequest = {
  systemPrompt: "Purpose and criteria",
  messages: [{ role: "user", parts: [{ type: "text", text: "Inspect this artifact" }] }],
  tools: [],
  maxOutputTokens: 800,
  retry: "never",
  openRouterRouting: { only: ["openai"], maxPrice: { prompt: 3, completion: 10, request: 0 } },
};

function router(fetchFn: FetchLike, extraBody: Readonly<Record<string, unknown>> = {}) {
  return new OpenAiCompatibleProvider({
    name: "my-router",
    model: "openai/gpt-4.1",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "private-key",
    fetchFn,
    extraBody,
  });
}

async function collect(provider: Provider, input: ProviderRequest = request) {
  const deltas: TurnDelta[] = [];
  for await (const delta of provider.stream(input)) deltas.push(delta);
  return deltas;
}

const stopped = { delta: {}, finish_reason: "stop" };

function stoppedStream(): Response {
  return sseResponse([JSON.stringify({ choices: [stopped] }), "[DONE]"]);
}

describe("bounded provider dispatch", () => {
  it("pins the model, caps output, strengthens existing routing, and disables redirects", async () => {
    let sent: RequestInit | undefined;
    const provider = router(
      async (_url, init) => {
        sent = init;
        return stoppedStream();
      },
      {
        max_tokens: 400,
        max_completion_tokens: 5000,
        provider: {
          only: ["openai", "azure"],
          max_price: { prompt: 2 },
          zdr: true,
          allow_fallbacks: true,
        },
      },
    );
    await collect(withDeclaredCapabilities(new RetryingProvider(provider)));
    expect(sent?.redirect).toBe("error");
    expect(JSON.parse(String(sent?.body))).toMatchObject({
      model: "openai/gpt-4.1",
      max_tokens: 400,
      provider: {
        only: ["openai"],
        max_price: { prompt: 2, completion: 10, request: 0 },
        zdr: true,
        allow_fallbacks: false,
        require_parameters: true,
      },
    });
    expect(JSON.parse(String(sent?.body))).not.toHaveProperty("max_completion_tokens");
    expect(withDeclaredCapabilities(new RetryingProvider(provider)).requestSupport).toEqual({
      maxOutputTokens: true,
      singleAttempt: true,
      openRouterRouting: true,
    });
  });

  it("never retries a failed bounded HTTP request", async () => {
    let calls = 0;
    const updates: ProviderResponseReceipt[] = [];
    const provider = new RetryingProvider(
      router(async () => {
        calls++;
        return new Response("busy", { status: 503, headers: { "x-request-id": "failed-http" } });
      }),
      {
        sleep: async () => {
          throw new Error("must not sleep");
        },
      },
    );
    await expect(
      collect(provider, { ...request, onResponse: (receipt) => updates.push(receipt) }),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(1);
    expect(updates).toEqual([
      { requestedModel: "openai/gpt-4.1", requestId: "failed-http", usageReported: false },
    ]);
  });

  it.each([0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid output cap %s before dispatch",
    async (cap) => {
      let called = false;
      const provider = router(async () => {
        called = true;
        return stoppedStream();
      });
      await expect(collect(provider, { ...request, maxOutputTokens: cap })).rejects.toBeInstanceOf(
        ProviderRequestControlError,
      );
      expect(called).toBe(false);
    },
  );

  it.each([
    "models",
    "plugins",
    "messages",
    "tools",
    "preset",
    "route",
    "input",
    "response_format",
    "stop",
  ])("rejects a hidden %s decoration before dispatch", async (field) => {
    let called = false;
    const provider = router(
      async () => {
        called = true;
        return stoppedStream();
      },
      { [field]: [] },
    );
    await expect(collect(provider)).rejects.toThrow(/not admitted/);
    expect(called).toBe(false);
  });

  it("refuses disjoint configured provider restrictions instead of broadening them", async () => {
    const provider = router(
      async () => {
        throw new Error("must not dispatch");
      },
      { provider: { only: ["azure"] } },
    );
    await expect(collect(provider)).rejects.toThrow(/no provider satisfies/);
  });

  it("preserves reasoning effort under the combined cap and excludes unquoted service tiers", async () => {
    let body: unknown;
    const provider = router(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return stoppedStream();
    });
    await collect(provider, {
      ...request,
      effort: "high",
      openRouterRouting: {
        only: ["openai"],
        maxPrice: { prompt: 3, completion: 10, request: 0 },
        ignore: ["openai/flex", "openai/fast"],
      },
    });
    expect(body).toMatchObject({
      max_tokens: 800,
      reasoning: { effort: "high" },
      provider: { ignore: ["openai/flex", "openai/fast"] },
    });
    const unquoted = router(
      async () => {
        throw new Error("must not dispatch");
      },
      { reasoning: { mode: "pro" } },
    );
    await expect(collect(unquoted)).rejects.toThrow(/unadmitted billing/);
  });

  it("requires the complete bounded policy and rejects dynamic model aliases", async () => {
    const provider = router(async () => {
      throw new Error("must not dispatch");
    });
    await expect(
      collect(provider, { systemPrompt: "", messages: [], tools: [], maxOutputTokens: 1 }),
    ).rejects.toThrow(/require maxOutputTokens/);
    const alias = new OpenAiCompatibleProvider({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openrouter/auto",
      fetchFn: async () => {
        throw new Error("must not dispatch");
      },
    });
    await expect(collect(alias)).rejects.toThrow(/specific model/);
  });

  it("does not trust a provider name or a lookalike endpoint", async () => {
    const provider = new OpenAiCompatibleProvider({
      name: "openrouter",
      baseUrl: "https://openrouter.ai.example.test/api/v1",
      model: "m",
      fetchFn: async () => {
        throw new Error("must not dispatch");
      },
    });
    expect(provider.requestSupport).toBeUndefined();
    await expect(collect(provider)).rejects.toThrow(/not supported/);
  });

  it("rejects unsupported direct transports before their network or credential work", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("must not dispatch");
    };
    const providers: Provider[] = [
      new AnthropicProvider({
        name: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-test",
        fetchFn,
      }),
      new OpenAiResponsesProvider({
        name: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-test",
        authHeaders: async () => {
          throw new Error("must not authenticate");
        },
        fetchFn,
      }),
      new BedrockProvider({
        region: "us-east-1",
        model: "m",
        credentials: { accessKeyId: "key", secretAccessKey: "secret" },
        fetchFn,
      }),
    ];
    for (const provider of providers)
      await expect(collect(provider)).rejects.toBeInstanceOf(ProviderRequestControlError);
  });
});

describe("bounded response receipts", () => {
  it("captures actual identity, explicit zero usage, finish reason, and a reported charge", async () => {
    const updates: ProviderResponseReceipt[] = [];
    const provider = router(async () => {
      const response = sseResponse([
        JSON.stringify({
          id: "gen-1",
          model: "openai/gpt-4.1-2025-04-14",
          provider: "OpenAI",
          choices: [{ delta: { content: "ok" } }],
        }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 },
        }),
        "[DONE]",
      ]);
      response.headers.set("x-request-id", "http-1");
      return response;
    });
    const deltas = await collect(provider, {
      ...request,
      onResponse: (receipt) => updates.push(receipt),
    });
    expect(updates[0]).toMatchObject({ requestId: "http-1", usageReported: false });
    expect(deltas.at(-1)).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      receipt: {
        usageReported: true,
        requestId: "http-1",
        responseId: "gen-1",
        requestedModel: "openai/gpt-4.1",
        servedModel: "openai/gpt-4.1-2025-04-14",
        servedProvider: "OpenAI",
        finishReason: "stop",
      },
    });
    expect(JSON.stringify(updates)).not.toContain("private-key");
  });

  it.each([
    null,
    {},
    { completion_tokens: 0 },
    { prompt_tokens: -1, completion_tokens: 1 },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 11 } },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: -1 } },
  ])("keeps missing or partial usage unresolved: %j", async (usage) => {
    const deltas = await collect(
      router(async () => sseResponse([JSON.stringify({ usage, choices: [stopped] }), "[DONE]"])),
    );
    expect(deltas.at(-1)).toMatchObject({ receipt: { usageReported: false } });
  });

  it("reports generation identity before a later interrupted stream", async () => {
    const updates: ProviderResponseReceipt[] = [];
    const provider = router(async () =>
      sseResponse([
        JSON.stringify({ id: "gen-lost", model: "served", provider: "OpenAI", choices: [] }),
        JSON.stringify({ error: { message: "lost connection" } }),
      ]),
    );
    await expect(
      collect(provider, { ...request, onResponse: (receipt) => updates.push(receipt) }),
    ).rejects.toThrow(/lost connection/);
    expect(updates.at(-1)).toMatchObject({ responseId: "gen-lost", usageReported: false });
  });

  it("separates cache writes without adding reasoning tokens to billed output twice", async () => {
    const deltas = await collect(
      router(async () =>
        sseResponse([
          JSON.stringify({
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 30 },
              completion_tokens_details: { reasoning_tokens: 15 },
              cost: 0.02,
            },
          }),
          "[DONE]",
        ]),
      ),
    );
    expect(deltas.at(-1)).toMatchObject({
      usage: {
        inputTokens: 30,
        outputTokens: 20,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 30,
        costUsd: 0.02,
      },
      receipt: { usageReported: true },
    });
  });
});
