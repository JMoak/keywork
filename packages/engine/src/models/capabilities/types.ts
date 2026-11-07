import type { Protocol } from "../../inference/types.ts";

export type ServerKind =
  | "ollama"
  | "llama-server"
  | "lm-studio"
  | "vllm"
  | "sglang"
  | "mlx-lm"
  | "llama-swap"
  | "openai-compatible"
  | "openrouter"
  | "openai"
  | "anthropic";

export interface ServerFingerprint {
  id: string;
  kind: ServerKind;
  version: string | null;
  build: string | null;
  routes: readonly string[];
}

export type Evidence =
  | { source: "native-route"; route: string }
  | { source: "server-delta"; rule: string }
  | { source: "rejected-field"; field: string; status: number }
  | { source: "behaviour-probe"; probe: string }
  | { source: "measured"; at: string }
  | { source: "declared" };

export type Probed<T> =
  | { known: true; value: T; evidence: Evidence }
  | { known: false; reason: string };

export type ToolChoiceMode = "auto" | "none" | "required" | "named";

export type ResponseFormatMode = "json_object" | "json_schema";

export type ImageInputKind = "none" | "base64" | "url-or-base64";

export type ReasoningDialect =
  | "none"
  | "reasoning-effort"
  | "chat-template-kwargs"
  | "ollama-think"
  | "anthropic-thinking"
  | "responses-reasoning";

export type DecisionEndpoint = "/v1/systemone" | "/v1/decisions" | "/api/alpha/decisions";

export interface Modalities {
  input: readonly string[];
  output: readonly string[];
}

export interface RejectedField {
  field: string;
  status: number;
  learnedAt: string;
}

export interface CapabilityRecord {
  endpoint: string;
  model: string;
  server: ServerFingerprint;
  probedAt: string;
  protocols: Probed<readonly Protocol[]>;
  tools: Probed<boolean>;
  toolChoice: Probed<readonly ToolChoiceMode[]>;
  parallelTools: Probed<boolean>;
  strictSchemas: Probed<boolean>;
  responseFormat: Probed<readonly ResponseFormatMode[]>;
  imageInput: Probed<ImageInputKind>;
  reasoning: Probed<ReasoningDialect>;
  reasoningReplay: Probed<boolean>;
  logprobs: Probed<boolean>;
  usageInStream: Probed<boolean>;
  prefixCacheReport: Probed<boolean>;
  contextAllocated: Probed<number>;
  contextTrained: Probed<number>;
  maxOutput: Probed<number>;
  decisionEndpoint: Probed<DecisionEndpoint | null>;
  modalities: Probed<Modalities>;
  decodeTokensPerSecond: Probed<number>;
  license: Probed<string>;
  rejectedFields: readonly RejectedField[];
}

export type CapabilityName = Exclude<
  keyof CapabilityRecord,
  "endpoint" | "model" | "server" | "probedAt" | "rejectedFields"
>;
