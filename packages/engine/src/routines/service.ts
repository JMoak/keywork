import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { choreNeedTierOf, type NeedTier } from "../notices/tier.ts";
import type { CheckResult } from "./check.ts";
import { type Clock, isoOf, systemClock } from "./clock.ts";
import {
  type RoutineEventSink,
  type RoutineEvents,
  type RoutineEventType,
  silentSink,
} from "./events.ts";
import { removeRoutineFile, writeRoutineFile } from "./files.ts";
import { type CreatureDirectory, mirrorCreature, mirrorRoutine, routineOf } from "./mirror.ts";
import { type PayloadRef, payloadRefOf, type TriggerPayload } from "./payload.ts";
import { grantDigest, needsAcceptance, parseRoutine, type Routine } from "./routine.ts";
import { needsKeeper, type RunRow, tellsNow } from "./run.ts";
import type { CreatureHome } from "./runner.ts";
import { RoutineScheduler, type SchedulerOptions } from "./scheduler.ts";
import { type Occurrence, TriggerSources } from "./sources.ts";
import type { IndexedRoutine, RoutineStore } from "./store.ts";
import { wakeExpiryOf } from "./trigger.ts";
import {
  coversGrants,
  defaultWakeSettings,
  type WakeRequest,
  type WakeSettings,
  wakeIdOf,
  wakeLedgerWindowMs,
  wakeLimitOf,
  wakeRoutineOf,
} from "./wake.ts";
import { type FileWatcher, nodeFileWatcher } from "./watch.ts";

export interface RoutineView {
  creature: string;
  id: string;
  file: string;
  routine: Routine | null;
  problem: string | null;
  grants: GrantsView | null;
  schedule: ScheduleView;
  activeRunId: string | null;
  lastRun: RunRow | null;
  lastCheck: CheckResult | null;
}

export interface GrantsView {
  posture: Routine["tools"];
  check: string | null;
  digest: string;
  needsAcceptance: boolean;
  accepted: boolean;
  acceptedAt: string | null;
}

export interface ChoreJournal {
  view: RoutineView;
  runs: RunRow[];
  acceptedDigest: string | null;
}

export interface ScheduleView {
  enabled: boolean;
  disabled: { reason: string; at: string } | null;
  nextRunAt: string | null;
  consecutiveErrors: number;
  retryAt: string | null;
}

export type Missing = "missing-creature" | "missing-routine";

export type Refusal = { refusal: string };

export type NeedsYouKind = "invalid" | "disabled" | "grants" | "run";

export interface NeedsYouItem {
  creature: string;
  routineId: string;
  kind: NeedsYouKind;
  tier: NeedTier;
  reason: string;
  runId: string | null;
  since: string | null;
  action: NeedsYouAction | null;
}

export type NeedsYouAction = { verb: "accept"; digest: string } | { verb: "answer" };

export type QuestionChoice = "retry" | "off";

export interface RoutineServiceOptions extends SchedulerOptions {
  watcher?: FileWatcher | undefined;
  wakes?: Partial<WakeSettings> | undefined;
}

export interface HookDelivery {
  token: string | undefined;
  contentType: string;
  body: string;
}

export interface MintedHook {
  token: string;
  path: string;
}

export type HookRefusal = "unauthorized" | "too-large";

export interface ScheduledWake {
  routine: RoutineView;
  inheritedFrom: string | null;
}

export class RoutineService {
  private readonly scheduler: RoutineScheduler;
  private readonly store: RoutineStore;
  private readonly creatures: CreatureDirectory;
  private readonly now: () => number;
  private readonly emit: RoutineEventSink;
  private readonly sources: TriggerSources;
  private readonly occurring = new Set<Promise<unknown>>();
  private readonly wakeSettings: WakeSettings;
  private readonly wakesAsked = new Map<string, number[]>();
  private readonly outputsDir: string;

