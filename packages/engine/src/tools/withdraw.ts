import { z } from "zod";
import { meansEverything, type OwnPane, paneCalled, sharedNameWords } from "../show/arrangement.ts";
import { settingIdInput } from "../show/input.ts";
import { calledOf } from "../show/naming.ts";
import { placeSaid } from "../show/places.ts";
import { Reading } from "../show/reading.ts";
import type { Mood, Setting } from "../show/setting.ts";
import { standingWords } from "../show/standing.ts";
import { mannerOf, moodWords } from "../show/vocabularies.ts";
import { listed, quoted, wordInput } from "../show/words.ts";
import type { Tool } from "../tools.ts";
import { defineTool } from "./define.ts";
import type { ShowSettings, ShowTarget } from "./show.ts";

export const withdrawToolName = "withdraw";

export function withdrawTool(target: ShowTarget): Tool {
  return defineTool({
    name: withdrawToolName,
    description:
      'Close what you set out, beside your conversation or outside, and it goes back where it came from. Name it by the id show gave, or by its title or ref; a list closes several, and "all" with except closes everything but those. It will not close what the keeper pinned or opened, a critical someone else raised, or anything not yours. What grew from it stays out, and closing a window that drilled in steps back out to its parent. It moves only the app\'s own windows, never the computer. mood says how it leaves.',
    schema: z
      .object({
        id: z
          .union([nameInput, z.array(nameInput).min(1).max(mostNamed)])
          .describe(
            'What to take back: an id, or the ref or title you showed it with. A list takes back several, and "all" takes back everything of yours that is out.',
          ),
        except: z
          .union([nameInput, z.array(nameInput).min(1).max(mostNamed)])
          .optional()
          .describe('With id "all", what stays out: ids, refs or titles.'),
        mood: wordInput(moodWords)
          .optional()
          .describe(
            "How it leaves, as motion only: one of show's moods. Leave it out and it leaves with your temperament, if you have one, else in the mood it arrived with.",
          ),
      })
      .strict(),
    run: async ({ id, except, mood: moodSaid }) => {
      const settings = target.settings();
      if (settings === undefined) return noKeeperSurface;
      const reading = new Reading();
      const named = reading.word("mood", moodWords, moodSaid);
      const temperament =
        named === undefined && target.temperament !== undefined
          ? await target.temperament()
          : undefined;
      const mood = named ?? temperament;
      if (reading.problem !== undefined) return `${refusalLead} ${reading.problem}.`;
      const said = typeof id === "string" ? [id] : id;
      const spared = except === undefined ? [] : typeof except === "string" ? [except] : except;
      const mine = ownOf(settings, target);
      const seated = seatedByTheConsole(settings, target);
      const [only] = said;
      const one = said.length === 1 && spared.length === 0 && !meansEverything(said, mine);
      const shared = one && only !== undefined ? sharedNameWords(only, mine) : undefined;
      if (shared !== undefined) return `Not withdrawn: ${shared}.`;
      const taken =
        one && only !== undefined
          ? oneTakenBack(settings, target, paneCalled(only, mine) ?? only, mood)
          : severalTakenBack(settings, target, { said, spared, mine, mood });
      if (taken.startsWith(refusalLead)) return taken;
      await consoleLetGo(settings, target, seated, mine);
      const standing = nowOutside(settings, target);
      const they = one ? "It" : "They";
      const left = mood === undefined ? "" : ` ${they} left ${mannerOf(mood, moodSaid)}.`;
      const answer = `${taken}${left}${steppedOut(mine, settings, target)}`;
      return standing === undefined ? answer : `${answer} ${standing}`;
    },
  });
}

const nameInput = settingIdInput;

const mostNamed = 64;

const refusalLead = "Not withdrawn:";

const noKeeperSurface = `${refusalLead} no keeper surface takes settings here.`;

function ownOf(settings: ShowSettings, target: ShowTarget): OwnPane[] {
  return settings
    .standingFor(target, "another")
    .out.filter(({ setting }) => setting.origin === "creature")
    .map(({ setting, where }) => ({ setting, outside: where === "outside" }));
}

function seatedByTheConsole(settings: ShowSettings, target: ShowTarget): ReadonlySet<string> {
  const reported = settings
    .standingFor(target, "another")
    .out.filter(({ where, by }) => where === "outside" && by !== undefined);
  return new Set(reported.map(({ setting }) => setting.id));
}

