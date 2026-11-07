import { minuteMs } from "./clock.ts";
import {
  addDays,
  type CalendarDate,
  instantOf,
  type WallClock,
  wallClockAt,
  weekdayOf,
} from "./zone.ts";

export interface CronSchedule {
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  dayRule: "both" | "either";
}

export class CronSyntaxError extends Error {
  constructor(
    readonly expr: string,
    detail: string,
  ) {
    super(`cron "${expr}": ${detail}`);
    this.name = "CronSyntaxError";
  }
}

export function parseCron(expr: string): CronSchedule {
  const fields = (macros[expr.trim()] ?? expr).trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronSyntaxError(expr, "needs five fields: minute hour day-of-month month weekday");
  }
  const [minute, hour, dayOfMonth, month, weekday] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const restricted = (field: string) => !field.startsWith("*");
  return {
    minutes: [...parseField(expr, minute, minuteField)],
    hours: [...parseField(expr, hour, hourField)],
    daysOfMonth: new Set(parseField(expr, dayOfMonth, dayOfMonthField)),
    months: new Set(parseField(expr, month, monthField)),
    weekdays: new Set(parseField(expr, weekday, weekdayField).map((day) => day % 7)),
    dayRule: restricted(dayOfMonth) && restricted(weekday) ? "either" : "both",
  };
}

export function isCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

export function nextCronSlot(
  schedule: CronSchedule,
  zone: string,
  after: number,
): number | undefined {
  for (const wall of candidateWallClocks(schedule, wallClockAt(nextWholeMinute(after), zone))) {
    const instant = instantOf(wall, zone);
    if (instant > after) return instant;
  }
  return undefined;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
}

const minuteField: FieldSpec = { name: "minute", min: 0, max: 59 };
const hourField: FieldSpec = { name: "hour", min: 0, max: 23 };
const dayOfMonthField: FieldSpec = { name: "day of month", min: 1, max: 31 };
const monthField: FieldSpec = {
  name: "month",
  min: 1,
  max: 12,
  names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
};
const weekdayField: FieldSpec = {
  name: "weekday",
  min: 0,
  max: 7,
  names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
};

const macros: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const searchHorizonDays = 366 * 9;

function parseField(expr: string, text: string, spec: FieldSpec): number[] {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    for (const value of parseItem(expr, item, spec)) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

function parseItem(expr: string, item: string, spec: FieldSpec): number[] {
  const [range = "", stepText, extra] = item.split("/");
  if (extra !== undefined) throw new CronSyntaxError(expr, `"${item}" has more than one step`);
  const step = stepText === undefined ? 1 : parseStep(expr, stepText, spec);
  const [start, end] = parseRange(expr, range, spec, stepText !== undefined);
  const values: number[] = [];
  for (let value = start; value <= end; value += step) values.push(value);
  return values;
}

function parseStep(expr: string, text: string, spec: FieldSpec): number {
  const step = Number(text);
  if (!/^\d+$/.test(text) || step < 1) {
    throw new CronSyntaxError(expr, `the ${spec.name} step "${text}" is not a positive integer`);
  }
  return step;
}

function parseRange(
  expr: string,
  range: string,
  spec: FieldSpec,
  stepped: boolean,
): [number, number] {
  if (range === "*") return [spec.min, spec.max];
  const [startText = "", endText, extra] = range.split("-");
  if (extra !== undefined) throw new CronSyntaxError(expr, `"${range}" is not a range`);
  const start = parseValue(expr, startText, spec);
  if (endText === undefined) return [start, stepped ? spec.max : start];
  const end = parseValue(expr, endText, spec);
  if (end < start)
    throw new CronSyntaxError(expr, `the ${spec.name} range "${range}" runs backward`);
  return [start, end];
}

function parseValue(expr: string, text: string, spec: FieldSpec): number {
  const named = spec.names?.indexOf(text.toLowerCase()) ?? -1;
  const value = named >= 0 ? named + spec.min : /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw new CronSyntaxError(
      expr,
      `the ${spec.name} "${text}" is outside ${spec.min} to ${spec.max}`,
    );
  }
  return value;
}

function nextWholeMinute(instant: number): number {
  return Math.floor(instant / minuteMs) * minuteMs + minuteMs;
}

function* candidateWallClocks(schedule: CronSchedule, from: WallClock): Generator<WallClock> {
  for (let offset = 0; offset <= searchHorizonDays; offset++) {
    const date = addDays(from, offset);
    if (!matchesDay(schedule, date)) continue;
    yield* slotsOfDay(schedule, date, offset === 0 ? from : undefined);
  }
}

function* slotsOfDay(
  schedule: CronSchedule,
  date: CalendarDate,
  notBefore: WallClock | undefined,
): Generator<WallClock> {
  for (const hour of schedule.hours) {
    if (notBefore !== undefined && hour < notBefore.hour) continue;
    for (const minute of schedule.minutes) {
      if (notBefore !== undefined && hour === notBefore.hour && minute < notBefore.minute) continue;
      yield { ...date, hour, minute };
    }
  }
}

function matchesDay(schedule: CronSchedule, date: CalendarDate): boolean {
  if (!schedule.months.has(date.month)) return false;
  const byDate = schedule.daysOfMonth.has(date.day);
  const byWeekday = schedule.weekdays.has(weekdayOf(date));
  return schedule.dayRule === "either" ? byDate || byWeekday : byDate && byWeekday;
}
