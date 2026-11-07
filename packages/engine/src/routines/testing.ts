import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cancel, Clock } from "./clock.ts";
import type { RoutineEvents, RoutineEventType } from "./events.ts";
import { routineFilePath } from "./files.ts";
import type { CreatureDirectory } from "./mirror.ts";
import type { NotificationSettings } from "./notify.ts";
import type { Routine, RoutineInput } from "./routine.ts";
import type { RunRow } from "./run.ts";
import type {
  CreatureHome,
  RoutineRunner,
  RunHandle,
  RunnerResult,
  RunRequest,
  RunSignals,
} from "./runner.ts";
import type { Deliverer, Delivery, SchedulerSettings } from "./scheduler.ts";
import { RoutineService } from "./service.ts";
import { RoutineStore } from "./store.ts";
import type { WakeSettings } from "./wake.ts";
import type { FileWatcher } from "./watch.ts";

export class FakeClock implements Clock {
  private readonly timers = new Set<{ at: number; fire: () => void }>();

  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  at(when: number, fire: () => void): Cancel {
    const timer = { at: when, fire };
    this.timers.add(timer);
    return () => this.timers.delete(timer);
  }

  async sleepUntil(target: number, settle: () => Promise<void>): Promise<void> {
    this.current = Math.max(this.current, target);
    for (let due = this.nextDue(target); due !== undefined; due = this.nextDue(target)) {
      this.timers.delete(due);
      due.fire();
      await settle();
    }
  }

  async advanceTo(target: number, settle: () => Promise<void>): Promise<void> {
    for (let due = this.nextDue(target); due !== undefined; due = this.nextDue(target)) {
      this.timers.delete(due);
      this.current = Math.max(this.current, due.at);
      due.fire();
      await settle();
    }
    this.current = Math.max(this.current, target);
    await settle();
  }

  private nextDue(target: number) {
    return [...this.timers]
      .filter((timer) => timer.at <= target)
      .sort((left, right) => left.at - right.at)[0];
  }
}

export class FakeWatcher implements FileWatcher {
  private readonly listeners = new Set<{ root: string; changed: (path: string) => void }>();

  watch(root: string, changed: (path: string) => void): Cancel {
    const listener = { root, changed };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get roots(): string[] {
    return [...this.listeners].map((listener) => listener.root);
  }

  change(path: string): void {
    for (const listener of this.listeners) listener.changed(path);
  }
}

export interface StartedRun {
  request: RunRequest;
  signals: RunSignals;
  sessionId: string;
  stops: number;
  denied: string[];
  finish(result?: Partial<RunnerResult>): void;
}

export class FakeRunner implements RoutineRunner {
  readonly started: StartedRun[] = [];
  refuseWith: string | undefined;
  finishAtOnce: Partial<RunnerResult> | undefined;

  async start(request: RunRequest, signals: RunSignals): Promise<RunHandle> {
    if (this.refuseWith !== undefined) throw new Error(this.refuseWith);
    let settle: (result: RunnerResult) => void = () => {};
    const finished = new Promise<RunnerResult>((resolve) => {
      settle = resolve;
    });
    const run: StartedRun = {
      request,
      signals,
      sessionId: `session-${this.started.length + 1}`,
      stops: 0,
      denied: [],
      finish: (result = {}) => settle({ ...completed, ...result }),
    };
    this.started.push(run);
    if (this.finishAtOnce !== undefined) run.finish(this.finishAtOnce);
    return {
      sessionId: run.sessionId,
      finished,
      stop: async () => {
        run.stops += 1;
        settle({ ...completed, ended: "stopped", output: "" });
      },
      deny: async (callId) => {
        run.denied.push(callId);
      },
    };
  }

  last(): StartedRun {
    const run = this.started.at(-1);
    if (run === undefined) throw new Error("no run has started");
    return run;
  }
}

export class FakeDeliverer implements Deliverer {
  readonly delivered: Delivery[] = [];
  failWith: string | undefined;

