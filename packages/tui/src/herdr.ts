import { spawn } from "node:child_process";

export type HerdrState = "idle" | "working" | "blocked";

export interface HerdrWork {
  readonly working: boolean;
  readonly blocked: boolean;
}

export type HerdrSpawner = (command: string, args: readonly string[]) => Promise<unknown>;

export interface HerdrSeams {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly spawn?: HerdrSpawner;
  readonly clock?: () => number;
}

export interface HerdrReporter {
  report(work: HerdrWork): void;
  release(): void;
}

export const herdrAgent = "keywork";
export const herdrResumeArgv: readonly string[] = [herdrAgent];

export function herdrStateOf(work: HerdrWork): HerdrState {
  if (work.blocked) return "blocked";
  return work.working ? "working" : "idle";
}

export function herdrReporter(seams: HerdrSeams = {}): HerdrReporter {
  const pane = herdrPaneOf(seams.env ?? process.env);
  if (pane === undefined) return silentReporter;
  return new PaneReporter(pane, seams.spawn ?? spawnQuietly, seams.clock ?? Date.now);
}

interface HerdrPane {
  readonly bin: string;
  readonly id: string;
}

const silentReporter: HerdrReporter = { report: () => {}, release: () => {} };

const reportTimeoutMs = 2000;

class PaneReporter implements HerdrReporter {
  private lastSeq = 0;
  private reported: HerdrState | undefined;
  private queued: HerdrState | undefined;
  private inFlight = false;
  private gone = false;

  constructor(
    private readonly pane: HerdrPane,
    private readonly spawner: HerdrSpawner,
    private readonly clock: () => number,
  ) {}

  report(work: HerdrWork): void {
    const state = herdrStateOf(work);
    if (this.gone || state === (this.queued ?? this.reported)) return;
    if (this.inFlight) {
      this.queued = state;
      return;
    }
    this.send(state);
  }

  release(): void {
    if (this.gone) return;
    this.gone = true;
    void this.run(["pane", "release-agent", this.pane.id, ...this.identity()]);
  }

  private send(state: HerdrState): void {
    this.reported = state;
    this.inFlight = true;
    void this.run([
      "pane",
      "report-agent",
      this.pane.id,
      ...this.identity(),
      "--state",
      state,
      "--",
      ...herdrResumeArgv,
    ]).then(() => this.sendQueued());
  }

  private sendQueued(): void {
    this.inFlight = false;
    const next = this.queued;
    this.queued = undefined;
    if (next !== undefined && next !== this.reported && !this.gone) this.send(next);
  }

  private identity(): string[] {
    return ["--source", herdrAgent, "--agent", herdrAgent, "--seq", String(this.nextSeq())];
  }

  private nextSeq(): number {
    this.lastSeq = Math.max(Math.floor(this.clock()), this.lastSeq + 1);
    return this.lastSeq;
  }

  private run(args: readonly string[]): Promise<void> {
    try {
      return this.spawner(this.pane.bin, args).then(
        () => {},
        () => this.giveUp(),
      );
    } catch {
      this.giveUp();
      return Promise.resolve();
    }
  }

  private giveUp(): void {
    this.gone = true;
  }
}

function herdrPaneOf(env: Readonly<Record<string, string | undefined>>): HerdrPane | undefined {
  const bin = env.HERDR_BIN_PATH;
  const id = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !bin || !id) return undefined;
  return { bin, id };
}

function spawnQuietly(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true,
      timeout: reportTimeoutMs,
    });
    child.once("error", reject);
    child.once("exit", () => resolve());
    child.unref();
  });
}
