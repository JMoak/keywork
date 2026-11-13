import { describe, expect, it } from "vitest";
import type { ProviderRequest } from "../provider.ts";
import {
  campaignRequestBound,
  estimatedCampaignMicros,
  OpenRouterQuoteCache,
  reportedCampaignMicros,
} from "./pricing.ts";

describe("campaign OpenRouter quote admission", () => {
  it("uses public endpoint rates, exact routing tags, and explicit units", async () => {
    let url: string | undefined;
    let init: RequestInit | undefined;
    const cache = new OpenRouterQuoteCache({
      now: () => 1000,
      fetchFn: async (target, options) => {
        url = target;
        init = options;
        return Response.json(metadata());
      },
    });
    const quote = await cache.quote("openai/gpt-4.1");
    expect(url).toBe("https://openrouter.ai/api/v1/models/openai/gpt-4.1/endpoints");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init?.headers).toBeUndefined();
    expect(quote).toMatchObject({
      modelId: "openai/gpt-4.1",
      providerTag: "openai",
      providerName: "OpenAI",
      quotedAt: 1000,
      expiresAt: 61000,
      ratesMicrosPerToken: { prompt: 2, completion: 8, cacheRead: 0.5, cacheWrite: 2 },
      requestMicros: 0,
      routing: { only: ["openai"], maxPrice: { prompt: 2, completion: 8, request: 0 } },
    });
    expect(quote.provenance.at(-1)).toContain("absent from metadata");
  });

  it("deduplicates lookups, refreshes expired data, and never uses stale metadata after failure", async () => {
    let now = 10;
    let calls = 0;
    const cache = new OpenRouterQuoteCache({
      now: () => now,
      ttlMs: 10,
      fetchFn: async () => {
        calls++;
        return calls === 1 ? Response.json(metadata()) : new Response(null, { status: 503 });
      },
    });
    await Promise.all([cache.quote("openai/gpt-4.1"), cache.quote("openai/gpt-4.1")]);
    expect(calls).toBe(1);
    await cache.quote("openai/gpt-4.1");
    now = 20;
    await expect(cache.quote("openai/gpt-4.1")).rejects.toThrow(/503/);
    expect(calls).toBe(2);
  });

  it.each([
    { internal_reasoning: "0.000001" },
    { input_cache_write_1h: "0.000003" },
    { unknown_fee: "0.01" },
    { overrides: [{ condition: "large context", prompt: "0.000005" }] },
    { prompt: "-1" },
    { completion: "1e-9999" },
    { input_cache_read: "NaN" },
  ])("rejects unknown, conditional, or unbounded rates: %j", async (pricing) => {
    const endpoint = endpointFixture();
    Object.assign(endpoint.pricing, pricing);
    await expect(quoteFor(metadata([endpoint]))).rejects.toThrow();
  });

  it("accounts for an explicit per-request fee and rejects unavailable caps", async () => {
    const endpoint = endpointFixture();
    Object.assign(endpoint.pricing, { request: "0.0002" });
    expect(await quoteFor(metadata([endpoint]))).toMatchObject({
      requestMicros: 200,
      routing: { maxPrice: { request: 0.0002 } },
    });
    endpoint.supported_parameters = ["max_completion_tokens"];
    await expect(quoteFor(metadata([endpoint]))).rejects.toThrow(/max_tokens/);
  });

  it("excludes sibling service tiers without changing the selected model", async () => {
    const endpoint = endpointFixture();
    endpoint.supported_parameters.push("reasoning");
    const quote = await quoteFor(
      metadata([endpoint, { ...endpointFixture(), tag: "openai/flex" }]),
    );
    expect(quote).toMatchObject({
      reasoningSupported: true,
      routing: { only: ["openai"], ignore: ["openai/flex"] },
    });
    let fetched = false;
    const cache = new OpenRouterQuoteCache({
      fetchFn: async () => {
        fetched = true;
        return Response.json(metadata());
      },
    });
    await expect(cache.quote("openrouter/auto")).rejects.toThrow(/contract/);
    expect(fetched).toBe(false);
  });

  it("admits current GPT reasoning models while bounding cache writes and excluding higher price tiers", async () => {
    const endpoint = endpointFixture();
    endpoint.model_id = "openai/gpt-6.1-terra";
    endpoint.supported_parameters.push("reasoning");
    Object.assign(endpoint.pricing, {
      input_cache_write: "0.0000025",
      overrides: [
        {
          min_prompt_tokens: 50_000,
          prompt: "0.000004",
          completion: "0.000012",
          input_cache_write: "0.000005",
        },
      ],
    });
    const source = metadata([endpoint]);
    source.data.id = endpoint.model_id;
    const quote = await new OpenRouterQuoteCache({
      fetchFn: async () => Response.json(source),
    }).quote(endpoint.model_id);
    expect(quote).toMatchObject({
      modelId: endpoint.model_id,
      contextTokens: 49_999,
      reasoningSupported: true,
      ratesMicrosPerToken: { cacheWrite: 2.5 },
    });
    const bound = campaignRequestBound(
      { systemPrompt: "", messages: [], tools: [], effort: "high" },
      quote,
      2048,
    );
    expect(bound.maximumMicros).toBe(Math.ceil(bound.inputTokens * 2.5 + 2048 * 8) + 1);
    expect(quote.provenance.some((item) => item.includes("conditional pricing"))).toBe(true);
  });
});

