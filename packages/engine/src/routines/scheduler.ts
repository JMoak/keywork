import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backoffMs } from "../backoff.ts";
import { type Cancel, type Clock, dayMs, hourMs, isoOf, minuteMs, systemClock } from "./clock.ts";
import { deliveryOfEffects, performEffect } from "./effects.ts";
import { type RoutineEventSink, silentSink } from "./events.ts";
import { type CreatureDirectory, mirrorRoutine, routineOf } from "./mirror.ts";
import {
  defaultNotificationSettings,
  type NotificationSettings,
  surfaceAt,
  tierOf,
} from "./notify.ts";
import { payloadRefOf, savePayload, type TriggerPayload } from "./payload.ts";
import { runPrompt } from "./prompt.ts";
import {
  type GrantRule,
  grantDigest,
  type NotifyChoice,
  needsAcceptance,
  type Routine,
  type ToolPosture,
} from "./routine.ts";
import {
  needsKeeper,
  type RunDelivery,
  type RunKind,
  type RunProcess,
  type RunRow,
  type RunTrigger,
} from "./run.ts";
import type {
  AskVerdict,
  CreatureHome,
  RoutineRunner,
  RunHandle,
  RunnerResult,
  RunSignals,
} from "./runner.ts";
import { type IndexedRoutine, type RoutineStore, runIdOf } from "./store.ts";
import { hasSlots, routinePlanOf, type SlotPlan, slotsBetween, staggerOf } from "./trigger.ts";
import { localTimeZone } from "./zone.ts";

export type ApprovalClass = "outbound" | "local";

export interface SchedulerSettings {
  catchUpWindowMs: number;
  startupDelayMs: number;
  pacingMs: number;
  overdueToleranceMs: number;
  backoffFirstMs: number;
  backoffMaxMs: number;
  disableAfterErrors: number;
  hourlyCapPerCreature: number;
  hourlyCapPerTrigger: number;
  watchdogMs: Readonly<Record<RunKind, number>>;
  approvalDeadlineMs: Readonly<Record<ApprovalClass, number>>;
  skippedRecordLimit: number;
}

export const defaultSchedulerSettings: SchedulerSettings = {
  catchUpWindowMs: dayMs,
  startupDelayMs: 30_000,
  pacingMs: 30_000,
  overdueToleranceMs: minuteMs,
  backoffFirstMs: 30_000,
  backoffMaxMs: 5 * minuteMs,
  disableAfterErrors: 5,
  hourlyCapPerCreature: 30,
  hourlyCapPerTrigger: 12,
  watchdogMs: { agent: 60 * minuteMs },
  approvalDeadlineMs: { outbound: 30 * minuteMs, local: 2 * hourMs },
  skippedRecordLimit: 50,
};

export interface Delivery {
  run: RunRow;
  routine: Routine;
  creature: CreatureHome;
  output: string;
}

export interface Deliverer {
  deliver(delivery: Delivery): Promise<void>;
}

export interface SchedulerOptions {
  store: RoutineStore;
  runner: RoutineRunner;
  deliverer: Deliverer;
  creatures: CreatureDirectory;
  outputsDir: string;
  clock?: Clock;
  emit?: RoutineEventSink;
  held?: (run: RunRow) => void;
  settings?: Partial<SchedulerSettings>;
  notifications?: NotificationSettings;
  zone?: string;
}

export interface PendingFire {
  creature: string;
  routineId: string;
  slot: number;
  attempt: number;
  trigger: RunTrigger;
  catchUp: boolean;
  scheduledFor: number;
  triggerKey: string;
}

export function approvalClassOf(tool: string): ApprovalClass {
  return localTools.has(tool) ? "local" : "outbound";
}

export class RoutineScheduler {
  private readonly store: RoutineStore;
  private readonly clock: Clock;
  private readonly emit: RoutineEventSink;
  private readonly settings: SchedulerSettings;
  private readonly notifications: NotificationSettings;
  private readonly pending = new Map<string, PendingFire>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private cancelTimer: Cancel | undefined;
  private running = false;

  constructor(private readonly options: SchedulerOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.emit = options.emit ?? silentSink;
    this.settings = { ...defaultSchedulerSettings, ...options.settings };
    this.notifications = options.notifications ?? defaultNotificationSettings;
  }

