import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "@keywork/shared";
import { chat } from "./chat.ts";
import { providerSetupHint, resolveProvider } from "./provider.ts";
import { runHeadless } from "./run.ts";

const usage = `keywork — keyboard-first coding agent

Usage:
  keywork [chat] [--model <model>] [--continue]             interactive session
  keywork run "<prompt>" [--model <model>] [--json]
              [--session-dir <dir>]                         one-shot headless run
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0] !== undefined && !argv[0].startsWith("-") ? argv[0] : "chat";
  const rest = argv[0] === command ? argv.slice(1) : argv;

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      model: { type: "string" },
      continue: { type: "boolean", default: false },
      "session-dir": { type: "string" },
    },
  });

  const cwd = process.cwd();
  const config = await loadConfig({
    userDir: join(homedir(), ".keywork"),
    projectDir: join(cwd, ".keywork"),
  });
  const model = values.model ?? config.model;
  const resolved = resolveProvider(process.env, model);

  switch (command) {
    case "chat": {
      if (resolved === undefined) {
        console.error(providerSetupHint);
        return 1;
      }
      await chat({
        cwd,
        provider: resolved.provider,
        label: resolved.label,
        resume: values.continue,
        ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
      });
      return 0;
    }
    case "run": {
      const prompt = positionals.join(" ").trim();
      if (prompt === "") {
        console.error("keywork run requires a prompt");
        return 1;
      }
      await runHeadless({
        prompt,
        cwd,
        json: values.json,
        ...(resolved !== undefined && { provider: resolved.provider }),
        ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
      });
      return 0;
    }
    default: {
      console.log(usage);
      return command === "help" ? 0 : 1;
    }
  }
}

process.exitCode = await main(process.argv.slice(2));