  constructor(options: RoutineServiceOptions) {
    this.outputsDir = options.outputsDir;
    this.emit = options.emit ?? silentSink;
    this.scheduler = new RoutineScheduler({
      ...options,
      emit: this.announcingSink(),
      held: (run) => this.announceNeeds(run.creature, run.routineId),
    });
    this.store = options.store;
    this.creatures = options.creatures;
    const clock: Clock = options.clock ?? systemClock;
    this.now = () => clock.now();
    this.wakeSettings = { ...defaultWakeSettings, ...options.wakes };
    this.sources = new TriggerSources({
      clock,
      workspace: options.workspace,
      watcher: options.watcher ?? nodeFileWatcher,
      occur: (occurrence) => this.trackOccurrence(this.occur(occurrence)),
    });
  }

  async start(): Promise<void> {
    for (const home of await this.creatures.creatures()) {
      await mirrorCreature(this.store, home, this.now());
    }
    this.scheduler.start();
    for (const indexed of this.store.routines()) this.sources.sync(indexed);
  }

  stop(): void {
    this.scheduler.stop();
    this.sources.stop();
  }

  async drain(): Promise<void> {
    do {
      await Promise.allSettled([...this.occurring]);
      await this.scheduler.drain();
    } while (this.occurring.size > 0);
  }

  observe(type: string, payload: unknown): void {
    this.sources.observe(type, payload);
  }

  async list(creature: string): Promise<RoutineView[] | Missing> {
    const home = await this.creatures.creature(creature);
    if (home === undefined) return "missing-creature";
    const indexed = await mirrorCreature(this.store, home, this.now());
    for (const routine of indexed) {
      this.scheduler.refresh(routine);
      this.sources.sync(routine);
    }
    return indexed.map((routine) => this.viewOf(routine));
  }

  async read(creature: string, id: string): Promise<RoutineView | Missing> {
    const found = await this.find(creature, id);
    return typeof found === "string" ? found : this.viewOf(found.indexed);
  }

  async put(
    creature: string,
    id: string,
    body: unknown,
  ): Promise<{ routine: RoutineView; created: boolean } | Refusal | Missing> {
    const home = await this.creatures.creature(creature);
    if (home === undefined) return "missing-creature";
    const parsed = parseRoutine(withId(body, id));
    if ("problem" in parsed) return { refusal: parsed.problem };
    if (parsed.routine.id !== id) {
      return { refusal: `the path names ${id} but the body's id is "${parsed.routine.id}"` };
    }
    const created = this.store.routine(creature, id) === undefined;
    await writeRoutineFile(home.dir, parsed.routine);
    const indexed = await this.remirror(home, id);
    if (indexed === undefined) return "missing-routine";
    if (indexed.disabled !== null && parsed.routine.enabled) this.store.reinstate(creature, id);
    const current = this.store.routine(creature, id) ?? indexed;
    await this.scheduler.replan(current, creature, id);
    this.sources.sync(current);
    this.announceNeeds(creature, id);
    return { routine: this.viewOf(current), created };
  }

  async scheduleWake(
    creature: string,
    request: WakeRequest,
  ): Promise<ScheduledWake | Refusal | Missing> {
    const home = await this.creatures.creature(creature);
    if (home === undefined) return "missing-creature";
    const now = this.now();
    const limit = wakeLimitOf(
      this.wakesAskedSince(creature, now),
      this.liveWakes(creature),
      this.wakeSettings,
    );
    if (limit !== undefined) return { refusal: limit };
    const id = wakeIdOf(now, (taken) => this.store.routine(creature, taken) !== undefined);
    const built = wakeRoutineOf(request, id, now, this.wakeSettings);
    if ("problem" in built) return { refusal: built.problem };
    this.wakesAsked.set(creature, [...(this.wakesAsked.get(creature) ?? []), now]);
    await writeRoutineFile(home.dir, built.routine);
    const indexed = await this.remirror(home, id);
    if (indexed === undefined) return "missing-routine";
    const inheritedFrom = this.inheritAcceptance(indexed, built.routine);
    const current = this.store.routine(creature, id) ?? indexed;
    await this.scheduler.replan(current, creature, id);
    this.announceNeeds(creature, id);
    return { routine: this.viewOf(current), inheritedFrom };
  }

