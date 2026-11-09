import { randomUUID } from "node:crypto";
import { type Cancel, type Clock, hourMs, isoOf, systemClock } from "../routines/clock.ts";
import { type Heard, HeardOutcomes } from "./heard.ts";
import type { KeeperOpening } from "./input.ts";
import { type KeptSettings, memorySettingStorage, type SettingStorage } from "./kept.ts";
import { ownerOf, type SettingSeat, sameOwner, sees, type ThreadLookup } from "./lineage.ts";
import type {
  Rung,
  Setting,
  SettingAnswer,
  SettingOrigin,
  SettingSize,
  SettingState,
  SettingUntil,
  SettingWhat,
  SettledBy,
  SettledOutcome,
  ShowEventSink,
} from "./setting.ts";

export interface ShowProposal {
  creature: string | null;
  sessionId: string;
  what: SettingWhat;
  rung: Rung;
  why: string;
  until: SettingUntil;
  from: string | null;
  origin: SettingOrigin;
  size?: SettingSize | undefined;
}

export interface SetOut {
  setting: Setting;
  replaced: Setting | undefined;
}

export type ShowRefusalKind = "invalid" | "missing" | "conflict" | "limited";

export interface ShowRefusal {
  refused: ShowRefusalKind;
  error: string;
}

export const showRefusalStatus: Readonly<Record<ShowRefusalKind, number>> = {
  invalid: 400,
  missing: 404,
  conflict: 409,
  limited: 429,
};

export const settingsPerHour = 30;

export interface SettingStoreOptions {
  emit: ShowEventSink;
  clock?: Clock | undefined;
  hourlyLimit?: number | undefined;
  threads?: ThreadLookup | undefined;
}

export interface KeptSettingStoreOptions extends SettingStoreOptions {
  storage: SettingStorage;
}

export class SettingStore {
  private readonly out = new Map<string, Setting>();
  private readonly timers = new Map<string, Cancel>();
  private readonly setOutAt = new Map<string, number[]>();
  private readonly outcomes = new HeardOutcomes();
  private readonly emit: ShowEventSink;
  private readonly clock: Clock;
  private readonly hourlyLimit: number;
  private readonly threadOf: ThreadLookup;
  private storage: SettingStorage = memorySettingStorage();

  static async load(options: KeptSettingStoreOptions): Promise<SettingStore> {
    const store = new SettingStore(options);
    await store.restore(options.storage);
    return store;
  }

  constructor(options: SettingStoreOptions) {
    this.emit = options.emit;
    this.clock = options.clock ?? systemClock;
    this.hourlyLimit = options.hourlyLimit ?? settingsPerHour;
    this.threadOf = options.threads ?? noThreads;
  }

  propose(proposal: ShowProposal): SetOut | ShowRefusal {
    const now = this.clock.now();
    const refusal = this.refusalOf(proposal, now);
    if (refusal !== undefined) return refusal;
    if (spendsTheHour(proposal)) this.remember(ownerOf(proposal), now);
    const replaced = this.outWithSameWhat(proposal);
    if (replaced !== undefined) this.withdraw(replaced, proposal.origin);
    const setting = settingOf(randomUUID(), proposal, replaced, isoOf(now));
    this.seat(setting);
    this.emit(setting.sessionId, "show.proposed", { setting });
    this.keep();
    return { setting, replaced };
  }

  async keeperOpens(opening: KeeperOpening): Promise<SetOut | ShowRefusal> {
    const { what, from, rung } = opening;
    const seat = await this.seatOf(from);
    if (seat === undefined)
      return refused("missing", `no setting out and no thread has the id ${from}`);
    return this.propose({ ...seat, what, rung, why: "", until: "seen", from, origin: "keeper" });
  }

  async canGrowFrom(caller: SettingSeat, from: string): Promise<boolean> {
    const parent = this.out.get(from);
    if (parent !== undefined && sameOwner(parent, caller)) return true;
    return this.threadInSight(caller, parent?.sessionId ?? from);
  }

  open(): readonly Setting[] {
    return [...this.out.values()];
  }

  answer(id: string, outcome: SettingAnswer): Setting | ShowRefusal {
    const setting = this.out.get(id);
    if (setting === undefined) return refused("missing", `no setting out has the id ${id}`);
    const state = keeperMoves[setting.state]?.[outcome];
    if (state === undefined) return refused("conflict", conflictOf(setting));
    const settled = this.settle(setting, outcome, "keeper", state);
    this.keep();
    return settled;
  }

