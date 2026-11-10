import type { Usage } from "../messages.ts";
import type { OpenRouterRouting, ProviderRequest } from "../provider.ts";
import { toChatRequest } from "../providers/chat-wire.ts";
import type { FetchLike } from "../providers/transport.ts";

export interface OpenRouterCampaignQuote {
  modelId: string;
  providerTag: string;
  providerName: string;
  sourceUrl: string;
  quotedAt: number;
  expiresAt: number;
  contextTokens: number;
  maxOutputTokens: number;
  reasoningSupported?: boolean;
  ratesMicrosPerToken: {
    prompt: number;
    completion: number;
    cacheRead: number;
    cacheWrite: number;
  };
  requestMicros: number;
  routing: OpenRouterRouting;
  provenance: string[];
}

export interface CampaignRequestBound {
  inputTokens: number;
  maximumMicros: number;
  provenance: string;
}

export interface OpenRouterQuoteCacheOptions {
  fetchFn?: FetchLike;
  now?: () => number;
  ttlMs?: number;
}

export class CampaignPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignPricingError";
  }
}

export class OpenRouterQuoteCache {
  private readonly cache = new Map<string, { data: unknown; quotedAt: number }>();
  private readonly pending = new Map<string, Promise<{ data: unknown; quotedAt: number }>>();
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: OpenRouterQuoteCacheOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 60_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 300_000)
      throw new CampaignPricingError("Quote lifetime must be between 1 and 300000 milliseconds");
  }

  async quote(
    modelId: string,
    options: { providerTag?: string } = {},
  ): Promise<OpenRouterCampaignQuote> {
    assertAdmittedModel(modelId);
    const cached = await this.metadata(modelId);
    return admitQuote(cached.data, modelId, options.providerTag, cached.quotedAt, this.ttlMs);
  }

  private async metadata(modelId: string): Promise<{ data: unknown; quotedAt: number }> {
    const cached = this.cache.get(modelId);
    if (
      cached !== undefined &&
      cached.quotedAt <= this.now() &&
      cached.quotedAt + this.ttlMs > this.now()
    )
      return cached;
    const pending = this.pending.get(modelId);
    if (pending !== undefined) return pending;
    const loading = this.load(modelId);
    this.pending.set(modelId, loading);
    try {
      return await loading;
    } finally {
      this.pending.delete(modelId);
    }
  }

  private async load(modelId: string): Promise<{ data: unknown; quotedAt: number }> {
    const response = await this.fetchFn(metadataUrl(modelId), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new CampaignPricingError(`OpenRouter quote lookup failed (${response.status})`);
    const body = await response.text();
    if (body.length > 2_000_000)
      throw new CampaignPricingError("OpenRouter quote response is too large");
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new CampaignPricingError("OpenRouter quote response is not valid JSON");
    }
    const cached = { data, quotedAt: this.now() };
    this.cache.set(modelId, cached);
    return cached;
  }
}

export function campaignRequestBound(
  request: ProviderRequest,
  quote: OpenRouterCampaignQuote,
  maxOutputTokens: number,
): CampaignRequestBound {
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > quote.maxOutputTokens
  )
    throw new CampaignPricingError("Output cap exceeds the admitted endpoint limit");
  if (
    ((request.thinking === true || request.effort !== undefined) &&
      quote.reasoningSupported !== true) ||
    (request.effortChanges?.length ?? 0) > 0
  )
    throw new CampaignPricingError(
      "Reasoning requests need a separately verified billing and output-cap contract",
    );
  for (const message of request.messages) {
    if (message.parts.some((part) => !["text", "tool-call", "tool-result"].includes(part.type)))
      throw new CampaignPricingError("Campaign quote admits text and function tools only");
  }
  const encoded = JSON.stringify(toChatRequest(request, quote.modelId));
  const inputTokens =
    new TextEncoder().encode(encoded).byteLength +
    1024 +
    request.messages.length * 64 +
    request.tools.length * 256;
  if (!Number.isSafeInteger(inputTokens) || inputTokens + maxOutputTokens > quote.contextTokens)
    throw new CampaignPricingError(
      "Conservative input and output bound exceeds endpoint context capacity",
    );
  const inputRate = Math.max(
    quote.ratesMicrosPerToken.prompt,
    quote.ratesMicrosPerToken.cacheRead,
    quote.ratesMicrosPerToken.cacheWrite,
  );
  return {
    inputTokens,
    maximumMicros:
      boundedMicros(
        inputTokens * inputRate +
          maxOutputTokens * quote.ratesMicrosPerToken.completion +
          quote.requestMicros,
      ) + 1,
    provenance:
      "UTF-8 chat request bytes plus 1024 envelope, 64 per message, and 256 per function tool; GPT byte-tokenizer admission; one micro rounding allowance",
  };
}

