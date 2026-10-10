import type { ExtensionApi, ToolCallDecision } from "../../extensions/hooks.ts";

export default function gatekeeper(api: ExtensionApi): void {
  api.on("tool_call", ({ call }): ToolCallDecision | undefined => {
    if (call.name === "bash") return { action: "deny", reason: "shell is off limits here" };
    if (call.name === "echo") {
      const { text } = call.arguments as { text: string };
      return { action: "modify", arguments: { text: text.toUpperCase() } };
    }
    return undefined;
  });
}
