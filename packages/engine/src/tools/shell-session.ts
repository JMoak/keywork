import { type ChildProcess, spawn } from "node:child_process";
import { z } from "zod";
import { killTree } from "../proc.ts";
import type { Tool } from "../tools.ts";
import { detectShell, type Shell, scrubbedEnv } from "./bash.ts";
import { defineTool } from "./define.ts";

const defaultTimeoutMs = 120_000;
const maxOutputChars = 30_000;

export interface ShellRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export function persistentBashTool(
  session: ShellSession,
  onOutput?: (chunk: string) => void,
): Tool {
  return defineTool({
    name: "bash",
    description: `Run a command in ${session.shellName} from the working directory. The shell persists across calls: cwd changes, exported variables, and activated environments stay live.`,
    schema: z.object({
      command: z.string().min(1).describe("Shell command to execute."),
      timeoutMs: z.number().int().min(1).optional().describe("Kill the command after this long."),
    }),
    mutates: true,
    run: (args, signal) =>
      session.run(args.command, {
        ...(args.timeoutMs !== undefined && { timeoutMs: args.timeoutMs }),
        ...(signal !== undefined && { signal }),
        ...(onOutput !== undefined && { onOutput }),
      }),
  });
}

export class ShellSession {
  private live: LiveShell | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cwd: string,
    private readonly shell: Shell = detectShell(),
  ) {}

  get shellName(): string {
    return this.shell.name;
  }

  running(): boolean {
    return this.live !== undefined;
  }

  pid(): number | undefined {
    return this.live?.child.pid;
  }

  run(command: string, options: ShellRunOptions = {}): Promise<string> {
    const turn = this.queue.then(() => this.execute(command, options));
    this.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  reset(): Promise<void> {
    return this.terminate();
  }

  close(): Promise<void> {
    return this.terminate();
  }

  private async terminate(): Promise<void> {
    const live = this.live;
    this.live = undefined;
    if (live === undefined) return;
    await killTree(live.child, live.closed).catch(() => undefined);
  }

  private execute(command: string, options: ShellRunOptions): Promise<string> {
    options.signal?.throwIfAborted();
    this.live ??= spawnShell(this.cwd, this.shell);
    const live = this.live;
    return new Promise((resolvePromise, rejectPromise) => {
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
      const sentinel = `__keywork_${crypto.randomUUID()}__`;
      const output = new BoundedOutput(options.onOutput);
      let exitCode: number | undefined;
      let settled = false;

      const stdout = new SentinelScanner(sentinel, output, (code) => {
        exitCode = code ?? 0;
        maybeFinish();
      });
      const stderr = new SentinelScanner(sentinel, output, () => maybeFinish());
      const onStdout = (chunk: Buffer) => stdout.push(chunk.toString());
      const onStderr = (chunk: Buffer) => stderr.push(chunk.toString());

      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        live.child.stdout?.off("data", onStdout);
        live.child.stderr?.off("data", onStderr);
        live.child.off("close", onShellExit);
        outcome();
      };

      const maybeFinish = () => {
        if (!stdout.sawSentinel || !stderr.sawSentinel) return;
        const body = output.rendered().trimEnd();
        const code = exitCode ?? 0;
        settle(() =>
          resolvePromise(code === 0 ? body : `${body}\n(exit code ${code})`.trimStart()),
        );
      };

      const onShellExit = () => {
        this.live = undefined;
        const body = output.rendered().trimEnd();
        settle(() =>
          resolvePromise(
            `${body}\n(shell exited; a fresh shell starts on the next command)`.trimStart(),
          ),
        );
      };

      const abandon = (reason: string) => {
        void this.terminate();
        settle(() => rejectPromise(new Error(reason)));
      };

      const timer = setTimeout(
        () => abandon(`Command timed out after ${timeoutMs}ms:\n${output.rendered()}`),
        timeoutMs,
      );
      const onAbort = () => abandon("Command aborted");
      options.signal?.addEventListener("abort", onAbort, { once: true });

      live.child.stdout?.on("data", onStdout);
      live.child.stderr?.on("data", onStderr);
      live.child.on("close", onShellExit);
      live.child.stdin?.write(framedCommand(this.shell, command, sentinel));
    });
  }
}

interface LiveShell {
  child: ChildProcess;
  closed: Promise<void>;
}

function spawnShell(cwd: string, shell: Shell): LiveShell {
  const child = spawn(shell.file, persistentArgs(shell), {
    cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: scrubbedEnv(process.env),
  });
  const closed = new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
  return { child, closed };
}

function persistentArgs(shell: Shell): string[] {
  return shell.name === "powershell" ? ["-NoProfile", "-NonInteractive", "-Command", "-"] : [];
}

function framedCommand(shell: Shell, command: string, sentinel: string): string {
  if (shell.name === "powershell") {
    return [
      command,
      `"\`n${sentinel} $(if ($?) { 0 } else { 1 })"`,
      `[Console]::Error.WriteLine("\`n${sentinel}")`,
      "",
    ].join("\n");
  }
  const heredoc = `${sentinel}heredoc`;
  return [
    `eval "$(cat <<'${heredoc}'`,
    command,
    heredoc,
    `)"`,
    `printf '\\n%s %s\\n' '${sentinel}' "$?"`,
    `printf '\\n%s\\n' '${sentinel}' >&2`,
    "",
  ].join("\n");
}

class BoundedOutput {
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

class SentinelScanner {
  sawSentinel = false;
  private buffer = "";

  constructor(
    private readonly sentinel: string,
    private readonly output: BoundedOutput,
    private readonly onSentinel: (exitCode?: number) => void,
  ) {}

  push(chunk: string): void {
    if (this.sawSentinel) return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith(this.sentinel)) {
        this.sawSentinel = true;
        this.onSentinel(exitCodeIn(line, this.sentinel));
        return;
      }
      this.output.append(line);
      newline = this.buffer.indexOf("\n");
    }
  }
}

function exitCodeIn(line: string, sentinel: string): number | undefined {
  const code = Number.parseInt(line.slice(sentinel.length).trim(), 10);
  return Number.isNaN(code) ? undefined : code;
}
