import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type EngineEvents,
  EventBus,
  type ExtensionFactory,
  ExtensionHost,
  SessionStore,
} from "@keywork/engine";
import { scratchDirs } from "@keywork/shared/testing";
import { describe, expect, it } from "vitest";

const scratch = scratchDirs("keywork-extension-example-");

const examplePath = fileURLToPath(
  new URL("../../../docs/examples/extensions/shell-sentry.ts", import.meta.url),
);
const authoringSurface = pathToFileURL(fileURLToPath(new URL("./index.ts", import.meta.url)));

async function loadExample(): Promise<ExtensionFactory> {
  const source = await readFile(examplePath, "utf8");
  const bound = join(await scratch(), "shell-sentry.ts");
  await writeFile(bound, source.replace('"@keywork/extensions"', `"${authoringSurface.href}"`));
  const module = (await import(pathToFileURL(bound).href)) as { default: ExtensionFactory };
  return module.default;
}

function hostWithNotices() {
  const bus = new EventBus<EngineEvents>();
  const notices: string[] = [];
  bus.on("extension.notice", (notice) => notices.push(`${notice.level}:${notice.message}`));
  return { host: new ExtensionHost({ bus }), notices };
}

const deleteCall = {
  type: "tool-call" as const,
  callId: "c1",
  name: "bash",
  arguments: { command: "rm -rf build" },
};

describe("docs/examples/extensions/shell-sentry", () => {
  it("registers one tool and one command, gates bash, and keeps its count across a resume", async () => {
    const shellSentry = await loadExample();
    const file = join(await scratch(), "session.jsonl");
    const first = hostWithNotices();
    await first.host.activate({ name: "shell-sentry", source: "inline", activate: shellSentry });
    await first.host.startSession({ store: await SessionStore.create(file, "/w") });
    expect(first.host.registrations("shell-sentry")).toEqual({
      tools: ["shell_sentry_report"],
      commands: ["sentry"],
      shortcuts: [],
      flags: [],
    });

    const ruling = await first.host.agentHooks().toolCall?.(deleteCall);
    expect(ruling).toEqual({
      kind: "refuse",
      reason: "shell-sentry: the sentry refuses recursive deletes",
    });
    const allowed = await first.host
      .agentHooks()
      .toolCall?.({ ...deleteCall, arguments: { command: "ls" } });
    expect(allowed?.kind).toBe("proceed");
    expect(await first.host.runCommand("sentry", "")).toBe(
      "1 shell command(s) refused this session",
    );
    await first.host.dispose();

    const resumed = hostWithNotices();
    await resumed.host.activate({ name: "shell-sentry", source: "inline", activate: shellSentry });
    await resumed.host.startSession({ reason: "resume", store: await SessionStore.open(file) });
    expect(await resumed.host.runCommand("sentry", "")).toBe(
      "1 shell command(s) refused this session",
    );
    expect(resumed.notices).toContain("info:sentry ready (resume), 1 refusals on record");
    await resumed.host.dispose();
    expect(resumed.notices.at(-1)).toBe("info:sentry off duty");
  });
});
