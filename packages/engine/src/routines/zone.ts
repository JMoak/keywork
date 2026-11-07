import { dayMs } from "./clock.ts";

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface WallClock extends CalendarDate {
  hour: number;
  minute: number;
}

export class InvalidTimeZoneError extends Error {
  constructor(readonly zone: string) {
    super(`"${zone}" is not an IANA time zone this runtime knows`);
    this.name = "InvalidTimeZoneError";
  }
}

export function isTimeZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function wallClockAt(instant: number, zone: string): WallClock {
  const { year, month, day, hour, minute } = partsAt(instant, zone);
  return { year, month, day, hour, minute };
}

export function instantOf(wall: WallClock, zone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const before = asUtc - offsetAt(asUtc - dayMs, zone);
  const after = asUtc - offsetAt(asUtc + dayMs, zone);
  const exact = [before, after].filter((instant) =>
    sameWallClock(wallClockAt(instant, zone), wall),
  );
  return exact.length === 0 ? before : Math.min(...exact);
}

export function weekdayOf(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function formatWallClock(instant: number, zone: string): string {
  const { year, month, day, hour, minute } = wallClockAt(instant, zone);
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)} ${zone}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    throw new InvalidTimeZoneError(zone);
  }
  formatters.set(zone, made);
  return made;
}

function partsAt(instant: number, zone: string): WallClock & { second: number } {
  const parts = formatterFor(zone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour") % 24,
    minute: field("minute"),
    second: field("second"),
  };
}

function offsetAt(instant: number, zone: string): number {
  const wall = partsAt(instant, zone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - (instant - mod(instant, 1000));
}

function sameWallClock(left: WallClock, right: WallClock): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
