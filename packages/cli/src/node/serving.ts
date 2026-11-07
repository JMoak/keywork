import { mkdirSync, watch } from "node:fs";
import type { Cancel, Clock } from "@keywork/engine";
import { keyworkClient, readServerTicket, type ServerTicket } from "@keywork/server";
import { type FolderOpen, type FolderOpens, heldByConsole } from "./opens.ts";
import type { Supervisor } from "./supervisor.ts";
import type { WorkspaceUnit } from "./units.ts";

export interface ServedNow {
  workspaces: readonly WorkspaceUnit[];
  opens: FolderOpens;
}

export interface ServedSource {
  read(): ServedNow;
  watch(changed: () => void): () => void;
  inUse(unit: WorkspaceUnit): Promise<boolean>;
}

export interface ParkingPolicy {
  idleMs: number;
  sweepMs: number;
}

export const parkingPolicy: ParkingPolicy = { idleMs: 60 * 60_000, sweepMs: 5 * 60_000 };

export interface ServingOptions {
  supervisor: Pick<Supervisor, "add" | "remove" | "park" | "wake" | "status">;
  source: ServedSource;
  workspaces: readonly WorkspaceUnit[];
  clock: Clock;
  isAlive: (pid: number) => boolean;
  say: (line: string) => void;
  policy?: Partial<ParkingPolicy> | undefined;
}

export class Serving {
  private readonly served = new Map<string, Served>();
  private readonly policy: ParkingPolicy;
  private queue: Promise<unknown> = Promise.resolve();
  private sweepTimer: Cancel | undefined;
  private unwatch: () => void = () => {};

  constructor(private readonly options: ServingOptions) {
    this.policy = { ...parkingPolicy, ...options.policy };
    for (const unit of options.workspaces) this.track(unit);
  }

  workspaces(): WorkspaceUnit[] {
    return [...this.served.values()].map(({ unit }) => unit);
  }

  start(): () => void {
    this.unwatch = this.options.source.watch(() => void this.reconcile());
    this.scheduleSweep();
    void this.reconcile();
    return () => this.stop();
  }

  reconcile(): Promise<void> {
    return this.serially(async () => {
      await this.reconcileNow();
    });
  }

  sweep(): Promise<void> {
    return this.serially(() => this.sweepNow());
  }

  private async reconcileNow(): Promise<ServedNow | undefined> {
    const now = this.readServed();
    if (now === undefined) return undefined;
    const wanted = new Map(now.workspaces.map((unit) => [unit.spec.name, unit]));
    for (const [name, unit] of wanted) {
      if (!this.served.has(name)) this.serve(unit);
    }
    for (const name of [...this.served.keys()]) {
      if (!wanted.has(name)) await this.unserve(name);
    }
    for (const served of this.served.values()) this.notice(served, now.opens[served.unit.identity]);
    return now;
  }

  private async sweepNow(): Promise<void> {
    const opens = (await this.reconcileNow())?.opens ?? {};
    const status = this.options.supervisor.status();
    for (const served of [...this.served.values()]) {
      if (status.get(served.unit.spec.name)?.state !== "running") continue;
      if (await this.inUse(served.unit, opens)) served.activeAt = this.now();
      else if (this.now() - served.activeAt >= this.policy.idleMs) await this.park(served);
    }
  }

  private readServed(): ServedNow | undefined {
    try {
      return this.options.source.read();
    } catch (cause) {
      this.options.say(
        `serving: the served folders could not be read, so nothing changed: ${errorText(cause)}`,
      );
      return undefined;
    }
  }

  private serve(unit: WorkspaceUnit): void {
    this.track(unit);
    this.options.supervisor.add(unit.spec);
  }

  private async unserve(name: string): Promise<void> {
    this.served.delete(name);
    await this.options.supervisor.remove(name);
  }

  private notice(served: Served, open: FolderOpen | undefined): void {
    const openedAt = open === undefined ? Number.NaN : Date.parse(open.at);
    if (!(openedAt > served.activeAt)) return;
    served.activeAt = openedAt;
    if (!served.parked) return;
    served.parked = false;
    served.activeAt = Math.max(openedAt, this.now());
    this.options.supervisor.wake(served.unit.spec.name);
  }

  private async inUse(unit: WorkspaceUnit, opens: FolderOpens): Promise<boolean> {
    if (heldByConsole(opens[unit.identity], this.options.isAlive)) return true;
    return this.options.source.inUse(unit).catch(() => true);
  }

  private async park(served: Served): Promise<void> {
    served.parked = true;
    await this.options.supervisor.park(served.unit.spec.name);
  }

  private track(unit: WorkspaceUnit): void {
    this.served.set(unit.spec.name, { unit, activeAt: this.now(), parked: false });
  }

  private scheduleSweep(): void {
    const tick = (): void => {
      this.sweepTimer = this.options.clock.at(this.now() + this.policy.sweepMs, tick);
      void this.sweep();
    };
    this.sweepTimer = this.options.clock.at(this.now() + this.policy.sweepMs, tick);
  }

  private stop(): void {
    this.unwatch();
    this.sweepTimer?.();
    this.sweepTimer = undefined;
  }

  private serially<Result>(work: () => Promise<Result>): Promise<Result> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private now(): number {
    return this.options.clock.now();
  }
}

export async function workspaceInUse(
  unit: Pick<WorkspaceUnit, "ticket">,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const ticket = readServerTicket(unit.ticket);
  if (ticket === undefined) return true;
  const [creatures, working] = await Promise.all([
    creatureCount(ticket, fetcher),
    anySessionWorking(ticket, fetcher),
  ]);
  return creatures > 0 || working;
}

export function watchFolder(folder: string, changed: (file: string) => void): () => void {
  try {
    mkdirSync(folder, { recursive: true });
    const watcher = watch(folder, (_event, file) => changed(file === null ? "" : String(file)));
    watcher.on("error", () => watcher.close());
    return () => watcher.close();
  } catch {
    return () => {};
  }
}

interface Served {
  unit: WorkspaceUnit;
  activeAt: number;
  parked: boolean;
}

async function creatureCount(ticket: ServerTicket, fetcher: typeof fetch): Promise<number> {
  const response = await fetcher(`${ticket.url.replace(/\/+$/, "")}/creatures`, {
    headers: { authorization: `Bearer ${ticket.token}` },
  });
  if (response.status === 503) return 0;
  if (!response.ok) throw new Error(`GET /creatures answered ${response.status}`);
  const body = (await response.json()) as { creatures?: unknown };
  return Array.isArray(body.creatures) ? body.creatures.length : 0;
}

async function anySessionWorking(ticket: ServerTicket, fetcher: typeof fetch): Promise<boolean> {
  const rows = await keyworkClient(ticket, { fetch: fetcher }).sessions();
  return rows.some((row) => row.working);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
