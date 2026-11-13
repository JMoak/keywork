import { type ChildProcess, spawn } from "node:child_process";
import { z } from "zod";
import { killTree } from "../proc.ts";
import { type Sandbox, sandboxedToolNote, unconfined } from "../sandbox/sandbox.ts";
import { fixedSandbox, type ToolSandbox } from "../sandbox/session.ts";
import type { Tool } from "../tools.ts";
import {
  announcedGroup,
  detectShell,
  isMsysShell,
  msysGroupAnnouncement,
  type Shell,
  sweepMsysGroup,
} from "./bash.ts";
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

export interface ShellRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  onExit?: (exitCode: number) => void;
  sandbox?: ToolSandbox;
}

export interface PersistentShell {
  readonly shellName: string;
  run(command: string, options?: ShellRunOptions): Promise<string>;
  workingDirectory?(): string;
  close(): Promise<void>;
}

export function persistentBashTool(
  session: PersistentShell,
  onOutput?: (chunk: string) => void,
  sandbox: ToolSandbox = fixedSandbox(unconfined),
  onExit?: (exitCode: number) => void,
): Tool {
  return defineTool({
    name: "bash",
    description: `Run a command in ${session.shellName} from the working directory. The shell persists across calls: cwd changes, exported variables, and activated environments stay live.${sandboxedToolNote(sandbox.configured)}`,
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
        ...(onExit !== undefined && { onExit }),
        sandbox,
      }),
  });
}

export class ShellSession implements PersistentShell {
  private live: LiveShell | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cwd: string,
    private readonly shell: Shell = detectShell(),
  ) {}

  get shellName(): string {
    return this.shell.name;
  }

  workingDirectory(): string {
    return this.live?.workingDirectory ?? this.cwd;
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
    const sweepOrphans = () => sweepMsysGroup(this.shell, live.group);
    await killTree(live.child, live.closed, sweepOrphans).catch(() => undefined);
  }

  private spawnLive(sandbox: Sandbox): LiveShell {
    const live = spawnShell(this.cwd, this.shell, sandbox, agentShellEnv());
    this.live = live;
    void live.closed.then(() => {
      if (this.live === live) this.live = undefined;
    });
    return live;
  }

  private async execute(command: string, options: ShellRunOptions): Promise<string> {
    options.signal?.throwIfAborted();
    const live = this.live ?? (await this.startShell(options));
    return this.runIn(live, command, options);
  }

  private async startShell(options: ShellRunOptions): Promise<LiveShell> {
    const sandbox = (await options.sandbox?.current()) ?? unconfined;
    options.signal?.throwIfAborted();
    const live = this.spawnLive(sandbox);
    await this.prepare(live, options.signal);
    return live;
  }

  private async prepare(live: LiveShell, signal: AbortSignal | undefined): Promise<void> {
    if (this.shell.name === "powershell") live.child.stdin?.write(`${nativeStdinFromNul}\n`);
    if (isMsysShell(this.shell)) await this.learnGroup(live, signal);
  }

  private async learnGroup(live: LiveShell, signal: AbortSignal | undefined): Promise<void> {
    const answer = await this.runIn(live, msysGroupAnnouncement, signal ? { signal } : {});
    if (this.live !== live) throw new Error(answer);
    live.group = announcedGroup(answer);
  }

  private runIn(live: LiveShell, command: string, options: ShellRunOptions): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
      const sentinel = `__keywork_${crypto.randomUUID()}__`;
      const output = new BoundedOutput(options.onOutput);
      let exitCode: number | undefined;

      const stdout = new SentinelScanner(sentinel, output, (code, workingDirectory) => {
        exitCode = code ?? 0;
        live.workingDirectory = workingDirectory ?? live.workingDirectory;
        maybeFinish();
      });
      const stderr = new SentinelScanner(sentinel, output, () => maybeFinish());
      const onStdout = (chunk: Buffer) => stdout.push(chunk.toString());
      const onStderr = (chunk: Buffer) => stderr.push(chunk.toString());

      const run = new CommandRun({
        timeoutMs,
        signal: options.signal,
        onTimeout: () => abandon(commandTimedOut(timeoutMs, output.rendered())),
        onAbort: () => abandon(commandAborted()),
      });

      const settle = (outcome: () => void) =>
        run.settle(() => {
          live.child.stdout?.off("data", onStdout);
          live.child.stderr?.off("data", onStderr);
          live.child.off("close", onShellExit);
          live.failureListeners.delete(onShellFailure);
          outcome();
        });

      const maybeFinish = () => {
        if (!stdout.sawSentinel || !stderr.sawSentinel) return;
        settle(() => {
          options.onExit?.(exitCode ?? 0);
          resolvePromise(commandResult(output.rendered(), exitCode ?? 0));
        });
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

      const abandon = (failure: Error) => {
        void this.terminate();
        settle(() => rejectPromise(failure));
      };

      const onShellFailure = (failure: Error) => abandon(failure);

      live.child.stdout?.on("data", onStdout);
      live.child.stderr?.on("data", onStderr);
      live.child.on("close", onShellExit);
      live.failureListeners.add(onShellFailure);
      live.child.stdin?.write(framedCommand(this.shell, command, sentinel));
    });
  }
}