  async mintHook(creature: string, id: string): Promise<MintedHook | Refusal | Missing> {
    const found = await this.find(creature, id);
    if (typeof found === "string") return found;
    const routine = routineOf(found.indexed);
    if (routine === undefined) return { refusal: problemOf(found.indexed) };
    if (routine.trigger.kind !== "webhook") {
      return { refusal: "only a chore with a webhook trigger has a hook token" };
    }
    const token = randomBytes(32).toString("base64url");
    this.store.setHookToken(creature, id, digestOf(token), this.now());
    return { token, path: `/hooks/${creature}/${id}` };
  }

  async hook(
    creature: string,
    id: string,
    delivery: HookDelivery,
  ): Promise<RunRow | Refusal | HookRefusal | "quiet"> {
    const expected = this.store.hookTokenDigest(creature, id);
    if (expected === undefined || !tokenMatches(delivery.token, expected)) return "unauthorized";
    const found = await this.find(creature, id);
    if (typeof found === "string") return "unauthorized";
    const routine = routineOf(found.indexed);
    if (routine === undefined) return { refusal: problemOf(found.indexed) };
    if (routine.trigger.kind !== "webhook") return "unauthorized";
    if (Buffer.byteLength(delivery.body) > routine.trigger.maxBytes) return "too-large";
    if (!routine.enabled || found.indexed.disabled !== null) {
      return { refusal: "the chore is turned off, so its hook fires nothing" };
    }
    const fired = await this.scheduler.fireOnOccurrence(
      found.home,
      found.indexed,
      routine,
      hookPayloadOf(delivery, this.now()),
    );
    return fired ?? "quiet";
  }

  async remove(creature: string, id: string): Promise<RoutineView | Missing> {
    const found = await this.find(creature, id);
    if (typeof found === "string") return found;
    const view = this.viewOf(found.indexed);
    await removeRoutineFile(found.home.dir, id);
    this.store.forget(creature, id);
    this.sources.forget(creature, id);
    await this.scheduler.replan(undefined, creature, id);
    this.announceNeeds(creature, id);
    return view;
  }

  async run(creature: string, id: string): Promise<RunRow | Refusal | Missing> {
    const found = await this.find(creature, id);
    if (typeof found === "string") return found;
    const routine = routineOf(found.indexed);
    if (routine === undefined) return { refusal: problemOf(found.indexed) };
    return this.scheduler.fireByHand(found.home, found.indexed, routine);
  }

  async cancel(creature: string, id: string): Promise<RunRow | "idle" | Missing> {
    const found = await this.find(creature, id);
    if (typeof found === "string") return found;
    const runId = await this.scheduler.cancel(creature, id);
    return runId === undefined ? "idle" : (this.store.run(runId) as RunRow);
  }

  async runs(creature: string, id: string, limit: number): Promise<RunRow[] | Missing> {
    if ((await this.creatures.creature(creature)) === undefined) return "missing-creature";
    const known = this.store.routine(creature, id) !== undefined;
    const runs = this.store.runs(creature, id, limit);
    return known || runs.length > 0 ? runs : "missing-routine";
  }

  async accept(
    creature: string,
    id: string,
    digest: string,
  ): Promise<RoutineView | Refusal | Missing> {
    const found = await this.find(creature, id);
    if (typeof found === "string") return found;
    const routine = routineOf(found.indexed);
    if (routine === undefined) return { refusal: problemOf(found.indexed) };
    if (!needsAcceptance(routine))
      return { refusal: "a read-only chore with no check has nothing to accept" };
    const current = grantDigest(routine);
    if (digest !== current) {
      return {
        refusal: `the grant set changed: it is now ${current}; read it again before accepting`,
      };
    }
    this.store.accept(creature, id, current, this.now());
    const accepted = this.store.routine(creature, id) ?? found.indexed;
    await this.scheduler.replan(accepted, creature, id);
    this.sources.sync(accepted);
    this.announceNeeds(creature, id);
    return this.viewOf(accepted);
  }