  start(): void {
    this.running = true;
    this.recoverInterrupted();
    const pacer = this.pacer("startup");
    for (const indexed of this.store.routines()) this.plan(indexed, "startup", pacer);
    this.arm();
  }

  stop(): void {
    this.running = false;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.pending.clear();
  }

  nextFire(creature: string, routineId: string): PendingFire | undefined {
    return this.pending.get(keyOf(creature, routineId));
  }

  activeRunId(creature: string, routineId: string): string | undefined {
    return (
      this.activeFor(creature, routineId)?.runId ?? this.store.heldRun(creature, routineId)?.runId
    );
  }

  refresh(indexed: IndexedRoutine): void {
    const pending = this.pending.get(keyOf(indexed.creature, indexed.id));
    const routine = routineOf(indexed);
    const wanted = routine !== undefined && isLive(indexed, routine) && hasSlots(routine.trigger);
    const stale =
      pending === undefined ? wanted : !wanted || pending.triggerKey !== triggerKeyOf(routine);
    if (stale) this.replan(indexed, indexed.creature, indexed.id);
  }

  replan(indexed: IndexedRoutine | undefined, creature: string, routineId: string): Promise<void> {
    this.pending.delete(keyOf(creature, routineId));
    if (indexed !== undefined) this.plan(indexed, "normal", this.pacer("wake"));
    this.arm();
    const settled = this.settleHeld(indexed, creature, routineId);
    this.track(settled);
    return settled;
  }

  async fireByHand(home: CreatureHome, indexed: IndexedRoutine, routine: Routine): Promise<RunRow> {
    const now = this.clock.now();
    return this.fire(
      {
        creature: home.slug,
        routineId: routine.id,
        slot: now,
        attempt: 1,
        trigger: "manual",
        catchUp: false,
        scheduledFor: now,
        triggerKey: triggerKeyOf(routine),
      },
      home,
      indexed,
      routine,
    );
  }

  async fireOnOccurrence(
    home: CreatureHome,
    indexed: IndexedRoutine,
    routine: Routine,
    payload: TriggerPayload,
  ): Promise<RunRow> {
    const now = this.clock.now();
    return this.fire(
      {
        creature: home.slug,
        routineId: routine.id,
        slot: now,
        attempt: 1,
        trigger: payload.kind,
        catchUp: false,
        scheduledFor: now,
        triggerKey: triggerKeyOf(routine),
      },
      home,
      indexed,
      routine,
      payload,
    );
  }

  async cancel(creature: string, routineId: string): Promise<string | undefined> {
    const active = this.activeFor(creature, routineId);
    if (active !== undefined) {
      this.stopRun(active, "cancelled");
      return active.runId;
    }
    const held = this.store.heldRun(creature, routineId);
    if (held === undefined) return undefined;
    const indexed = this.store.routine(creature, routineId);
    const notify = indexed === undefined ? undefined : routineOf(indexed)?.notify;
    await this.release(held, notify, "stopped by the keeper while it waited on its grant set");
    return held.runId;
  }

  async drain(): Promise<void> {
    do {
      await nextMacrotask();
      await Promise.allSettled([...this.inFlight]);
    } while (this.inFlight.size > 0);
  }

  private plan(indexed: IndexedRoutine, mode: PlanMode, pacer: Pacer): void {
    const key = keyOf(indexed.creature, indexed.id);
    this.pending.delete(key);
    const routine = routineOf(indexed);
    if (routine === undefined || !isLive(indexed, routine)) return;
    if (this.store.heldRun(indexed.creature, indexed.id) !== undefined) return;
    const plan = routinePlanOf(routine, indexed.anchorAt);
    if (plan === undefined) return;
    const fire = this.nextFireOf(indexed, routine, plan, mode, pacer);
    if (fire !== undefined) this.pending.set(key, fire);
  }