  takeBack(caller: SettingSeat, id: string): Setting | ShowRefusal {
    const setting = this.out.get(id);
    if (setting === undefined || !sameOwner(setting, caller))
      return refused("missing", nothingOfYoursOut(id));
    const held = heldByTheKeeper(setting);
    if (held !== undefined) return refused("conflict", held);
    const settled = this.withdraw(setting, "creature");
    this.keep();
    return settled;
  }

  takeHeardBy(sessionId: string): Heard | undefined {
    return this.outcomes.take(sessionId);
  }

  rested(sessionId: string): void {
    this.withdrawLive(
      (setting) => setting.sessionId === sessionId && setting.until === "rests",
      "creature",
    );
  }

  removed(sessionId: string): void {
    this.withdrawLive((setting) => setting.sessionId === sessionId, "keeper");
    this.outcomes.forget(sessionId);
  }

  close(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  private async restore(storage: SettingStorage): Promise<void> {
    const kept = storage.load();
    const now = this.clock.now();
    const spent = kept.spent.filter((spend) => withinTheHour(Date.parse(spend.at), now));
    const missing = await this.missingThreadsOf(kept.settings.filter(isLive));
    const back = kept.settings.filter((setting) => !withdrawnByTheStop(setting, now, missing));
    for (const { owner, at } of spent) this.remember(owner, Date.parse(at));
    for (const setting of back) this.seat(setting);
    this.storage = storage;
    if (back.length < kept.settings.length || spent.length < kept.spent.length) this.keep();
  }

  private async missingThreadsOf(settings: readonly Setting[]): Promise<ReadonlySet<string>> {
    const missing = new Set<string>();
    for (const sessionId of new Set(settings.map((setting) => setting.sessionId))) {
      if (await this.knownGone(sessionId)) missing.add(sessionId);
    }
    return missing;
  }

  private async knownGone(sessionId: string): Promise<boolean> {
    try {
      return (await this.threadOf(sessionId)) === undefined;
    } catch {
      return false;
    }
  }

  private seat(setting: Setting): void {
    this.out.set(setting.id, setting);
    if (isLive(setting)) this.withdrawAtItsTime(setting);
  }

  private keep(): void {
    this.storage.save(this.keptNow());
  }

  private keptNow(): KeptSettings {
    const now = this.clock.now();
    const spent = [...this.setOutAt].flatMap(([owner, times]) =>
      times.filter((at) => withinTheHour(at, now)).map((at) => ({ owner, at: isoOf(at) })),
    );
    return { settings: this.open(), spent };
  }

  private async seatOf(from: string): Promise<SettingSeat | undefined> {
    const parent = this.out.get(from);
    if (parent !== undefined) return { creature: parent.creature, sessionId: parent.sessionId };
    const thread = await this.threadOf(from);
    return thread === undefined ? undefined : { creature: thread.creature, sessionId: from };
  }

  private async threadInSight(caller: SettingSeat, sessionId: string): Promise<boolean> {
    if (sessionId === caller.sessionId) return true;
    const thread = await this.threadOf(sessionId);
    return thread !== undefined && sees(caller, thread);
  }

  private refusalOf(proposal: ShowProposal, now: number): ShowRefusal | undefined {
    const ends = endOf(proposal.until);
    if (Number.isNaN(ends))
      return refused("invalid", `until is seen, rests or an ISO 8601 time, not ${proposal.until}`);
    if (ends <= now) return refused("invalid", `until ${proposal.until} has already passed`);
    if (
      spendsTheHour(proposal) &&
      this.setOutWithinTheHour(ownerOf(proposal), now) >= this.hourlyLimit
    )
      return refused("limited", limitWords(proposal.creature, this.hourlyLimit));
    return undefined;
  }

  private setOutWithinTheHour(owner: string, now: number): number {
    const recent = (this.setOutAt.get(owner) ?? []).filter((at) => withinTheHour(at, now));
    this.setOutAt.set(owner, recent);
    return recent.length;
  }

  private remember(owner: string, now: number): void {
    this.setOutAt.set(owner, [...(this.setOutAt.get(owner) ?? []), now]);
  }

  private outWithSameWhat(proposal: ShowProposal): Setting | undefined {
    const { what } = proposal;
    return [...this.out.values()].find(
      (setting) =>
        sameOwner(setting, proposal) &&
        setting.what.kind === what.kind &&
        setting.what.ref === what.ref,
    );
  }

  private withdrawAtItsTime(setting: Setting): void {
    const ends = endOf(setting.until);
    if (ends === Number.POSITIVE_INFINITY) return;
    this.timers.set(
      setting.id,
      this.clock.at(ends, () => this.withdrawLive(({ id }) => id === setting.id, "time")),
    );
  }

  private withdrawLive(matches: (setting: Setting) => boolean, by: SettledBy): void {
    const withdrawn = this.open().filter((setting) => isLive(setting) && matches(setting));
    for (const setting of withdrawn) this.withdraw(setting, by);
    if (withdrawn.length > 0) this.keep();
  }

  private withdraw(setting: Setting, by: SettledBy): Setting {
    return this.settle(setting, "withdrawn", by, "withdrawn");
  }

  private settle(
    setting: Setting,
    outcome: SettledOutcome,
    by: SettledBy,
    state: SettingState,
  ): Setting {
    const settled = { ...setting, state };
    if (isOut(state)) this.out.set(setting.id, settled);
    else this.takeIn(setting.id);
    this.outcomes.note(setting, outcome, by);
    this.emit(setting.sessionId, "show.settled", { id: setting.id, outcome, by });
    return settled;
  }

  private takeIn(id: string): void {
    this.out.delete(id);
    this.timers.get(id)?.();
    this.timers.delete(id);
  }
}

const keeperMoves: Readonly<
  Partial<Record<SettingState, Partial<Record<SettingAnswer, SettingState>>>>
> = {
  live: { seen: "seen", pinned: "pinned", dismissed: "dismissed" },
  pinned: { unpinned: "seen", dismissed: "dismissed" },
};

const noThreads: ThreadLookup = async () => undefined;

function spendsTheHour({ origin }: ShowProposal): boolean {
  return origin === "creature";
}

function limitWords(creature: string | null, limit: number): string {
  return creature === null
    ? `this thread has set out ${limit} settings this hour, the most a thread may set out; try again later`
    : `${creature} has set out ${limit} settings this hour, the most a creature may set out; try again later`;
}

function lineageOf({ from }: ShowProposal, replaced: Setting | undefined): string | null {
  return from === null || from === replaced?.id ? (replaced?.from ?? null) : from;
}

function settingOf(
  id: string,
  proposal: ShowProposal,
  replaced: Setting | undefined,
  at: string,
): Setting {
  const { creature, sessionId, what, rung, why, until, origin } = proposal;
  const lineage = { from: lineageOf(proposal, replaced), origin, replaces: replaced?.id ?? null };
  const size = sizeOf(proposal, replaced);
  return {
    id,
    creature,
    sessionId,
    what,
    rung,
    why,
    at,
    until,
    state: "live",
    ...lineage,
    ...(size !== undefined && { size }),
  };
}

function sizeOf(
  { size, origin }: ShowProposal,
  replaced: Setting | undefined,
): SettingSize | undefined {
  return size ?? (origin === "creature" ? replaced?.size : undefined);
}

function endOf(until: SettingUntil): number {
  return until === "seen" || until === "rests" ? Number.POSITIVE_INFINITY : Date.parse(until);
}

function withinTheHour(at: number, now: number): boolean {
  return at > now - hourMs;
}

function withdrawnByTheStop(
  setting: Setting,
  now: number,
  missingThreads: ReadonlySet<string>,
): boolean {
  return (
    isLive(setting) &&
    (setting.until === "rests" ||
      endOf(setting.until) <= now ||
      missingThreads.has(setting.sessionId))
  );
}

function isLive({ state }: Setting): boolean {
  return state === "live";
}

function isOut(state: SettingState): boolean {
  return state === "live" || state === "pinned";
}

function nothingOfYoursOut(id: string): string {
  return `nothing you set out is out with the id ${id}; shown lists what is out`;
}

function heldByTheKeeper(setting: Setting): string | undefined {
  if (setting.origin === "keeper")
    return `the keeper opened ${setting.id} themselves, so it is theirs to put away`;
  if (setting.state === "pinned")
    return `the keeper pinned ${setting.id}, so it stays until they let it go`;
  return undefined;
}

function conflictOf(setting: Setting): string {
  return setting.state === "pinned"
    ? `setting ${setting.id} is pinned; unpin or dismiss it`
    : `setting ${setting.id} is not pinned, so there is nothing to unpin`;
}

function refused(refusal: ShowRefusalKind, error: string): ShowRefusal {
  return { refused: refusal, error };
}
