import { z } from "zod";
import { settingFromInput, settingWhatInput, settingWhatOf } from "../show/input.ts";
import { type Rung, rungs } from "../show/setting.ts";
import type { SetOut, SettingStore, ShowProposal, ShowRefusal } from "../show/store.ts";
import type { Tool } from "../tools.ts";
import { defineTool } from "./define.ts";

export type ShowSettings = Pick<SettingStore, "propose" | "canGrowFrom">;

export interface ShowTarget {
  creature: string | null;
  sessionId: string;
  settings(): ShowSettings | undefined;
}

export const showToolName = "show";

export function showTool(target: ShowTarget): Tool {
  return defineTool({
    name: showToolName,
    description:
      "Set something out for the keeper to see beside this conversation: a file, a diff, a report, a thread, a chore, a link or a short note. This is IDE control: it arranges the console's own space around the conversation, never the computer, and it changes nothing in the world, so it asks for no permission. It lands as a card by default. Propose unfold only when the keeper should read it now, and stage only when it deserves the whole view; the console spends the keeper's attention and may show it lower than you ask. Showing the same thing again replaces what you set out before. It stays until the keeper has seen it, until this thread rests, or until a time you name. Name from when it grows out of something already in view: the id of a setting you set out (every answer names it), or a thread of yours such as one you delegated; the console sets it beside what it grew from, so the keeper can walk the trail. At most thirty settings an hour.",
    schema: showArgs,
    run: async (args) => {
      const settings = target.settings();
      if (settings === undefined) return noKeeperSurface;
      const from = args.from ?? null;
      if (from !== null && !(await settings.canGrowFrom(target, from))) return outOfSight(from);
      return sentenceOf(settings.propose(proposalOf(target, args)));
    },
  });
}

const showArgs = z
  .object({
    what: settingWhatInput,
    rung: z
      .enum(rungs)
      .optional()
      .describe(
        "How much of the keeper's attention you propose: lantern (a mark to look at when ready), card (the default), unfold (open beside the conversation) or stage (the whole view).",
      ),
    why: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("One sentence the keeper reads on the card: why this matters now."),
    until: z
      .union([z.enum(["seen", "rests"]), z.iso.datetime({ offset: true })])
      .optional()
      .describe(
        "When it goes: seen (the default, once the keeper has seen it), rests (when this thread rests), or an ISO 8601 date-time with its offset.",
      ),
    from: settingFromInput
      .nullable()
      .optional()
      .describe(
        "What it grows from: the id of a setting you set out that is still out, or a thread of yours such as one you delegated. Leave it out for something new.",
      ),
  })
  .strict();

type ShowArgs = z.infer<typeof showArgs>;

const noKeeperSurface =
  "Not set out: no keeper surface takes settings here; tell the keeper in words instead.";

function outOfSight(from: string): string {
  return `Not set out: nothing you may grow from has the id ${from}; name a setting you set out that is still out, or a thread of yours.`;
}

function proposalOf(target: ShowTarget, args: ShowArgs): ShowProposal {
  return {
    creature: target.creature,
    sessionId: target.sessionId,
    what: settingWhatOf(args.what),
    rung: args.rung ?? "card",
    why: args.why,
    until: args.until ?? "seen",
    from: args.from ?? null,
    origin: "creature",
  };
}

function sentenceOf(outcome: SetOut | ShowRefusal): string {
  if ("refused" in outcome) return `Not set out: ${outcome.error}.`;
  const { setting, replaced } = outcome;
  return [
    placedAs[setting.rung],
    goesWhen(setting.until),
    ...(replaced === undefined ? [] : ["It replaces what you set out for this before."]),
    `To set out what grows from it, name ${setting.id} as from.`,
  ].join(" ");
}

const placedAs: Readonly<Record<Rung, string>> = {
  lantern: "Set out as a lantern; the keeper looks when ready.",
  card: "Set out as a card; the yard decides whether it unfolds.",
  unfold: "Set out to unfold; the yard decides whether it unfolds or stays a card.",
  stage:
    "Set out for the stage; only the keeper or a yard rule stages it, so the yard decides how it shows.",
};

function goesWhen(until: string): string {
  if (until === "seen") return "It stays until the keeper has seen it.";
  if (until === "rests") return "It goes when this thread rests.";
  return `It goes at ${until}.`;
}
