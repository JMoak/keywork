import { runProcess } from "@keywork/engine";
import { CommandMissingError } from "@keywork/shared";

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (program: string, args: readonly string[]) => Promise<Ran>;

export const missingCommandExit = 127;

export const systemRunner: CommandRunner = async (program, args) => {
  try {
    const outcome = await runProcess({ file: program, args, env: process.env, timeoutMs: 60_000 });
    return { code: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr };
  } catch (cause) {
    if (cause instanceof CommandMissingError) {
      return { code: missingCommandExit, stdout: "", stderr: `${program} is not on PATH` };
    }
    throw cause;
  }
};

export function failureText(program: string, args: readonly string[], ran: Ran): string {
  const said = (ran.stderr.trim() || ran.stdout.trim()).split(/\r?\n/).slice(-3).join(" · ");
  return `${program} ${args.join(" ")} exited ${ran.code}${said === "" ? "" : `: ${said}`}`;
}
