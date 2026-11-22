import { z } from "zod";
import { seatAsWritten } from "../show/seat.ts";
import type { Setting } from "../show/setting.ts";
import { overlapWords, type StandingPicture, type Stood, stageWords } from "../show/standing.ts";
import type { Tool } from "../tools.ts";
import { defineTool } from "./define.ts";
import type { ShowTarget } from "./show.ts";

export const shownToolName = "shown";

export function shownTool(target: ShowTarget): Tool {
  return defineTool({
    name: shownToolName,
    description:
      "List what is out, beside this conversation and outside in windows of their own, whoever set it out: what you set out and what the keeper opened. This is IDE control over the console's own space, never the computer, and it changes nothing, so it asks for no permission. Each setting is one line of JSON with id, what, rung, size, weight, why, state, at, until, from, origin, where, seat, by and sometimes note, mark, signal, agent and square. rung, size and weight are what was proposed, state is live or pinned, and origin is creature for what you set out and keeper for what the keeper opened. where is where it stands now: beside the conversation, outside, or inside when the keeper brought it into the console. seat is its place outside, written as show takes it (\"left-half\", or \"columns 4 to 8, rows 0 to 6\"). by is who put it there last, creature, keeper or console, and is absent until the console has reported; what the keeper placed is the keeper's. note is the console's reason when it has one, such as no room outside. mark is the word or two the keeper reads on it, set with show or arrange. signal is needs-you or critical while one outlines it, and is gone once the keeper or you have cleared it. agent is there when an agent outside this conversation set the thing out through you, and names it, with square the colour of the square the keeper sees on it, one colour to each agent; it counts against your limits, and it is yours to withdraw. When windows outside overlap, a line names the pairs. A last line tells the stage once the console has reported it: which room it is (beside the console, over its far side, or the whole display) and how many of the smallest seats fit across and down, so you can judge the room before you compose; whatever fits, at most twelve of yours stand outside at once. Use the ids with show's from, with arrange, or with withdraw for what is still yours to take back.",
    schema: z.object({}).strict(),
    run: async () => {
      const settings = target.settings();
      if (settings === undefined) return nothingListedHere;
      return listed(settings.standingFor(target));
    },
  });
}

const nothingListedHere =
  "Nothing to list: no keeper surface takes settings here, so nothing can be set out.";

const nothingOut = "Nothing is out beside this conversation.";

function listed({ out, stage }: StandingPicture): string {
  const overlap = overlapWords(out);
  return [
    ...(out.length === 0 ? [nothingOut] : [headingOf(out), ...out.map(rowOf)]),
    ...(overlap === undefined ? [] : [overlap]),
    ...(stage === undefined ? [] : [stageWords(stage)]),
  ].join("\n");
}

function headingOf(out: readonly Stood[]): string {
  const outside = out.filter(({ where }) => where === "outside").length;
  const lines = out.length === 1 ? "1 setting is out" : `${out.length} settings are out`;
  const places =
    outside === 0 ? " beside this conversation" : `, ${outside} outside in windows of their own`;
  return `${lines}${places}, oldest first, one JSON object to a line:`;
}

const noteWordsShown = 120;

function brieflyOf(what: Setting["what"]): Setting["what"] {
  if (what.kind !== "note" || what.ref.length <= noteWordsShown) return what;
  return { ...what, ref: `${what.ref.slice(0, noteWordsShown).trimEnd()}…` };
}

function rowOf({ setting, where, seat, by, note }: Stood): string {
  const { id, what, rung, size, weight, why, state, at, until, from, origin, agent, mark, signal } =
    setting;
  return JSON.stringify({
    id,
    what: brieflyOf(what),
    rung,
    ...(size !== undefined && { size }),
    ...(weight !== undefined && { weight }),
    why,
    state,
    at,
    until,
    from,
    origin,
    where,
    ...(seat !== undefined && { seat: seatAsWritten(seat) }),
    ...(by !== undefined && { by }),
    ...(note !== undefined && { note }),
    ...(mark !== undefined && { mark }),
    ...(signal !== undefined && { signal }),
    ...(agent !== undefined && { agent: agent.name ?? "an agent" }),
    ...(agent?.color !== undefined && { square: agent.color }),
  });
}
