import type { ExtensionApi } from "../../extensions/hooks.ts";

export default function explodesOnTurn(api: ExtensionApi): void {
  api.registerTool({
    name: "doomed",
    description: "Withdrawn once its owner misbehaves.",
    parameters: { type: "object" },
    execute: async () => "unreachable",
  });
  api.on("turn_start", () => {
    throw new Error("cannot handle turns");
  });
}