interface LiveShell {
  child: ChildProcess;
  closed: Promise<void>;
  failureListeners: Set<(failure: Error) => void>;
  group: number | undefined;
  workingDirectory: string | undefined;
}

function spawnShell(
  cwd: string,
  shell: Shell,
  sandbox: Sandbox,
  env: NodeJS.ProcessEnv,
): LiveShell {
  const options = shellSpawnOptions(cwd);
  const launch = sandbox.confine({ file: shell.file, args: persistentArgs(shell), cwd, env });
  const child = spawn(launch.file, [...launch.args], { ...options, env: launch.env });
  const closed = childClosed(child);
  const failureListeners = new Set<(failure: Error) => void>();
  const broadcastFailure = (failure: Error) => {
    for (const listener of failureListeners) listener(failure);
  };
  child.on("error", broadcastFailure);
  child.stdin?.on("error", broadcastFailure);
  return { child, closed, failureListeners, group: undefined, workingDirectory: undefined };
}

function persistentArgs(shell: Shell): string[] {
  return shell.name === "powershell" ? ["-NoProfile", "-NonInteractive", "-Command", "-"] : [];
}

// PowerShell hands its own stdin, the command pipe, to native programs. Pointing the process
// stdin at NUL gives them EOF while PowerShell keeps reading commands from the pipe it holds.
const nativeStdinFromNul = [
  "try { Add-Type -Namespace Keywork -Name NativeStdin -MemberDefinition '",
  '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);',
  '[DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);',
  '[DllImport("kernel32.dll")] static extern bool SetStdHandle(int stream, IntPtr handle);',
  "const uint GenericRead = 0x80000000, ShareReadWrite = 3, OpenExisting = 3, Inheritable = 1;",
  "const int StandardInput = -10;",
  "public static void FromNul() {",
  'IntPtr nul = CreateFileW("NUL", GenericRead, ShareReadWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);',
  "SetHandleInformation(nul, Inheritable, Inheritable);",
  "SetStdHandle(StandardInput, nul); }';",
  "[Keywork.NativeStdin]::FromNul() } catch {}",
].join(" ");

function framedCommand(shell: Shell, command: string, sentinel: string): string {
  if (shell.name === "powershell") {
    return [
      command,
      `"\`n${sentinel} $(if ($?) { 0 } else { 1 }) $($PWD.ProviderPath)"`,
      `[Console]::Error.WriteLine("\`n${sentinel}")`,
      "",
    ].join("\n");
  }
  const heredoc = `${sentinel}heredoc`;
  return [
    `eval "$(cat <<'${heredoc}'`,
    command,
    heredoc,
    `)" </dev/null`,
    ...exitAndPlaceReport(shell, sentinel),
    `printf '\\n%s\\n' '${sentinel}' >&2`,
    "",
  ].join("\n");
}