  private nextFireOf(
    indexed: IndexedRoutine,
    routine: Routine,
    plan: SlotPlan,
    mode: PlanMode,
    pacer: Pacer,
  ): PendingFire | undefined {
    const now = this.clock.now();
    const stagger = staggerOf(keyOf(indexed.creature, indexed.id), routine.trigger);
    const after = indexed.handledThrough ?? indexed.anchorAt;
    const retry = this.retryOf(indexed);
    const base = {
      creature: indexed.creature,
      routineId: indexed.id,
      triggerKey: triggerKeyOf(routine),
    };
    const trigger = routine.trigger.kind as RunTrigger;
    const missed = this.missedSlots(indexed, routine, plan, after, now);
    if (missed !== undefined) {
      const overdue =
        mode === "startup" || now > missed + stagger + this.settings.overdueToleranceMs;
      if (!overdue) {
        return {
          ...base,
          slot: missed,
          attempt: 1,
          trigger,
          catchUp: false,
          scheduledFor: Math.max(now, retry?.at ?? 0),
        };
      }
      return {
        ...base,
        slot: missed,
        attempt: 1,
        trigger,
        catchUp: true,
        scheduledFor: Math.max(pacer.next(), retry?.at ?? 0),
      };
    }
    const next = plan.next(Math.max(after, now));
    if (retry !== undefined && (next === undefined || next + stagger > retry.at)) {
      const at = mode === "startup" ? Math.max(retry.at, pacer.next()) : retry.at;
      return {
        ...base,
        slot: retry.slot,
        attempt: retry.attempt,
        trigger: retry.trigger,
        catchUp: false,
        scheduledFor: at,
      };
    }
    if (next === undefined) return undefined;
    return {
      ...base,
      slot: next,
      attempt: 1,
      trigger,
      catchUp: false,
      scheduledFor: Math.max(next + stagger, retry?.at ?? 0),
    };
  }

  private missedSlots(
    indexed: IndexedRoutine,
    routine: Routine,
    plan: SlotPlan,
    after: number,
    now: number,
  ): number | undefined {
    const windowStart = now - this.settings.catchUpWindowMs;
    const first = plan.next(after);
    if (first === undefined || first > now) return undefined;
    if (first <= windowStart) {
      this.recordSkipped(
        indexed,
        routine,
        first,
        `missed while the node was down or asleep; every slot until ${isoOf(windowStart)} is past the ${hoursOf(this.settings.catchUpWindowMs)} catch-up window`,
      );
    }
    const slots = slotsBetween(plan, Math.max(after, windowStart), now);
    const newest = slots.at(-1);
    if (newest === undefined) {
      this.store.markHandled(indexed.creature, indexed.id, now);
      return undefined;
    }
    const superseded = slots.slice(0, -1);
    const folded = Math.max(0, superseded.length - this.settings.skippedRecordLimit);
    superseded.slice(-this.settings.skippedRecordLimit).forEach((slot, index) => {
      const extra = index === 0 && folded > 0 ? ` (and ${folded} earlier slots)` : "";
      this.recordSkipped(
        indexed,
        routine,
        slot,
        `missed; only the most recent slot is caught up${extra}`,
      );
    });
    this.store.markHandled(indexed.creature, indexed.id, newest - 1);
    return newest;
  }

  private recordSkipped(indexed: IndexedRoutine, routine: Routine, slot: number, reason: string) {
    this.store.insertRun({
      creature: indexed.creature,
      routineId: indexed.id,
      attempt: 1,
      trigger: routine.trigger.kind as RunTrigger,
      catchUp: false,
      firedAt: slot,
      scheduledFor: slot,
      status: "skipped",
      reason,
      endedAt: this.clock.now(),
    });
  }

  private retryOf(indexed: IndexedRoutine): Retry | undefined {
    if (indexed.retryAt === null) return undefined;
    const [latest] = this.store.runs(indexed.creature, indexed.id, 1);
    if (latest === undefined || latest.trigger === "manual") return undefined;
    if (latest.process !== "failed" && latest.process !== "timed-out") return undefined;
    return {
      slot: Date.parse(latest.firedAt),
      attempt: latest.attempt + 1,
      trigger: latest.trigger,
      at: indexed.retryAt,
    };
  }

