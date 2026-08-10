import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "./define.ts";

const defaultTimeoutMs = 120_000;
const maxOutputChars = 30_000;
const settleAfterExitMs = 100;
const killGraceMs = 2_000;

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

export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !holdsSecret(name)));
}

function holdsSecret(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.endsWith("_API_KEY") || upper.startsWith("KEYWORK_");
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
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(shell.file, shell.args(command), {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: scrubbedEnv(process.env),
    });
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let settleTimer: NodeJS.Timeout | undefined;

    const capture = (chunk: Buffer) => {
      onOutput?.(chunk.toString());
      if (truncated) return;
      output += chunk.toString();
      if (output.length > maxOutputChars) {
        output = output.slice(0, maxOutputChars);
        truncated = true;
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => killTree(child);
    signal?.addEventListener("abort", onAbort, { once: true });

    const rendered = () => (truncated ? `${output}\n... (output truncated)` : output);

    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      signal?.removeEventListener("abort", onAbort);
      outcome();
    };

    const finish = (code: number | null) =>
      settle(() => {
        if (timedOut) {
          rejectPromise(new Error(`Command timed out after ${timeoutMs}ms:\n${rendered()}`));
          return;
        }
        if (signal?.aborted) {
          rejectPromise(new Error("Command aborted"));
          return;
        }
        const body = rendered().trimEnd();
        resolvePromise(code === 0 ? body : `${body}\n(exit code ${code})`.trimStart());
      });

    child.on("error", (error) => settle(() => rejectPromise(error)));
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => {
      settleTimer = setTimeout(() => finish(code), settleAfterExitMs);
    });
  });
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    return;
  }
  signalGroup(pid, "SIGTERM");
  setTimeout(() => signalGroup(pid, "SIGKILL"), killGraceMs).unref();
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}
