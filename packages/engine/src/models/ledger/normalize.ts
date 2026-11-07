import { isRecord, numberAt } from "../adapters/json.ts";
import { priceUsage } from "./cost.ts";
import type {
  CacheTtl,
  CacheWrite,
  MeasuredTiming,
  NormalizedUsage,
  UsageContext,
  UsagePayload,
  UsageShape,
} from "./types.ts";

export interface TokenCounts {
  inputUncached: number;
  cacheRead: number;
  cacheWrite: readonly CacheWrite[];
  output: number;
  reasoning: number | null;
}

export interface ServerTiming {
  msTtft: number | null;
  msTotal: number | null;
  tokS: number | null;
}

export function normalizeUsage(
  shape: UsageShape,
  payload: UsagePayload,
  context: UsageContext = {},
): NormalizedUsage | null {
  if (!isRecord(payload.usage)) return null;
  const tokens = tokenReaders[shape](payload.usage, payload.timings, context);
  if (tokens === undefined) return null;
  const timing = timingOf(shape, payload, tokens, context.measured);
  const price = priceUsage(shape, tokens, payload.usage, { ...context, msTotal: timing.msTotal });
  return {
    ...tokens,
    images: context.images ?? null,
    decisionQuestions: context.decisionQuestions ?? null,
    ...timing,
    ...price,
  };
}

export function totalCacheWrite(usage: Pick<NormalizedUsage, "cacheWrite">): number {
  return usage.cacheWrite.reduce((sum, write) => sum + write.tokens, 0);
}

type TokenReader = (
  usage: Record<string, unknown>,
  timings: unknown,
  context: UsageContext,
) => TokenCounts | undefined;

const tokenReaders: Readonly<Record<UsageShape, TokenReader>> = {
  anthropic: anthropicTokens,
  "openai-chat": chatTokens,
  openrouter: chatTokens,
  "openai-responses": responsesTokens,
  "llama-server": llamaServerTokens,
  "ollama-native": ollamaNativeTokens,
  "ollama-openai": chatTokens,
  decision: decisionTokens,
};

function anthropicTokens(
  usage: Record<string, unknown>,
  _timings: unknown,
  context: UsageContext,
): TokenCounts | undefined {
  const input = numberAt(usage, "input_tokens");
  const output = numberAt(usage, "output_tokens");
  if (input === undefined || output === undefined) return undefined;
  return {
    inputUncached: input,
    cacheRead: numberAt(usage, "cache_read_input_tokens") ?? 0,
    cacheWrite: anthropicCacheWrites(usage, context.requestedCacheTtl),
    output,
    reasoning: null,
  };
}

function anthropicCacheWrites(
  usage: Record<string, unknown>,
  requestedTtl: CacheTtl | undefined,
): CacheWrite[] {
  const fiveMinutes = numberAt(usage, "cache_creation", "ephemeral_5m_input_tokens");
  const oneHour = numberAt(usage, "cache_creation", "ephemeral_1h_input_tokens");
  if (fiveMinutes !== undefined || oneHour !== undefined) {
    return nonEmptyWrites([
      { ttl: "5m", tokens: fiveMinutes ?? 0 },
      { ttl: "1h", tokens: oneHour ?? 0 },
    ]);
  }
  return nonEmptyWrites([
    { ttl: requestedTtl ?? "unknown", tokens: numberAt(usage, "cache_creation_input_tokens") ?? 0 },
  ]);
}

function chatTokens(
  usage: Record<string, unknown>,
  _timings: unknown,
  context: UsageContext,
): TokenCounts | undefined {
  const prompt = numberAt(usage, "prompt_tokens");
  const output = numberAt(usage, "completion_tokens");
  if (prompt === undefined || output === undefined) return undefined;
  const cached = numberAt(usage, "prompt_tokens_details", "cached_tokens") ?? 0;
  const written = numberAt(usage, "prompt_tokens_details", "cache_write_tokens") ?? 0;
  return {
    inputUncached: Math.max(0, prompt - cached - written),
    cacheRead: cached,
    cacheWrite: nonEmptyWrites([{ ttl: context.requestedCacheTtl ?? "unknown", tokens: written }]),
    output,
    reasoning: numberAt(usage, "completion_tokens_details", "reasoning_tokens") ?? null,
  };
}

