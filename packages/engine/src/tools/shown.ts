import { z } from "zod";
import { placeSaid } from "../show/places.ts";
import { seatAsWritten } from "../show/seat.ts";
import type { Setting } from "../show/setting.ts";
import { overlapWords, type StandingPicture, type Stood, stageWords } from "../show/standing.ts";
import type { Tool } from "../tools.ts";
import { awayShownWords } from "./away.ts";
import { defineTool } from "./define.ts";
import { scenesListedWords } from "./scenes.ts";
import type { ShowTarget } from "./show.ts";

export const shownToolName = "shown";

export function shownTool(target: ShowTarget): Tool {
  return defineTool({
    name: shownToolName,
    description:
      'List what is open for the keeper, whoever opened it, one JSON line each: id, what, place (where in the stead it rose from), from (the id of what it grew from, or null), where it stands now (beside your conversation, outside in its own window with its seat such as "left-half", or inside the app), by (who put it there last: you, the keeper or the app), mark, tone, signal, state and when it goes. origin keeper means the keeper opened it; agent names an agent that set it out through you. A line says how much room your windows have outside, and a last line names the scenes you keep. It changes nothing. Use the ids with from, arrange and withdraw, and the scene names with arrange.',
    schema: z.object({}).strict(),
    run: async () => {
      const settings = target.settings();
      if (settings === undefined) return nothingListedHere;
      const away = target.away?.();
      return [
        listed(settings.standingFor(target), target.creature),
        ...scenesListedWords(target),
        ...(away === undefined ? [] : [awayShownWords(away)]),
      ].join("\n");
    },
  });
}

const nothingListedHere =
  "Nothing to list: no keeper surface takes settings here, so nothing can be set out.";

const nothingOut = "Nothing is out beside this conversation.";

function listed({ out, stage }: StandingPicture, caller: string | null): string {
  const overlap = overlapWords(out);
  return [
    ...(out.length === 0
      ? [nothingOut]
      : [headingOf(out), ...out.map((stood) => rowOf(stood, caller))]),
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

function rowOf({ setting, where, seat, by, note }: Stood, caller: string | null): string {
  const { id, what, rung, size, weight, why, state, at, until, from, origin, agent, mark } =
    setting;
  const { markTone, signal, place } = setting;
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
    place: placeSaid(place, caller),
    origin,
    where,
    ...(seat !== undefined && { seat: seatAsWritten(seat) }),
    ...(by !== undefined && { by }),
    ...(note !== undefined && { note }),
    ...(mark !== undefined && { mark }),
    ...(markTone !== undefined && { tone: markTone }),
    ...(signal !== undefined && { signal }),
    ...(agent !== undefined && { agent: agent.name ?? "an agent" }),
    ...(agent?.color !== undefined && { square: agent.color }),
  });
}
