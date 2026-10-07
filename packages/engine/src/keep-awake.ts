import { spawn } from "node:child_process";

export interface HeldProcess {
  kill(): void;
  onError(listener: () => void): void;
}

export type Spawner = (command: string, args: readonly string[]) => HeldProcess;

export type ExecutionStateSetter = (flags: number) => void;

export interface KeepAwakeHost {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly spawn: Spawner;
  loadExecutionState(): Promise<ExecutionStateSetter | undefined>;
  onExit(listener: () => void): void;
}

export interface WakeInhibitor {
  inhibit(): (() => void) | undefined;
}

export class KeepAwake {
  private running = false;
  private disposed = false;
  private undo: (() => void) | undefined;

  constructor(private readonly inhibitor: WakeInhibitor | undefined) {}

  get holding(): boolean {
    return this.undo !== undefined;
  }

  turnRunning(running: boolean): void {
    if (this.disposed || running === this.running) return;
    this.running = running;
    if (running) this.hold();
    else this.release();
  }

  dispose(): void {
    this.release();
    this.disposed = true;
  }

  private hold(): void {
    const inhibitor = this.inhibitor;
    if (inhibitor === undefined) return;
    this.undo = quietly(() => inhibitor.inhibit());
  }

  private release(): void {
    const undo = this.undo;
    this.undo = undefined;
    if (undo !== undefined) quietly(undo);
  }
}

export function keepAwake(host: KeepAwakeHost = systemHost()): KeepAwake {
  const awake = new KeepAwake(inhibitorFor(host));
  host.onExit(() => awake.dispose());
  return awake;
}

export function inhibitorFor(host: KeepAwakeHost): WakeInhibitor | undefined {
  const pid = String(host.pid);
  switch (host.platform) {
    case "win32":
      return threadExecutionState(host.loadExecutionState);
    case "darwin":
      return heldChild(host.spawn, "caffeinate", ["-i", "-w", pid]);
    case "linux":
      return heldChild(host.spawn, "systemd-inhibit", [
        "--what=idle",
        "--who=keywork",
        "--why=agent turn running",
        "tail",
        `--pid=${pid}`,
        "-f",
        "/dev/null",
      ]);
    default:
      return undefined;
  }
}

const esContinuous = 0x80000000;
const esSystemRequired = 0x00000001;

function threadExecutionState(
  load: () => Promise<ExecutionStateSetter | undefined>,
): WakeInhibitor {
  let setter: Promise<ExecutionStateSetter | undefined> | undefined;
  return {
    inhibit() {
      setter ??= load().catch(() => undefined);
      const loaded = setter;
      let released = false;
      void loaded.then((set) => {
        if (!released) quietly(() => set?.(esContinuous + esSystemRequired));
      });
      return () => {
        released = true;
        void loaded.then((set) => quietly(() => set?.(esContinuous)));
      };
    },
  };
}

function heldChild(spawner: Spawner, command: string, args: readonly string[]): WakeInhibitor {
  let missing = false;
  return {
    inhibit() {
      if (missing) return undefined;
      const child = spawner(command, args);
      child.onError(() => {
        missing = true;
      });
      return () => child.kill();
    },
  };
}

function quietly<T>(work: () => T): T | undefined {
  try {
    return work();
  } catch {
    return undefined;
  }
}

function systemHost(): KeepAwakeHost {
  return {
    platform: process.platform,
    pid: process.pid,
    spawn: spawnHeld,
    loadExecutionState: loadThreadExecutionState,
    onExit: (listener) => void process.once("exit", listener),
  };
}

function spawnHeld(command: string, args: readonly string[]): HeldProcess {
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.unref();
  return {
    kill: () => {
      const pid = child.pid;
      if (pid === undefined || child.exitCode !== null) return;
      if (quietly(() => process.kill(-pid, "SIGTERM")) === undefined) quietly(() => child.kill());
    },
    onError: (listener) => void child.once("error", listener),
  };
}

async function loadThreadExecutionState(): Promise<ExecutionStateSetter | undefined> {
  const { dlopen, FFIType } = await import("bun:ffi");
  const kernel = dlopen("kernel32.dll", {
    SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
  });
  return (flags) => void kernel.symbols.SetThreadExecutionState(flags);
}
