import { join } from "node:path";
import { jsonFileStore, renameOverSync, toError } from "@keywork/shared";
import { z } from "zod";
import { isPromptEntry, type SessionEntry } from "../session/entries.ts";
import type { CreatureHandoff, CreatureHandoffsPort } from "./handoffs.ts";
import type { CreatureSummary, CreaturesPort } from "./host.ts";
import type { CreatureWorksite, CreatureWorksitesPort, WorksiteHistory } from "./worksites.ts";

export const honourKinds = [
  "conversations",
  "night",
  "partners",
  "tower",
  "standing",
  "range",
  "run",
  "first-creature",
  "hamlet",
  "town",
  "paved-road",
  "first-tower",
] as const;

export type HonourKind = (typeof honourKinds)[number];

export interface Honour {
  holder: string | null;
  kind: HonourKind;
  tier: number;
  with: string | null;
  earnedAt: string;
  proof: string;
}

export type HonourChangeKind = "earned" | "dropped";

export interface HonourChange {
  change: HonourChangeKind;
  honour: Honour;
}

export interface VisitorWork {
  creature: string;
  conversations: string[];
  night: string | null;
  tools: Record<string, string[]>;
  days: string[];
}

export interface CreatureHonoursPort {
  list(): Promise<Honour[]>;
  visiting(workspace: string): Promise<VisitorWork[]>;
  subscribe(listener: (change: HonourChange) => void): () => void;
}

export interface HonouredWork {
  creature: string;
  conversation: string;
  visitor?: string | undefined;
}

export interface CreatureHonours extends CreatureHonoursPort {
  began(work: HonouredWork, at: string): void;
  finished(work: HonouredWork, at: string): void;
  used(work: HonouredWork, tool: string, at: string): void;
  visited(project: string, work: readonly VisitorWork[]): void;
  close(): void;
}

export interface Calendar {
  hourOf(at: string): number;
  dayOf(at: string): string;
  dateWords(at: string): string;
  timeWords(at: string): string;
}

export type HonouredCreature = Pick<CreatureSummary, "slug" | "name" | "created">;

export interface HonouredCreatures extends Pick<CreaturesPort, "subscribe"> {
  list(): Promise<readonly HonouredCreature[]>;
}

export interface CreatureHonoursOptions {
  file: string;
  creatures: HonouredCreatures;
  handoffs?: Pick<CreatureHandoffsPort, "list" | "subscribe"> | undefined;
  worksites?: Pick<CreatureWorksitesPort, "list" | "subscribe"> | undefined;
  history(): Promise<WorksiteHistory>;
  notice(line: string): void;
  now?: (() => Date) | undefined;
  calendar?: Calendar | undefined;
  standingCheckMs?: number | undefined;
}

export const conversationTiers = [10, 100, 1_000] as const;
export const partnerTiers = [10, 100] as const;
export const towerTiers = [30, 300] as const;
export const rangeTiers = [4, 8, 12] as const;
export const runTiers = [7, 30, 100] as const;
export const usesForRange = 10;
export const nightEndsAtHour = 5;
export const hamletOf = 3;
export const townOf = 8;
export const pavedRoadOf = 20;

export function honoursFileIn(workspaceState: string): string {
  return join(workspaceState, "creatures", "honours.json");
}

export const machineCalendar: Calendar = {
  hourOf: (at) => new Date(at).getHours(),
  dayOf: (at) => localDayOf(new Date(at)),
  dateWords: (at) => {
    const date = new Date(at);
    return `${date.getDate()} ${monthNames[date.getMonth()]} ${date.getFullYear()}`;
  },
  timeWords: (at) => {
    const date = new Date(at);
    return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
  },
};

