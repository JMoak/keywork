import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "./define.ts";

const defaultTimeoutMs = 120_000;
const maxOutputChars = 30_000;
const settleAfterExitMs = 100;
const killGraceMs = 2_000;
const killCheckIntervalMs = 25;
const forceKillWaitMs = 1_000;

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
    const closed = childClosed(child);
    let output = "";
    let truncated = false;
    let terminationReason: TerminationReason | undefined;
    let termination: Promise<void> | undefined;
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

    const rendered = () => (truncated ? `${output}\n... (output truncated)` : output);

    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      signal?.removeEventListener("abort", onAbort);
      outcome();
    };

    const finish = async (code: number | null) => {
      let terminationFailure: unknown;
      try {
        await termination;
      } catch (cause) {
        terminationFailure = cause;
      }
      settle(() => {
        if (terminationReason === "timeout") {
          rejectPromise(
            new Error(`Command timed out after ${timeoutMs}ms:\n${rendered()}`, {
              ...(terminationFailure !== undefined && { cause: terminationFailure }),
            }),
          );
          return;
        }
        if (terminationReason === "abort") {
          rejectPromise(
            new Error("Command aborted", {
              ...(terminationFailure !== undefined && { cause: terminationFailure }),
            }),
          );
          return;
        }
        const body = rendered().trimEnd();
        resolvePromise(code === 0 ? body : `${body}\n(exit code ${code})`.trimStart());
      });
    };

    const terminate = (reason: TerminationReason) => {
      if (settled || termination !== undefined) return;
      terminationReason = reason;
      termination = killTree(child, closed);
      void termination.then(
        () => finish(null),
        () => finish(null),
      );
    };

    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const onAbort = () => terminate("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) terminate("abort");

    child.on("error", (error) => settle(() => rejectPromise(error)));
    child.on("close", (code) => void finish(code));
    child.on("exit", (code) => {
      settleTimer = setTimeout(() => void finish(code), settleAfterExitMs);
    });
  });
}

function killTree(child: ChildProcess, closed: Promise<void>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (process.platform === "win32") {
    return killWindowsTree(pid, closed);
  }
  return killPosixTree(pid);
}

async function killWindowsTree(pid: number, closed: Promise<void>): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", rejectPromise);
    killer.once("close", (code) => {
      if (code === 0 || !processExists(pid)) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`taskkill exited with code ${code}`));
    });
  });
  if (await within(closed, forceKillWaitMs)) return;
  throw new Error(`process tree ${pid} did not close after taskkill`);
}

async function killPosixTree(pid: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  if (await waitForExit(() => processGroupExists(pid), killGraceMs)) return;
  signalGroup(pid, "SIGKILL");
  if (await waitForExit(() => processGroupExists(pid), forceKillWaitMs)) return;
  throw new Error(`process group ${pid} survived SIGKILL`);
}

async function waitForExit(alive: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (alive()) {
    if (Date.now() >= deadline) return false;
    await delay(killCheckIntervalMs);
  }
  return true;
}

function childClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => child.once("close", () => resolvePromise()));
}

function within(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let finished = false;
    const finish = (result: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void completion.then(() => finish(true));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return permissionDenied(cause);
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    return permissionDenied(cause);
  }
}

function permissionDenied(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EPERM";
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}
