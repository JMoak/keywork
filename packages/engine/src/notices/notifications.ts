import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { jsonFileStore } from "@keywork/shared";
import type { PromiseKind } from "../promises/types.ts";
import { type Cancel, type Clock, isoOf, systemClock } from "../routines/clock.ts";
import type { NotificationTier } from "../routines/run.ts";
import type { NeedsYouKind } from "../routines/service.ts";
import {
  awayOf,
  type KeeperAway,
  nextQuietBoundary,
  type Quiet,
  quietAt,
  sameQuiet,
} from "./quiet.ts";
import {
  changedSettings,
  type KeeperSettings,
  type NotificationSettings,
  type SettingsSource,
} from "./settings.ts";
import { heldBy, type NoticeSubject, noticeTierOf } from "./tier.ts";

export type NoticeAbout =
  | { kind: "ask"; callId: string; tool: string }
  | { kind: "chore"; routineId: string; need: NeedsYouKind; runId: string | null }
  | { kind: "run"; routineId: string; runId: string }
  | { kind: "inbox"; pending: number }
  | { kind: "question"; questionId: string; promise: PromiseKind };

export interface Notice {
  id: string;
  tier: NotificationTier;
  held: boolean;
  creature: string | null;
  session: string | null;
  title: string;
  at: string;
  about: NoticeAbout;
}

export interface NoticeInput {
  id: string;
  subject: NoticeSubject;
  creature: string | null;
  session: string | null;
  title: string;
  at: string;
  about: NoticeAbout;
}

export type DigestReason = "quiet-ended" | "arrived";

export interface Digest {
  id: string;
  at: string;
  reason: DigestReason;
  notices: Notice[];
  folded: number;
  seenAt: string | null;
}

export interface NotificationState {
  settings: NotificationSettings;
  quiet: Quiet | null;
  held: Notice[];
  digest: Digest | null;
}

export type QuietChange = "began" | "changed" | "ended";

export interface NotificationEvents {
  "notifications.notice": { notice: Notice };
  "notifications.quiet": { change: QuietChange; quiet: Quiet | null };
  "notifications.digest": { change: "ready" | "seen"; digest: Digest };
  "notifications.settings": { settings: NotificationSettings };
}

export type NotificationEvent = {
  [Type in keyof NotificationEvents]: { type: Type; payload: NotificationEvents[Type] };
}[keyof NotificationEvents];

export interface HeldNotices {
  held: Notice[];
  told: string[];
  digest: Digest | null;
  quiet: Quiet | null;
}

export interface HeldSource {
  read(): HeldNotices | undefined;
  write(kept: HeldNotices): void;
}

export interface KeeperNotificationsOptions {
  settings: SettingsSource;
  held: HeldSource;
  clock?: Clock | undefined;
  newId?: (() => string) | undefined;
}

export interface KeeperNotifications {
  state(): NotificationState;
  change(change: unknown): NotificationState | { error: string };
  seen(digestId: string): Digest | undefined;
  notice(input: NoticeInput): Notice | undefined;
  resolved(id: string): void;
  asksStillOpen(ids: ReadonlySet<string>): void;
  away(): KeeperAway | undefined;
  subscribe(listener: (event: NotificationEvent) => void): () => void;
  close(): void;
}

export const digestListsAtMost = 50;

export const askNoticePrefix = "ask:";

export function heldNoticesFileIn(workspaceState: string): string {
  return join(workspaceState, "notifications.json");
}

export function fileHeldSource(file: string): HeldSource {
  const store = jsonFileStore<HeldNotices | undefined>({ file, mode: "lenient", validate: heldOf });
  return { read: () => store.read(), write: (kept) => store.write(kept) };
}

export function memoryHeldSource(): HeldSource {
  let kept: HeldNotices | undefined;
  return {
    read: () => (kept === undefined ? undefined : structuredClone(kept)),
    write: (next) => {
      kept = structuredClone(next);
    },
  };
}