export function creatureHonours(options: CreatureHonoursOptions): CreatureHonours {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const calendar = options.calendar ?? machineCalendar;
  const kept = keptHonours(options.file, options.notice);
  const book = new HonourBook(calendar);
  const listeners = new Set<(change: HonourChange) => void>();
  let built = false;
  const announce = (change: HonourChangeKind, honours: readonly Honour[]): void => {
    for (const honour of honours) {
      for (const listener of [...listeners]) listener({ change, honour });
    }
  };
  const save = (): void => {
    if (built) kept.save(book.kept());
  };
  const announceEarned = (earned: readonly Honour[]): void =>
    announce(
      "earned",
      earned.filter((honour) => honour.earnedAt >= startedAt),
    );
  const settle = async (): Promise<void> => {
    if (!built) return;
    const earned = book.earn(await sourcesNow(options, clock()));
    if (earned.length === 0) return;
    save();
    announceEarned(earned);
  };
  let settling = Promise.resolve();
  const settleSoon = (): void => {
    settling = settling
      .then(settle)
      .catch((cause: unknown) => options.notice(unsettledWords(cause)));
  };
  const loaded = kept.load();
  if (loaded !== undefined) {
    book.adopt(loaded);
    built = true;
  }
  const ready =
    loaded !== undefined
      ? Promise.resolve()
      : options.history().then(
          async (history) => {
            book.recall(history);
            const earned = book.earn(await sourcesNow(options, clock()));
            built = true;
            save();
            announceEarned(earned);
          },
          (cause: unknown) => options.notice(unbuiltWords(cause)),
        );
  settleSoon();
  const noticed = (changed: boolean): void => {
    if (!changed) return;
    save();
    settleSoon();
  };
  const unfollow = [
    options.creatures.subscribe(({ slug, change }) => {
      if (change === "removed") {
        const dropped = book.drop(slug);
        save();
        announce("dropped", dropped);
      } else if (change === "created") settleSoon();
    }),
    ...(options.handoffs === undefined ? [] : [options.handoffs.subscribe(settleSoon)]),
    ...(options.worksites === undefined ? [] : [options.worksites.subscribe(settleSoon)]),
  ];
  const standingCheck = setInterval(settleSoon, options.standingCheckMs ?? hourMs);
  standingCheck.unref?.();
  return {
    list: async () => {
      await ready;
      await settling;
      return book.held();
    },
    visiting: async (workspace) => {
      await ready;
      return book.visiting(workspace);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    began: (work, at) => noticed(book.began(work, at)),
    finished: (work, at) => noticed(book.finished(work, at)),
    used: (work, tool, at) => noticed(book.used(work, tool, at)),
    visited: (project, work) => noticed(book.visited(project, work)),
    close: () => {
      clearInterval(standingCheck);
      for (const stop of unfollow) stop();
    },
  };
}

const hourMs = 60 * 60 * 1000;

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface Sources {
  creatures: readonly HonouredCreature[];
  handoffs: readonly CreatureHandoff[];
  worksites: readonly CreatureWorksite[];
  now: Date;
}

async function sourcesNow(options: CreatureHonoursOptions, now: Date): Promise<Sources> {
  const [creatures, worksites] = await Promise.all([
    options.creatures.list(),
    options.worksites?.list() ?? Promise.resolve([]),
  ]);
  return { creatures, handoffs: options.handoffs?.list() ?? [], worksites, now };
}

class Work {
  readonly conversations = new Map<string, string>();
  night: string | null = null;
  readonly tools = new Map<string, string[]>();
  readonly days = new Map<string, string>();

  began(conversation: string, at: string): boolean {
    const known = this.conversations.get(conversation);
    if (known !== undefined && known <= at) return false;
    this.conversations.set(conversation, at);
    return true;
  }

  finished(at: string, calendar: Calendar): boolean {
    const atNight =
      calendar.hourOf(at) < nightEndsAtHour && (this.night === null || at < this.night);
    if (atNight) this.night = at;
    const day = calendar.dayOf(at);
    const first = this.days.get(day);
    if (first !== undefined && first <= at) return atNight;
    this.days.set(day, at);
    return true;
  }

  used(tool: string, at: string): boolean {
    const uses = this.tools.get(tool) ?? [];
    if (uses.length >= usesForRange && (uses.at(-1) ?? "") <= at) return false;
    this.tools.set(tool, [...uses, at].sort().slice(0, usesForRange));
    return true;
  }

  told(creature: string): VisitorWork {
    return {
      creature,
      conversations: [...this.conversations.values()].sort(),
      night: this.night,
      tools: Object.fromEntries(this.tools),
      days: [...this.days.values()].sort(),
    };
  }
}

interface Held {
  honour: Honour;
  key: string;
}

class HonourBook {
  private readonly honours = new Map<string, Honour>();
  private readonly work = new Map<string, Work>();
  private readonly visits = new Map<string, Map<string, VisitorWork>>();

  constructor(private readonly calendar: Calendar) {}

  held(): Honour[] {
    return [...this.honours.values()].sort(byEarning);
  }

  visiting(workspace: string): VisitorWork[] {
    return [...this.work.entries()].flatMap(([key, work]) => {
      const { visitor, creature } = ownerOfKey(key);
      return visitor === workspace ? [work.told(creature)] : [];
    });
  }

  began(work: HonouredWork, at: string): boolean {
    return this.workOf(work).began(work.conversation, at);
  }

  finished(work: HonouredWork, at: string): boolean {
    return this.workOf(work).finished(at, this.calendar);
  }

  used(work: HonouredWork, tool: string, at: string): boolean {
    return this.workOf(work).used(tool, at);
  }

  visited(project: string, told: readonly VisitorWork[]): boolean {
    const visit = this.visits.get(project) ?? new Map<string, VisitorWork>();
    this.visits.set(project, visit);
    let changed = false;
    for (const work of told) {
      const before = visit.get(work.creature);
      if (before !== undefined && JSON.stringify(before) === JSON.stringify(work)) continue;
      visit.set(work.creature, work);
      changed = true;
    }
    return changed;
  }

  recall(history: WorksiteHistory): void {
    for (const conversation of history.conversations) {
      recallInto(this.workOf(conversation), conversation.id, conversation.entries, this.calendar);
    }
  }

  earn(sources: Sources): Honour[] {
    const earned = earnedFrom(sources, this.mergedWork(sources.creatures), this.calendar)
      .map((honour): Held => ({ honour, key: honourKeyOf(honour) }))
      .filter(({ key }) => !this.honours.has(key));
    const stead = steadFirstsAfter(this.held(), earned, this.calendar, namesOf(sources)).map(
      (honour): Held => ({ honour, key: honourKeyOf(honour) }),
    );
    const fresh = [...earned, ...stead.filter(({ key }) => !this.honours.has(key))];
    for (const { honour, key } of fresh) this.honours.set(key, honour);
    return fresh.map(({ honour }) => honour).sort(byEarning);
  }

  drop(creature: string): Honour[] {
    const dropped = [...this.honours.entries()].filter(([, honour]) => honour.holder === creature);
    for (const [key] of dropped) this.honours.delete(key);
    this.work.delete(workKeyOf({ creature }));
    for (const visit of this.visits.values()) visit.delete(creature);
    return dropped.map(([, honour]) => honour).sort(byEarning);
  }

  kept(): KeptBook {
    return {
      honours: this.held(),
      work: [...this.work.entries()].map(([key, work]) => ({
        ...ownerOfKey(key),
        conversations: Object.fromEntries(work.conversations),
        night: work.night,
        tools: Object.fromEntries(work.tools),
        days: Object.fromEntries(work.days),
      })),
      visits: [...this.visits.entries()].flatMap(([project, visit]) =>
        [...visit.values()].map((work) => ({ project, ...work })),
      ),
    };
  }

  adopt(kept: KeptBook): void {
    for (const honour of kept.honours) this.honours.set(honourKeyOf(honour), honour);
    for (const row of kept.work) {
      const work = this.workOf({ creature: row.creature, visitor: row.visitor ?? undefined });
      for (const [id, at] of Object.entries(row.conversations)) work.conversations.set(id, at);
      work.night = row.night;
      for (const [tool, uses] of Object.entries(row.tools)) work.tools.set(tool, uses);
      for (const [day, at] of Object.entries(row.days)) work.days.set(day, at);
    }
    for (const { project, ...work } of kept.visits) this.visited(project, [work]);
  }

  private workOf(owner: Pick<HonouredWork, "creature" | "visitor">): Work {
    const key = workKeyOf(owner);
    const found = this.work.get(key);
    if (found !== undefined) return found;
    const opened = new Work();
    this.work.set(key, opened);
    return opened;
  }

  private mergedWork(creatures: Sources["creatures"]): Map<string, VisitorWork> {
    return new Map(
      creatures.map(({ slug }) => {
        const own = this.work.get(workKeyOf({ creature: slug }))?.told(slug);
        const visits = [...this.visits.values()].flatMap((visit) => visit.get(slug) ?? []);
        return [slug, mergedOf(slug, [...(own === undefined ? [] : [own]), ...visits])];
      }),
    );
  }
}

function recallInto(
  work: Work,
  conversation: string,
  entries: readonly SessionEntry[],
  calendar: Calendar,
): void {
  const calls = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.timestamp === "") continue;
    if (isPromptEntry(entry)) work.began(conversation, entry.timestamp);
    const { role, parts } = entry.message;
    if (role === "assistant" && parts.every((part) => part.type !== "tool-call"))
      work.finished(entry.timestamp, calendar);
    for (const part of parts) {
      if (part.type === "tool-call") calls.set(part.callId, part.name);
      if (part.type !== "tool-result" || part.isError) continue;
      const tool = calls.get(part.callId);
      if (tool !== undefined) work.used(tool, entry.timestamp);
    }
  }
}

