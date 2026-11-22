import { randomUUID } from "node:crypto";
import {
  type Cancel,
  type Clock,
  hourMs,
  isoOf,
  minuteMs,
  systemClock,
} from "../routines/clock.ts";
import { AgentColors } from "./agents.ts";
import {
  type Arrangement,
  type ArrangementAsk,
  arrangementBodyOf,
  arrangementsPerMinute,
  arrangementsRemembered,
  earlierBodyOf,
  type OwnPane,
  outsideAtOnce,
  placementWaitMs,
  type SeatedPane,
} from "./arrangement.ts";
import { type Heard, HeardOutcomes, keeperMoveOf, type PlacedNote } from "./heard.ts";
import type { KeeperOpening } from "./input.ts";
import { type KeptSettings, memorySettingStorage, type SettingStorage } from "./kept.ts";
import { ownerOf, type SettingSeat, sameOwner, sees, type ThreadLookup } from "./lineage.ts";
import { ConsoleReports, PlacementBook, type PlacementsReport, standsAs } from "./placements.ts";
import { nothingOfYoursOut, refused, type ShowRefusal } from "./refusal.ts";
import { type Seat, seatProblemOf } from "./seat.ts";
import type {
  Mood,
  Rung,
  Setting,
  SettingAgent,
  SettingAnswer,
  SettingOrigin,
  SettingPlace,
  SettingSignal,
  SettingSize,
  SettingState,
  SettingUntil,
  SettingWeight,
  SettingWhat,
  SettledBy,
  SettledOutcome,
  ShowEventSink,
} from "./setting.ts";
import {
  criticalAlready,
  criticalOfAnother,
  criticalsAtOnce,
  criticalWithoutReason,
  loweredByAnother,
  raisedByTheCaller,
  type SignalCaller,
  type Signalled,
  type Signalling,
  severalCriticals,
} from "./signals.ts";
import { askedOf, type StandingPicture, type Stood, stoodOf } from "./standing.ts";
import { noSignal, type SignalSaid } from "./vocabularies.ts";

export { type ShowRefusal, type ShowRefusalKind, showRefusalStatus } from "./refusal.ts";
export type { SignalCaller, Signalled, Signalling } from "./signals.ts";

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
  where?: SettingPlace | undefined;
  seat?: Seat | undefined;
  weight?: SettingWeight | undefined;
  mood?: Mood | undefined;
  agent?: SettingAgent | undefined;
  mark?: string | undefined;
  signal?: SignalSaid | undefined;
  lastsMs?: number | undefined;
  keeps?: Keeps | undefined;
}

export interface Keeps {
  rung?: boolean;
  why?: boolean;
  until?: boolean;
}

export interface Marking {
  id: string;
  mark: string | undefined;
}

export interface SetOut {
  setting: Setting;
  replaced: Setting | undefined;
}

export const settingsPerHour = 100;

