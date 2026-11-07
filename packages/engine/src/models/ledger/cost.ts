import { type ModelRates, ratesFor } from "../../pricing.ts";
import { numberAt } from "../adapters/json.ts";
import type { TokenCounts } from "./normalize.ts";
import type { CacheTtl, CostSource, LocalEnergy, UsageContext, UsageShape } from "./types.ts";

export interface Price {
  cost: number | null;
  costSource: CostSource | null;
}

export interface PricingContext extends UsageContext {
  msTotal: number | null;
}

export const cacheWriteMultipliers: Readonly<Record<Exclude<CacheTtl, "unknown">, number>> = {
  "5m": 1.25,
  "1h": 2,
  "30m": 1.25,
  "12h": 2.5,
};

export function priceUsage(
  shape: UsageShape,
  tokens: TokenCounts,
  usage: Record<string, unknown>,
  context: PricingContext,
): Price {
  const metered = numberAt(usage, "cost");
  if (metered !== undefined) return { cost: metered, costSource: "provider" };
  if ((context.locality ?? defaultLocality[shape]) === "local") {
    return { cost: energyCost(context.energy, context.msTotal), costSource: "local_estimate" };
  }
  const rates = context.model === undefined ? undefined : ratesFor(context.model);
  if (rates === undefined) return { cost: null, costSource: null };
  return { cost: tableCost(tokens, rates), costSource: "price_table" };
}

const defaultLocality: Readonly<Record<UsageShape, "local" | "cloud">> = {
  anthropic: "cloud",
  "openai-chat": "cloud",
  "openai-responses": "cloud",
  openrouter: "cloud",
  "llama-server": "local",
  "ollama-native": "local",
  "ollama-openai": "local",
  decision: "local",
};

const nanosPerDollar = 1_000_000_000;
const joulesPerKwh = 3_600_000;

function energyCost(energy: LocalEnergy | undefined, msTotal: number | null): number {
  if (energy === undefined || msTotal === null) return 0;
  return ((energy.watts * (msTotal / 1000)) / joulesPerKwh) * energy.usdPerKwh;
}

function tableCost(tokens: TokenCounts, rates: ModelRates): number {
  const writes = tokens.cacheWrite.reduce(
    (sum, write) => sum + write.tokens * cacheWriteRate(write.ttl, rates),
    0,
  );
  const nanos =
    tokens.inputUncached * rates.inputNanosPerToken +
    tokens.cacheRead * rates.cacheReadNanosPerToken +
    writes +
    tokens.output * rates.outputNanosPerToken;
  return nanos / nanosPerDollar;
}

function cacheWriteRate(ttl: CacheTtl, rates: ModelRates): number {
  if (ttl === "unknown") return rates.cacheWriteNanosPerToken;
  return rates.inputNanosPerToken * cacheWriteMultipliers[ttl];
}