  private async tick(): Promise<void> {
    const now = this.clock.now();
    this.expireApprovals(now);
    this.enforceDeadlines(now);
    const due = [...this.pending.values()]
      .filter((fire) => fire.scheduledFor <= now)
      .sort((left, right) => left.scheduledFor - right.scheduledFor);
    const wakePacer = this.pacer("wake");
    for (const fire of due) {
      this.pending.delete(keyOf(fire.creature, fire.routineId));
      if (this.isOverdue(fire, now)) this.replanOverdue(fire, wakePacer);
      else await this.fireScheduled(fire);
    }
    this.arm();
  }

  private isOverdue(fire: PendingFire, now: number): boolean {
    return (
      !fire.catchUp &&
      fire.attempt === 1 &&
      now > fire.scheduledFor + this.settings.overdueToleranceMs
    );
  }

  private replanOverdue(fire: PendingFire, pacer: Pacer): void {
    const indexed = this.store.routine(fire.creature, fire.routineId);
    if (indexed !== undefined) this.plan(indexed, "wake", pacer);
  }

  private async fireScheduled(fire: PendingFire): Promise<void> {
    const home = await this.options.creatures.creature(fire.creature);
    if (home === undefined) return;
    const indexed = await mirrorRoutine(this.store, home, fire.routineId, this.clock.now());
    if (indexed === undefined) return;
    const routine = routineOf(indexed);
    const current =
      routine !== undefined &&
      isLive(indexed, routine) &&
      triggerKeyOf(routine) === fire.triggerKey;
    if (!current) return this.plan(indexed, "normal", this.pacer("wake"));
    await this.fire(fire, home, indexed, routine);
  }

  private async fire(
    fire: PendingFire,
    home: CreatureHome,
    indexed: IndexedRoutine,
    routine: Routine,
    payload?: TriggerPayload,
  ): Promise<RunRow> {
    const now = this.clock.now();
    const scheduled = fire.trigger !== "manual";
    const refusal = scheduled ? this.capRefusal(fire, now) : undefined;
    const occupied = this.occupiedBy(fire.creature, fire.routineId);
    const turnedAway =
      refusal !== undefined
        ? this.recordTurnedAway(fire, "dropped", refusal, now)
        : occupied !== undefined
          ? this.recordTurnedAway(fire, "skipped", occupied, now)
          : undefined;
    if (scheduled) this.store.markHandled(fire.creature, fire.routineId, fire.slot);
    if (turnedAway !== undefined) {
      this.replanAfter(indexed);
      return turnedAway;
    }
    const inserted = this.store.insertRun({ ...fire, firedAt: fire.slot, status: "running" });
    if (inserted === undefined) {
      this.replanAfter(indexed);
      return this.store.run(
        runIdOf(fire.creature, fire.routineId, fire.slot, fire.attempt),
      ) as RunRow;
    }
    if (payload !== undefined) await savePayload(this.options.outputsDir, inserted, payload);
    const consent = consentOf(indexed, routine);
    if ("blocked" in consent) return this.hold(inserted, routine, consent.blocked);
    return this.launch(inserted, fire, home, routine, consent, now);
  }

  private hold(run: RunRow, routine: Routine, reason: string): RunRow {
    const now = this.clock.now();
    const tier = tierOf(routine.notify, true);
    const held = this.store.holdRun(run.runId, reason, {
      tier,
      at: surfaceAt(tier, now, this.notifications),
    });
    this.options.held?.(held);
    this.replanAfterId(run.creature, run.routineId);
    return held;
  }

  private async settleHeld(
    indexed: IndexedRoutine | undefined,
    creature: string,
    routineId: string,
  ): Promise<void> {
    const held = this.store.heldRun(creature, routineId);
    if (held === undefined) return;
    if (indexed === undefined) {
      return this.release(
        held,
        undefined,
        "the chore was removed while its run waited on the grant set",
      );
    }
    const routine = routineOf(indexed);
    if (routine === undefined) return;
    const consent = consentOf(indexed, routine);
    if ("blocked" in consent) {
      if (held.trigger === "manual" || isLive(indexed, routine)) return;
      return this.release(
        held,
        routine.notify,
        "the chore was turned off while its run waited on the grant set",
      );
    }
    const home = await this.options.creatures.creature(creature);
    const stillHeld = this.store.heldRun(creature, routineId)?.runId === held.runId;
    if (home === undefined || !stillHeld || this.active.has(held.runId)) return;
    await this.launch(held, fireFactsOf(held), home, routine, consent, this.clock.now());
  }

