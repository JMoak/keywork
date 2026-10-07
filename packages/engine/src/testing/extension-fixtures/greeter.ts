import type { ExtensionApi } from "../../extensions/hooks.ts";

export default function greeter(api: ExtensionApi): () => void {
  api.registerTool({
    name: "greet",
    description: "Greets someone by name.",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    execute: async (args) => `hello, ${(args as { name: string }).name}`,
  });
  api.registerCommand({
    name: "hello",
    description: "Says hello back.",
    run: (args) => `hello ${args}`.trim(),
  });
  api.registerShortcut({ keys: "ctrl+shift+g", description: "greet", run: () => undefined });
  api.registerFlag({ name: "greeting", description: "sets the greeting", takesValue: true });
  api.on("context", () => "Greet people warmly.");
  api.on("turn_start", ({ userText }) => api.log.info(`turn: ${userText}`));
  return () => api.log.info("greeter torn down");
}
