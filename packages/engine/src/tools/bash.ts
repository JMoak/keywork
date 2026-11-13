import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { killTree } from "../proc.ts";
import { type Launch, sandboxedToolNote, unconfined } from "../sandbox/sandbox.ts";
import { fixedSandbox, type ToolSandbox } from "../sandbox/session.ts";
import {
  agentShellEnv,
  BoundedOutput,
  CommandRun,
  childClosed,
  commandAborted,
  commandResult,
  commandTimedOut,
  defaultTimeoutMs,
  scrubbedEnv,
  shellSpawnOptions,
} from "./command-run.ts";
import { defineTool } from "./define.ts";

const settleAfterExitMs = 100;
const msysGroupMarker = "keywork-msys-group";

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

interface CommandWatch {
  onOutput?: ((chunk: string) => void) | undefined;
  onExit?: ((exitCode: number) => void) | undefined;
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
  sandbox: ToolSandbox = fixedSandbox(unconfined),
  onExit?: (exitCode: number) => void,
) {
  return defineTool({
    name: "bash",
    description: `Run a command in ${shell.name} from the working directory.${sandboxedToolNote(sandbox.configured)}`,
    schema,
    mutates: true,
    run: async ({ command, timeoutMs = defaultTimeoutMs }, signal) => {
      const launch = (await sandbox.current()).confine(shellLaunch(shell, command, cwd));
      return execute(shell, launch, timeoutMs, signal, { onOutput, onExit });
    },
  });
}

export function isMsysShell(shell: Shell, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && shell.name === "bash";
}

export const msysGroupAnnouncement = `printf '%s %s\\n' ${msysGroupMarker} "$$"`;

export function announcedGroup(line: string): number | undefined {
  const [marker, group] = line.trim().split(" ");
  if (marker !== msysGroupMarker) return undefined;
  const pid = Number(group);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

// Cygwin runs an exec'd program in a new Windows process whose parent has already exited,
// so taskkill /t cannot reach it; the MSYS process group still holds it.
export function sweepMsysGroup(shell: Shell, group: number | undefined): Promise<void> {
  if (group === undefined) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const sweeper = spawn(shell.file, shell.args(`kill -9 -- -${group}`), {
      windowsHide: true,
      stdio: "ignore",
      env: scrubbedEnv(process.env),
    });
    sweeper.once("error", () => resolvePromise());
    sweeper.once("close", () => resolvePromise());
  });
}

function shellLaunch(shell: Shell, command: string, cwd: string): Launch {
  const script = isMsysShell(shell) ? `${msysGroupAnnouncement}; ${command}` : command;
  return { file: shell.file, args: shell.args(script), cwd, env: agentShellEnv() };
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
  launch: Launch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  { onOutput, onExit }: CommandWatch,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(launch.file, [...launch.args], {
      ...shellSpawnOptions(launch.cwd),
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = childClosed(child);
    const output = new BoundedOutput(onOutput);
    const announcement = isMsysShell(shell) ? new GroupAnnouncement(output) : undefined;
    let terminationReason: TerminationReason | undefined;
    let termination: Promise<void> | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (chunk: Buffer) => (announcement ?? output).append(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.append(chunk.toString()));

    const run = new CommandRun({
      timeoutMs,
      signal,
      onTimeout: () => terminate("timeout"),
      onAbort: () => terminate("abort"),
    });

    const settle = (outcome: () => void) =>
      run.settle(() => {
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        announcement?.flush();
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
        if (code !== null) onExit?.(code);
        resolvePromise(commandResult(output.rendered(), code));
      });
    };

    const terminate = (reason: TerminationReason) => {
      if (termination !== undefined) return;
      terminationReason = reason;
      termination = killTree(child, closed, () => sweepMsysGroup(shell, announcement?.group));
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

class GroupAnnouncement {
  group: number | undefined;
  private held: string | undefined = "";

  constructor(private readonly output: BoundedOutput) {}

  append(chunk: string): void {
    if (this.held === undefined) {
      this.output.append(chunk);
      return;
    }
    this.held += chunk;
    const newline = this.held.indexOf("\n");
    if (newline !== -1) this.hear(this.held.slice(0, newline), this.held.slice(newline + 1));
  }

  flush(): void {
    if (this.held) this.output.append(this.held);
    this.held = undefined;
  }

  private hear(firstLine: string, rest: string): void {
    this.group = announcedGroup(firstLine);
    this.held = this.group === undefined ? `${firstLine}\n${rest}` : rest;
    this.flush();
  }
}
