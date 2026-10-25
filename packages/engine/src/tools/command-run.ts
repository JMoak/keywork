import type { ChildProcess, SpawnOptions } from "node:child_process";

export const defaultTimeoutMs = 120_000;
export const retainedOutputChars = 1_048_576;

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

export function agentShellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...scrubbedEnv(env), ...unattendedShellMarkers };
}

export function childClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => child.once("close", () => resolvePromise()));
}

export class BoundedOutput {
  private head = "";
  private tail = "";
  private dropped = 0;

  constructor(private readonly forward?: (chunk: string) => void) {}

  append(chunk: string): void {
    this.forward?.(chunk);
    const room = headChars - this.head.length;
    this.head += chunk.slice(0, Math.max(0, room));
    const rest = room > 0 ? chunk.slice(room) : chunk;
    if (rest === "") return;
    this.tail += rest;
    if (this.tail.length > 2 * tailChars) this.dropOldestTail();
  }

  rendered(): string {
    const tail = this.tail.slice(-tailChars);
    const elided = this.dropped + this.tail.length - tail.length;
    if (elided === 0) return this.head + tail;
    return `${this.head}\n... (${elided} characters elided from the middle)\n${tail}`;
  }

  private dropOldestTail(): void {
    this.dropped += this.tail.length - tailChars;
    this.tail = this.tail.slice(-tailChars);
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

const headChars = retainedOutputChars / 2;
const tailChars = retainedOutputChars / 2;

const unattendedShellMarkers = { KEYWORK: "1", CI: "1" } as const;

function holdsSecret(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.endsWith("_API_KEY") || upper.startsWith("KEYWORK_");
}
