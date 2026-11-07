import type { Cancel, Clock, KeepAwake } from "@keywork/engine";
import type { ServerTicket } from "@keywork/server";

export interface ActivitySource {
  name: string;
  live(): Promise<boolean>;
}

export interface SessionsReader {
  sessions(): Promise<readonly { working: boolean }[]>;
}

export type ActivitySources = readonly ActivitySource[] | (() => readonly ActivitySource[]);

export interface AwakeWhileLiveOptions {
  awake: Pick<KeepAwake, "turnRunning" | "dispose">;
  sources: ActivitySources;
  clock: Clock;
  pollMs?: number | undefined;
  onChange?: ((live: boolean, sources: readonly string[]) => void) | undefined;
}

export const activityPollMs = 15_000;

export class AwakeWhileLive {
  private timer: Cancel | undefined;
  private live = false;
  private stopped = false;

  constructor(private readonly options: AwakeWhileLiveOptions) {}

  get holding(): boolean {
    return this.live;
  }

  start(): void {
    this.stopped = false;
    void this.poll();
  }

  async poll(): Promise<boolean> {
    const busy = await this.busySources();
    if (this.stopped) return false;
    this.turn(busy.length > 0, busy);
    this.schedule();
    return this.live;
  }

  stop(): void {
    this.stopped = true;
    this.timer?.();
    this.timer = undefined;
    this.options.awake.dispose();
    this.live = false;
  }

  private async busySources(): Promise<string[]> {
    const { sources } = this.options;
    const now = typeof sources === "function" ? sources() : sources;
    const verdicts = await Promise.all(
      now.map(async (source) =>
        (await source.live().catch(() => false)) ? source.name : undefined,
      ),
    );
    return verdicts.filter((name): name is string => name !== undefined);
  }

  private turn(live: boolean, busy: readonly string[]): void {
    this.options.awake.turnRunning(live);
    if (live !== this.live) this.options.onChange?.(live, busy);
    this.live = live;
  }

  private schedule(): void {
    this.timer?.();
    const pollMs = this.options.pollMs ?? activityPollMs;
    this.timer = this.options.clock.at(this.options.clock.now() + pollMs, () => void this.poll());
  }
}

export function workspaceActivity(
  name: string,
  ticket: () => ServerTicket | undefined,
  reader: (ticket: ServerTicket) => SessionsReader,
): ActivitySource {
  return {
    name,
    live: async () => {
      const held = ticket();
      if (held === undefined) return false;
      const rows = await reader(held).sessions();
      return rows.some((row) => row.working);
    },
  };
}
