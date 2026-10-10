import { within } from "../proc.ts";
import { detectShell, type Shell } from "./bash.ts";
import { scrubbedEnv } from "./command-run.ts";

export interface PtySize {
  cols: number;
  rows: number;
}

export interface PtyChild {
  readonly shellName: string;
  readonly pid: number | undefined;
  write(data: string | Uint8Array): void;
  resize(size: PtySize): void;
  onOutput(listener: (bytes: Uint8Array) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  kill(): Promise<void>;
}

export type PtySupport =
  | { available: true; open: (cwd: string, size: PtySize) => PtyChild }
  | { available: false; reason: string };

export interface PtyRuntimeFacts {
  platform: NodeJS.Platform;
  runtime: BunPtyRuntime | undefined;
  loginShell?: string | undefined;
}

export const ptyUnavailableOnWindows =
  "Bun's PTY is POSIX-only (no ConPTY in Bun.Terminal); Windows runs the pipe shell";
export const ptyUnavailableInRuntime =
  "this runtime has no Bun.Terminal (needs Bun 1.3.14+); running the pipe shell";

export function probePtySupport(
  facts: PtyRuntimeFacts = realPtyRuntimeFacts(),
  shell: Shell = interactiveShell(facts),
): PtySupport {
  if (facts.platform === "win32") return { available: false, reason: ptyUnavailableOnWindows };
  const runtime = facts.runtime;
  if (runtime === undefined) return { available: false, reason: ptyUnavailableInRuntime };
  const refusal = terminalRefusal(runtime);
  if (refusal !== undefined) return { available: false, reason: refusal };
  return { available: true, open: (cwd, size) => openPtyChild(runtime, shell, cwd, size) };
}

function terminalRefusal(runtime: BunPtyRuntime): string | undefined {
  try {
    new runtime.Terminal({ cols: 1, rows: 1 }).close();
    return undefined;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return `Bun.Terminal refused to open (${message}); running the pipe shell`;
  }
}

export function realPtyRuntimeFacts(): PtyRuntimeFacts {
  const candidate = (globalThis as { Bun?: Partial<BunPtyRuntime> }).Bun;
  const runtime =
    typeof candidate?.Terminal === "function" && typeof candidate.spawn === "function"
      ? (candidate as BunPtyRuntime)
      : undefined;
  return { platform: process.platform, runtime, loginShell: process.env.SHELL };
}

export function interactiveShell(facts: Pick<PtyRuntimeFacts, "platform" | "loginShell">): Shell {
  const login = facts.loginShell;
  if (facts.platform === "win32" || login === undefined || login === "") {
    return detectShell(facts.platform);
  }
  return { file: login, args: (command) => ["-c", command], name: basenameOf(login) };
}

export interface BunPtyRuntime {
  Terminal: new (options: BunTerminalOptions) => BunTerminal;
  spawn(command: string[], options: BunPtySpawnOptions): BunPtySubprocess;
}

export interface BunTerminalOptions {
  cols: number;
  rows: number;
  name?: string;
  data?: (terminal: BunTerminal, data: Uint8Array) => void;
  exit?: (terminal: BunTerminal, exitCode: number, signal: string | null) => void;
}

export interface BunTerminal {
  readonly closed: boolean;
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface BunPtySpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  terminal: BunTerminal;
}

export interface BunPtySubprocess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal?: number | NodeJS.Signals): void;
}

const terminalName = "xterm-256color";
const hangupGraceMs = 2_000;
const forceKillWaitMs = 1_000;

function openPtyChild(runtime: BunPtyRuntime, shell: Shell, cwd: string, size: PtySize): PtyChild {
  const outputListeners = new Set<(bytes: Uint8Array) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  const terminal = new runtime.Terminal({
    cols: size.cols,
    rows: size.rows,
    name: terminalName,
    data: (_terminal, bytes) => {
      for (const listener of outputListeners) listener(bytes);
    },
  });
  const child = runtime.spawn([shell.file, ...interactiveArgs(shell)], {
    cwd,
    env: { ...scrubbedEnv(process.env), TERM: terminalName },
    terminal,
  });
  let closed = false;
  const closeTerminal = (): void => {
    if (closed) return;
    closed = true;
    if (!terminal.closed) terminal.close();
  };
  const announceExit = (code: number | null): void => {
    closeTerminal();
    for (const listener of exitListeners) listener(code);
  };
  const exited: Promise<void> = child.exited.then(
    (code) => announceExit(code),
    () => announceExit(null),
  );
  return {
    shellName: shell.name,
    pid: child.pid,
    write: (data) => {
      if (!closed) terminal.write(data);
    },
    resize: ({ cols, rows }) => {
      if (!closed) terminal.resize(cols, rows);
    },
    onOutput: (listener) => {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    kill: () => hangUp(child, exited, closeTerminal),
  };
}

async function hangUp(
  child: BunPtySubprocess,
  exited: Promise<void>,
  closeTerminal: () => void,
): Promise<void> {
  closeTerminal();
  signal(child, "SIGHUP");
  if (await within(exited, hangupGraceMs)) return;
  signal(child, "SIGKILL");
  if (await within(exited, forceKillWaitMs)) return;
  throw new Error(`pty shell ${child.pid} survived SIGKILL`);
}

function signal(child: BunPtySubprocess, name: NodeJS.Signals): void {
  try {
    child.kill(name);
  } catch {
    return;
  }
}

function interactiveArgs(shell: Shell): string[] {
  return shell.name === "powershell" ? ["-NoLogo"] : ["-i"];
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