  private release(held: RunRow, notify: NotifyChoice | undefined, reason: string): Promise<void> {
    return this.conclude(held, notify ?? "never", {
      process: "cancelled",
      delivery: "none",
      reason,
      usage: null,
      costUsd: null,
      output: null,
    }).then(() => undefined);
  }

  private occupiedBy(creature: string, routineId: string): string | undefined {
    const active = this.activeFor(creature, routineId);
    if (active !== undefined) return `the previous run ${active.runId} is still active`;
    const held = this.store.heldRun(creature, routineId);
    if (held === undefined) return undefined;
    return `the run ${held.runId} is parked until the keeper accepts the grant set`;
  }

  private async launch(
    run: RunRow,
    fire: FireFacts,
    home: CreatureHome,
    routine: Routine,
    consent: Granted,
    now: number,
  ): Promise<RunRow> {
    const active = this.activate(run, home, routine, now);
    let handle: RunHandle;
    try {
      const payload = await payloadRefOf(this.options.outputsDir, run);
      handle = await this.options.runner.start(
        {
          runId: run.runId,
          creature: home,
          routine,
          prompt: runPrompt(routine, home.slug, {
            firedAt: fire.slot,
            startedAt: now,
            zone: this.zoneOf(routine),
            catchUp: fire.catchUp,
            attempt: fire.attempt,
            payload,
          }),
          posture: consent.posture,
          grants: consent.grants,
          ...(payload !== undefined && { payload }),
        },
        this.signalsFor(active),
      );
    } catch (cause) {
      this.active.delete(run.runId);
      const reason = `the run could not start: ${messageOf(cause)}`;
      return this.conclude(run, routine.notify, failedEnding(reason));
    }
    active.handle = handle;
    this.store.startRun(run.runId, handle.sessionId, now);
    this.emitFired(run, handle.sessionId, now);
    if (active.stopReason !== null) this.track(handle.stop());
    this.replanAfterId(home.slug, routine.id);
    handle.finished.then(
      (result) => this.track(this.finish(active, result)),
      (cause) => this.track(this.finish(active, crashedResult(cause))),
    );
    this.arm();
    return this.store.run(run.runId) as RunRow;
  }

  private activate(run: RunRow, home: CreatureHome, routine: Routine, now: number): ActiveRun {
    const watchdog = this.settings.watchdogMs.agent;
    const budget = routine.budget.minutes * minuteMs;
    const active: ActiveRun = {
      runId: run.runId,
      home,
      routine,
      handle: undefined,
      watchdogMs: watchdog,
      deadline: now + Math.min(watchdog, budget),
      deadlineReason: budget < watchdog ? "minutes-budget" : "watchdog",
      parkedAt: null,
      stopReason: null,
    };
    this.active.set(run.runId, active);
    return active;
  }

  private async finish(active: ActiveRun, result: RunnerResult): Promise<void> {
    this.active.delete(active.runId);
    const run = this.store.run(active.runId) as RunRow;
    const process = processOf(result, active);
    const output = await this.saveOutput(run, result.output);
    const delivery =
      process === "completed" && result.output.trim() !== ""
        ? await this.deliver(run, active, result.output)
        : deliveryOfEffects(this.store.effectsOf(run.runId));
    await this.conclude(run, active.routine.notify, {
      process,
      delivery,
      reason: reasonOf(process, result, active),
      usage: result.usage,
      costUsd: result.costUsd,
      output,
    });
  }

  private async conclude(run: RunRow, notify: NotifyChoice, ending: Ending): Promise<RunRow> {
    const now = this.clock.now();
    const tier = tierOf(notify, needsKeeper(ending));
    const ended = this.store.endRun(
      run.runId,
      { ...ending, verified: null, notify: { tier, at: surfaceAt(tier, now, this.notifications) } },
      now,
    );
    const disabled = this.account(ended, ending.reason, now);
    this.emit("routine.finished", { run: ended, disabled });
    this.replanAfterId(run.creature, run.routineId);
    return ended;
  }