  async deliver(delivery: Delivery): Promise<void> {
    if (this.failWith !== undefined) throw new Error(this.failWith);
    this.delivered.push(delivery);
  }
}

export const completed: RunnerResult = {
  ended: "completed",
  output: "Nothing needs you today.",
  usage: { inputTokens: 1200, outputTokens: 80 },
  costUsd: 0.02,
  reason: null,
};

export const heldOnGrants: Pick<Routine, "tools" | "grants"> = {
  tools: "write",
  grants: [{ action: "write", resource: "notes/**" }],
};

export const parkedRun: Pick<RunRow, "status" | "sessionId" | "process"> = {
  status: "parked",
  sessionId: null,
  process: null,
};

export function routineInput(overrides: Partial<RoutineInput> = {}): RoutineInput {
  return {
    id: "triage",
    title: "Morning triage",
    instructions: "Read the inbox. Tell me only what needs me today.",
    trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    ...overrides,
  };
}

export interface HarnessOptions {
  start: number;
  creatures?: readonly string[];
  settings?: Partial<SchedulerSettings>;
  notifications?: NotificationSettings;
  wakes?: Partial<WakeSettings>;
}

export type RecordedEvent = {
  [Type in RoutineEventType]: { type: Type; payload: RoutineEvents[Type] };
}[RoutineEventType];

export class RoutineHarness {
  readonly clock: FakeClock;
  readonly runner = new FakeRunner();
  readonly deliverer = new FakeDeliverer();
  readonly watcher = new FakeWatcher();
  readonly events: RecordedEvent[] = [];
  service: RoutineService;
  private closed = false;

  private constructor(
    readonly root: string,
    public store: RoutineStore,
    private readonly options: HarnessOptions,
  ) {
    this.clock = new FakeClock(options.start);
    this.service = this.serviceOver(store);
  }

  static async create(options: HarnessOptions): Promise<RoutineHarness> {
    const root = await mkdtemp(join(tmpdir(), "keywork-routines-"));
    for (const slug of options.creatures ?? ["wren"]) {
      await mkdir(join(root, "bots", slug), { recursive: true });
    }
    await mkdir(join(root, "workspace"), { recursive: true });
    return new RoutineHarness(root, await RoutineStore.open(databaseOf(root)), options);
  }

  get databasePath(): string {
    return databaseOf(this.root);
  }

  get workspace(): string {
    return join(this.root, "workspace");
  }

  home(slug = "wren"): CreatureHome {
    return { slug, dir: join(this.root, "bots", slug), bot: slug };
  }

  async writeRoutine(input: RoutineInput, slug = "wren"): Promise<string> {
    const file = routineFilePath(this.home(slug).dir, String(input.id));
    await mkdir(join(this.home(slug).dir, "routines"), { recursive: true });
    await writeFile(file, `${JSON.stringify(input, null, 2)}\n`, "utf8");
    return file;
  }

  async advance(ms: number): Promise<void> {
    await this.clock.advanceTo(this.clock.now() + ms, () => this.service.drain());
  }

  async advanceTo(instant: number): Promise<void> {
    await this.clock.advanceTo(instant, () => this.service.drain());
  }

  async sleepUntil(instant: number): Promise<void> {
    await this.clock.sleepUntil(instant, () => this.service.drain());
  }

  async restart(): Promise<void> {
    this.service.stop();
    this.store.close();
    this.store = await RoutineStore.open(this.databasePath);
    this.service = this.serviceOver(this.store);
    await this.service.start();
  }

  eventsOf<Type extends RoutineEventType>(type: Type): RoutineEvents[Type][] {
    return this.events
      .filter((event) => event.type === type)
      .map((event) => event.payload as RoutineEvents[Type]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.service.stop();
    await this.service.drain();
    this.store.close();
    await rm(this.root, { recursive: true, force: true });
  }

  private serviceOver(store: RoutineStore): RoutineService {
    return new RoutineService({
      store,
      runner: this.runner,
      deliverer: this.deliverer,
      creatures: this.directory(),
      outputsDir: join(this.root, "outputs"),
      clock: this.clock,
      emit: (type, payload) => this.events.push({ type, payload } as RecordedEvent),
      zone: "UTC",
      workspace: this.workspace,
      watcher: this.watcher,
      ...(this.options.wakes !== undefined && { wakes: this.options.wakes }),
      ...(this.options.settings !== undefined && { settings: this.options.settings }),
      ...(this.options.notifications !== undefined && {
        notifications: this.options.notifications,
      }),
    });
  }

  private directory(): CreatureDirectory {
    const slugs = this.options.creatures ?? ["wren"];
    return {
      creatures: async () => slugs.map((slug) => this.home(slug)),
      creature: async (slug) => (slugs.includes(slug) ? this.home(slug) : undefined),
    };
  }
}

function databaseOf(root: string): string {
  return join(root, "state", "routines.db");
}
