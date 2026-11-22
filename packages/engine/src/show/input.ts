import { z } from "zod";
import { markLength, type SettingWhat, settingKinds } from "./setting.ts";

export const settingWhatInput = z
  .object({
    kind: z
      .enum(settingKinds)
      .describe("file, diff, report, thread, chore, url, note or pane: what you set out."),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe(
        "Which one: a workspace path for a file, a change-set id for a diff, a report id, a session id for a thread, a chore id, a url, the note's own words (at most 2000 characters, read as markdown), or for a pane the name of one of the console's own: sessions, arcs, files, context, memory, needs-you, permissions, mcp or workspaces.",
      ),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("A short title for the card; the yard names it from ref when left out."),
  })
  .strict();

export const settingIdInput = z.string().trim().min(1).max(128);

export const markInput = z.string().trim().max(markLength);

export function markOf(said: string | null | undefined): string | undefined {
  const mark = (said ?? "").replace(/\s+/g, " ").trim().slice(0, markLength);
  return mark === "" ? undefined : mark;
}

const secondMs = 1_000;

const unitMs: ReadonlyArray<[RegExp, number]> = [
  [/^(s|secs?|seconds?)$/, secondMs],
  [/^(m|mins?|minutes?)$/, 60 * secondMs],
  [/^(h|hrs?|hours?)$/, 3_600 * secondMs],
  [/^(d|days?)$/, 86_400 * secondMs],
];

export const longestLastingMs = 30 * 86_400 * secondMs;

export const lastingPattern =
  /^(?:(?:in|for|after)\s+)?(\d{1,4}(?:\.\d)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i;

export function lastingOf(said: string): number | undefined {
  const found = lastingPattern.exec(said.trim());
  if (found === null) return undefined;
  const unit = unitMs.find(([named]) => named.test((found[2] ?? "").toLowerCase()));
  if (unit === undefined) return undefined;
  const lasts = Math.round(Number(found[1]) * unit[1]);
  return Math.min(longestLastingMs, Math.max(secondMs, lasts));
}

export function lastingWords(lastsMs: number): string {
  const [size, unit] =
    lastsMs % (86_400 * secondMs) === 0
      ? [lastsMs / (86_400 * secondMs), "day"]
      : lastsMs % (3_600 * secondMs) === 0
        ? [lastsMs / (3_600 * secondMs), "hour"]
        : lastsMs % (60 * secondMs) === 0
          ? [lastsMs / (60 * secondMs), "minute"]
          : [Math.round(lastsMs / secondMs), "second"];
  return `${size} ${unit}${size === 1 ? "" : "s"}`;
}

export const settingFromInput = settingIdInput;

export const keeperRung = "unfold";

export interface KeeperOpening {
  what: SettingWhat;
  from: string;
  rung: typeof keeperRung;
}

export const keeperOpeningInput = z
  .object({
    what: settingWhatInput,
    from: settingFromInput.describe(
      "What the keeper opened it from: the id of a setting still out, or a session id.",
    ),
    rung: z.literal(keeperRung).default(keeperRung),
  })
  .strict();

export const keeperOpeningJsonSchema = z.toJSONSchema(keeperOpeningInput, { io: "input" });

export function keeperOpeningOf(body: unknown): KeeperOpening | undefined {
  const parsed = keeperOpeningInput.safeParse(body);
  if (!parsed.success) return undefined;
  const { what, from, rung } = parsed.data;
  return { what: settingWhatOf(what), from, rung };
}

export function settingWhatOf({ kind, ref, title }: z.infer<typeof settingWhatInput>): SettingWhat {
  return title === undefined ? { kind, ref } : { kind, ref, title };
}
