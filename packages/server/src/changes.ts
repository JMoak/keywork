import {
  type ChangedPath,
  type EngineEvents,
  type EventBus,
  followMutations,
} from "@keywork/engine";
import type { EventLog } from "./events.ts";
import type { ChangesPort, ChangesSummary, FileSides } from "./host.ts";

export interface ChangesSource {
  label: string;
  changes(): Promise<ChangedPath[]>;
  before(path: string): Promise<string | undefined>;
  after(path: string): Promise<string | undefined>;
}

export interface ChangesUpdate {
  paths: string[];
  turn?: number;
}

export interface KnownSessions {
  has(id: string): Promise<boolean>;
}

export type ChangesSourceOf = (sessionId: string) => Promise<ChangesSource | undefined>;

export const changesQuietMs = 16;

export function changesPortOver(sessions: KnownSessions, source: ChangesSourceOf): ChangesPort {
  const baselineFor = async (id: string): Promise<ChangesSource | "missing" | "no-baseline"> => {
    if (!(await sessions.has(id))) return "missing";
    return (await source(id)) ?? "no-baseline";
  };
  return {
    list: async (id) => {
      const baseline = await baselineFor(id);
      if (typeof baseline === "string") return baseline;
      return { baseline: baseline.label, files: await baseline.changes() };
    },
    file: async (id, path) => {
      const baseline = await baselineFor(id);
      if (typeof baseline === "string") return baseline;
      const after = await baseline.after(path);
      const sides: FileSides = { before: await baseline.before(path), after };
      return sides;
    },
  };
}

export class ChangesFeed {
  private queue: Promise<void> = Promise.resolve();
  private readonly quiet = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly scheduled = new Set<string>();
  private readonly announced = new Map<string, ChangesSummary>();

  constructor(
    private readonly log: EventLog,
    private readonly source: ChangesSourceOf,
  ) {}

  lastAnnounced(sessionId: string): ChangesSummary | undefined {
    return this.announced.get(sessionId);
  }

  follow(bus: EventBus<EngineEvents>, sessionId: string): () => void {
    return followMutations(bus, () => this.announceAfterQuiet(sessionId));
  }

  announceAfterQuiet(sessionId: string): void {
    this.stopWaiting(sessionId);
    this.quiet.set(
      sessionId,
      setTimeout(() => void this.announce(sessionId), changesQuietMs),
    );
  }

  announce(sessionId: string): Promise<void> {
    this.stopWaiting(sessionId);
    if (!this.scheduled.has(sessionId)) {
      this.scheduled.add(sessionId);
      this.queue = this.queue.then(() => this.recordScheduled(sessionId)).catch(() => undefined);
    }
    return this.queue;
  }

  settled(): Promise<void> {
    for (const sessionId of [...this.quiet.keys()]) void this.announce(sessionId);
    return this.queue;
  }

  private stopWaiting(sessionId: string): void {
    const timer = this.quiet.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.quiet.delete(sessionId);
  }

  private async recordScheduled(sessionId: string): Promise<void> {
    this.scheduled.delete(sessionId);
    const baseline = await this.source(sessionId);
    if (baseline === undefined) return;
    const files = await baseline.changes();
    this.announced.set(sessionId, changesSummaryOf(files));
    this.log.record(sessionId, "changes.updated", changesUpdateOf(files));
  }
}

export function changesSummaryOf(files: readonly ChangedPath[]): ChangesSummary {
  return {
    files: files.length,
    added: files.reduce((total, file) => total + file.added, 0),
    deleted: files.reduce((total, file) => total + file.deleted, 0),
  };
}

export function changesUpdateOf(files: readonly ChangedPath[]): ChangesUpdate {
  const turns = files.flatMap((file) => (file.turn === undefined ? [] : [file.turn]));
  return {
    paths: files.map((file) => file.path),
    ...(turns.length > 0 && { turn: Math.max(...turns) }),
  };
}
