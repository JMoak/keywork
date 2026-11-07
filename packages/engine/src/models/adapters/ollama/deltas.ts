import type { ServerDeltas } from "../types.ts";

export const ollamaDeltas: ServerDeltas = {
  kind: "ollama",
  defaultPort: 11434,
  versionTested: "0.40.14",
  droppedChatFields: ["tool_choice", "n", "logit_bias", "logprobs", "top_logprobs", "user"],
  honoredToolChoice: ["auto"],
  imageInput: "base64",
  reasoningDeltaFields: ["reasoning", "reasoning_content"],
  saturationStatuses: [503],
  usageShape: "ollama-openai",
  rules: {
    droppedChatFields: "MODEL-002",
    contextLength: "MODEL-003",
    statelessResponses: "MODEL-004",
    messagesDeltas: "MODEL-005",
    nativeUsage: "MODEL-006",
    residency: "MODEL-020",
    saturation: "MODEL-024",
    localOnly: "MODEL-031",
    modalities: "MODEL-036",
  },
};

export const ollamaMessagesSince = "0.14.0";

export const ollamaLocalOnlyEnvironment: Readonly<Record<string, string>> = {
  OLLAMA_NO_CLOUD: "1",
};