export type StandingReader = "owner" | "another";

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
  private readonly arrangedAt = new Map<string, number[]>();
  private readonly arrangedBefore = new Map<string, SeatedPane[][]>();
  private readonly outcomes = new HeardOutcomes();
  private readonly placements = new PlacementBook();
  private readonly agents = new AgentColors();
  private readonly reports: ConsoleReports;
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
    this.reports = new ConsoleReports(this.clock, placementWaitMs);
    this.hourlyLimit = options.hourlyLimit ?? settingsPerHour;
    this.threadOf = options.threads ?? noThreads;
  }

  propose(asked: ShowProposal): SetOut | ShowRefusal {
    const now = this.clock.now();
    const { lastsMs, keeps, ...named } = asked;
    const replaced = this.outWithSameWhat(named);
    const signal = signalAfter(named, replaced);
    const held = signal === "critical";
    const timed = held
      ? { ...named, until: "seen" }
      : lastsMs === undefined
        ? named
        : { ...named, until: isoOf(now + lastsMs) };
    const proposal = keptFrom(
      timed,
      replaced,
      held || lastsMs !== undefined ? { ...keeps, until: false } : keeps,
    );
    const placing = this.placingOf(proposal, replaced);
    const refusal =
      this.signalRefusal(named, signal, replaced) ??
      this.refusalOf(proposal, placing, replaced, now);
    if (refusal !== undefined) return refusal;
    if (spendsTheHour(proposal)) this.remember(ownerOf(proposal), now);
    if (replaced !== undefined) this.withdraw(replaced, proposal.origin);
    const { agent } = proposal;
    const shownBy =
      agent === undefined ? proposal : { ...proposal, agent: this.agents.coloured(agent) };
    const setting = settingOf(randomUUID(), shownBy, placing, replaced, isoOf(now), signal);
    this.setDown(setting);
    this.emit(setting.sessionId, "show.proposed", { setting });
    this.keep();
    return { setting, replaced };
  }

  async keeperOpens(opening: KeeperOpening): Promise<SetOut | ShowRefusal> {
    const { what, from, rung } = opening;
    const owner = await this.ownerAt(from);
    if (owner === undefined)
      return refused("missing", `no setting out and no thread has the id ${from}`);
    return this.propose({ ...owner, what, rung, why: "", until: "seen", from, origin: "keeper" });
  }

  arrange(caller: SettingSeat, ask: ArrangementAsk): Arrangement | ShowRefusal {
    const now = this.clock.now();
    const history = this.arrangedBefore.get(caller.sessionId) ?? [];
    const own = this.ownPanesOf(caller);
    const standing = this.seatedOutside(caller);
    const body = ask.back === true ? earlierBodyOf(ask, history, own) : arrangementBodyOf(ask, own);
    if ("refused" in body) return body;
    const recent = this.arrangedWithinTheMinute(caller.sessionId, now);
    if (recent.length >= arrangementsPerMinute)
      return refused("limited", arrangementLimitWords(recent, now));
    const { creature, sessionId } = caller;
    const arrangement = { id: randomUUID(), creature, sessionId, at: isoOf(now), ...body };
    this.arrangedAt.set(sessionId, [...recent, now]);
    const grown = standing.length === 0 ? history : [...history, standing];
    const remembered = ask.back === true ? history.slice(0, -1) : grown;
    this.arrangedBefore.set(sessionId, remembered.slice(-arrangementsRemembered));
    this.askOutside(arrangement);
    this.emit(sessionId, "show.arranged", { arrangement });
    this.keep();
    return arrangement;
  }

  async placed(sessionId: string, report: PlacementsReport): Promise<ShowRefusal | undefined> {
    if (!(await this.hasThread(sessionId)))
      return refused("missing", `no session has the id ${sessionId}`);
    this.placements.report(sessionId, report);
    this.reports.heard(report);
    return undefined;
  }

  reportNaming(
    names: (report: PlacementsReport) => boolean,
  ): Promise<PlacementsReport | undefined> {
    return this.reports.next(names);
  }

  standingFor(caller: SettingSeat, readBy: StandingReader = "owner"): StandingPicture {
    const out = this.open()
      .filter((setting) => sameOwner(setting, caller))
      .map((setting) => this.stood(setting));
    if (readBy === "owner") this.placements.lookedAt(out.map(({ setting }) => setting.id));
    return { out, stage: this.placements.stage() };
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

  takeBack(caller: SignalCaller, id: string, mood?: Mood): Setting | ShowRefusal {
    const setting = this.out.get(id);
    if (setting === undefined || !sameOwner(setting, caller))
      return refused("missing", nothingOfYoursOut(id));
    const held = heldByTheKeeper(setting);
    if (held !== undefined) return refused("conflict", held);
    if (setting.signal === "critical" && !raisedByTheCaller(setting, caller))
      return loweredByAnother(setting);
    const settled = this.withdraw(setting, "creature", mood);
    this.keep();
    return settled;
  }

  signal(
    caller: SignalCaller,
    signals: readonly Signalling[],
    why: string | undefined,
    spends: boolean,
  ): readonly Signalled[] | ShowRefusal {
    const now = this.clock.now();
    const recent = this.arrangedWithinTheMinute(caller.sessionId, now);
    if (spends && recent.length >= arrangementsPerMinute)
      return refused("limited", arrangementLimitWords(recent, now));
    const named = this.ownSignalled(caller, signals);
    if ("refused" in named) return named;
    const refusal = this.signallingRefusal(caller, named, why);
    if (refusal !== undefined) return refusal;
    if (spends) this.arrangedAt.set(caller.sessionId, [...recent, now]);
    const signalled = named.map(({ setting, signal }) => this.signalledAs(setting, signal, why));
    if (signalled.some(({ setting }, at) => setting !== named[at]?.setting)) this.keep();
    return signalled;
  }

  clearSignal(id: string): Setting | ShowRefusal {
    const setting = this.out.get(id);
    if (setting === undefined) return refused("missing", `no setting out has the id ${id}`);
    const { signal } = setting;
    if (signal === undefined)
      return refused("conflict", `setting ${id} carries no signal, so there is nothing to clear`);
    const { setting: cleared } = this.signalledAs(setting, undefined);
    this.outcomes.cleared(cleared, signal);
    this.keep();
    return cleared;
  }

  mark(
    caller: SettingSeat,
    marks: readonly Marking[],
    spends: boolean,
  ): readonly Setting[] | ShowRefusal {
    const now = this.clock.now();
    const recent = this.arrangedWithinTheMinute(caller.sessionId, now);
    if (spends && recent.length >= arrangementsPerMinute)
      return refused("limited", arrangementLimitWords(recent, now));
    const stranger = marks.find(({ id }) => {
      const setting = this.out.get(id);
      return setting === undefined || !sameOwner(setting, caller) || setting.origin !== "creature";
    });
    if (stranger !== undefined) return refused("missing", nothingOfYoursOut(stranger.id));
    if (spends) this.arrangedAt.set(caller.sessionId, [...recent, now]);
    const marked = marks.flatMap(({ id, mark }) => this.markedAs(id, mark));
    if (marked.length > 0) this.keep();
    return marks.flatMap(({ id }) => this.out.get(id) ?? []);
  }

  takeHeardBy(sessionId: string): Heard | undefined {
    const settled = this.outcomes.take(sessionId);
    const placed = this.placedByTheKeeper(sessionId);
    if (placed.length === 0) return settled;
    return { told: [], earlier: 0, ...settled, placed };
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
    this.placements.forgetSession(sessionId);
    this.arrangedAt.delete(sessionId);
    this.arrangedBefore.delete(sessionId);
  }

  close(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.reports.close();
  }

  private async restore(storage: SettingStorage): Promise<void> {
    const kept = storage.load();
    const now = this.clock.now();
    const spent = kept.spent.filter((spend) => withinTheHour(Date.parse(spend.at), now));
    const missing = await this.missingThreadsOf(kept.settings.filter(isLive));
    const back = kept.settings.filter((setting) => !withdrawnByTheStop(setting, now, missing));
    for (const { owner, at } of spent) this.remember(owner, Date.parse(at));
    for (const setting of back) this.setDown(setting);
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

  private async hasThread(sessionId: string): Promise<boolean> {
    if (this.open().some((setting) => setting.sessionId === sessionId)) return true;
    return !(await this.knownGone(sessionId));
  }

  private ownSignalled(
    caller: SignalCaller,
    signals: readonly Signalling[],
  ): NamedSignal[] | ShowRefusal {
    const named: NamedSignal[] = [];
    for (const { id, signal } of signals) {
      const setting = this.out.get(id);
      if (setting === undefined || !sameOwner(setting, caller) || setting.origin !== "creature")
        return refused("missing", nothingOfYoursOut(id));
      named.push({ setting, signal });
    }
    return named;
  }

  private signallingRefusal(
    caller: SignalCaller,
    named: readonly NamedSignal[],
    why: string | undefined,
  ): ShowRefusal | undefined {
    for (const { setting, signal } of named) {
      const lowers = setting.signal === "critical" && signal !== "critical";
      if (lowers && !raisedByTheCaller(setting, caller)) return loweredByAnother(setting);
      if (signal !== "critical" || setting.signal === "critical") continue;
      if (!raisedByTheCaller(setting, caller)) return criticalOfAnother(setting);
      if ((why ?? "").trim() === "") return criticalWithoutReason(setting);
    }
    const raising = named.filter(
      ({ setting, signal }) => signal === "critical" && setting.signal !== "critical",
    );
    if (raising.length > criticalsAtOnce) return severalCriticals;
    if (raising.length === 0) return undefined;
    const asked = new Map(named.map(({ setting, signal }) => [setting.id, signal]));
    const held = this.criticalsOf(caller).find((setting) => !asked.has(setting.id));
    const kept = named.find(
      ({ setting, signal }) => signal === "critical" && setting.signal === "critical",
    );
    const holding = held ?? kept?.setting;
    return holding === undefined ? undefined : criticalAlready(holding);
  }

  private signalRefusal(
    asked: ShowProposal,
    signal: SettingSignal | undefined,
    replaced: Setting | undefined,
  ): ShowRefusal | undefined {
    if (asked.origin !== "creature") return undefined;
    const lowers = replaced?.signal === "critical" && signal !== "critical";
    if (lowers && !raisedByTheCaller(replaced, asked)) return loweredByAnother(replaced);
    if (signal !== "critical" || replaced?.signal === "critical") return undefined;
    if (asked.why.trim() === "") return criticalWithoutReason(asked);
    const held = this.criticalsOf(asked).find((setting) => setting.id !== replaced?.id);
    return held === undefined ? undefined : criticalAlready(held);
  }

  private criticalsOf(caller: SignalCaller): Setting[] {
    return this.open().filter(
      (setting) =>
        setting.signal === "critical" &&
        sameOwner(setting, caller) &&
        raisedByTheCaller(setting, caller),
    );
  }

  private signalledAs(
    setting: Setting,
    signal: SettingSignal | undefined,
    why?: string,
  ): Signalled {
    const before = setting.signal;
    const reason = signal === undefined ? undefined : why;
    if (before === signal && (reason === undefined || reason === setting.why))
      return { setting, before };
    const { signal: _before, ...quiet } = setting;
    const changed: Setting =
      signal === undefined
        ? quiet
        : {
            ...quiet,
            signal,
            ...(reason !== undefined && { why: reason }),
            ...(signal === "critical" && { until: "seen" }),
          };
    if (signal === "critical") this.stopTheClockOn(setting.id);
    this.out.set(setting.id, changed);
    this.emit(changed.sessionId, "show.changed", { setting: changed });
    return { setting: changed, before };
  }

  private stopTheClockOn(id: string): void {
    this.timers.get(id)?.();
    this.timers.delete(id);
  }

  private markedAs(id: string, mark: string | undefined): Setting[] {
    const setting = this.out.get(id);
    if (setting === undefined || setting.mark === mark) return [];
    const { mark: _before, ...unmarked } = setting;
    const changed: Setting = mark === undefined ? unmarked : { ...unmarked, mark };
    this.out.set(id, changed);
    this.emit(changed.sessionId, "show.changed", { setting: changed });
    return [changed];
  }

  private setDown(setting: Setting): void {
    this.agents.remember(setting.agent);
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

  private async ownerAt(from: string): Promise<SettingSeat | undefined> {
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

  private stood(setting: Setting): Stood {
    return stoodOf(setting, this.placements.of(setting.id));
  }

  private seatedOutside(caller: SettingSeat): SeatedPane[] {
    return this.open()
      .filter((setting) => sameOwner(setting, caller) && setting.origin === "creature")
      .flatMap((setting) => {
        const { where, seat, by } = this.stood(setting);
        const reported = where === "outside" && seat !== undefined && by !== undefined;
        return reported ? [{ id: setting.id, seat }] : [];
      });
  }

  private ownPanesOf(caller: SettingSeat): OwnPane[] {
    return this.open()
      .filter((setting) => sameOwner(setting, caller) && setting.origin === "creature")
      .map((setting) => ({ setting, outside: this.stood(setting).where === "outside" }));
  }

  private placingOf(proposal: ShowProposal, replaced: Setting | undefined): Placing {
    const { where, seat, origin } = proposal;
    if (seat !== undefined) return { where: where ?? "outside", seat };
    if (where !== undefined) return { where };
    if (origin !== "creature" || replaced === undefined) return {};
    const stands = this.stood(replaced);
    return stands.where === "outside" ? { where: "outside", ...seated(stands.seat) } : {};
  }

  private refusalOf(
    proposal: ShowProposal,
    placing: Placing,
    replaced: Setting | undefined,
    now: number,
  ): ShowRefusal | undefined {
    const ends = endOf(proposal.until);
    if (Number.isNaN(ends))
      return refused("invalid", `until is seen, rests or an ISO 8601 time, not ${proposal.until}`);
    if (ends <= now) return refused("invalid", `until ${proposal.until} has already passed`);
    const unseated = seatRefusal(placing);
    if (unseated !== undefined) return unseated;
    if (
      spendsTheHour(proposal) &&
      this.setOutWithinTheHour(ownerOf(proposal), now) >= this.hourlyLimit
    )
      return refused("limited", limitWords(proposal.creature, this.hourlyLimit));
    return this.roomRefusal(proposal, placing, replaced);
  }

  private roomRefusal(
    proposal: ShowProposal,
    placing: Placing,
    replaced: Setting | undefined,
  ): ShowRefusal | undefined {
    if (placing.where !== "outside" || proposal.origin !== "creature") return undefined;
    const outside = this.ownPanesOf(proposal).filter(
      (pane) => pane.outside && pane.setting.id !== replaced?.id,
    ).length;
    return outside < outsideAtOnce ? undefined : refused("limited", outsideLimitWords(outside));
  }

  private setOutWithinTheHour(owner: string, now: number): number {
    const recent = (this.setOutAt.get(owner) ?? []).filter((at) => withinTheHour(at, now));
    this.setOutAt.set(owner, recent);
    return recent.length;
  }

  private remember(owner: string, now: number): void {
    this.setOutAt.set(owner, [...(this.setOutAt.get(owner) ?? []), now]);
  }

  private arrangedWithinTheMinute(sessionId: string, now: number): number[] {
    return (this.arrangedAt.get(sessionId) ?? []).filter((at) => at > now - minuteMs);
  }

  private askOutside(arrangement: Arrangement): void {
    const composed = new Map(arrangement.seats?.map(({ id, seat }) => [id, seat]));
    for (const id of arrangement.panes) {
      const setting = this.out.get(id);
      if (setting === undefined || this.placements.of(id)?.by === "keeper") continue;
      const seat = arrangement.seats === undefined ? undefined : (composed.get(id) ?? setting.seat);
      this.out.set(id, askedOutside(setting, seat));
    }
  }

  private placedByTheKeeper(sessionId: string): PlacedNote[] {
    const mine = this.open().filter(
      (setting) => setting.sessionId === sessionId && setting.origin === "creature",
    );
    const placings = this.placements.takeKeeperPlacings(mine.map(({ id }) => id));
    return placings.flatMap(({ id, before, now }) => {
      const setting = mine.find((candidate) => candidate.id === id);
      if (setting === undefined) return [];
      const stood = before ?? askedOf(setting);
      if (standsAs(stood, now)) return [];
      const move = keeperMoveOf(stood, now);
      return [{ id, what: setting.what, move, ...(now.where === "outside" && seated(now.seat)) }];
    });
  }

  private outWithSameWhat(proposal: ShowProposal): Setting | undefined {
    const { what } = proposal;
    return [...this.out.values()].find(
      (setting) =>
        sameOwner(setting, proposal) &&
        setting.what.kind === what.kind &&
        (setting.what.ref === what.ref || sameNote(setting.what, what)),
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

  private withdraw(setting: Setting, by: SettledBy, mood?: Mood): Setting {
    return this.settle(setting, "withdrawn", by, "withdrawn", mood);
  }

  private settle(
    setting: Setting,
    outcome: SettledOutcome,
    by: SettledBy,
    state: SettingState,
    mood?: Mood,
  ): Setting {
    const settled = { ...setting, state };
    if (isOut(state)) this.out.set(setting.id, settled);
    else this.takeIn(setting.id);
    this.outcomes.note(setting, outcome, by);
    const leaving = { id: setting.id, outcome, by, ...(mood !== undefined && { mood }) };
    this.emit(setting.sessionId, "show.settled", leaving);
    return settled;
  }

  private takeIn(id: string): void {
    this.out.delete(id);
    this.timers.get(id)?.();
    this.timers.delete(id);
    this.placements.forgetSetting(id);
  }
}

interface Placing {
  where?: SettingPlace;
  seat?: Seat;
}

interface NamedSignal {
  setting: Setting;
  signal: SettingSignal | undefined;
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

function outsideLimitWords(outside: number): string {
  return `${outside} of your settings already stand outside, the most that may at once; withdraw one that has gone stale, or leave where out and this sets out beside the conversation`;
}

function arrangementLimitWords(recent: readonly number[], now: number): string {
  const wait = Math.ceil(((recent[0] ?? now) + minuteMs - now) / 1000);
  return `this thread has arranged ${recent.length} times in the last minute, the most it may; the next may go in ${wait} seconds, and one arrange can seat every pane at once`;
}

function seatRefusal({ where, seat }: Placing): ShowRefusal | undefined {
  if (seat === undefined) return undefined;
  if (where !== "outside")
    return refused(
      "invalid",
      "a seat is a place outside, so it cannot go with where beside; leave one of them out",
    );
  const problem = seatProblemOf(seat);
  return problem === undefined
    ? undefined
    : refused("invalid", `the seat does not fit: ${problem}`);
}

function lineageOf({ from }: ShowProposal, replaced: Setting | undefined): string | null {
  return from === null || from === replaced?.id ? (replaced?.from ?? null) : from;
}

function signalAfter(
  { signal, origin }: ShowProposal,
  replaced: Setting | undefined,
): SettingSignal | undefined {
  if (signal === noSignal) return undefined;
  return keptByAReplacement(signal, replaced?.signal, origin);
}

function settingOf(
  id: string,
  proposal: ShowProposal,
  placing: Placing,
  replaced: Setting | undefined,
  at: string,
  signal: SettingSignal | undefined,
): Setting {
  const { creature, sessionId, what, rung, why, until, origin, mood, agent } = proposal;
  const lineage = { from: lineageOf(proposal, replaced), origin, replaces: replaced?.id ?? null };
  const size = keptByAReplacement(proposal.size, replaced?.size, origin);
  const weight = keptByAReplacement(proposal.weight, replaced?.weight, origin);
  const mark = keptByAReplacement(proposal.mark, replaced?.mark, origin);
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
    ...placing,
    ...(weight !== undefined && { weight }),
    ...(mood !== undefined && { mood }),
    ...(agent !== undefined && { agent }),
    ...(mark !== undefined && { mark }),
    ...(signal !== undefined && { signal }),
  };
}

function keptFrom<Asked extends Omit<ShowProposal, "lastsMs" | "keeps">>(
  asked: Asked,
  replaced: Setting | undefined,
  keeps: Keeps | undefined,
): Asked {
  if (replaced === undefined || keeps === undefined || asked.origin !== "creature") return asked;
  return {
    ...asked,
    ...(keeps.rung === true && { rung: replaced.rung }),
    ...(keeps.why === true && { why: replaced.why }),
    ...(keeps.until === true && { until: replaced.until }),
  };
}

function keptByAReplacement<Named>(
  named: Named | undefined,
  before: Named | undefined,
  origin: SettingOrigin,
): Named | undefined {
  return named ?? (origin === "creature" ? before : undefined);
}

function seated(seat: Seat | undefined): { seat?: Seat } {
  return seat === undefined ? {} : { seat };
}

function askedOutside({ seat: _before, ...setting }: Setting, seat: Seat | undefined): Setting {
  return { ...setting, where: "outside", ...seated(seat) };
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

function sameNote(one: SettingWhat, other: SettingWhat): boolean {
  return one.kind === "note" && one.title !== undefined && one.title === other.title;
}
