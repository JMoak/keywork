import { backoffMs, type Cancel, type Clock } from "@keywork/engine";
import {
  type Crash,
  CrashLedger,
  type CrashLoopPolicy,
  crashLoopPolicy,
  crashLoopReason,
} from "./crash-loop.ts";
import type { UnitState } from "./node-file.ts";

export interface UnitSpec {
  name: string;
  argv: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>> | undefined;
  occupied?: (() => Promise<boolean>) | undefined;
}

export interface ChildExit {
  code: number | null;
  signal: string | null;
}

export interface SupervisedChild {
  readonly pid: number | null;
  readonly exited: Promise<ChildExit>;
  stop(): void;
  kill(): void;
}

export type OutputStream = "stdout" | "stderr";

export type LineListener = (stream: OutputStream, line: string) => void;

export type ProcessSpawner = (unit: UnitSpec, onLine: LineListener) => SupervisedChild;

export interface SupervisionPolicy {
  crashLoop: CrashLoopPolicy;
  backoffFirstMs: number;
  backoffMaxMs: number;
  adoptRecheckMs: number;
  stopGraceMs: number;
}

export const supervisionPolicy: SupervisionPolicy = {
  crashLoop: crashLoopPolicy,
  backoffFirstMs: 1_000,
  backoffMaxMs: 60_000,
  adoptRecheckMs: 30_000,
  stopGraceMs: 10_000,
};

export interface UnitStatus {
  state: UnitState;
  pid: number | null;
  restarts: number;
  since: number | null;
  url: string | null;
}

export type SupervisorEvent =
  | { event: "unit.started"; unit: string; pid: number | null }
  | { event: "unit.adopted"; unit: string; recheckMs: number }
  | { event: "unit.spawn-failed"; unit: string; error: string }
  | { event: "unit.exited"; unit: string; code: number | null; signal: string | null }
  | { event: "unit.backoff"; unit: string; attempt: number; delayMs: number }
  | { event: "unit.added"; unit: string }
  | { event: "unit.removed"; unit: string }
  | { event: "unit.parked"; unit: string }
  | { event: "unit.woken"; unit: string }
  | { event: "supervisor.crash-loop"; reason: string; crashes: Crash[] }
  | { event: "supervisor.stopping"; because: "asked" | "crash-loop" }
  | { event: "supervisor.stopped" };

export type SupervisorOutcome =
  | { ended: "stopped" }
  | { ended: "crash-loop"; reason: string; crashes: Crash[] };

export interface SupervisorOptions {
  units: readonly UnitSpec[];
  spawn: ProcessSpawner;
  clock: Clock;
  policy?: Partial<SupervisionPolicy> | undefined;
  onLine?: ((unit: string, stream: OutputStream, line: string) => void) | undefined;
  onEvent?: ((event: SupervisorEvent) => void) | undefined;
  onChange?: ((units: ReadonlyMap<string, UnitStatus>) => void) | undefined;
}

export function redactedLine(line: string): string {
  return line.replace(/^token \S+/, "token [redacted]");
}

export function listeningUrlOf(line: string): string | undefined {
  return /^listening on (\S+)/.exec(line)?.[1];
}

export class Supervisor {
  private readonly policy: SupervisionPolicy;
  private readonly ledger: CrashLedger;
  private readonly units = new Map<string, UnitRuntime>();
  private stopping = false;
  private launched = false;
  private settle: (outcome: SupervisorOutcome) => void = () => {};

  constructor(private readonly options: SupervisorOptions) {
    this.policy = { ...supervisionPolicy, ...options.policy };
    this.ledger = new CrashLedger(this.policy.crashLoop);
    for (const spec of options.units) this.units.set(spec.name, freshRuntime(spec));
  }

  run(signal: AbortSignal): Promise<SupervisorOutcome> {
    const outcome = new Promise<SupervisorOutcome>((resolve) => {
      this.settle = resolve;
    });
    const askedToStop = () => void this.shutdown({ ended: "stopped" }, "asked");
    if (signal.aborted) askedToStop();
    else signal.addEventListener("abort", askedToStop, { once: true });
    this.launched = true;
    for (const runtime of this.units.values()) void this.launch(runtime);
    return outcome;
  }

  status(): ReadonlyMap<string, UnitStatus> {
    return new Map([...this.units].map(([name, runtime]) => [name, { ...runtime.status }]));
  }

  add(spec: UnitSpec): void {
    if (this.stopping || this.units.has(spec.name)) return;
    const runtime = freshRuntime(spec);
    this.units.set(spec.name, runtime);
    this.emit({ event: "unit.added", unit: spec.name });
    this.update(runtime, {});
    if (this.launched) void this.launch(runtime);
  }

  async remove(name: string): Promise<void> {
    const runtime = this.units.get(name);
    if (runtime === undefined) return;
    await this.halt(runtime, "stopped");
    this.units.delete(name);
    this.emit({ event: "unit.removed", unit: name });
    this.options.onChange?.(this.status());
  }

  async park(name: string): Promise<void> {
    const runtime = this.units.get(name);
    if (runtime === undefined || runtime.halted || this.stopping) return;
    await this.halt(runtime, "parked");
    this.emit({ event: "unit.parked", unit: name });
  }

  wake(name: string): void {
    const runtime = this.units.get(name);
    if (runtime?.status.state !== "parked" || this.stopping) return;
    runtime.halted = false;
    runtime.attempt = 0;
    this.update(runtime, { state: "starting" });
    this.emit({ event: "unit.woken", unit: name });
    void this.launch(runtime);
  }