function mergedOf(creature: string, told: readonly VisitorWork[]): VisitorWork {
  const tools: Record<string, string[]> = {};
  for (const work of told) {
    for (const [tool, uses] of Object.entries(work.tools)) {
      tools[tool] = [...(tools[tool] ?? []), ...uses].sort().slice(0, usesForRange);
    }
  }
  const nights = told.flatMap(({ night }) => (night === null ? [] : [night])).sort();
  return {
    creature,
    conversations: told.flatMap((work) => work.conversations).sort(),
    night: nights[0] ?? null,
    tools,
    days: told.flatMap((work) => work.days).sort(),
  };
}

function earnedFrom(
  sources: Sources,
  work: ReadonlyMap<string, VisitorWork>,
  calendar: Calendar,
): Honour[] {
  const own = new Set(sources.creatures.map(({ slug }) => slug));
  return [
    ...sources.creatures.flatMap((creature) => {
      const done = work.get(creature.slug);
      return [
        ...(done === undefined ? [] : creatureWorkHonours(done, calendar)),
        ...standingHonours(creature, sources.now, calendar),
      ];
    }),
    ...partnerHonours(sources.handoffs, own, calendar, namesOf(sources)),
    ...towerHonours(sources.worksites, own, calendar),
    ...steadHonours(sources, calendar),
  ];
}

