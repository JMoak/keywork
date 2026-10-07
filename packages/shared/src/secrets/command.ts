import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: string,
) => Promise<CommandResult>;

export class CommandMissingError extends Error {
  constructor(readonly command: string) {
    super(`${command} is not installed`);
    this.name = "CommandMissingError";
  }
}

export const runCommand: CommandRunner = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "pipe", windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new CommandMissingError(command) : error),
    );
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
