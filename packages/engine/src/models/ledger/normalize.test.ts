import { describe, expect, it } from "vitest";
import { normalizeUsage, toKeyworkUsage, UsageLedger } from "./index.ts";

describe("normalizeUsage across the research's usage shapes", () => {
  it("reads Anthropic input as already uncached and prices cache writes by their TTL", () => {
    const usage = normalizeUsage(
      "anthropic",
      {
        usage: {
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 2000,
          cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1500 },
        },
      },
      { model: "claude-opus-5-5" },
    );
    expect(usage).toMatchObject({
      inputUncached: 1200,
      cacheRead: 8000,
      cacheWrite: [
        { ttl: "5m", tokens: 500 },
        { ttl: "1h", tokens: 1500 },
      ],
      output: 300,
      reasoning: null,
      costSource: "price_table",
    });
    expect(usage?.cost).toBeCloseTo(0.0269, 10);
  });

  it("subtracts cached and written tokens from OpenAI Responses input", () => {
    const usage = normalizeUsage(
      "openai-responses",
      {
        usage: {
          input_tokens: 10_000,
          input_tokens_details: { cached_tokens: 6000, cache_write_tokens: 3000 },
          output_tokens: 500,
          output_tokens_details: { reasoning_tokens: 200 },
        },
      },
      { model: "gpt-5.6-sol", requestedCacheTtl: "30m" },
    );
    expect(usage).toMatchObject({
      inputUncached: 1000,
      cacheRead: 6000,
      cacheWrite: [{ ttl: "30m", tokens: 3000 }],
      output: 500,
      reasoning: 200,
      costSource: "price_table",
    });
    expect(usage?.cost).toBeCloseTo(0.0314, 10);
  });

  it("reads OpenAI Chat Completions usage with cached prompt tokens", () => {
    const usage = normalizeUsage(
      "openai-chat",
      {
        usage: {
          prompt_tokens: 2000,
          prompt_tokens_details: { cached_tokens: 1500 },
          completion_tokens: 100,
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      },
      { model: "gpt-5.4" },
    );
    expect(usage).toMatchObject({
      inputUncached: 500,
      cacheRead: 1500,
      output: 100,
      reasoning: 40,
    });
    expect(usage?.cost).toBeCloseTo(0.003125, 10);
  });

  it("treats the OpenRouter cost as authoritative", () => {
    const usage = normalizeUsage(
      "openrouter",
      {
        usage: {
          prompt_tokens: 5000,
          completion_tokens: 800,
          prompt_tokens_details: { cached_tokens: 3000, cache_write_tokens: 1000 },
          completion_tokens_details: { reasoning_tokens: 120 },
          cost: 0.00042,
        },
      },
      { model: "claude-opus-5-5" },
    );
    expect(usage).toMatchObject({
      inputUncached: 1000,
      cacheRead: 3000,
      cacheWrite: [{ ttl: "unknown", tokens: 1000 }],
      output: 800,
      reasoning: 120,
      cost: 0.00042,
      costSource: "provider",
    });
  });

  it("prefers llama-server timings for cache reuse and decode speed", () => {
    const usage = normalizeUsage("llama-server", {
      usage: {
        prompt_tokens: 4100,
        completion_tokens: 256,
        prompt_tokens_details: { cached_tokens: 4000 },
      },
      timings: {
        cache_n: 4000,
        prompt_n: 100,
        prompt_ms: 85.2,
        predicted_n: 256,
        predicted_ms: 3412,
        predicted_per_second: 75.03,
      },
    });
    expect(usage).toEqual({
      inputUncached: 100,
      cacheRead: 4000,
      cacheWrite: [],
      output: 256,
      reasoning: null,
      images: null,
      decisionQuestions: null,
      msTtft: 85.2,
      msTotal: 3497.2,
      tokS: 75.03,
      cost: 0,
      costSource: "local_estimate",
    });
  });

  it("converts Ollama native nanosecond durations and the cached prompt count", () => {
    const usage = normalizeUsage("ollama-native", {
      usage: {
        model: "qwen3.8:27b",
        done: true,
        total_duration: 5_043_500_000,
        load_duration: 12_000_000,
        prompt_eval_count: 26,
        prompt_eval_cached_count: 1024,
        prompt_eval_duration: 130_000_000,
        eval_count: 298,
        eval_duration: 4_799_921_000,
      },
    });
    expect(usage).toMatchObject({
      inputUncached: 26,
      cacheRead: 1024,
      output: 298,
      msTtft: 142,
      msTotal: 5043.5,
      costSource: "local_estimate",
      cost: 0,
    });
    expect(usage?.tokS).toBeCloseTo(62.08, 2);
  });

  it("reads Ollama /v1 usage, which reports no cache split", () => {
    expect(
      normalizeUsage("ollama-openai", { usage: { prompt_tokens: 900, completion_tokens: 12 } }),
    ).toMatchObject({ inputUncached: 900, cacheRead: 0, output: 12, costSource: "local_estimate" });
  });

  it("charges decisions for input only", () => {
    expect(
      normalizeUsage(
        "decision",
        { usage: { input_tokens: 812, output_tokens: 0 } },
        { decisionQuestions: 3 },
      ),
    ).toMatchObject({ inputUncached: 812, output: 0, decisionQuestions: 3 });
  });

  it("returns null, never zeros, when the server omits usage", () => {
    expect(normalizeUsage("openai-chat", { usage: undefined })).toBeNull();
    expect(normalizeUsage("openai-chat", { usage: null })).toBeNull();
    expect(normalizeUsage("anthropic", { usage: { output_tokens: 3 } })).toBeNull();
  });

  it("estimates local energy cost when a power draw is known", () => {
    const usage = normalizeUsage(
      "ollama-openai",
      { usage: { prompt_tokens: 10, completion_tokens: 10 } },
      { measured: { msTtft: 400, msTotal: 3_600_000 }, energy: { watts: 500, usdPerKwh: 0.3 } },
    );
    expect(usage?.cost).toBeCloseTo(0.15, 10);
    expect(usage?.costSource).toBe("local_estimate");
  });

  it("measured timings override server-reported ones", () => {
    const usage = normalizeUsage(
      "llama-server",
      {
        usage: { prompt_tokens: 10, completion_tokens: 50 },
        timings: { prompt_n: 10, cache_n: 0, prompt_ms: 5, predicted_ms: 500 },
      },
      { measured: { msTtft: 100, msTotal: 1100 } },
    );
    expect(usage).toMatchObject({ msTtft: 100, msTotal: 1100, tokS: 50 });
  });

  it("leaves a cloud model without a price unpriced rather than free", () => {
    expect(
      normalizeUsage(
        "openai-chat",
        { usage: { prompt_tokens: 10, completion_tokens: 1 } },
        { model: "no-such-model" },
      ),
    ).toMatchObject({ cost: null, costSource: null });
  });
});