export function estimatedCampaignMicros(quote: OpenRouterCampaignQuote, usage: Usage): number {
  const rates = quote.ratesMicrosPerToken;
  return boundedMicros(
    usage.inputTokens * rates.prompt +
      usage.outputTokens * rates.completion +
      (usage.cacheReadInputTokens ?? 0) * rates.cacheRead +
      (usage.cacheCreationInputTokens ?? 0) * rates.cacheWrite +
      quote.requestMicros,
  );
}

export function reportedCampaignMicros(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd < 0)
    throw new CampaignPricingError("Reported cost is invalid");
  return boundedMicros(costUsd * 1_000_000);
}

function admitQuote(
  raw: unknown,
  modelId: string,
  providerTag: string | undefined,
  quotedAt: number,
  ttlMs: number,
): OpenRouterCampaignQuote {
  const data = record(record(raw).data);
  if (data.id !== modelId)
    throw new CampaignPricingError("Quote metadata does not match the requested model");
  const architecture = record(data.architecture);
  if (
    architecture.tokenizer !== "GPT" ||
    !strings(architecture.input_modalities).includes("text") ||
    strings(architecture.output_modalities).join(",") !== "text"
  )
    throw new CampaignPricingError("Quote requires a verified GPT tokenizer and text-only output");
  if (!Array.isArray(data.endpoints))
    throw new CampaignPricingError("Quote has no endpoint metadata");
  const candidates = data.endpoints
    .map(record)
    .filter((endpoint) =>
      providerTag === undefined ? endpoint.tag === "openai" : endpoint.tag === providerTag,
    );
  if (candidates.length > 1)
    throw new CampaignPricingError("Provider tag matches multiple endpoint quotes");
  const failures: string[] = [];
  for (const endpoint of candidates) {
    try {
      const quote = admitEndpoint(endpoint, modelId, quotedAt, ttlMs);
      const variants = data.endpoints
        .map(record)
        .filter(
          (item) => typeof item.tag === "string" && item.tag.startsWith(`${quote.providerTag}/`),
        );
      return {
        ...quote,
        routing: {
          ...quote.routing,
          ...(variants.length > 0 && { ignore: variants.map((item) => textField(item.tag)) }),
        },
      };
    } catch (cause) {
      failures.push(cause instanceof Error ? cause.message : "Endpoint admission failed");
    }
  }
  throw new CampaignPricingError(
    `No bounded endpoint admitted${failures.length > 0 ? `: ${failures.join("; ")}` : " for this provider selection"}`,
  );
}

