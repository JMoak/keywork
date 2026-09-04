import type { ChildProcess, SpawnOptions } from "node:child_process";

export const defaultTimeoutMs = 120_000;
export const maxOutputChars = 30_000;

export function shellSpawnOptions(cwd: string): SpawnOptions {
  return {
    cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: scrubbedEnv(process.env),
  };
}

export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !holdsSecret(name)));
}

export function childClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => child.once("close", () => resolvePromise()));
}

export class BoundedOutput {
  private text = "";
  private truncated = false;

  constructor(private readonly forward?: (chunk: string) => void) {}

  append(chunk: string): void {
    this.forward?.(chunk);
    if (this.truncated) return;
    this.text += chunk;
    if (this.text.length > maxOutputChars) {
      this.text = this.text.slice(0, maxOutputChars);
      this.truncated = true;
    }
  }

  rendered(): string {
    return this.truncated ? `${this.text}\n... (output truncated)` : this.text;
  }
}

export interface CommandRunOptions {
  timeoutMs: number;
  signal: AbortSignal | undefined;
  onTimeout: () => void;
  onAbort: () => void;
}

export class CommandRun {
  private settled = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: CommandRunOptions) {
    this.timer = setTimeout(options.onTimeout, options.timeoutMs);
    options.signal?.addEventListener("abort", options.onAbort, { once: true });
  }

  settle(outcome: () => void): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.options.onAbort);
    outcome();
  }
}

export function commandResult(rendered: string, exitCode: number | null): string {
  const body = rendered.trimEnd();
  return exitCode === 0 ? body : `${body}\n(exit code ${exitCode})`.trimStart();
}

export function commandTimedOut(timeoutMs: number, rendered: string, cause?: unknown): Error {
  return new Error(`Command timed out after ${timeoutMs}ms:\n${rendered}`, {
    ...(cause !== undefined && { cause }),
  });
}

export function commandAborted(cause?: unknown): Error {
  return new Error("Command aborted", { ...(cause !== undefined && { cause }) });
}

function holdsSecret(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.endsWith("_API_KEY") || upper.startsWith("KEYWORK_");
}