describe("toKeyworkUsage", () => {
  it("maps the normalized shape onto the engine's turn usage", () => {
    const usage = normalizeUsage("openrouter", {
      usage: {
        prompt_tokens: 5000,
        completion_tokens: 800,
        prompt_tokens_details: { cached_tokens: 3000, cache_write_tokens: 1000 },
        cost: 0.5,
      },
    });
    expect(toKeyworkUsage(usage)).toEqual({
      inputTokens: 1000,
      outputTokens: 800,
      cacheReadInputTokens: 3000,
      cacheCreationInputTokens: 1000,
      costUsd: 0.5,
    });
    expect(toKeyworkUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("UsageLedger", () => {
  const at = new Date("2026-11-05T12:00:00.000Z");

  it("flags a turn without usage and keeps it out of the token sums", () => {
    const ledger = new UsageLedger(undefined, () => at);
    const missing = ledger.record({
      node: "spark-ad4d",
      provider: "ollama",
      model: "qwen3.8:27b",
      servedModel: null,
      creature: "wren",
      session: "s1",
      usage: null,
    });
    expect(missing.flags).toEqual(["usage-missing"]);
    expect(missing.at).toBe(at.toISOString());
    expect(ledger.totals({ creature: "wren" })).toMatchObject({
      turns: 1,
      turnsWithoutUsage: 1,
      inputUncached: 0,
      costUsd: 0,
    });
  });

  it("totals per creature and per thread with cost split by source", () => {
    const written: string[] = [];
    const ledger = new UsageLedger(
      (entry) => written.push(entry.model),
      () => at,
    );
    const record = (session: string, creature: string, usage: ReturnType<typeof normalizeUsage>) =>
      ledger.record({
        node: null,
        provider: "p",
        model: `m-${session}`,
        servedModel: null,
        creature,
        session,
        usage,
      });
    record(
      "s1",
      "wren",
      normalizeUsage("openrouter", {
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.25 },
      }),
    );
    record(
      "s2",
      "wren",
      normalizeUsage("llama-server", { usage: { prompt_tokens: 50, completion_tokens: 5 } }),
    );
    record(
      "s3",
      "otter",
      normalizeUsage(
        "openai-chat",
        { usage: { prompt_tokens: 1, completion_tokens: 1 } },
        { model: "no-such-model" },
      ),
    );
    expect(ledger.totals({ creature: "wren" })).toMatchObject({
      turns: 2,
      inputUncached: 150,
      output: 15,
      costUsd: 0.25,
      costBySource: { provider: 0.25, price_table: 0, local_estimate: 0 },
    });
    expect(ledger.totals({ session: "s3" })).toMatchObject({ turns: 1, unpricedTurns: 1 });
    expect(ledger.entries({ session: "s3" })[0]?.flags).toEqual(["unpriced"]);
    expect(written).toEqual(["m-s1", "m-s2", "m-s3"]);
  });
});