function creatureWorkHonours(work: VisitorWork, calendar: Calendar): Honour[] {
  const holder = work.creature;
  const said = calendar.dateWords;
  const conversations = conversationTiers.flatMap((count, at) => {
    const earnedAt = work.conversations[count - 1];
    if (earnedAt === undefined) return [];
    const proof = `${countWords(count)} conversations; the ${ordinalOf(count)} began on ${said(earnedAt)}.`;
    return [honourOf(holder, "conversations", at + 1, null, earnedAt, proof)];
  });
  const night =
    work.night === null
      ? []
      : [
          honourOf(
            holder,
            "night",
            1,
            null,
            work.night,
            `Worked through the night: a turn finished at ${calendar.timeWords(work.night)} on ${said(work.night)}, this machine's time.`,
          ),
        ];
  const mastered = Object.entries(work.tools)
    .flatMap(([tool, uses]) => {
      const tenth = uses[usesForRange - 1];
      return tenth === undefined ? [] : [{ tool, tenth }];
    })
    .sort(
      (left, right) => left.tenth.localeCompare(right.tenth) || left.tool.localeCompare(right.tool),
    );
  const range = rangeTiers.flatMap((count, at) => {
    const reached = mastered[count - 1];
    if (reached === undefined) return [];
    const proof = `${countWords(count)} kinds of tool, each used well ten times; the ${ordinalOf(count)} was ${reached.tool}, on ${said(reached.tenth)}.`;
    return [honourOf(holder, "range", at + 1, null, reached.tenth, proof)];
  });
  return [...conversations, ...night, ...range, ...runHonours(holder, work.days, calendar)];
}

