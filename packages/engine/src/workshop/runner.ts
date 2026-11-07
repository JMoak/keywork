import { spawn } from "node:child_process";
import { CommandMissingError } from "@keywork/shared";
import { scrubbedEnv } from "../tools/command-run.ts";

export interface Invocation {
  readonly args: readonly string[];
  readonly input?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type CliRunner = (invocation: Invocation) => Promise<Outcome>;

export interface ProcessLaunch {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs?: number;
}

export function spawnRunner(program: string): CliRunner {
  return (invocation) =>
    runProcess({
      file: program,
      args: invocation.args,
      env: { ...scrubbedEnv(process.env), ...invocation.env },
      ...(invocation.cwd !== undefined && { cwd: invocation.cwd }),
      ...(invocation.input !== undefined && { input: invocation.input }),
      ...(invocation.timeoutMs !== undefined && { timeoutMs: invocation.timeoutMs }),
    });
}

export function runProcess(launch: ProcessLaunch): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, [...launch.args], {
      stdio: "pipe",
      windowsHide: true,
      cwd: launch.cwd,
      env: launch.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer =
      launch.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, launch.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new CommandMissingError(launch.file) : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(launch.input ?? "");
  });
}