export function keeperNotifications(options: KeeperNotificationsOptions): KeeperNotifications {
  const clock = options.clock ?? systemClock;
  const newId = options.newId ?? (() => randomBytes(8).toString("hex"));
  const listeners = new Set<(event: NotificationEvent) => void>();
  const emit = (event: NotificationEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const saved = options.held.read();
  let kept = options.settings.read();
  let held: Notice[] = saved?.held ?? [];
  let told = new Set(saved?.told ?? []);
  let digest: Digest | null = saved?.digest ?? null;
  let quiet: Quiet | null = saved?.quiet ?? null;
  let disarm: Cancel = () => undefined;

  const persist = (): void => options.held.write({ held, told: [...told], digest, quiet });

  const reached = (notice: Notice): void => {
    if (notice.about.kind === "ask" && notice.tier === "interrupt") told.add(notice.id);
  };

  const compose = (reason: DigestReason, taken: readonly Notice[], now: number): void => {
    if (taken.length === 0) return;
    const ids = new Set(taken.map(({ id }) => id));
    held = held.filter(({ id }) => !ids.has(id));
    for (const notice of taken) reached(notice);
    const earlier = (digest?.notices ?? []).filter(({ id }) => !ids.has(id));
    const listed = byWeight([...earlier, ...taken.map(released)]);
    digest = {
      id: newId(),
      at: isoOf(now),
      reason,
      notices: listed.slice(0, digestListsAtMost),
      folded: (digest?.folded ?? 0) + Math.max(0, listed.length - digestListsAtMost),
      seenAt: null,
    };
    emit({ type: "notifications.digest", payload: { change: "ready", digest } });
  };

  const step = (now: number): void => {
    const was = quiet;
    quiet = quietAt(now, kept);
    if (!sameQuiet(was, quiet)) {
      emit({ type: "notifications.quiet", payload: { change: changeOf(was, quiet), quiet } });
    }
    if (was !== null && quiet === null) compose("quiet-ended", held, now);
    persist();
    arm(now);
  };

  const arm = (now: number): void => {
    disarm();
    const boundary = nextQuietBoundary(now, kept.settings);
    disarm = boundary === undefined ? () => undefined : clock.at(boundary, () => step(clock.now()));
  };

  const settled = (): number => {
    const now = clock.now();
    const fresh = options.settings.read();
    if (!sameKept(fresh, kept)) {
      kept = fresh;
      emit({ type: "notifications.settings", payload: { settings: kept.settings } });
      step(now);
    } else if (!sameQuiet(quietAt(now, kept), quiet)) {
      step(now);
    }
    return now;
  };

  const state = (): NotificationState => {
    settled();
    return { settings: kept.settings, quiet, held: [...held], digest };
  };

  const unwatch = options.settings.watch(() => void settled());
  step(clock.now());

  return {
    state,
    change: (asked) => {
      const next = changedSettings(options.settings.read(), asked, isoOf(clock.now()));
      if ("error" in next) return next;
      options.settings.write(next);
      return state();
    },
    seen: (digestId) => {
      if (digest === null || digest.id !== digestId) return undefined;
      const seen = { ...digest, seenAt: isoOf(clock.now()) };
      digest = null;
      persist();
      emit({ type: "notifications.digest", payload: { change: "seen", digest: seen } });
      return seen;
    },
    notice: (input) => {
      if (told.has(input.id) || held.some(({ id }) => id === input.id)) return undefined;
      const now = settled();
      const tier = noticeTierOf(input.subject);
      const notice: Notice = {
        id: input.id,
        tier,
        held: heldBy(tier, quiet),
        creature: input.creature,
        session: input.session,
        title: input.title,
        at: input.at,
        about: input.about,
      };
      if (notice.held) held = [...held, notice];
      else reached(notice);
      emit({ type: "notifications.notice", payload: { notice } });
      if (arrivesAtOnceAsANote(notice)) compose("arrived", [notice], now);
      persist();
      return notice;
    },
    resolved: (id) => {
      if (!told.has(id) && !held.some((notice) => notice.id === id)) return;
      told.delete(id);
      held = held.filter((notice) => notice.id !== id);
      persist();
    },
    asksStillOpen: (open) => {
      const stale = (id: string) => id.startsWith(askNoticePrefix) && !open.has(id);
      told = new Set([...told].filter((id) => !stale(id)));
      held = held.filter(({ id }) => !stale(id));
      persist();
    },
    away: () => {
      settled();
      return quiet === null ? undefined : awayOf(quiet, kept.settings);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      unwatch();
      disarm();
      listeners.clear();
    },
  };
}

function changeOf(was: Quiet | null, now: Quiet | null): QuietChange {
  if (was === null) return "began";
  return now === null ? "ended" : "changed";
}

function arrivesAtOnceAsANote(notice: Notice): boolean {
  return notice.tier === "digest" && !notice.held;
}

function released(notice: Notice): Notice {
  return { ...notice, held: false };
}

function byWeight(notices: readonly Notice[]): Notice[] {
  const weight = (notice: Notice) => (notice.tier === "interrupt" ? 0 : 1);
  return [...notices].sort(
    (left, right) => weight(left) - weight(right) || left.at.localeCompare(right.at),
  );
}

function sameKept(left: KeeperSettings, right: KeeperSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function heldOf(data: unknown): HeldNotices | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const fields = data as Partial<HeldNotices>;
  if (!Array.isArray(fields.held)) return undefined;
  return {
    held: fields.held,
    told: Array.isArray(fields.told) ? fields.told.filter((id) => typeof id === "string") : [],
    digest: fields.digest ?? null,
    quiet: fields.quiet ?? null,
  };
}