function runHonours(holder: string, finishes: readonly string[], calendar: Calendar): Honour[] {
  const firstOfDay = new Map<string, string>();
  for (const at of finishes) {
    const day = calendar.dayOf(at);
    const known = firstOfDay.get(day);
    if (known === undefined || at < known) firstOfDay.set(day, at);
  }
  const days = [...firstOfDay.keys()].sort();
  const reachedAt = new Map<number, string>();
  let length = 0;
  days.forEach((day, index) => {
    length = index > 0 && days[index - 1] === dayBefore(day) ? length + 1 : 1;
    if (!reachedAt.has(length)) reachedAt.set(length, firstOfDay.get(day) ?? "");
  });
  return runTiers.flatMap((count, at) => {
    const earnedAt = reachedAt.get(count);
    if (earnedAt === undefined) return [];
    const proof = `${countWords(count)} days in a row with a finished turn; the ${ordinalOf(count)} was ${calendar.dateWords(earnedAt)}.`;
    return [honourOf(holder, "run", at + 1, null, earnedAt, proof)];
  });
}

function standingHonours(
  creature: Pick<CreatureSummary, "slug" | "created">,
  now: Date,
  calendar: Calendar,
): Honour[] {
  const made = new Date(creature.created);
  if (Number.isNaN(made.getTime())) return [];
  const honours: Honour[] = [];
  for (let years = 1; ; years += 1) {
    const anniversary = new Date(made);
    anniversary.setFullYear(made.getFullYear() + years);
    if (anniversary > now) return honours;
    const proof = `Has stood ${years === 1 ? "a year" : `${countWords(years)} years`}; made on ${calendar.dateWords(creature.created)}.`;
    honours.push(
      honourOf(creature.slug, "standing", years, null, anniversary.toISOString(), proof),
    );
  }
}

interface Pair {
  creatures: [string, string];
  count: number;
  lastAt: string;
}

function pairsOf(handoffs: readonly CreatureHandoff[]): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const { from, to, count, lastAt } of handoffs) {
    const creatures = [from, to].sort() as [string, string];
    const key = creatures.join("+");
    const known = pairs.get(key);
    pairs.set(key, {
      creatures,
      count: (known?.count ?? 0) + count,
      lastAt: known === undefined || lastAt > known.lastAt ? lastAt : known.lastAt,
    });
  }
  return [...pairs.values()];
}

function partnerHonours(
  handoffs: readonly CreatureHandoff[],
  own: ReadonlySet<string>,
  calendar: Calendar,
  nameOf: (slug: string) => string,
): Honour[] {
  return pairsOf(handoffs).flatMap(({ creatures, count, lastAt }) =>
    partnerTiers.flatMap((threshold, at) => {
      if (count < threshold) return [];
      return creatures.flatMap((holder, index) => {
        const partner = creatures[1 - index] ?? "";
        if (!own.has(holder)) return [];
        const proof = `${countWords(threshold)} hand-offs with ${nameOf(partner)}, both ways together; ${whenCounted(threshold, count, lastAt, calendar)}.`;
        return [honourOf(holder, "partners", at + 1, partner, lastAt, proof)];
      });
    }),
  );
}

function towerHonours(
  worksites: readonly CreatureWorksite[],
  own: ReadonlySet<string>,
  calendar: Calendar,
): Honour[] {
  return worksites.flatMap(({ creature, directory, conversations, latest }) => {
    if (!own.has(creature)) return [];
    return towerTiers.flatMap((threshold, at) => {
      if (conversations < threshold) return [];
      const grew = at === 0 ? "a tower" : "a skyscraper";
      const proof = `${countWords(threshold)} conversations in ${directory}, ${grew}; ${whenCounted(threshold, conversations, latest, calendar)}.`;
      return [honourOf(creature, "tower", at + 1, directory, latest, proof)];
    });
  });
}

