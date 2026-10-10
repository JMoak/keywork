import { CommandMissingError, type CommandResult, type CommandRunner } from "./command.ts";

export const serviceName = "keywork";

export class SecretStoreError extends Error {
  constructor(backend: string, reason: string) {
    super(`${backend}: ${reason}`);
    this.name = "SecretStoreError";
  }
}

export async function invoke(
  backend: string,
  run: CommandRunner,
  command: string,
  args: readonly string[],
  input?: string,
): Promise<CommandResult> {
  try {
    return await run(command, args, input);
  } catch (cause) {
    if (cause instanceof CommandMissingError) throw new SecretStoreError(backend, cause.message);
    throw cause;
  }
}

export function failed(backend: string, result: CommandResult): SecretStoreError {
  const reason = result.stderr.trim().split(/\r?\n/)[0] ?? "";
  return new SecretStoreError(backend, reason === "" ? `exit ${result.code}` : reason);
}
