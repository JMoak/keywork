import { z } from "zod";
import { type SettingWhat, settingKinds } from "./setting.ts";

export const settingWhatInput = z
  .object({
    kind: z
      .enum(settingKinds)
      .describe("file, diff, report, thread, chore, url or note: what you set out."),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe(
        "Which one: a workspace path for a file, a change-set id for a diff, a report id, a session id for a thread, a chore id, a url, or the note's own words (at most 2000 characters).",
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
