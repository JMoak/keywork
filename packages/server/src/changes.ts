import {
  type ChangedPath,
  type EngineEvents,
  type EventBus,
  followMutations,
} from "@keywork/engine";
import type { EventLog } from "./events.ts";
import type { ChangesPort, FileSides } from "./host.ts";

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

export type ChangesSourceOf = () => Promise<ChangesSource | undefined>;

export function changesPortOver(sessions: KnownSessions, source: ChangesSourceOf): ChangesPort {
  const baselineFor = async (id: string): Promise<ChangesSource | "missing" | "no-baseline"> => {
    if (!(await sessions.has(id))) return "missing";
    return (await source()) ?? "no-baseline";
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
      const [before, after] = await Promise.all([baseline.before(path), baseline.after(path)]);
      const sides: FileSides = { before, after };
      return sides;
    },
  };
}

export class ChangesFeed {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly log: EventLog,
    private readonly source: ChangesSourceOf,
  ) {}

  follow(bus: EventBus<EngineEvents>, sessionId: string): () => void {
    return followMutations(bus, () => {
      this.announce(sessionId);
    });
  }

  announce(sessionId: string): Promise<void> {
    this.queue = this.queue.then(() => this.record(sessionId)).catch(() => undefined);
    return this.queue;
  }

  settled(): Promise<void> {
    return this.queue;
  }

  private async record(sessionId: string): Promise<void> {
    const baseline = await this.source();
    if (baseline === undefined) return;
    this.log.record(sessionId, "changes.updated", changesUpdateOf(await baseline.changes()));
  }
}

export function changesUpdateOf(files: readonly ChangedPath[]): ChangesUpdate {
  const turns = files.flatMap((file) => (file.turn === undefined ? [] : [file.turn]));
  return {
    paths: files.map((file) => file.path),
    ...(turns.length > 0 && { turn: Math.max(...turns) }),
  };
}
