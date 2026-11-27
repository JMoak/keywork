import { isoOf } from "../routines/clock.ts";
import {
  addDays,
  type CalendarDate,
  instantOf,
  localTimeZone,
  wallClockAt,
} from "../routines/zone.ts";
import type { KeeperSettings, NotificationSettings } from "./settings.ts";

export const quietReasons = ["quiet-hours", "do-not-disturb"] as const;

export type QuietReason = (typeof quietReasons)[number];

export interface Quiet {
  reason: QuietReason;
  since: string;
  until: string | null;
}

export interface Span {
  start: number;
  end: number;
}

export function quietAt(at: number, { settings, doNotDisturbSince }: KeeperSettings): Quiet | null {
  if (settings.doNotDisturb) {
    return { reason: "do-not-disturb", since: doNotDisturbSince ?? isoOf(at), until: null };
  }
  const span = quietSpanAt(at, settings);
  if (span === undefined) return null;
  return { reason: "quiet-hours", since: isoOf(span.start), until: isoOf(span.end) };
}

export function sameQuiet(left: Quiet | null, right: Quiet | null): boolean {
  if (left === null || right === null) return left === right;
  return left.reason === right.reason && left.since === right.since && left.until === right.until;
}

export function quietSpanAt(at: number, settings: NotificationSettings): Span | undefined {
  const { on, start, end } = settings.quietHours;
  if (!on) return undefined;
  const zone = zoneOf(settings);
  const today = wallClockAt(at, zone);
  for (const offset of [-1, 0]) {
    const span = spanBeginning(addDays(today, offset), minutesOf(start), minutesOf(end), zone);
    if (at >= span.start && at < span.end) return span;
  }
  return undefined;
}

export function nextQuietBoundary(
  after: number,
  settings: NotificationSettings,
): number | undefined {
  if (!settings.quietHours.on) return undefined;
  const { start, end } = settings.quietHours;
  return nextOf(after, [minutesOf(start), minutesOf(end)], zoneOf(settings));
}

export function zoneOf(settings: NotificationSettings): string {
  return settings.tz ?? localTimeZone();
}

export interface KeeperAway {
  reason: QuietReason;
  until: string | null;
}

export function awayOf(quiet: Quiet, settings: NotificationSettings): KeeperAway {
  if (quiet.until === null) return { reason: quiet.reason, until: null };
  const { hour, minute } = wallClockAt(Date.parse(quiet.until), zoneOf(settings));
  return { reason: quiet.reason, until: `${twoDigits(hour)}:${twoDigits(minute)}` };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function spanBeginning(date: CalendarDate, start: number, end: number, zone: string): Span {
  const endDate = end > start ? date : addDays(date, 1);
  return { start: instantAt(date, start, zone), end: instantAt(endDate, end, zone) };
}

function nextOf(after: number, minutes: readonly number[], zone: string): number | undefined {
  const today = wallClockAt(after, zone);
  const coming = [0, 1, 2].flatMap((offset) => {
    const date = addDays(today, offset);
    return minutes.map((minute) => instantAt(date, minute, zone));
  });
  const later = coming.filter((instant) => instant > after);
  return later.length === 0 ? undefined : Math.min(...later);
}

function instantAt(date: CalendarDate, minuteOfDay: number, zone: string): number {
  return instantOf({ ...date, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 }, zone);
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
}
