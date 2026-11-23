import { z } from "zod";
import { markLength, type SettingWhat, settingKinds, settingPanes } from "./setting.ts";
import { toneWords } from "./vocabularies.ts";
import { wordInput } from "./words.ts";

export const settingWhatInput = z
  .object({
    kind: z.enum(settingKinds).describe("What it is."),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe(
        `Which one: a workspace path, a change-set id, a report id, a session id, a chore id, a url, the note's own markdown (at most 2000 characters), or a pane's name: ${settingPanes.join(", ")}.`,
      ),
    title: z.string().trim().min(1).max(200).optional().describe("A short title."),
  })
  .strict();

export const settingIdInput = z.string().trim().min(1).max(128);

export const markInput = z.string().trim().max(markLength);

export const toneInput = wordInput(toneWords);

export const markSaidInput = z.union([
  markInput,
  z.object({ text: markInput.optional(), tone: toneInput.optional() }).strict(),
]);

export type MarkSaid = z.infer<typeof markSaidInput>;

export function markOf(said: MarkSaid | null | undefined): string | undefined {
  const text = typeof said === "string" ? said : said?.text;
  const mark = (text ?? "").replace(/\s+/g, " ").trim().slice(0, markLength);
  return mark === "" ? undefined : mark;
}

export function toneSaidOf(said: MarkSaid | null | undefined): string | undefined {
  return typeof said === "object" && said !== null ? said.tone : undefined;
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
