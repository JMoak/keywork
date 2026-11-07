export type CostSource = "provider" | "price_table" | "local_estimate";

export type CacheTtl = "5m" | "1h" | "30m" | "12h" | "unknown";

export interface CacheWrite {
  ttl: CacheTtl;
  tokens: number;
}

export interface NormalizedUsage {
  inputUncached: number;
  cacheRead: number;
  cacheWrite: readonly CacheWrite[];
  output: number;
  reasoning: number | null;
  images: number | null;
  decisionQuestions: number | null;
  msTtft: number | null;
  msTotal: number | null;
  tokS: number | null;
  cost: number | null;
  costSource: CostSource | null;
}

export type UsageShape =
  | "anthropic"
  | "openai-chat"
  | "openai-responses"
  | "openrouter"
  | "llama-server"
  | "ollama-native"
  | "ollama-openai"
  | "decision";

export interface UsagePayload {
  usage: unknown;
  timings?: unknown;
}

export interface MeasuredTiming {
  msTtft?: number | undefined;
  msTotal?: number | undefined;
}

export interface LocalEnergy {
  watts: number;
  usdPerKwh: number;
}

export interface UsageContext {
  model?: string | undefined;
  measured?: MeasuredTiming | undefined;
  requestedCacheTtl?: CacheTtl | undefined;
  images?: number | undefined;
  decisionQuestions?: number | undefined;
  locality?: "local" | "cloud" | undefined;
  energy?: LocalEnergy | undefined;
}