  async answer(
    creature: string,
    id: string,
    choice: QuestionChoice,
  ): Promise<{ done: string; run: RunRow | null } | Refusal | Missing> {
    const found = await this.find(creature, id);
    if (typeof found === "string") return found;
    const routine = routineOf(found.indexed);
    if (routine === undefined) return { refusal: problemOf(found.indexed) };
    if (found.indexed.disabled === null) {
      return { refusal: "this chore has no question waiting: it was not turned off by failures" };
    }
    if (choice === "off") {
      await writeRoutineFile(found.home.dir, { ...routine, enabled: false });
      const indexed = await this.remirror(found.home, id);
      this.store.reinstate(creature, id);
      await this.scheduler.replan(this.store.routine(creature, id) ?? indexed, creature, id);
      this.announceNeeds(creature, id);
      return {
        done: `${routine.title} is off. It runs again only when you turn it on.`,
        run: null,
      };
    }
    const run = await this.scheduler.retryNow(found.home, found.indexed, routine);
    this.announceNeeds(creature, id);
    if (run === undefined) {
      return {
        done: `${routine.title}'s check found nothing to do, so it did not run.`,
        run: null,
      };
    }
    return { done: `${routine.title} is trying again now.`, run };
  }

  async journalOf(creature: string, runsEach = journalRuns): Promise<ChoreJournal[] | Missing> {
    const views = await this.list(creature);
    if (typeof views === "string") return views;
    return views.map((view) => ({
      view,
      runs: this.store.runs(creature, view.id, runsEach),
      acceptedDigest: this.store.routine(creature, view.id)?.accepted?.digest ?? null,
    }));
  }

  async payloadOf(sessionId: string): Promise<PayloadRef | undefined> {
    const run = this.store.activeRuns().find((active) => active.sessionId === sessionId);
    return run === undefined ? undefined : payloadRefOf(this.outputsDir, run);
  }

  needsYou(): NeedsYouItem[] {
    return this.store.routines().flatMap((indexed) => this.needsOf(indexed));
  }

  private async find(
    creature: string,
    id: string,
  ): Promise<{ home: CreatureHome; indexed: IndexedRoutine } | Missing> {
    const home = await this.creatures.creature(creature);
    if (home === undefined) return "missing-creature";
    const indexed = await this.remirror(home, id);
    if (indexed === undefined) return "missing-routine";
    this.scheduler.refresh(indexed);
    return { home, indexed };
  }

  private async remirror(home: CreatureHome, id: string): Promise<IndexedRoutine | undefined> {
    const indexed = await mirrorRoutine(this.store, home, id, this.now());
    if (indexed === undefined) {
      this.sources.forget(home.slug, id);
      await this.scheduler.replan(undefined, home.slug, id);
    }
    return indexed;
  }

  private async occur({ creature, routineId, payload }: Occurrence): Promise<void> {
    const found = await this.find(creature, routineId);
    if (typeof found === "string") return;
    const routine = routineOf(found.indexed);
    if (routine === undefined || routine.trigger.kind !== payload.kind) return;
    if (!routine.enabled || found.indexed.disabled !== null) return;
    await this.scheduler.fireOnOccurrence(found.home, found.indexed, routine, payload);
  }

