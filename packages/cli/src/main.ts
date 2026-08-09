import { parseArgs } from "node:util";
import { runHeadless } from "./run.ts";

const usage = `keywork — keyboard-first coding agent

Usage:
  keywork run "<prompt>" [--json] [--session-dir <dir>]
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "run") {
    console.log(usage);
    return command === undefined || command === "help" ? 0 : 1;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      "session-dir": { type: "string" },
    },
  });
  const prompt = positionals.join(" ").trim();
  if (prompt === "") {
    console.error("keywork run requires a prompt");
    return 1;
  }

  await runHeadless({
    prompt,
    cwd: process.cwd(),
    json: values.json,
    ...(values["session-dir"] !== undefined && { sessionDir: values["session-dir"] }),
  });
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