  private account(run: RunRow, reason: string | null, now: number): string | null {
    if (run.trigger === "manual") return null;
    if (run.process === "completed") {
      this.store.recordSuccess(run.creature, run.routineId);
      return null;
    }
    if (run.process !== "failed" && run.process !== "timed-out") return null;
    const before = this.store.routine(run.creature, run.routineId)?.consecutiveErrors ?? 0;
    const failures = this.store.recordFailure(
      run.creature,
      run.routineId,
      now + backoffMs(before + 1, this.settings),
    );
    if (failures < this.settings.disableAfterErrors) return null;
    const disabled = `disabled after ${failures} failed runs in a row; the last: ${reason ?? run.process}`;
    this.store.disable(run.creature, run.routineId, disabled, now);
    return disabled;
  }

  private async deliver(run: RunRow, active: ActiveRun, output: string): Promise<RunDelivery> {
    const outcome = await performEffect(
      this.store,
      this.clock,
      {
        key: `deliver:${run.creature}/${run.routineId}/${Date.parse(run.firedAt)}`,
        runId: run.runId,
        kind: "deliver",
        params: { destination: active.routine.destination },
      },
      () =>
        this.options.deliverer.deliver({
          run,
          routine: active.routine,
          creature: active.home,
          output,
        }),
    );
    return outcome.delivery;
  }

  private async saveOutput(run: RunRow, output: string): Promise<string> {
    const dir = join(this.options.outputsDir, run.creature, run.routineId);
    const file = join(dir, `${run.firedAt.replace(/[:.]/g, "-")}-${run.attempt}.md`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, output.endsWith("\n") || output === "" ? output : `${output}\n`, "utf8");
    return file;
  }

  private recoverInterrupted(): void {
    const now = this.clock.now();
    for (const run of this.store.activeRuns()) {
      if (heldOnGrants(run)) continue;
      for (const approval of this.store.pendingApprovals(run.runId)) {
        this.store.settleApproval(approval.callId, "expired", now);
      }
      const delivery = deliveryOfEffects(this.store.effectsOf(run.runId));
      const reason =
        delivery === "unknown"
          ? "the node stopped while an effect was in flight; it may or may not have happened, so it is never replayed"
          : "the node stopped during the run";
      const tier = "interrupt" as const;
      const ended = this.store.endRun(
        run.runId,
        {
          ...failedEnding(reason),
          delivery,
          verified: null,
          notify: { tier, at: surfaceAt(tier, now, this.notifications) },
        },
        now,
      );
      if (delivery === "none" && run.attempt === 1 && run.trigger !== "manual") {
        this.store.recordRetry(run.creature, run.routineId, now);
      }
      this.emit("routine.finished", { run: ended, disabled: null });
    }
    for (const orphan of this.store.pendingApprovals()) {
      this.store.settleApproval(orphan.callId, "expired", now);
    }
  }

  private capRefusal(fire: PendingFire, now: number): string | undefined {
    const since = now - hourMs;
    const byRoutine = this.store.countFiredSince(fire.creature, fire.routineId, since);
    if (byRoutine >= this.settings.hourlyCapPerTrigger) {
      return `dropped: this chore already ran ${byRoutine} times in the last hour (cap ${this.settings.hourlyCapPerTrigger})`;
    }
    const byCreature = this.store.countFiredSince(fire.creature, undefined, since);
    if (byCreature >= this.settings.hourlyCapPerCreature) {
      return `dropped: ${fire.creature} already ran ${byCreature} chores in the last hour (cap ${this.settings.hourlyCapPerCreature})`;
    }
    return undefined;
  }

  private recordTurnedAway(
    fire: PendingFire,
    status: "skipped" | "dropped",
    reason: string,
    now: number,
  ): RunRow {
    const row = this.store.insertRun({ ...fire, firedAt: fire.slot, status, reason, endedAt: now });
    return (
      row ??
      (this.store.run(runIdOf(fire.creature, fire.routineId, fire.slot, fire.attempt)) as RunRow)
    );
  }

  private replanAfter(indexed: IndexedRoutine): void {
    this.replanAfterId(indexed.creature, indexed.id);
  }

  private replanAfterId(creature: string, routineId: string): void {
    const indexed = this.store.routine(creature, routineId);
    if (indexed !== undefined && this.running) this.plan(indexed, "normal", this.pacer("wake"));
    this.arm();
  }