function steadHonours(sources: Sources, calendar: Calendar): Honour[] {
  const nameOf = namesOf(sources);
  const made = [...sources.creatures].sort((left, right) =>
    left.created.localeCompare(right.created),
  );
  const standingAt = (count: number, kind: HonourKind, words: string): Honour[] => {
    const nth = made[count - 1];
    if (nth === undefined) return [];
    const proof = `${words}; ${nth.name} made it ${countWords(count).toLowerCase()} on ${calendar.dateWords(nth.created)}.`;
    return [honourOf(null, kind, 1, null, nth.created, proof)];
  };
  const first = made[0];
  const firstCreature =
    first === undefined
      ? []
      : [
          honourOf(
            null,
            "first-creature",
            1,
            null,
            first.created,
            `The first creature, ${first.name}, was made on ${calendar.dateWords(first.created)}.`,
          ),
        ];
  const road = pairsOf(sources.handoffs)
    .filter(({ count }) => count >= pavedRoadOf)
    .sort((left, right) => left.lastAt.localeCompare(right.lastAt))[0];
  const pavedRoad =
    road === undefined
      ? []
      : [
          honourOf(
            null,
            "paved-road",
            1,
            road.creatures.join("+"),
            road.lastAt,
            `The first paved road: ${countWords(pavedRoadOf).toLowerCase()} hand-offs between ${road.creatures.map(nameOf).join(" and ")}, both ways together; ${whenCounted(pavedRoadOf, road.count, road.lastAt, calendar)}.`,
          ),
        ];
  return [
    ...firstCreature,
    ...standingAt(hamletOf, "hamlet", "A hamlet: three creatures standing at once"),
    ...standingAt(townOf, "town", "A town: eight creatures standing at once"),
    ...pavedRoad,
  ];
}

function steadFirstsAfter(
  held: readonly Honour[],
  earned: readonly Held[],
  calendar: Calendar,
  nameOf: (slug: string) => string,
): Honour[] {
  if (held.some(({ holder, kind }) => holder === null && kind === "first-tower")) return [];
  const towers = [...held, ...earned.map(({ honour }) => honour)]
    .filter(({ kind, tier }) => kind === "tower" && tier === 1)
    .sort(byEarning);
  const first = towers[0];
  if (first === undefined) return [];
  const proof = `The first tower: ${nameOf(first.holder ?? "a creature")} raised one in ${first.with ?? "a folder"}, by ${calendar.dateWords(first.earnedAt)}.`;
  return [honourOf(null, "first-tower", 1, first.with, first.earnedAt, proof)];
}

function namesOf({ creatures }: Pick<Sources, "creatures">): (slug: string) => string {
  const names = new Map(creatures.map(({ slug, name }) => [slug, name]));
  return (slug) => names.get(slug) ?? slug;
}

function whenCounted(threshold: number, count: number, at: string, calendar: Calendar): string {
  return count === threshold
    ? `the ${ordinalOf(threshold)} on ${calendar.dateWords(at)}`
    : `counted by ${calendar.dateWords(at)}`;
}

function honourOf(
  holder: string | null,
  kind: HonourKind,
  tier: number,
  partner: string | null,
  earnedAt: string,
  proof: string,
): Honour {
  return { holder, kind, tier, with: partner, earnedAt, proof };
}

function honourKeyOf({ holder, kind, tier, with: partner }: Honour): string {
  return JSON.stringify([holder, kind, tier, partner]);
}

function byEarning(left: Honour, right: Honour): number {
  return (
    left.earnedAt.localeCompare(right.earnedAt) ||
    (left.holder ?? "").localeCompare(right.holder ?? "") ||
    left.kind.localeCompare(right.kind) ||
    left.tier - right.tier ||
    (left.with ?? "").localeCompare(right.with ?? "")
  );
}

function workKeyOf({ creature, visitor }: Pick<HonouredWork, "creature" | "visitor">): string {
  return JSON.stringify([visitor ?? null, creature]);
}

function ownerOfKey(key: string): { visitor: string | null; creature: string } {
  const [visitor, creature] = JSON.parse(key) as [string | null, string];
  return { visitor, creature };
}

const countNames: Readonly<Record<number, string>> = {
  3: "Three",
  4: "Four",
  7: "Seven",
  8: "Eight",
  10: "Ten",
  12: "Twelve",
  20: "Twenty",
  30: "Thirty",
};

function countWords(count: number): string {
  return countNames[count] ?? count.toLocaleString("en-GB");
}