function admitEndpoint(
  endpoint: Record<string, unknown>,
  modelId: string,
  quotedAt: number,
  ttlMs: number,
): OpenRouterCampaignQuote {
  if (endpoint.model_id !== modelId || endpoint.status !== 0 || endpoint.service_tier != null)
    throw new CampaignPricingError("Endpoint model, availability, or service tier is not admitted");
  const providerTag = textField(endpoint.tag);
  const providerName = textField(endpoint.provider_name);
  if (providerTag !== "openai" && !providerTag.startsWith("openai/"))
    throw new CampaignPricingError(
      "Endpoint needs a verified implicit-cache and output-cap contract",
    );
  const parameters = strings(endpoint.supported_parameters);
  if (!parameters.includes("max_tokens"))
    throw new CampaignPricingError("Endpoint lacks an admitted max_tokens contract");
  const pricing = record(endpoint.pricing);
  if (/^openai\/gpt-(?:6|5\.[6-9])/.test(modelId) && pricing.input_cache_write === undefined)
    throw new CampaignPricingError(
      "This GPT generation requires an explicit automatic cache-write price",
    );
  const prompt = rate(pricing.prompt);
  const completion = rate(pricing.completion);
  const cacheRead =
    pricing.input_cache_read === undefined ? prompt : rate(pricing.input_cache_read);
  const cacheWrite =
    pricing.input_cache_write === undefined ? prompt : rate(pricing.input_cache_write);
  const tierLimit = excludedPricingTier(pricing.overrides);
  for (const [key, value] of Object.entries(pricing)) {
    if (["prompt", "completion", "request", "input_cache_read", "input_cache_write"].includes(key))
      continue;
    if (key === "web_search" || key === "image" || key === "audio" || key === "video") {
      rate(value);
      continue;
    }
    if (key === "overrides") continue;
    if (key === "discount" && value === 0) continue;
    if (rateOrUnknown(value) === 0) continue;
    throw new CampaignPricingError(`Unaccounted pricing category: ${key}`);
  }
  const requestUsd = pricing.request === undefined ? 0 : usdRate(pricing.request);
  const context = positiveInteger(endpoint.context_length, "context limit");
  const promptLimit =
    endpoint.max_prompt_tokens == null
      ? context
      : positiveInteger(endpoint.max_prompt_tokens, "prompt limit");
  return {
    modelId,
    providerTag,
    providerName,
    sourceUrl: metadataUrl(modelId),
    quotedAt,
    expiresAt: quotedAt + ttlMs,
    contextTokens: Math.min(context, promptLimit, tierLimit),
    maxOutputTokens: positiveInteger(endpoint.max_completion_tokens, "completion limit"),
    reasoningSupported: parameters.includes("reasoning"),
    ratesMicrosPerToken: { prompt, completion, cacheRead, cacheWrite },
    requestMicros: boundedMicros(requestUsd * 1_000_000),
    routing: { only: [providerTag], maxPrice: { prompt, completion, request: requestUsd } },
    provenance: [
      "Official endpoint pricing in USD/token; routing price ceilings in USD/million tokens",
      "Text and function tools only; media, native tools, plugins, presets, and service tiers excluded",
      "OpenAI GPT combined reasoning and visible output cap; explicit cache-write/read rates reserved conservatively",
      ...(Number.isFinite(tierLimit)
        ? [
            `Input and output envelope capped below the first conditional pricing threshold (${tierLimit + 1} tokens)`,
          ]
        : []),
      pricing.request === undefined
        ? "Request fee absent from metadata; max_price.request=0 enforced on dispatch"
        : "Explicit per-request fee included",
    ],
  };
}

function assertAdmittedModel(modelId: string): void {
  if (
    modelId.includes("latest") ||
    !/^openai\/gpt-(?:4\.1(?:-(?:mini|nano))?|4o(?:-mini)?|4-turbo|[56](?:\.\d+)?(?:-[a-z0-9]+)*)(?:-\d{4}-\d{2}-\d{2})?$/.test(
      modelId,
    )
  )
    throw new CampaignPricingError(
      "This model needs a verified tokenizer, cache-price, and output-cap admission contract",
    );
}

function excludedPricingTier(value: unknown): number {
  if (value === undefined) return Infinity;
  if (!Array.isArray(value)) throw new CampaignPricingError("Unaccounted conditional pricing");
  let limit = Infinity;
  for (const candidate of value) {
    const tier = record(candidate);
    const threshold = positiveInteger(tier.min_prompt_tokens, "conditional pricing threshold");
    for (const [key, price] of Object.entries(tier)) {
      if (key === "min_prompt_tokens") continue;
      if (!["prompt", "completion", "input_cache_read", "input_cache_write"].includes(key))
        throw new CampaignPricingError(`Unaccounted conditional pricing category: ${key}`);
      rate(price);
    }
    limit = Math.min(limit, threshold - 1);
  }
  return limit;
}

function metadataUrl(modelId: string): string {
  return `https://openrouter.ai/api/v1/models/${modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CampaignPricingError("Invalid quote metadata object");
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new CampaignPricingError("Invalid quote metadata list");
  return value as string[];
}

function textField(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512)
    throw new CampaignPricingError("Invalid endpoint identity");
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new CampaignPricingError(`Invalid endpoint ${name}`);
  return value;
}

function usdRate(value: unknown): number {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
    throw new CampaignPricingError("Pricing must be an explicit nonnegative decimal string");
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    parsed > 1000 ||
    (parsed === 0 && /[1-9]/.test(value.split(/e/i)[0] ?? ""))
  )
    throw new CampaignPricingError("Pricing is outside supported accounting bounds");
  return parsed;
}

function rate(value: unknown): number {
  usdRate(value);
  const [mantissa, exponent = "0"] = String(value).split(/e/i);
  return Number(`${mantissa}e${Number(exponent) + 6}`);
}

function rateOrUnknown(value: unknown): number | undefined {
  try {
    return rate(value);
  } catch {
    return undefined;
  }
}

function boundedMicros(value: number): number {
  const rounded = Math.ceil(value);
  if (!Number.isSafeInteger(rounded) || rounded < 0)
    throw new CampaignPricingError("Cost exceeds safe integer accounting");
  return rounded;
}
