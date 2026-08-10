import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "./define.ts";

const defaultTimeoutMs = 120_000;
const maxOutputChars = 30_000;

const schema = z.object({
  command: z.string().min(1).describe("Shell command to execute."),
  timeoutMs: z.number().int().min(1).optional().describe("Kill the command after this long."),
});

export interface Shell {
  file: string;
  args: (command: string) => string[];
  name: string;
}

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

export function bashTool(cwd: string, shell: Shell = detectShell()) {
  return defineTool({
    name: "bash",
    description: `Run a command in ${shell.name} from the working directory.`,
    schema,
    mutates: true,
    run: ({ command, timeoutMs = defaultTimeoutMs }, signal) =>
      execute(shell, command, cwd, timeoutMs, signal),
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
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(shell.file, shell.args(command), { cwd, windowsHide: true });
    let output = "";
    let timedOut = false;
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        rejectPromise(new Error(`Command timed out after ${timeoutMs}ms:\n${truncate(output)}`));
        return;
      }
      if (signal?.aborted) {
        rejectPromise(new Error("Command aborted"));
        return;
      }
      const body = truncate(output).trimEnd();
      resolvePromise(code === 0 ? body : `${body}\n(exit code ${code})`.trimStart());
    });
  });
}

function truncate(output: string): string {
  if (output.length <= maxOutputChars) return output;
  return `${output.slice(0, maxOutputChars)}\n... (output truncated)`;
}