const ordinalNames: Readonly<Record<number, string>> = {
  4: "fourth",
  7: "seventh",
  8: "eighth",
  10: "tenth",
  12: "twelfth",
  20: "twentieth",
  30: "thirtieth",
  100: "hundredth",
  300: "three-hundredth",
  1000: "thousandth",
};

function ordinalOf(count: number): string {
  return ordinalNames[count] ?? `${count}th`;
}

function localDayOf(date: Date): string {
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

function dayBefore(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return localDayOf(new Date(year ?? 0, (month ?? 1) - 1, (date ?? 1) - 1));
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

type KeptBook = z.infer<typeof keptBook>;

interface KeptHonours {
  load(): KeptBook | undefined;
  save(book: KeptBook): void;
}

const keptVersion = 1;

const keptTime = z.string().refine((at) => !Number.isNaN(Date.parse(at)), "is a time");

const keptHonour = z.strictObject({
  holder: z.string().min(1).nullable(),
  kind: z.enum(honourKinds),
  tier: z.number().int().positive(),
  with: z.string().min(1).nullable(),
  earnedAt: keptTime,
  proof: z.string().min(1),
});

const keptTools = z.record(z.string().min(1), z.array(keptTime).max(usesForRange));

const keptWork = z.strictObject({
  visitor: z.string().min(1).nullable(),
  creature: z.string().min(1),
  conversations: z.record(z.string().min(1), keptTime),
  night: keptTime.nullable(),
  tools: keptTools,
  days: z.record(z.string().min(1), keptTime),
});

const keptVisit = z.strictObject({
  project: z.string().min(1),
  creature: z.string().min(1),
  conversations: z.array(keptTime),
  night: keptTime.nullable(),
  tools: keptTools,
  days: z.array(keptTime),
});

const keptBook = z.strictObject({
  honours: z.array(keptHonour),
  work: z.array(keptWork),
  visits: z.array(keptVisit),
});

const keptFile = z.strictObject({ version: z.literal(keptVersion), ...keptBook.shape });

function keptHonours(file: string, notice: (line: string) => void): KeptHonours {
  const store = jsonFileStore({
    file,
    mode: "strict",
    private: true,
    validate: keptFileOf,
    error: (at, detail) => new Error(`${at} is ${detail}`),
  });
  let lastSaveFailed = false;
  return {
    load: () => {
      try {
        const read = store.read();
        if (read === undefined) return undefined;
        const { version: _version, ...book } = read;
        return book;
      } catch (cause) {
        notice(unreadableWords(file, cause, setAside(file)));
        return undefined;
      }
    },
    save: (book) => {
      try {
        store.write({ version: keptVersion, ...book });
        lastSaveFailed = false;
      } catch (cause) {
        if (!lastSaveFailed) notice(unsavedWords(file, cause));
        lastSaveFailed = true;
      }
    },
  };
}

function keptFileOf(data: unknown): z.infer<typeof keptFile> {
  const parsed = keptFile.safeParse(data);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const at = issue?.path.join(".") ?? "";
  throw new Error(`not a book of honours: ${at === "" ? "" : `${at}: `}${issue?.message ?? ""}`);
}

type SetAside = { moved: true; to: string } | { moved: false; reason: string };

function setAside(file: string): SetAside {
  const to = `${file}.unreadable`;
  try {
    renameOverSync(file, to);
    return { moved: true, to };
  } catch (cause) {
    return { moved: false, reason: oneLine(toError(cause).message) };
  }
}

function unreadableWords(file: string, cause: unknown, aside: SetAside): string {
  const where = aside.moved
    ? `it was moved to ${aside.to}`
    : `it could not be moved aside (${aside.reason})`;
  return `the honours kept at ${file} are unreadable (${oneLine(toError(cause).message)}); they are counted again from the session journals and ${where}`;
}

function unsavedWords(file: string, cause: unknown): string {
  return `honours could not be saved to ${file} (${oneLine(toError(cause).message)}); they stay held in memory and the next change saves them again`;
}

function unbuiltWords(cause: unknown): string {
  return `the honours earned before this server could not be counted (${oneLine(toError(cause).message)}); new work is counted and the next start tries again`;
}

function unsettledWords(cause: unknown): string {
  return `honours could not be weighed just now (${oneLine(toError(cause).message)}); the next change weighs them again`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
