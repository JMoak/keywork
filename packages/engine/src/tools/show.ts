import { z } from "zod";
import { type Rung, rungs, type SettingWhat, settingKinds } from "../show/setting.ts";
import type { SetOut, SettingStore, ShowProposal, ShowRefusal } from "../show/store.ts";
import type { Tool } from "../tools.ts";
import { defineTool } from "./define.ts";

export interface ShowTarget {
  creature: string | null;
  sessionId: string;
  settings(): Pick<SettingStore, "propose"> | undefined;
}

export const showToolName = "show";

export function showTool(target: ShowTarget): Tool {
  return defineTool({
    name: showToolName,
    description:
      "Set something out for the keeper to see beside this conversation: a file, a diff, a report, a thread, a chore, a link or a short note. This is IDE control: it arranges the console's own space around the conversation, never the computer, and it changes nothing in the world, so it asks for no permission. It lands as a card by default. Propose unfold only when the keeper should read it now, and stage only when it deserves the whole view; the console spends the keeper's attention and may show it lower than you ask. Showing the same thing again replaces what you set out before. It stays until the keeper has seen it, until this thread rests, or until a time you name. At most thirty settings an hour.",
    schema: showArgs,
    run: async (args) => {
      const settings = target.settings();
      if (settings === undefined) return noKeeperSurface;
      return sentenceOf(settings.propose(proposalOf(target, args)));
    },
  });
}

const showArgs = z
  .object({
    what: z
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
      .strict(),
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
  })
  .strict();

type ShowArgs = z.infer<typeof showArgs>;

const noKeeperSurface =
  "Not set out: no keeper surface takes settings here; tell the keeper in words instead.";

function proposalOf(target: ShowTarget, args: ShowArgs): ShowProposal {
  return {
    creature: target.creature,
    sessionId: target.sessionId,
    what: whatOf(args.what),
    rung: args.rung ?? "card",
    why: args.why,
    until: args.until ?? "seen",
  };
}

function whatOf({ kind, ref, title }: ShowArgs["what"]): SettingWhat {
  return title === undefined ? { kind, ref } : { kind, ref, title };
}

function sentenceOf(outcome: SetOut | ShowRefusal): string {
  if ("refused" in outcome) return `Not set out: ${outcome.error}.`;
  const { setting, replaced } = outcome;
  return [
    placedAs[setting.rung],
    goesWhen(setting.until),
    ...(replaced === undefined ? [] : ["It replaces what you set out for this before."]),
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