  private trackOccurrence(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => this.occurring.delete(tracked));
    this.occurring.add(tracked);
  }

  private wakesAskedSince(creature: string, now: number): number {
    const recent = (this.wakesAsked.get(creature) ?? []).filter(
      (at) => at > now - wakeLedgerWindowMs,
    );
    this.wakesAsked.set(creature, recent);
    return recent.length;
  }

  private liveWakes(creature: string): number {
    return this.store.routines(creature).filter((indexed) => {
      const routine = routineOf(indexed);
      if (routine?.wake === undefined) return false;
      return (
        this.scheduler.nextFire(creature, indexed.id) !== undefined ||
        this.scheduler.activeRunId(creature, indexed.id) !== undefined
      );
    }).length;
  }

  private inheritAcceptance(indexed: IndexedRoutine, wake: Routine): string | null {
    if (!needsAcceptance(wake)) return null;
    const cover = this.store.routines(indexed.creature).find((candidate) => {
      const routine = routineOf(candidate);
      return (
        routine !== undefined &&
        routine.wake === undefined &&
        candidate.accepted?.digest === grantDigest(routine) &&
        coversGrants(routine, wake)
      );
    });
    if (cover === undefined) return null;
    this.store.accept(indexed.creature, indexed.id, grantDigest(wake), this.now());
    return cover.id;
  }

  private viewOf(indexed: IndexedRoutine): RoutineView {
    const routine = routineOf(indexed) ?? null;
    const next = this.scheduler.nextFire(indexed.creature, indexed.id);
    const [lastRun] = this.store.runs(indexed.creature, indexed.id, 1);
    return {
      creature: indexed.creature,
      id: indexed.id,
      file: indexed.file,
      routine,
      problem: routine === null ? problemOf(indexed) : null,
      grants: routine === null ? null : grantsViewOf(indexed, routine),
      schedule: {
        enabled: routine?.enabled ?? false,
        disabled:
          indexed.disabled === null
            ? null
            : { reason: indexed.disabled.reason, at: isoOf(indexed.disabled.at) },
        nextRunAt: next === undefined ? null : isoOf(next.scheduledFor),
        consecutiveErrors: indexed.consecutiveErrors,
        retryAt: indexed.retryAt === null ? null : isoOf(indexed.retryAt),
      },
      activeRunId: this.scheduler.activeRunId(indexed.creature, indexed.id) ?? null,
      lastRun: lastRun ?? null,
      lastCheck: indexed.lastCheck,
    };
  }

  private announcingSink(): RoutineEventSink {
    return (type, payload) => {
      this.emit(type, payload);
      this.sources.observe(type, payload);
      const changed = routineOfEvent(type, payload);
      if (changed !== undefined) this.announceNeeds(changed.creature, changed.routineId);
      const finished = finishedRunOf(type, payload);
      if (finished !== undefined && finished.trigger !== "manual" && !needsKeeper(finished)) {
        this.trackOccurrence(this.retireIfSpent(finished.creature, finished.routineId));
      }
      if (type === "routine.checked" && "check" in payload && payload.check.verdict === "quiet") {
        this.trackOccurrence(this.retireIfSpent(payload.creature, payload.routineId));
      }
    };
  }

  private async retireIfSpent(creature: string, routineId: string): Promise<void> {
    const found = await this.find(creature, routineId);
    if (typeof found === "string") return;
    const routine = routineOf(found.indexed);
    if (routine === undefined || !retiresWhenSpent(routine)) return;
    if (!routine.enabled || found.indexed.disabled !== null) return;
    const waiting =
      this.scheduler.nextFire(creature, routineId) !== undefined ||
      this.scheduler.activeRunId(creature, routineId) !== undefined;
    if (!waiting) await this.remove(creature, routineId);
  }

  private announceNeeds(creature: string, routineId: string): void {
    const indexed = this.store.routine(creature, routineId);
    this.emit("routine.needs", {
      creature,
      routineId,
      items: indexed === undefined ? [] : this.needsOf(indexed),
    });
  }

  private needsOf(indexed: IndexedRoutine): NeedsYouItem[] {
    const item = (
      kind: NeedsYouKind,
      reason: string,
      since: string | null,
      runId: string | null = null,
      action: NeedsYouAction | null = null,
    ): NeedsYouItem => ({
      creature: indexed.creature,
      routineId: indexed.id,
      kind,
      tier: choreNeedTierOf(kind, runId !== null),
      reason,
      runId,
      since,
      action,
    });
    const routine = routineOf(indexed);
    if (routine === undefined) return [item("invalid", problemOf(indexed), null)];
    if (indexed.disabled !== null) {
      const since = isoOf(indexed.disabled.at);
      return [item("disabled", indexed.disabled.reason, since, null, { verb: "answer" })];
    }
    const grants = grantsViewOf(indexed, routine);
    const held = this.store.heldRun(indexed.creature, indexed.id);
    const [lastRun] = this.store.runs(indexed.creature, indexed.id, 1);
    const ended = lastRun?.status === "ended" ? lastRun : undefined;
    const items: NeedsYouItem[] = [];
    if (grants.needsAcceptance && !grants.accepted && (routine.enabled || held !== undefined)) {
      const accept: NeedsYouAction = { verb: "accept", digest: grants.digest };
      const since = held?.firedAt ?? null;
      const asked = acceptanceAsked(routine);
      items.push(item("grants", asked, since, held?.runId ?? null, accept));
    }
    if (ended !== undefined && (routine.enabled || ended.trigger === "manual") && tellsNow(ended)) {
      items.push(
        item(
          "run",
          ended.reason ?? ended.process ?? "the last run needs you",
          ended.endedAt,
          ended.runId,
        ),
      );
    }
    return items;
  }
}