  private signalsFor(active: ActiveRun): RunSignals {
    return {
      spent: (costUsd) => {
        if (costUsd > active.routine.budget.usd) this.stopRun(active, "usd-budget");
      },
      asked: ({ callId, tool }) => this.park(active, callId, tool),
      answered: (callId, verdict) => this.answered(active, callId, verdict),
    };
  }

  private park(active: ActiveRun, callId: string, tool: string): void {
    const now = this.clock.now();
    const approvalClass = approvalClassOf(tool);
    this.store.parkApproval({
      callId,
      runId: active.runId,
      tool,
      approvalClass,
      requestedAt: now,
      deadlineAt: now + this.settings.approvalDeadlineMs[approvalClass],
    });
    if (active.parkedAt === null) {
      active.parkedAt = now;
      this.store.setActiveStatus(active.runId, "parked", waitingOnAnswer(tool));
    }
    this.arm();
  }

  private answered(active: ActiveRun, callId: string, verdict: AskVerdict): void {
    this.store.settleApproval(callId, verdict, this.clock.now());
    this.unparkIfClear(active);
  }

  private unparkIfClear(active: ActiveRun): void {
    if (active.parkedAt === null || this.store.pendingApprovals(active.runId).length > 0) return;
    active.deadline += this.clock.now() - active.parkedAt;
    active.parkedAt = null;
    this.store.setActiveStatus(active.runId, "running", null);
    this.arm();
  }

  private expireApprovals(now: number): void {
    for (const approval of this.store.pendingApprovals()) {
      if (approval.deadlineAt > now) continue;
      this.store.settleApproval(approval.callId, "expired", now);
      const active = this.active.get(approval.runId);
      if (active === undefined) continue;
      if (active.handle !== undefined) this.track(active.handle.deny(approval.callId));
      this.unparkIfClear(active);
    }
  }

  private enforceDeadlines(now: number): void {
    for (const active of this.active.values()) {
      if (active.parkedAt === null && active.stopReason === null && active.deadline <= now) {
        this.stopRun(active, active.deadlineReason);
      }
    }
  }

  private stopRun(active: ActiveRun, reason: StopReason): void {
    if (active.stopReason !== null) return;
    active.stopReason = reason;
    if (active.handle !== undefined) this.track(active.handle.stop());
  }

  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!this.running) return;
    const wake = this.nextWake();
    if (wake !== undefined) {
      this.cancelTimer = this.clock.at(wake, () => this.track(this.tick()));
    }
  }

  private nextWake(): number | undefined {
    const times = [
      ...[...this.pending.values()].map((fire) => fire.scheduledFor),
      ...[...this.active.values()]
        .filter((active) => active.parkedAt === null && active.stopReason === null)
        .map((active) => active.deadline),
      ...this.store.pendingApprovals().map((approval) => approval.deadlineAt),
    ];
    return times.length === 0 ? undefined : Math.min(...times);
  }

  private pacer(mode: PlanMode): Pacer {
    const first =
      this.clock.now() +
      (mode === "startup" ? this.settings.startupDelayMs : this.settings.pacingMs);
    let issued = 0;
    return { next: () => first + this.settings.pacingMs * issued++ };
  }

  private activeFor(creature: string, routineId: string): ActiveRun | undefined {
    return [...this.active.values()].find(
      (active) => active.home.slug === creature && active.routine.id === routineId,
    );
  }

  private emitFired(run: RunRow, sessionId: string, startedAt: number): void {
    this.emit("routine.fired", {
      runId: run.runId,
      creature: run.creature,
      routineId: run.routineId,
      attempt: run.attempt,
      trigger: run.trigger,
      catchUp: run.catchUp,
      firedAt: run.firedAt,
      scheduledFor: run.scheduledFor,
      startedAt: isoOf(startedAt),
      sessionId,
    });
  }

  private zoneOf(routine: Routine): string {
    return routine.trigger.kind === "cron"
      ? routine.trigger.tz
      : (this.options.zone ?? this.notifications.tz ?? localTimeZone());
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }
}

type PlanMode = "startup" | "wake" | "normal";

