import { z } from "zod";
import { sameOwner } from "../show/lineage.ts";
import type { Setting } from "../show/setting.ts";
import type { Tool } from "../tools.ts";
import { defineTool } from "./define.ts";
import type { ShowTarget } from "./show.ts";

export const shownToolName = "shown";

export function shownTool(target: ShowTarget): Tool {
  return defineTool({
    name: shownToolName,
    description:
      "List what is out beside this conversation, whoever set it out: what you set out and what the keeper opened. This is IDE control over the console's own space, never the computer, and it changes nothing, so it asks for no permission. Each setting comes back as one line of JSON with id, what, rung, size, why, state, at, until, from and origin. rung and size are what was proposed, and the console may be showing less. state is live or pinned. origin is creature for what this seat set out and keeper for what the keeper opened. Use the ids with show's from, or with withdraw for what is still yours to take back.",
    schema: z.object({}).strict(),
    run: async () => {
      const settings = target.settings();
      if (settings === undefined) return nothingListedHere;
      return listedRows(settings.open().filter((setting) => sameOwner(setting, target)));
    },
  });
}

const nothingListedHere =
  "Nothing to list: no keeper surface takes settings here, so nothing can be set out.";

const nothingOut = "Nothing is out beside this conversation.";

function listedRows(settings: readonly Setting[]): string {
  if (settings.length === 0) return nothingOut;
  return [headingOf(settings.length), ...settings.map(rowOf)].join("\n");
}

function headingOf(count: number): string {
  const lines = count === 1 ? "1 setting is out" : `${count} settings are out`;
  return `${lines} beside this conversation, oldest first, one JSON object to a line:`;
}

function rowOf(setting: Setting): string {
  const { id, what, rung, size, why, state, at, until, from, origin } = setting;
  return JSON.stringify({
    id,
    what,
    rung,
    ...(size !== undefined && { size }),
    why,
    state,
    at,
    until,
    from,
    origin,
  });
}
