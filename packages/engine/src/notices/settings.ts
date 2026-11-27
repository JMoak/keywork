import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { type JsonFileStore, jsonFileStore } from "@keywork/shared";
import { z } from "zod";
import { isTimeZone } from "../routines/zone.ts";

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time of day as HH:MM, 24-hour")
  .describe("A time of day in the zone the settings are read in.");

const quietHoursSchema = z
  .object({
    on: z
      .boolean()
      .default(true)
      .describe("Whether quiet hours hold at all; off keeps their span."),
    start: timeOfDay.default("22:00").describe("When quiet begins each day."),
    end: timeOfDay
      .default("07:00")
      .describe("When quiet ends; before start, the span crosses midnight."),
  })
  .strict()
  .refine(({ start, end }) => start !== end, "quiet hours start and end at the same time");

export const notificationSettingsSchema = z
  .object({
    quietHours: quietHoursSchema
      .default({ on: false, start: "22:00", end: "07:00" })
      .describe(
        "A daily span in the keeper's zone when nothing interrupts: notifications wait for its end, work never does (REQ-065). Off until the keeper turns it on, with a night span ready, so nobody is silenced without choosing it.",
      ),
    doNotDisturb: z
      .boolean()
      .default(false)
      .describe(
        "A plain switch that silences every interruption until the keeper switches it off, for focus outside quiet hours.",
      ),
    tz: z
      .string()
      .refine(isTimeZone, "not an IANA time zone")
      .nullable()
      .default(null)
      .describe("The zone quiet hours are read in; null is this machine's own zone."),
  })
  .strict();

export type NotificationSettings = z.output<typeof notificationSettingsSchema>;

export const defaultNotificationSettings: NotificationSettings = notificationSettingsSchema.parse(
  {},
);

export interface KeeperSettings {
  settings: NotificationSettings;
  doNotDisturbSince: string | null;
}

export const settingsChangeSchema = z
  .object({
    quietHours: z
      .object({ on: z.boolean(), start: timeOfDay, end: timeOfDay })
      .partial()
      .strict()
      .optional(),
    doNotDisturb: z.boolean().optional(),
    tz: z.string().nullable().optional(),
  })
  .strict();

export type SettingsChange = z.input<typeof settingsChangeSchema>;

export function changedSettings(
  kept: KeeperSettings,
  change: unknown,
  at: string,
): KeeperSettings | { error: string } {
  const asked = settingsChangeSchema.safeParse(change);
  if (!asked.success) return { error: problemOf(asked.error) };
  const { quietHours, ...rest } = asked.data;
  const merged = notificationSettingsSchema.safeParse({
    ...kept.settings,
    ...rest,
    quietHours: { ...kept.settings.quietHours, ...quietHours },
  });
  if (!merged.success) return { error: problemOf(merged.error) };
  const settings = merged.data;
  const switchedOn = settings.doNotDisturb && !kept.settings.doNotDisturb;
  return {
    settings,
    doNotDisturbSince: settings.doNotDisturb
      ? switchedOn
        ? at
        : (kept.doNotDisturbSince ?? at)
      : null,
  };
}

export interface SettingsSource {
  read(): KeeperSettings;
  write(kept: KeeperSettings): void;
  watch(changed: () => void): () => void;
}

export function keeperSettingsDir(nodeState: string): string {
  return join(nodeState, "notifications");
}

export function fileSettingsSource(
  nodeState: string,
  notice: (line: string) => void,
): SettingsSource {
  const dir = keeperSettingsDir(nodeState);
  const store: JsonFileStore<KeeperSettings> = jsonFileStore<KeeperSettings>({
    file: join(dir, "settings.json"),
    mode: "lenient",
    validate: keptOf,
  });
  let told: string | undefined;
  return {
    read: () => {
      try {
        return store.read() ?? defaultKept;
      } catch (cause) {
        const problem = messageOf(cause);
        if (problem !== told)
          notice(`the notification settings are unreadable, so the defaults hold: ${problem}`);
        told = problem;
        return defaultKept;
      }
    },
    write: (kept) => store.write(kept),
    watch: (changed) => watchedDir(dir, changed),
  };
}

export function memorySettingsSource(kept: KeeperSettings = defaultKept): SettingsSource {
  let held = kept;
  const watchers = new Set<() => void>();
  return {
    read: () => held,
    write: (next) => {
      held = next;
      for (const changed of [...watchers]) changed();
    },
    watch: (changed) => {
      watchers.add(changed);
      return () => watchers.delete(changed);
    },
  };
}

const defaultKept: KeeperSettings = {
  settings: defaultNotificationSettings,
  doNotDisturbSince: null,
};

function keptOf(data: unknown): KeeperSettings {
  const fields = recordOf(data) ?? {};
  const settings = notificationSettingsSchema.parse(withoutRetired(fields.settings ?? {}));
  const since = fields.doNotDisturbSince;
  return {
    settings,
    doNotDisturbSince: settings.doNotDisturb && typeof since === "string" ? since : null,
  };
}

const retiredSettings: ReadonlySet<string> = new Set(["digest"]);

function withoutRetired(settings: unknown): unknown {
  const fields = recordOf(settings);
  if (fields === undefined) return settings;
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !retiredSettings.has(key)));
}

function recordOf(data: unknown): Record<string, unknown> | undefined {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

function watchedDir(dir: string, changed: () => void): () => void {
  let watcher: FSWatcher | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    watcher = watch(dir, () => changed());
    watcher.on("error", () => watcher?.close());
  } catch {
    return () => undefined;
  }
  return () => watcher?.close();
}

function problemOf(error: z.ZodError): string {
  const [first] = error.issues;
  if (first === undefined) return "the settings are not valid";
  const where = first.path.join(".");
  if (first.code === "unrecognized_keys") return `unknown setting ${first.keys.join(", ")}`;
  return where === "" ? first.message : `${where}: ${first.message}`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
