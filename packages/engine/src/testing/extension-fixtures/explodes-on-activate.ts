import type { ExtensionApi } from "../../extensions/hooks.ts";

export default function explodesOnActivate(api: ExtensionApi): void {
  api.registerTool({
    name: "never",
    description: "Never reaches the model.",
    parameters: { type: "object" },
    execute: async () => "unreachable",
  });
  throw new Error("activation went sideways");
}
