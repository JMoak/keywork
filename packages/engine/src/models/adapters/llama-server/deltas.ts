import type { ServerDeltas } from "../types.ts";

export const llamaServerDeltas: ServerDeltas = {
  kind: "llama-server",
  defaultPort: 9931,
  versionTested: "b12122",
  droppedChatFields: ["n"],
  honoredToolChoice: null,
  imageInput: "base64",
  reasoningDeltaFields: ["reasoning_content"],
  saturationStatuses: [],
  usageShape: "llama-server",
  rules: {
    defaultPort: "MODEL-001",
    toolCallsVerified: "MODEL-007",
    reasoningReplay: "MODEL-008",
    reasoningControl: "MODEL-009",
    routerMode: "MODEL-019",
    memoryMargin: "MODEL-022",
    health: "MODEL-023",
    modalities: "MODEL-036",
  },
};