  private async launch(runtime: UnitRuntime): Promise<void> {
    runtime.timer = undefined;
    if (this.resting(runtime)) return;
    if ((await this.adoptedElsewhere(runtime)) || this.resting(runtime)) return;
    const child = this.spawnChild(runtime);
    if (child === undefined) return;
    const exit = await child.exited;
    runtime.child = undefined;
    if (this.stopping) return this.update(runtime, { state: "stopped", pid: null, url: null });
    if (runtime.halted) return;
    this.emit({ event: "unit.exited", unit: runtime.spec.name, ...exit });
    this.crashed(runtime, exit);
  }

  private resting(runtime: UnitRuntime): boolean {
    return this.stopping || runtime.halted;
  }

  private async halt(runtime: UnitRuntime, state: "parked" | "stopped"): Promise<void> {
    runtime.halted = true;
    runtime.timer?.();
    runtime.timer = undefined;
    const child = runtime.child;
    if (child !== undefined) {
      child.stop();
      await this.exitsWithinGrace([child]);
    }
    this.update(runtime, { state, pid: null, url: null });
  }

  private async adoptedElsewhere(runtime: UnitRuntime): Promise<boolean> {
    const occupied = runtime.spec.occupied;
    if (occupied === undefined || !(await occupied().catch(() => false)) || this.resting(runtime)) {
      return false;
    }
    const recheckMs = this.policy.adoptRecheckMs;
    this.update(runtime, { state: "adopted", pid: null, url: null });
    this.emit({ event: "unit.adopted", unit: runtime.spec.name, recheckMs });
    runtime.timer = this.options.clock.at(this.now() + recheckMs, () => void this.launch(runtime));
    return true;
  }

  private spawnChild(runtime: UnitRuntime): SupervisedChild | undefined {
    const unit = runtime.spec.name;
    let child: SupervisedChild;
    try {
      child = this.options.spawn(runtime.spec, (stream, line) => this.line(runtime, stream, line));
    } catch (cause) {
      this.emit({ event: "unit.spawn-failed", unit, error: errorText(cause) });
      this.crashed(runtime, { code: null, signal: null });
      return undefined;
    }
    runtime.child = child;
    runtime.startedAt = this.now();
    this.update(runtime, { state: "running", pid: child.pid, since: runtime.startedAt, url: null });
    this.emit({ event: "unit.started", unit, pid: child.pid });
    return child;
  }

  private line(runtime: UnitRuntime, stream: OutputStream, raw: string): void {
    const line = redactedLine(raw);
    this.options.onLine?.(runtime.spec.name, stream, line);
    const url = listeningUrlOf(line);
    if (url !== undefined) this.update(runtime, { url });
  }

  private crashed(runtime: UnitRuntime, exit: ChildExit): void {
    const at = this.now();
    if (this.ledger.record({ unit: runtime.spec.name, at, ...exit })) {
      const crashes = this.ledger.recent(at);
      const reason = crashLoopReason(this.policy.crashLoop);
      this.update(runtime, { state: "stopped", pid: null, url: null });
      this.emit({ event: "supervisor.crash-loop", reason, crashes });
      void this.shutdown({ ended: "crash-loop", reason, crashes }, "crash-loop");
      return;
    }
    const uptime = runtime.startedAt === null ? 0 : at - runtime.startedAt;
    runtime.attempt = uptime >= this.policy.crashLoop.windowMs ? 1 : runtime.attempt + 1;
    const delayMs = backoffMs(runtime.attempt, this.policy);
    this.update(runtime, {
      state: "backing-off",
      pid: null,
      url: null,
      restarts: runtime.status.restarts + 1,
    });
    this.emit({
      event: "unit.backoff",
      unit: runtime.spec.name,
      attempt: runtime.attempt,
      delayMs,
    });
    runtime.timer = this.options.clock.at(at + delayMs, () => void this.launch(runtime));
  }

  private async shutdown(
    outcome: SupervisorOutcome,
    because: "asked" | "crash-loop",
  ): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.emit({ event: "supervisor.stopping", because });
    const children: SupervisedChild[] = [];
    for (const runtime of this.units.values()) {
      runtime.timer?.();
      runtime.timer = undefined;
      if (runtime.child !== undefined) children.push(runtime.child);
      else this.update(runtime, { state: "stopped", pid: null, url: null });
    }
    for (const child of children) child.stop();
    await this.exitsWithinGrace(children);
    this.emit({ event: "supervisor.stopped" });
    this.settle(outcome);
  }

  private async exitsWithinGrace(children: readonly SupervisedChild[]): Promise<void> {
    if (children.length === 0) return;
    const exited = Promise.all(children.map((child) => child.exited)).then(() => "exited" as const);
    let cancelGrace: Cancel = () => {};
    const grace = new Promise<"grace">((resolve) => {
      cancelGrace = this.options.clock.at(this.now() + this.policy.stopGraceMs, () =>
        resolve("grace"),
      );
    });
    const first = await Promise.race([exited, grace]);
    cancelGrace();
    if (first === "exited") return;
    for (const child of children) child.kill();
    await exited;
  }

  private update(runtime: UnitRuntime, change: Partial<UnitStatus>): void {
    runtime.status = { ...runtime.status, ...change };
    this.options.onChange?.(this.status());
  }

  private emit(event: SupervisorEvent): void {
    this.options.onEvent?.(event);
  }

  private now(): number {
    return this.options.clock.now();
  }
}

interface UnitRuntime {
  spec: UnitSpec;
  status: UnitStatus;
  child: SupervisedChild | undefined;
  timer: Cancel | undefined;
  startedAt: number | null;
  attempt: number;
  halted: boolean;
}

function freshRuntime(spec: UnitSpec): UnitRuntime {
  return {
    spec,
    status: { state: "starting", pid: null, restarts: 0, since: null, url: null },
    child: undefined,
    timer: undefined,
    startedAt: null,
    attempt: 0,
    halted: false,
  };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