type StopReason = "cancelled" | "watchdog" | "minutes-budget" | "usd-budget";

type FireFacts = Pick<PendingFire, "slot" | "attempt" | "catchUp">;

interface ActiveRun {
  runId: string;
  home: CreatureHome;
  routine: Routine;
  handle: RunHandle | undefined;
  watchdogMs: number;
  deadline: number;
  deadlineReason: "watchdog" | "minutes-budget";
  parkedAt: number | null;
  stopReason: StopReason | null;
}

interface Pacer {
  next(): number;
}

interface Retry {
  slot: number;
  attempt: number;
  trigger: RunTrigger;
  at: number;
}

interface Granted {
  posture: ToolPosture;
  grants: readonly GrantRule[];
}

type Consent = Granted | { blocked: string };

interface Ending {
  process: RunProcess;
  delivery: RunDelivery;
  reason: string | null;
  usage: RunRow["usage"];
  costUsd: number | null;
  output: string | null;
}

const localTools = new Set(["write", "edit"]);

function consentOf(indexed: IndexedRoutine, routine: Routine): Consent {
  if (!needsAcceptance(routine)) return { posture: "read-only", grants: [] };
  const digest = grantDigest(routine);
  if (indexed.accepted?.digest === digest)
    return { posture: routine.tools, grants: routine.grants };
  return {
    blocked: `this chore asks for ${routine.tools} tools (grant set ${digest}); it waits until the keeper accepts that grant set, and a fired trigger never does`,
  };
}

function processOf(result: RunnerResult, active: ActiveRun): RunProcess {
  switch (active.stopReason) {
    case "cancelled":
      return "cancelled";
    case "watchdog":
      return "timed-out";
    case "minutes-budget":
    case "usd-budget":
      return "blocked";
    case null:
      break;
  }
  if (result.ended === "completed") return overBudget(result, active) ? "blocked" : "completed";
  return result.ended === "failed" ? "failed" : "cancelled";
}

function reasonOf(process: RunProcess, result: RunnerResult, active: ActiveRun): string | null {
  const { budget } = active.routine;
  switch (active.stopReason ?? (overBudget(result, active) ? "usd-budget" : null)) {
    case "cancelled":
      return "stopped by the keeper; stopping does not undo what already ran";
    case "watchdog":
      return `the ${hoursOf(active.watchdogMs)} watchdog for agent runs ended it`;
    case "minutes-budget":
      return `ran past its ${budget.minutes}-minute budget`;
    case "usd-budget":
      return `spent past its $${budget.usd.toFixed(2)} budget${result.costUsd === null ? "" : ` ($${result.costUsd.toFixed(2)})`}`;
    case null:
      return process === "completed" ? null : result.reason;
  }
}

function overBudget(result: RunnerResult, active: ActiveRun): boolean {
  return result.costUsd !== null && result.costUsd > active.routine.budget.usd;
}

export function heldOnGrants(run: Pick<RunRow, "status" | "sessionId">): boolean {
  return run.status === "parked" && run.sessionId === null;
}

export function waitingOnAnswer(tool: string): string {
  return `waits on the keeper's answer to its ${tool} ask; its session stays open and goes on once answered`;
}

function fireFactsOf(run: RunRow): FireFacts {
  return { slot: Date.parse(run.firedAt), attempt: run.attempt, catchUp: run.catchUp };
}

function failedEnding(reason: string): Ending {
  return { process: "failed", delivery: "none", reason, usage: null, costUsd: null, output: null };
}

function isLive(indexed: IndexedRoutine, routine: Routine): boolean {
  return routine.enabled && indexed.disabled === null;
}

function triggerKeyOf(routine: Routine): string {
  return JSON.stringify(routine.trigger);
}

function keyOf(creature: string, routineId: string): string {
  return `${creature}/${routineId}`;
}

function hoursOf(ms: number): string {
  return ms % hourMs === 0 ? `${ms / hourMs} h` : `${Math.round(ms / minuteMs)} min`;
}

function crashedResult(cause: unknown): RunnerResult {
  return {
    ended: "failed",
    output: "",
    usage: null,
    costUsd: null,
    reason: `the runner failed: ${messageOf(cause)}`,
  };
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