async function consoleLetGo(
  settings: ShowSettings,
  target: ShowTarget,
  seated: ReadonlySet<string>,
  mine: readonly OwnPane[],
): Promise<void> {
  const still = new Set(
    settings.standingFor(target, "another").out.map(({ setting }) => setting.id),
  );
  const gone = [...seated].filter((id) => !still.has(id));
  if (gone.length === 0) return;
  await settings.reportNaming(({ placements }) => !placements.some(({ id }) => gone.includes(id)));
  const drilledIn = mine.some(
    ({ setting }) =>
      gone.includes(setting.id) && setting.from !== null && setting.weight === "lead",
  );
  if (drilledIn) await settings.reportNaming(() => true);
}

function steppedOut(mine: readonly OwnPane[], settings: ShowSettings, target: ShowTarget): string {
  const still = new Set(
    settings.standingFor(target, "another").out.map(({ setting }) => setting.id),
  );
  const drilledOut = mine.some(
    ({ setting }) =>
      !still.has(setting.id) &&
      setting.from !== null &&
      still.has(setting.from) &&
      setting.weight === "lead",
  );
  return drilledOut ? " It stepped back out: what it grew from has its seat again." : "";
}

function nowOutside(settings: ShowSettings, target: ShowTarget): string | undefined {
  const mine = settings
    .standingFor(target, "another")
    .out.filter(({ setting, where }) => setting.origin === "creature" && where === "outside");
  return standingWords(mine, "Outside now");
}

function oneTakenBack(
  settings: ShowSettings,
  target: ShowTarget,
  id: string,
  mood: Mood | undefined,
): string {
  const taken = settings.takeBack(target, id, mood);
  if ("refused" in taken) return `Not withdrawn: ${taken.error}.`;
  return `Withdrawn: ${taken.id} has gone back to ${placeSaid(taken.place, target.creature)}.${grownWords(settings, target, [taken])}`;
}

function grownWords(settings: ShowSettings, target: ShowTarget, gone: readonly Setting[]): string {
  const left = new Set(gone.map(({ id }) => id));
  const grown = settings
    .standingFor(target, "another")
    .out.filter(({ setting }) => setting.from !== null && left.has(setting.from))
    .map(({ setting }) => calledOf(setting));
  if (grown.length === 0) return "";
  const named = listed(grown.slice(0, mostLeftNamed), "and");
  const more = grown.length > mostLeftNamed ? `, and ${grown.length - mostLeftNamed} more` : "";
  return ` What grew from ${gone.length === 1 ? "it" : "them"} stays out: ${named}${more}.`;
}

interface Asked {
  said: readonly string[];
  spared: readonly string[];
  mine: readonly OwnPane[];
  mood: Mood | undefined;
}

function severalTakenBack(settings: ShowSettings, target: ShowTarget, asked: Asked): string {
  const { said, spared, mine, mood } = asked;
  const unknown = spared.find((name) => paneCalled(name, mine) === undefined);
  if (unknown !== undefined)
    return `Not withdrawn: except names ${quoted(unknown)}, and nothing you set out is out as that, so nothing was taken back; shown lists what is out.`;
  const staying = new Set(spared.map((name) => paneCalled(name, mine)));
  const wanted = meansEverything(said, mine)
    ? mine.map(({ setting }) => setting.id)
    : said.map((name) => paneCalled(name, mine) ?? name);
  const taking = [...new Set(wanted)].filter((id) => !staying.has(id));
  if (taking.length === 0) return "Not withdrawn: nothing of yours is out to take back.";
  const gone: Setting[] = [];
  const held: string[] = [];
  for (const id of taking) {
    const taken = settings.takeBack(target, id, mood);
    if ("refused" in taken) held.push(taken.error);
    else gone.push(taken);
  }
  if (gone.length === 0) return `Not withdrawn: ${held.join("; ")}.`;
  const left = ownOf(settings, target).map(({ setting }) => calledOf(setting));
  return [
    `Withdrawn ${gone.length}: ${listed(gone.map(calledOf), "and")} ${goneBackWords(gone, target.creature)}.${grownWords(settings, target, gone)}`,
    ...(held.length === 0 ? [] : [`Not withdrawn: ${held.join("; ")}.`]),
    left.length === 0
      ? "Nothing of yours is still out."
      : `Still out: ${listed(left.slice(0, mostLeftNamed), "and")}${left.length > mostLeftNamed ? `, and ${left.length - mostLeftNamed} more` : ""}.`,
  ].join(" ");
}

const mostLeftNamed = 6;

function goneBackWords(gone: readonly Setting[], caller: string | null): string {
  const [first] = gone;
  if (gone.length === 1 && first !== undefined)
    return `has gone back to ${placeSaid(first.place, caller)}`;
  return "have gone back where they came from";
}