// MSYS rewrites $PWD under its own mounts (%TEMP% reads as /tmp), so only `pwd -W` names the
// folder Windows knows; it is a builtin, so it costs no fork.
function exitAndPlaceReport(shell: Shell, sentinel: string): string[] {
  if (!isMsysShell(shell)) return [`printf '\\n%s %s %s\\n' '${sentinel}' "$?" "$PWD"`];
  return [`printf '\\n%s %s ' '${sentinel}' "$?"`, `pwd -W 2>/dev/null || printf '\\n'`];
}

export class SentinelScanner {
  sawSentinel = false;
  private buffer = "";
  private midLine = false;
  private heldBlankLines = 0;

  constructor(
    private readonly sentinel: string,
    private readonly output: BoundedOutput,
    private readonly onSentinel: (exitCode?: number, workingDirectory?: string) => void,
  ) {}

  push(chunk: string): void {
    if (this.sawSentinel) return;
    this.buffer += chunk;
    this.drainCompleteLines();
    this.flushOverlongLine();
  }

  private drainCompleteLines(): void {
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1 && !this.sawSentinel) {
      const line = this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    if (!this.midLine && line.startsWith(this.sentinel)) {
      this.sawSentinel = true;
      this.releaseBlankLines(this.heldBlankLines - newlinesBeforeSentinel);
      const { exitCode, workingDirectory } = sentinelReport(line, this.sentinel);
      this.onSentinel(exitCode, workingDirectory);
      return;
    }
    if (!this.midLine && line === "\n") {
      this.heldBlankLines += 1;
      return;
    }
    this.midLine = false;
    this.append(line);
  }

  private flushOverlongLine(): void {
    if (this.sawSentinel || this.buffer.length <= longestHeldLine) return;
    this.append(this.buffer);
    this.buffer = "";
    this.midLine = true;
  }

  private append(text: string): void {
    this.releaseBlankLines(this.heldBlankLines);
    this.output.append(text);
  }

  private releaseBlankLines(count: number): void {
    if (count > 0) this.output.append("\n".repeat(count));
    this.heldBlankLines = 0;
  }
}

const longestHeldLine = 30_000;

const newlinesBeforeSentinel = 1;

function sentinelReport(
  line: string,
  sentinel: string,
): { exitCode?: number; workingDirectory?: string } {
  const [code = "", ...directory] = line.slice(sentinel.length).trim().split(" ");
  const exitCode = Number.parseInt(code, 10);
  const workingDirectory = directory.join(" ");
  return {
    ...(!Number.isNaN(exitCode) && { exitCode }),
    ...(workingDirectory !== "" && { workingDirectory }),
  };
}

export interface InteractiveShell {
  readonly shellName: string;
  write(text: string): void;
  onOutput(listener: (chunk: string) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  kill(): Promise<void>;
}

export function openInteractiveShell(
  cwd: string,
  shell: Shell = detectShell(),
  sandbox: Sandbox = unconfined,
): InteractiveShell {
  const live = spawnShell(cwd, shell, sandbox, scrubbedEnv(process.env));
  const { child } = live;
  const onExit = (listener: (code: number | null) => void): (() => void) => {
    const handler = (code: number | null) => listener(code);
    child.on("close", handler);
    return () => child.off("close", handler);
  };
  return {
    shellName: shell.name,
    write: (text) => {
      child.stdin?.write(text);
    },
    onOutput: (listener) => {
      const handler = (chunk: Buffer) => listener(chunk.toString());
      child.stdout?.on("data", handler);
      child.stderr?.on("data", handler);
      return () => {
        child.stdout?.off("data", handler);
        child.stderr?.off("data", handler);
      };
    },
    onExit,
    kill: () => killTree(child, live.closed).catch(() => undefined),
  };
}