function responsesTokens(
  usage: Record<string, unknown>,
  _timings: unknown,
  context: UsageContext,
): TokenCounts | undefined {
  const input = numberAt(usage, "input_tokens");
  const output = numberAt(usage, "output_tokens");
  if (input === undefined || output === undefined) return undefined;
  const cached = numberAt(usage, "input_tokens_details", "cached_tokens") ?? 0;
  const written =
    numberAt(usage, "input_tokens_details", "cache_write_tokens") ??
    numberAt(usage, "cache_write_tokens") ??
    0;
  return {
    inputUncached: Math.max(0, input - cached - written),
    cacheRead: cached,
    cacheWrite: nonEmptyWrites([{ ttl: context.requestedCacheTtl ?? "unknown", tokens: written }]),
    output,
    reasoning: numberAt(usage, "output_tokens_details", "reasoning_tokens") ?? null,
  };
}

function llamaServerTokens(
  usage: Record<string, unknown>,
  timings: unknown,
  context: UsageContext,
): TokenCounts | undefined {
  const counted = chatTokens(usage, timings, context);
  if (counted === undefined) return undefined;
  const evaluated = numberAt(timings, "prompt_n");
  const reused = numberAt(timings, "cache_n");
  if (evaluated === undefined || reused === undefined) return counted;
  return { ...counted, inputUncached: evaluated, cacheRead: reused };
}

function ollamaNativeTokens(usage: Record<string, unknown>): TokenCounts | undefined {
  const evaluated = numberAt(usage, "prompt_eval_count");
  const output = numberAt(usage, "eval_count");
  if (evaluated === undefined || output === undefined) return undefined;
  return {
    inputUncached: evaluated,
    cacheRead: numberAt(usage, "prompt_eval_cached_count") ?? 0,
    cacheWrite: [],
    output,
    reasoning: null,
  };
}

function decisionTokens(usage: Record<string, unknown>): TokenCounts | undefined {
  const input = numberAt(usage, "input_tokens") ?? numberAt(usage, "prompt_tokens");
  if (input === undefined) return undefined;
  return {
    inputUncached: input,
    cacheRead: 0,
    cacheWrite: [],
    output: 0,
    reasoning: null,
  };
}

function timingOf(
  shape: UsageShape,
  payload: UsagePayload,
  tokens: TokenCounts,
  measured: MeasuredTiming | undefined,
): ServerTiming {
  const reported = reportedTiming(shape, payload);
  const msTtft = measured?.msTtft ?? reported.msTtft;
  const msTotal = measured?.msTotal ?? reported.msTotal;
  return {
    msTtft,
    msTotal,
    tokS: reported.tokS ?? decodeRate(tokens.output, msTtft, msTotal),
  };
}

const nanosPerMilli = 1_000_000;

function reportedTiming(shape: UsageShape, payload: UsagePayload): ServerTiming {
  if (shape === "llama-server") {
    const promptMs = numberAt(payload.timings, "prompt_ms");
    const predictedMs = numberAt(payload.timings, "predicted_ms");
    return {
      msTtft: promptMs ?? null,
      msTotal: promptMs !== undefined && predictedMs !== undefined ? promptMs + predictedMs : null,
      tokS: numberAt(payload.timings, "predicted_per_second") ?? null,
    };
  }
  if (shape === "ollama-native") {
    const total = numberAt(payload.usage, "total_duration");
    const load = numberAt(payload.usage, "load_duration") ?? 0;
    const promptEval = numberAt(payload.usage, "prompt_eval_duration");
    const evalNanos = numberAt(payload.usage, "eval_duration");
    const evalCount = numberAt(payload.usage, "eval_count");
    return {
      msTtft: promptEval === undefined ? null : (load + promptEval) / nanosPerMilli,
      msTotal: total === undefined ? null : total / nanosPerMilli,
      tokS:
        evalNanos === undefined || evalCount === undefined || evalNanos === 0
          ? null
          : evalCount / (evalNanos / 1e9),
    };
  }
  return { msTtft: null, msTotal: null, tokS: null };
}

function decodeRate(output: number, msTtft: number | null, msTotal: number | null): number | null {
  if (msTtft === null || msTotal === null || output === 0) return null;
  const decodeMs = msTotal - msTtft;
  return decodeMs > 0 ? output / (decodeMs / 1000) : null;
}

function nonEmptyWrites(writes: readonly CacheWrite[]): CacheWrite[] {
  return writes.filter((write) => write.tokens > 0);
}
