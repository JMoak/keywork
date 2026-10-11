import { defineExtension } from "@keywork/extensions";

export default defineExtension((api) => {
  let refused = 0;

  api.registerTool({
    name: "shell_sentry_report",
    description: "Reports how many shell commands this extension has refused so far.",
    parameters: { type: "object", properties: {} },
    execute: async () => `${refused} shell command(s) refused this session`,
  });

  api.registerCommand({
    name: "sentry",
    description: "how many shell commands the sentry refused: /sentry",
    run: () => `${refused} shell command(s) refused this session`,
  });

  api.on("tool_call", async ({ call }) => {
    if (call.name !== "bash") return undefined;
    const { command } = call.arguments as { command: string };
    if (!/\brm\s+-rf?\b/.test(command)) return undefined;
    refused += 1;
    await api.appendEntry("refused", { command });
    return { action: "deny", reason: "the sentry refuses recursive deletes" };
  });

  api.on("custom_entry", ({ type, replay }) => {
    if (type === "refused" && replay) refused += 1;
  });

  api.on("session_start", ({ reason }) => {
    api.log.info(`sentry ready (${reason}), ${refused} refusals on record`);
  });

  return () => api.log.info("sentry off duty");
});
