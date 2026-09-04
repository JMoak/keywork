import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { killTree } from "../proc.ts";
import {
  BoundedOutput,
  CommandRun,
  childClosed,
  commandAborted,
  commandResult,
  commandTimedOut,
  defaultTimeoutMs,
  shellSpawnOptions,
} from "./command-run.ts";
import { defineTool } from "./define.ts";

const settleAfterExitMs = 100;

const schema = z.object({
  command: z.string().min(1).describe("Shell command to execute."),
  timeoutMs: z.number().int().min(1).optional().describe("Kill the command after this long."),
});

export interface Shell {
  file: string;
  args: (command: string) => string[];
  name: string;
}

type TerminationReason = "abort" | "timeout";

export function detectShell(platform: NodeJS.Platform = process.platform): Shell {
  if (platform !== "win32") {
    return { file: "/bin/sh", args: (command) => ["-c", command], name: "sh" };
  }
  const gitBash = findGitBash();
  if (gitBash !== undefined) {
    return { file: gitBash, args: (command) => ["-c", command], name: "bash" };
  }
  return {
    file: "powershell.exe",
    args: (command) => ["-NoProfile", "-NonInteractive", "-Command", command],
    name: "powershell",
  };
}

export function bashTool(
  cwd: string,
  shell: Shell = detectShell(),
  onOutput?: (chunk: string) => void,
) {
  return defineTool({
    name: "bash",
    description: `Run a command in ${shell.name} from the working directory.`,
    schema,
    mutates: true,
    run: ({ command, timeoutMs = defaultTimeoutMs }, signal) =>
      execute(shell, command, cwd, timeoutMs, signal, onOutput),
  });
}

function findGitBash(): string | undefined {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];
  return roots
    .filter((root): root is string => root !== undefined)
    .map((root) => join(root, "Git", "bin", "bash.exe"))
    .find((candidate) => existsSync(candidate));
}

function execute(
  shell: Shell,
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onOutput?: (chunk: string) => void,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(shell.file, shell.args(command), shellSpawnOptions(cwd));
    const closed = childClosed(child);
    const output = new BoundedOutput(onOutput);
    let terminationReason: TerminationReason | undefined;
    let termination: Promise<void> | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    const capture = (chunk: Buffer) => output.append(chunk.toString());
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const run = new CommandRun({
      timeoutMs,
      signal,
      onTimeout: () => terminate("timeout"),
      onAbort: () => terminate("abort"),
    });

    const settle = (outcome: () => void) =>
      run.settle(() => {
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        outcome();
      });

    const finish = async (code: number | null) => {
      let terminationFailure: unknown;
      try {
        await termination;
      } catch (cause) {
        terminationFailure = cause;
      }
      settle(() => {
        if (terminationReason === "timeout") {
          rejectPromise(commandTimedOut(timeoutMs, output.rendered(), terminationFailure));
          return;
        }
        if (terminationReason === "abort") {
          rejectPromise(commandAborted(terminationFailure));
          return;
        }
        resolvePromise(commandResult(output.rendered(), code));
      });
    };

    const terminate = (reason: TerminationReason) => {
      if (termination !== undefined) return;
      terminationReason = reason;
      termination = killTree(child, closed);
      void termination.then(
        () => finish(null),
        () => finish(null),
      );
    };

    child.on("error", (error) => settle(() => rejectPromise(error)));
    child.on("close", (code) => void finish(code));
    child.on("exit", (code) => {
      settleTimer = setTimeout(() => void finish(code), settleAfterExitMs);
    });
  });
}
