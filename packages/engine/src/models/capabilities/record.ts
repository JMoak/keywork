import type {
  CapabilityName,
  CapabilityRecord,
  Evidence,
  Probed,
  RejectedField,
  ServerFingerprint,
  ServerKind,
} from "./types.ts";

export const serverKinds: readonly ServerKind[] = [
  "ollama",
  "llama-server",
  "lm-studio",
  "vllm",
  "sglang",
  "mlx-lm",
  "llama-swap",
  "openai-compatible",
  "openrouter",
  "openai",
  "anthropic",
];

export function isServerKind(kind: string): kind is ServerKind {
  return (serverKinds as readonly string[]).includes(kind);
}

export function known<T>(value: T, evidence: Evidence): Probed<T> {
  return { known: true, value, evidence };
}

export function unknownCapability<T>(reason: string): Probed<T> {
  return { known: false, reason };
}

export function knownValue<T>(probed: Probed<T>): T | undefined {
  return probed.known ? probed.value : undefined;
}

export function blankRecord(
  endpoint: string,
  model: string,
  server: ServerFingerprint,
  probedAt: string,
): CapabilityRecord {
  const notProbed = unknownCapability<never>("no native route reported it");
  return {
    endpoint,
    model,
    server,
    probedAt,
    protocols: notProbed,
    tools: notProbed,
    toolChoice: notProbed,
    parallelTools: notProbed,
    strictSchemas: notProbed,
    responseFormat: notProbed,
    imageInput: notProbed,
    reasoning: notProbed,
    reasoningReplay: notProbed,
    logprobs: notProbed,
    usageInStream: notProbed,
    prefixCacheReport: notProbed,
    contextAllocated: notProbed,
    contextTrained: notProbed,
    maxOutput: notProbed,
    decisionEndpoint: notProbed,
    modalities: notProbed,
    decodeTokensPerSecond: notProbed,
    license: notProbed,
    rejectedFields: [],
  };
}

export function knownCapabilities(record: CapabilityRecord): CapabilityName[] {
  return capabilityNames.filter((name) => record[name].known);
}

export function withRejectedField(
  record: CapabilityRecord,
  rejected: RejectedField,
): CapabilityRecord {
  if (record.rejectedFields.some((entry) => entry.field === rejected.field)) return record;
  return { ...record, rejectedFields: [...record.rejectedFields, rejected] };
}

export function rejects(record: CapabilityRecord, field: string): boolean {
  return record.rejectedFields.some((entry) => entry.field === field);
}

export function withMeasuredDecode(
  record: CapabilityRecord,
  tokensPerSecond: number,
  at: string,
): CapabilityRecord {
  return {
    ...record,
    decodeTokensPerSecond: known(tokensPerSecond, { source: "measured", at }),
  };
}

export const capabilityNames: readonly CapabilityName[] = [
  "protocols",
  "tools",
  "toolChoice",
  "parallelTools",
  "strictSchemas",
  "responseFormat",
  "imageInput",
  "reasoning",
  "reasoningReplay",
  "logprobs",
  "usageInStream",
  "prefixCacheReport",
  "contextAllocated",
  "contextTrained",
  "maxOutput",
  "decisionEndpoint",
  "modalities",
  "decodeTokensPerSecond",
  "license",
];