export function acceptanceAsked(routine: Pick<Routine, "tools" | "check">): string {
  const check =
    routine.check === undefined ? undefined : `check for work by running ${routine.check.command}`;
  if (routine.tools === "read-only") return `asks to ${check}`;
  const tools = routine.tools === "act" ? "run commands and write files" : "write files";
  return check === undefined ? `asks to ${tools}` : `asks to ${tools}, and to ${check}`;
}

function routineOfEvent(
  type: RoutineEventType,
  payload: RoutineEvents[RoutineEventType],
): { creature: string; routineId: string } | undefined {
  if (type === "routine.needs" || type === "routine.checked" || "items" in payload) {
    return undefined;
  }
  if ("run" in payload) return { creature: payload.run.creature, routineId: payload.run.routineId };
  return { creature: payload.creature, routineId: payload.routineId };
}

function finishedRunOf(
  type: RoutineEventType,
  payload: RoutineEvents[RoutineEventType],
): RunRow | undefined {
  return type === "routine.finished" && "run" in payload ? payload.run : undefined;
}

const journalRuns = 12;

function retiresWhenSpent(routine: Routine): boolean {
  return routine.trigger.kind === "at" || wakeExpiryOf(routine) !== undefined;
}

function grantsViewOf(indexed: IndexedRoutine, routine: Routine): GrantsView {
  const digest = grantDigest(routine);
  const accepted = indexed.accepted?.digest === digest;
  return {
    posture: routine.tools,
    check: routine.check?.command ?? null,
    digest,
    needsAcceptance: needsAcceptance(routine),
    accepted,
    acceptedAt: accepted && indexed.accepted !== null ? isoOf(indexed.accepted.at) : null,
  };
}

function problemOf(indexed: IndexedRoutine): string {
  return "problem" in indexed.parse ? indexed.parse.problem : "unreadable";
}

function digestOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string | undefined, expected: string): boolean {
  if (token === undefined || token === "") return false;
  return timingSafeEqual(Buffer.from(digestOf(token)), Buffer.from(expected));
}

function hookPayloadOf(delivery: HookDelivery, now: number): TriggerPayload {
  return {
    kind: "webhook",
    receivedAt: isoOf(now),
    data: {
      contentType: delivery.contentType,
      bytes: Buffer.byteLength(delivery.body),
      body: delivery.body,
    },
  };
}

function withId(body: unknown, id: string): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  return "id" in body ? body : { ...body, id };
}
