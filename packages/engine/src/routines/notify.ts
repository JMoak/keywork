import { z } from "zod";
import { dayMs } from "./clock.ts";
import type { NotifyChoice } from "./routine.ts";
import type { NotificationTier } from "./run.ts";
import { addDays, instantOf, isTimeZone, localTimeZone, wallClockAt } from "./zone.ts";

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time of day as HH:MM, 24-hour")
  .describe("A time of day in the node's notification zone.");

export const notificationSettingsSchema = z
  .object({
    tz: z
      .string()
      .refine(isTimeZone, "not an IANA time zone")
      .optional()
      .describe("The zone digests and quiet hours are read in; absent means the node's own zone."),
    digest: z
      .array(timeOfDay)
      .min(1)
      .max(3)
      .default(["08:30", "12:30", "17:30"])
      .describe(
        "When finished chores that do not need the keeper are surfaced together; one to three times a day, never zero, because batching at breakpoints costs the keeper least (RUN-044, RUN-045).",
      ),
    quietHours: z
      .object({ start: timeOfDay, end: timeOfDay })
      .strict()
      .nullable()
      .default({ start: "22:00", end: "07:00" })
      .describe(
        "When nothing interrupts; notifications wait for the end, work never does (REQ-065). null turns quiet hours off.",
      ),
  })
  .strict();

export type NotificationSettings = z.output<typeof notificationSettingsSchema>;

export const defaultNotificationSettings: NotificationSettings = notificationSettingsSchema.parse(
  {},
);

export function tierOf(notify: NotifyChoice, needsKeeper: boolean): NotificationTier {
  if (needsKeeper) return "interrupt";
  return notify === "always" ? "digest" : "log";
}

export function surfaceAt(
  tier: NotificationTier,
  now: number,
  settings: NotificationSettings,
): number | null {
  const zone = settings.tz ?? localTimeZone();
  switch (tier) {
    case "interrupt":
      return quietEnd(now, settings, zone) ?? now;
    case "digest":
      return nextDigest(now, settings, zone);
    case "log":
      return null;
  }
}

function quietEnd(at: number, settings: NotificationSettings, zone: string): number | undefined {
  const quiet = settings.quietHours;
  if (quiet === null) return undefined;
  const minute = minuteOfDay(at, zone);
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  const inside = start <= end ? minute >= start && minute < end : minute >= start || minute < end;
  return inside ? nextOccurrence(at, end, zone) : undefined;
}

function nextDigest(now: number, settings: NotificationSettings, zone: string): number {
  const next = Math.min(
    ...settings.digest.map((time) => nextOccurrence(now, minutesOf(time), zone)),
  );
  return quietEnd(next, settings, zone) ?? next;
}

function nextOccurrence(after: number, minuteOfDayTarget: number, zone: string): number {
  const today = wallClockAt(after, zone);
  for (let offset = 0; offset <= 2; offset++) {
    const date = addDays(today, offset);
    const instant = instantOf(
      { ...date, hour: Math.floor(minuteOfDayTarget / 60), minute: minuteOfDayTarget % 60 },
      zone,
    );
    if (instant >= after) return instant;
  }
  return after + dayMs;
}

function minuteOfDay(instant: number, zone: string): number {
  const wall = wallClockAt(instant, zone);
  return wall.hour * 60 + wall.minute;
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
}