describe("campaign cost bounds", () => {
  it("bounds the full text/tool request with explicit framing and rounds cost up", async () => {
    const quote = await quoteFor(metadata());
    const request: ProviderRequest = {
      systemPrompt: "Purpose",
      messages: [{ role: "user", parts: [{ type: "text", text: "日本語" }] }],
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    };
    const bound = campaignRequestBound(request, quote, 800);
    expect(bound.inputTokens).toBeGreaterThan(1024 + 64 + 256);
    expect(bound.maximumMicros).toBe(bound.inputTokens * 2 + 6400 + 1);
    expect(bound.provenance).toContain("UTF-8");
    expect(
      estimatedCampaignMicros(quote, {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadInputTokens: 8,
        cacheCreationInputTokens: 3,
      }),
    ).toBe(36);
    expect(reportedCampaignMicros(0)).toBe(0);
    expect(reportedCampaignMicros(0.00000001)).toBe(1);
  });

  it("rejects multimedia, reasoning, excessive context, and unsafe arithmetic", async () => {
    const quote = await quoteFor(metadata());
    const request: ProviderRequest = { systemPrompt: "", messages: [], tools: [] };
    expect(() => campaignRequestBound({ ...request, thinking: true }, quote, 1)).toThrow(
      /Reasoning/,
    );
    expect(() =>
      campaignRequestBound(
        {
          ...request,
          messages: [
            { role: "user", parts: [{ type: "image", mediaType: "image/png", data: "a" }] },
          ],
        },
        quote,
        1,
      ),
    ).toThrow(/text/);
    expect(() => campaignRequestBound(request, { ...quote, contextTokens: 10 }, 1)).toThrow(
      /context/,
    );
    expect(() => campaignRequestBound(request, quote, 100_000)).toThrow(/cap/);
    expect(() => reportedCampaignMicros(Number.MAX_VALUE)).toThrow(/accounting/);
  });
});

function endpointFixture() {
  return {
    model_id: "openai/gpt-4.1",
    provider_name: "OpenAI",
    tag: "openai",
    status: 0,
    service_tier: null,
    context_length: 100_000,
    max_prompt_tokens: null,
    max_completion_tokens: 32768,
    supported_parameters: ["max_tokens", "temperature", "tools"],
    pricing: {
      prompt: "0.000002",
      completion: "0.000008",
      input_cache_read: "0.0000005",
      web_search: "0.01",
      discount: 0,
    },
  };
}

function metadata(endpoints = [endpointFixture()]) {
  return {
    data: {
      id: "openai/gpt-4.1",
      architecture: {
        tokenizer: "GPT",
        input_modalities: ["text", "image", "file"],
        output_modalities: ["text"],
      },
      endpoints,
    },
  };
}

function quoteFor(data: unknown) {
  return new OpenRouterQuoteCache({
    now: () => 1000,
    fetchFn: async () => Response.json(data),
  }).quote("openai/gpt-4.1");
}
