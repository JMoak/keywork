import { type Cancel, type Clock, minuteMs, systemClock } from "../routines/clock.ts";
import type { TemperamentSeat, Temperaments } from "../tools/temperament.ts";
import {
  type CreatureFile,
  type CreatureTemperaments,
  isTemperament,
  mannerOf,
  rangeOf,
  settledFile,
  type Temperament,
  temperamentOf,
  withManner,
} from "./file.ts";
import type { CreatureSummary } from "./host.ts";
import type { Creature, CreatureRegistry } from "./registry.ts";
import type { CreatureSessions } from "./threads.ts";

export const settlesAfterMs = 30 * minuteMs;

export interface WorkElsewhere {
  working: boolean;
  latest: string | undefined;
}

export interface MannerKeeperSeams {
  registry: Pick<CreatureRegistry, "read" | "list" | "update">;
  sessions: Pick<CreatureSessions, "list">;
  elsewhere?: ((slug: string) => Promise<WorkElsewhere>) | undefined;
  clock?: Clock | undefined;
  changed(slug: string): void;
  notice?: ((line: string) => void) | undefined;
}

export interface MannerKeeper {
  take(slug: string, temperament: Temperament): Promise<Creature | undefined>;
  worked(slug: string): void;
  keep(): Promise<void>;
  close(): void;
}

export function mannerKeeper(seams: MannerKeeperSeams): MannerKeeper {
  const clock = seams.clock ?? systemClock;
  const waiting = new Map<string, Cancel>();
  let closed = false;

  const wait = (slug: string, until: number): void => {
    waiting.get(slug)?.();
    waiting.set(
      slug,
      clock.at(until, () => lookQuietly(slug)),
    );
  };

  const lookQuietly = (slug: string): void => {
    look(slug).catch((cause: unknown) =>
      seams.notice?.(
        `${slug} did not settle back to its favourite temperament: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
  };

  const stopWaiting = (slug: string): void => {
    waiting.get(slug)?.();
    waiting.delete(slug);
  };

  const look = async (slug: string): Promise<void> => {
    if (closed) return;
    const creature = await seams.registry.read(slug);
    const taken = creature?.file.manner;
    if (taken === undefined) return stopWaiting(slug);
    const quiet = await quietSince(slug, Date.parse(taken.since));
    const settles = (quiet ?? clock.now()) + settlesAfterMs;
    if (quiet === undefined || settles > clock.now()) return wait(slug, settles);
    stopWaiting(slug);
    const settled = await seams.registry.update(slug, (file) => settledIf(file, taken.since));
    if (settled !== undefined && settled.file.manner === undefined) seams.changed(slug);
  };

  const quietSince = async (slug: string, since: number): Promise<number | undefined> => {
    const own = (await seams.sessions.list()).filter((session) => session.tag.creature === slug);
    const away = await seams.elsewhere?.(slug);
    if (own.some((session) => session.working) || away?.working === true) return undefined;
    const ends = [...own.map((session) => session.lastActivityAt), away?.latest];
    return Math.max(since, ...ends.flatMap((at) => (at === undefined ? [] : [Date.parse(at)])));
  };

  return {
    take: async (slug, temperament) => {
      const at = new Date(clock.now());
      const taken = await seams.registry.update(slug, (file) => withManner(file, temperament, at));
      if (taken === undefined) return undefined;
      seams.changed(slug);
      if (taken.file.manner === undefined) stopWaiting(slug);
      else await look(slug);
      return taken;
    },
    worked: (slug) => {
      if (waiting.has(slug)) lookQuietly(slug);
    },
    keep: async () => {
      for (const creature of await seams.registry.list())
        if (creature.file.manner !== undefined) await look(creature.slug);
    },
    close: () => {
      closed = true;
      for (const cancel of waiting.values()) cancel();
      waiting.clear();
    },
  };
}

export type CreatureTemperamentFacts = Pick<CreatureSummary, "temperament" | "range" | "manner">;

export interface TemperamentSource {
  read(slug: string): Promise<CreatureTemperamentFacts | undefined>;
  takeManner(slug: string, temperament: Temperament): Promise<CreatureTemperamentFacts | undefined>;
}

export function temperamentSeatOf(source: TemperamentSource, slug: string): TemperamentSeat {
  return {
    read: async () => temperamentsOf(await source.read(slug)),
    take: async (mood) =>
      isTemperament(mood) ? temperamentsOf(await source.takeManner(slug, mood)) : undefined,
  };
}

export function temperamentFactsOf(file: CreatureTemperaments): CreatureTemperamentFacts {
  return { temperament: temperamentOf(file), range: rangeOf(file), manner: mannerOf(file) };
}

function temperamentsOf(facts: CreatureTemperamentFacts | undefined): Temperaments | undefined {
  return facts === undefined
    ? undefined
    : { favourite: facts.temperament, range: facts.range, manner: facts.manner };
}

function settledIf(file: CreatureFile, since: string): CreatureFile {
  return file.manner?.since === since ? settledFile(file) : file;
}
