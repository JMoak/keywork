import { randomUUID } from "node:crypto";
import { type Cancel, type Clock, hourMs, isoOf, systemClock } from "../routines/clock.ts";
import type {
  Rung,
  Setting,
  SettingAnswer,
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
}

export class SettingStore {
  private readonly out = new Map<string, Setting>();
  private readonly timers = new Map<string, Cancel>();
  private readonly setOutAt = new Map<string, number[]>();
  private readonly emit: ShowEventSink;
  private readonly clock: Clock;
  private readonly hourlyLimit: number;

  constructor(options: SettingStoreOptions) {
    this.emit = options.emit;
    this.clock = options.clock ?? systemClock;
    this.hourlyLimit = options.hourlyLimit ?? settingsPerHour;
  }

  propose(proposal: ShowProposal): SetOut | ShowRefusal {
    const now = this.clock.now();
    const refusal = this.refusalOf(proposal, now);
    if (refusal !== undefined) return refusal;
    this.remember(ownerOf(proposal), now);
    const replaced = this.outWithSameWhat(proposal);
    if (replaced !== undefined) this.withdraw(replaced, "creature");
    const setting = settingOf(randomUUID(), proposal, isoOf(now));
    this.out.set(setting.id, setting);
    this.withdrawAtItsTime(setting);
    this.emit(setting.sessionId, "show.proposed", { setting });
    return { setting, replaced };
  }

  open(): readonly Setting[] {
    return [...this.out.values()];
  }

  answer(id: string, outcome: SettingAnswer): Setting | ShowRefusal {
    const setting = this.out.get(id);
    if (setting === undefined) return refused("missing", `no setting out has the id ${id}`);
    const state = keeperMoves[setting.state]?.[outcome];
    if (state === undefined) return refused("conflict", conflictOf(setting));
    return this.settle(setting, outcome, "keeper", state);
  }

  rested(sessionId: string): void {
    this.withdrawLive(
      (setting) => setting.sessionId === sessionId && setting.until === "rests",
      "creature",
    );
  }

  removed(sessionId: string): void {
    this.withdrawLive((setting) => setting.sessionId === sessionId, "keeper");
  }

  close(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  private refusalOf(proposal: ShowProposal, now: number): ShowRefusal | undefined {
    const ends = endOf(proposal.until);
    if (Number.isNaN(ends))
      return refused("invalid", `until is seen, rests or an ISO 8601 time, not ${proposal.until}`);
    if (ends <= now) return refused("invalid", `until ${proposal.until} has already passed`);
    if (this.setOutWithinTheHour(ownerOf(proposal), now) >= this.hourlyLimit)
      return refused("limited", limitWords(proposal.creature, this.hourlyLimit));
    return undefined;
  }

  private setOutWithinTheHour(owner: string, now: number): number {
    const recent = (this.setOutAt.get(owner) ?? []).filter((at) => at > now - hourMs);
    this.setOutAt.set(owner, recent);
    return recent.length;
  }

  private remember(owner: string, now: number): void {
    this.setOutAt.set(owner, [...(this.setOutAt.get(owner) ?? []), now]);
  }

  private outWithSameWhat(proposal: ShowProposal): Setting | undefined {
    const owner = ownerOf(proposal);
    const { what } = proposal;
    return [...this.out.values()].find(
      (setting) =>
        ownerOf(setting) === owner &&
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
    for (const setting of [...this.out.values()]) {
      if (setting.state === "live" && matches(setting)) this.withdraw(setting, by);
    }
  }

  private withdraw(setting: Setting, by: SettledBy): void {
    this.settle(setting, "withdrawn", by, "withdrawn");
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

function ownerOf({ creature, sessionId }: Pick<Setting, "creature" | "sessionId">): string {
  return creature === null ? `thread ${sessionId}` : `creature ${creature}`;
}

function limitWords(creature: string | null, limit: number): string {
  return creature === null
    ? `this thread has set out ${limit} settings this hour, the most a thread may set out; try again later`
    : `${creature} has set out ${limit} settings this hour, the most a creature may set out; try again later`;
}

function settingOf(id: string, proposal: ShowProposal, at: string): Setting {
  const { creature, sessionId, what, rung, why, until } = proposal;
  return { id, creature, sessionId, what, rung, why, at, until, state: "live" };
}

function endOf(until: SettingUntil): number {
  return until === "seen" || until === "rests" ? Number.POSITIVE_INFINITY : Date.parse(until);
}

function isOut(state: SettingState): boolean {
  return state === "live" || state === "pinned";
}

function conflictOf(setting: Setting): string {
  return setting.state === "pinned"
    ? `setting ${setting.id} is pinned; unpin or dismiss it`
    : `setting ${setting.id} is not pinned, so there is nothing to unpin`;
}

function refused(refusal: ShowRefusalKind, error: string): ShowRefusal {
  return { refused: refusal, error };
}
