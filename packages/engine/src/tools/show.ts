import { z } from "zod";
import { outsideAtOnce, paneCalled } from "../show/arrangement.ts";
import {
  lastingOf,
  lastingPattern,
  lastingWords,
  markInput,
  markOf,
  settingFromInput,
  settingWhatInput,
  settingWhatOf,
} from "../show/input.ts";
import { calledOf } from "../show/naming.ts";
import { Reading } from "../show/reading.ts";
import { sameSeat, seatInput, seatWords, seatWrittenInput } from "../show/seat.ts";
import {
  type Rung,
  rungs,
  type Setting,
  type SettingAgent,
  settingKinds,
} from "../show/setting.ts";
import { overlapWords, type Stood, standingWords } from "../show/standing.ts";
import type { SetOut, SettingStore, ShowProposal } from "../show/store.ts";
import {
  mannerOf,
  moodsDescribed,
  moodWords,
  placeWords,
  sizeWords,
  weightWords,
} from "../show/vocabularies.ts";
import { wordInput } from "../show/words.ts";
import type { Tool } from "../tools.ts";
import { defineTool } from "./define.ts";

export type ShowSettings = Pick<
  SettingStore,
  | "propose"
  | "canGrowFrom"
  | "takeBack"
  | "takeHeardBy"
  | "arrange"
  | "mark"
  | "standingFor"
  | "reportNaming"
>;

export interface ShowTarget {
  creature: string | null;
  sessionId: string;
  agent?: SettingAgent | undefined;
  settings(): ShowSettings | undefined;
}

export const showToolName = "show";

export function showTool(target: ShowTarget): Tool {
  return defineTool({
    name: showToolName,
    description:
      'Set something out for the keeper to see: a file, a diff, a report, a thread, a chore, a link or a short note. It sits beside this conversation, or with where outside it stands in a window of its own. This is IDE control: it arranges the console\'s own space and windows, never the computer, it never takes focus and it changes nothing in the world, so it asks for no permission. {what: {kind: "file", ref: "docs/plan.md"}, where: "outside"} is enough, and the console picks the seat; add seat: "left-half" to pick it yourself. To set out several at once, give what a list, {what: [{kind: "note", title: "Plan A", ref: "..."}, {kind: "note", title: "Plan B", ref: "..."}], where: "outside"}: they arrive together, each thing may carry its own seat, why, weight, from and mark, and the answer says where each stands. A note\'s words are markdown, so headings, lists, checklists and tables render. Beside the conversation, rung and size apply; outside, the seat decides: a seat you name overrides size and weight, and when the console chooses, weight says who gets the large seat. A size applies the first time the setting opens, the yard may still show less, and it cannot be changed later. Showing the same thing again replaces what you set out before and keeps its place; a note with the same title is the same thing, so that is how you change its words, and the id it had before still names it. Whatever you leave out the second time stays as it was: its place, rung, size, weight, mark, why and when it goes. A mark is a word or two the keeper reads as a highlighted tag beside its title for as long as it is out, such as chosen, draft or done; arrange changes it later. It stays until the keeper has seen it, until this thread rests, or for a time you name. Name from when it grows out of something already in view: a setting you set out, by its id (every answer names it) or its title, or a thread of yours such as one you delegated. Outside, it arises from that pane, and with weight lead it drills in: it takes the large seat, its parent steps aside, withdraw steps back out, and arrange with its parent as lead steps back out and keeps it. At most a hundred settings an hour, and twelve of yours outside at once.',
    schema: showArgs,
    run: async (args) => {
      const settings = target.settings();
      if (settings === undefined) return noKeeperSurface;
      const things = Array.isArray(args.what) ? args.what : [args.what];
      if (things.length > 1 && args.seat !== undefined) return oneSeatForSeveral;
      const reading = new Reading();
      const asked = things.map((thing) => proposalOf(target, args, thing, reading));
      if (reading.problem !== undefined) return `Not set out: ${reading.problem}.`;
      const [alone] = asked;
      if (asked.length === 1 && alone !== undefined) {
        const proposal = { ...alone, from: namedFrom(settings, target, alone.from) };
        const { from } = proposal;
        if (from !== null && !(await settings.canGrowFrom(target, from))) return outOfSight(from);
        const outcome = settings.propose(proposal);
        if ("refused" in outcome) return `Not set out: ${outcome.error}.`;
        const told = { moodSaid: args.mood, replaced: outcome.replaced !== undefined };
        const outside = await standingOutside(settings, target, outcome.setting, told);
        const first = onlyOnesOut(settings, target, [outcome.setting]);
        return sentenceOf(outcome, outside, { lasting: lastingSaid(args.until), first });
      }
      const { done, stopped } = await setOutInTurn(settings, target, asked);
      if (done.length === 0) return stopped ?? noKeeperSurface;
      return severalWords(settings, target, { done, stopped, asked: asked.length }, args);
    },
  });
}

const ownPlacing = {
  seat: seatWrittenInput.optional(),
  why: z.string().trim().min(1).max(200).optional(),
  weight: wordInput(weightWords).optional(),
  from: settingFromInput.nullable().optional(),
  mark: markInput.optional(),
};

const thingInput = z.object({ ...settingWhatInput.shape, ...ownPlacing }).strict();

const listedThingInput = z
  .object({
    kind: z.enum(settingKinds),
    ref: z.string().trim().min(1).max(2_000),
    title: z.string().trim().min(1).max(200).optional(),
    ...ownPlacing,
  })
  .strict();

type Thing = z.infer<typeof thingInput>;

const showArgs = z
  .object({
    what: z
      .union([thingInput, z.array(listedThingInput).min(1).max(outsideAtOnce)])
      .describe(
        "The thing to set out, or a list of up to twelve to set out together, each written as one thing is. A thing may carry its own seat, why, weight, from and mark, written as the call's are, and takes the call's for whatever it leaves out.",
      ),
    why: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("One sentence the keeper reads with it: why this matters now."),
    where: wordInput(placeWords)
      .optional()
      .describe(
        "beside (the default) keeps it beside the conversation; outside gives it a window of its own.",
      ),
    seat: seatInput
      .optional()
      .describe(
        'Where it stands outside, on the stage\'s 12 by 12 lattice: a named seat (full, left-half, right-half, top-half, bottom-half, left-third, middle-third, right-third, left-two-thirds, right-two-thirds, left-quarter, right-quarter, left-three-quarters, right-three-quarters, middle-half, top-left, top-right, bottom-left, bottom-right, center, top-third, bottom-third), lattice lines such as "columns 4 to 8, rows 0 to 6" (0 is the left and top edge, 12 the right and bottom), or {x, y, w, h}. Halves, thirds and quarters run the full height, the four corners are a quarter of the stage each, center is the middle half of each way, and seats snap to halves, thirds and quarters (lines 0, 3, 4, 6, 8, 9 and 12). Naming a seat puts it outside; leave it out and the console chooses, re-laying the windows it chose seats for as more arrive.',
      ),
    weight: wordInput(weightWords)
      .optional()
      .describe(
        "How much room it should have among your windows: lead, support or aside. With from, lead drills in.",
      ),
    mood: wordInput(moodWords)
      .optional()
      .describe(
        `How it arrives, and later leaves, as motion only: ${moodsDescribed}. The answer names the mood it arrived with.`,
      ),
    mark: markInput
      .optional()
      .describe(
        'A word or two the keeper reads on it while it is out, such as "chosen", "draft" or "done". arrange changes or clears it later.',
      ),
    rung: z
      .enum(rungs)
      .optional()
      .describe(
        "Beside the conversation, how much of the keeper's attention you propose: lantern (a mark to look at when ready), card (the default), unfold (open beside the conversation) or stage (the whole view).",
      ),
    size: wordInput(sizeWords)
      .optional()
      .describe(
        "How large it opens: card for a glance, readable for reading, working for something the keeper will work in.",
      ),
    until: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(namesWhenItGoes)
      .optional()
      .meta({ examples: ["seen", "rests", "10 minutes", "2026-11-08T10:00:00-06:00"] })
      .describe(
        'When it goes: seen (the default: it stays until the keeper marks it seen or dismisses it, however long that takes), rests (when this thread rests), a time from now such as "10 minutes" or "2 hours", or an ISO 8601 date-time with its offset.',
      ),
    from: settingFromInput
      .nullable()
      .optional()
      .describe(
        "What it grows from: a setting you set out that is still out, by its id or its title, or a thread of yours such as one you delegated. Leave it out for something new.",
      ),
  })
  .strict();

type ShowArgs = z.infer<typeof showArgs>;

const isoWithOffset = z.iso.datetime({ offset: true });

function namesWhenItGoes(said: string): boolean {
  if (said === "seen" || said === "rests" || lastingPattern.test(said)) return true;
  return isoWithOffset.safeParse(said).success;
}

const noKeeperSurface =
  "Not set out: no keeper surface takes settings here; tell the keeper in words instead.";

const oneSeatForSeveral =
  "Not set out: seat names one place, and you are setting out several things; give each thing its own seat inside what, or leave seats out and the console lays them out.";

interface TurnOut {
  done: SetOut[];
  stopped: string | undefined;
}

async function setOutInTurn(
  settings: ShowSettings,
  target: ShowTarget,
  asked: readonly ShowProposal[],
): Promise<TurnOut> {
  const done: SetOut[] = [];
  for (const ask of asked) {
    const proposal = { ...ask, from: namedFrom(settings, target, ask.from) };
    const { from } = proposal;
    if (from !== null && !(await settings.canGrowFrom(target, from)))
      return { done, stopped: outOfSight(from) };
    const outcome = settings.propose(proposal);
    if ("refused" in outcome) return { done, stopped: `Not set out: ${outcome.error}.` };
    done.push(outcome);
  }
  return { done, stopped: undefined };
}

function namedFrom(settings: ShowSettings, target: ShowTarget, from: string | null): string | null {
  if (from === null) return null;
  const mine = settings
    .standingFor(target, "another")
    .out.filter(({ setting }) => setting.origin === "creature")
    .map(({ setting, where }) => ({ setting, outside: where === "outside" }));
  return paneCalled(from, mine) ?? from;
}

function outOfSight(from: string): string {
  return `Not set out: nothing you may grow from has the id ${from}; name a setting you set out that is still out, or a thread of yours.`;
}

function proposalOf(
  target: ShowTarget,
  args: ShowArgs,
  thing: Thing,
  reading: Reading,
): ShowProposal {
  const lasting = untilOf(args.until);
  const mark = markOf(thing.mark ?? args.mark);
  return {
    creature: target.creature,
    sessionId: target.sessionId,
    what: settingWhatOf(thing),
    rung: args.rung ?? "card",
    size: reading.word("size", sizeWords, args.size),
    where: reading.word("where", placeWords, args.where),
    seat: reading.seat(thing.seat ?? args.seat),
    weight: reading.word("weight", weightWords, thing.weight ?? args.weight),
    mood: reading.word("mood", moodWords, args.mood),
    why: thing.why ?? args.why ?? "",
    ...lasting,
    from: thing.from ?? args.from ?? null,
    origin: "creature",
    keeps: {
      rung: args.rung === undefined,
      why: (thing.why ?? args.why) === undefined,
      until: args.until === undefined,
    },
    ...(mark !== undefined && { mark }),
    ...(target.agent !== undefined && { agent: target.agent }),
  };
}

function untilOf(said: string | undefined): Pick<ShowProposal, "until" | "lastsMs"> {
  if (said === undefined) return { until: "seen" };
  const lastsMs = lastingOf(said);
  return lastsMs === undefined ? { until: said } : { until: "seen", lastsMs };
}

function lastingSaid(said: string | undefined): string | undefined {
  const lastsMs = said === undefined ? undefined : lastingOf(said);
  return lastsMs === undefined ? undefined : lastingWords(lastsMs);
}

interface StandingOutside {
  arrived: string;
  others: string | undefined;
}

interface Told {
  moodSaid: string | undefined;
  replaced: boolean;
}

function onlyOnesOut(
  settings: ShowSettings,
  target: ShowTarget,
  mine: readonly Setting[],
): boolean {
  const { agent } = target;
  if (agent === undefined) return false;
  const ids = new Set(mine.map(({ id }) => id));
  return !settings
    .standingFor(target, "another")
    .out.some(
      ({ setting }) =>
        !ids.has(setting.id) && setting.agent !== undefined && setting.agent.name === agent.name,
    );
}

async function standingOutside(
  settings: ShowSettings,
  target: ShowTarget,
  setting: Setting,
  told: Told,
): Promise<StandingOutside | undefined> {
  if (setting.where !== "outside") return undefined;
  const report = await settings.reportNaming(({ placements }) =>
    placements.some(({ id }) => id === setting.id),
  );
  const mine = settings
    .standingFor(target)
    .out.filter(({ setting: { origin } }) => origin === "creature");
  const stood = mine.find((candidate) => candidate.setting.id === setting.id);
  const others = mine.filter((candidate) => candidate !== stood);
  const besideIt = others.filter(({ where, by }) => where === "outside" && by === "console").length;
  const overlap = overlapWords(mine);
  const standing = othersWords(others);
  return {
    arrived:
      stood === undefined || report === undefined
        ? askedWords(setting)
        : arrivedWords(stood, besideIt, told),
    others: overlap === undefined ? standing : [standing, overlap].filter(Boolean).join(" "),
  };
}

const mostOthersNamed = 12;

function othersWords(others: readonly Stood[]): string | undefined {
  const outside = others.filter(({ where }) => where === "outside");
  if (outside.length <= mostOthersNamed) return standingWords(others, "Your other windows");
  const elsewhere = standingWords(
    others.filter(({ where }) => where !== "outside"),
    "Your other windows",
  );
  const counted = `You have ${outside.length} other windows outside; shown tells where each stands.`;
  return elsewhere === undefined ? counted : `${counted} ${elsewhere}`;
}

function askedWords({ seat }: Setting): string {
  return seat === undefined
    ? "Set out outside in a window of its own; the console chooses its seat and has not said where yet, so shown will tell."
    : `Set out outside in a window of its own, asked for ${seatWords(seat)}; the console has not said where it stands yet, so shown will tell.`;
}

function arrivedWords(
  { setting, where, seat, note }: Stood,
  besideIt: number,
  { moodSaid, replaced }: Told,
): string {
  const because = note === undefined ? "" : ` The console says: ${sentenceEnded(note)}`;
  if (replaced && where === "outside" && seat !== undefined)
    return `${replacedInPlace} It keeps its window, in ${seatWords(seat)}.`;
  if (where === "inside")
    return `Set out, and the console is keeping it inside the console.${because}`;
  if (where === "beside")
    return `Set out, but not outside: it is a card beside the conversation.${because} Name it in arrange with a shape and the console re-lays your windows to make room for it, or show it again once there is room.`;
  const mannered =
    setting.mood === undefined ? "" : ` It arrived ${mannerOf(setting.mood, moodSaid)}.`;
  const drilled =
    setting.from !== null && setting.weight === "lead"
      ? " It drilled in: it takes the large seat and what it grew from steps aside. Withdrawing it steps back out, and arrange with what it grew from as lead steps back out and keeps it."
      : "";
  const arrived = `${drilled}${mannered}`;
  if (seat === undefined) return `Set out outside in a window of its own.${arrived}`;
  const asked = setting.seat;
  if (asked === undefined && besideIt > 0 && drilled === "")
    return `Set out outside in a window of its own, in ${seatWords(seat)} for now: the console re-lays the windows it seats as more arrive.${arrived}`;
  const corrected =
    asked === undefined || sameSeat(asked, seat)
      ? ""
      : ` You asked for ${seatWords(asked)}, and the console corrected it.`;
  return `Set out outside in a window of its own, in ${seatWords(seat)}.${corrected}${arrived}`;
}

function sentenceEnded(words: string): string {
  return /[.!?]$/.test(words) ? words : `${words}.`;
}

const replacedInPlace = "Replaced in place: what you set out for this before now reads as this.";

interface Said {
  lasting: string | undefined;
  first: boolean;
}

function sentenceOf(
  { setting, replaced }: SetOut,
  outside: StandingOutside | undefined,
  { lasting, first }: Said,
): string {
  const saidAlready = outside?.arrived.startsWith(replacedInPlace) === true;
  return [
    outside?.arrived ?? placedAs[setting.rung],
    goesWhen(setting.until, lasting),
    ...(replaced === undefined || saidAlready
      ? []
      : ["It replaces what you set out for this before."]),
    ...markedWords([setting]),
    ...(first ? squareWords(setting) : []),
    `To set out what grows from it, name ${setting.id} as from.`,
    ...(outside?.others === undefined ? [] : [outside.others]),
  ].join(" ");
}

function markedWords(settings: readonly Setting[]): string[] {
  const marked = settings.filter(({ mark }) => mark !== undefined);
  const [only] = settings;
  if (marked.length === 0) return [];
  if (settings.length === 1 && only !== undefined)
    return [`The keeper reads ${JSON.stringify(only.mark)} on it.`];
  const each = marked.map(
    ({ what, mark }) => `${JSON.stringify(what.title ?? what.ref)} as ${JSON.stringify(mark)}`,
  );
  return [`Marked: ${each.join("; ")}.`];
}

function squareWords({ agent }: Setting): string[] {
  if (agent?.color === undefined) return [];
  const whose = agent.name === undefined ? "an agent's" : `${agent.name}'s`;
  return [`The keeper sees it marked with a ${agent.color} square as ${whose}.`];
}

const placedAs: Readonly<Record<Rung, string>> = {
  lantern: "Set out as a lantern; the keeper looks when ready.",
  card: "Set out as a card; the yard decides whether it unfolds.",
  unfold: "Set out to unfold; the yard decides whether it unfolds or stays a card.",
  stage:
    "Set out for the stage; only the keeper or a yard rule stages it, so the yard decides how it shows.",
};

function goesWhen(until: string, lasting?: string): string {
  if (until === "seen") return "It stays until the keeper has seen it.";
  if (until === "rests") return "It goes when this thread rests.";
  return lasting === undefined ? `It goes at ${until}.` : `It goes in ${lasting}, at ${until}.`;
}

interface Several {
  done: readonly SetOut[];
  stopped: string | undefined;
  asked: number;
}

async function severalWords(
  settings: ShowSettings,
  target: ShowTarget,
  { done, stopped, asked }: Several,
  args: ShowArgs,
): Promise<string> {
  const mine = done.map(({ setting }) => setting);
  const ids = new Set(mine.map(({ id }) => id));
  const outside = mine.filter(({ where }) => where === "outside").map(({ id }) => id);
  if (outside.length > 0)
    await settings.reportNaming(({ placements }) =>
      outside.every((id) => placements.some((placed) => placed.id === id)),
    );
  const out = settings
    .standingFor(target)
    .out.filter(({ setting: { origin } }) => origin === "creature");
  const stood = mine.flatMap(({ id }) => out.find(({ setting }) => setting.id === id) ?? []);
  const others = out.filter(({ setting }) => !ids.has(setting.id));
  const [first] = mine;
  const replaced = done.filter((one) => one.replaced !== undefined).length;
  const mannered =
    first?.mood === undefined || outside.length === 0
      ? []
      : [`They arrived ${mannerOf(first.mood, args.mood)}.`];
  return [
    `Set out ${mine.length}: ${stood.map(placedWords).join("; ")}.`,
    ...mannered,
    theyGoWhen(first?.until ?? "seen", lastingSaid(args.until)),
    ...(replaced === 0 ? [] : [`${replaced} of them replaced what you set out before.`]),
    ...markedWords(mine),
    ...(first === undefined || !onlyOnesOut(settings, target, mine) ? [] : squareWords(first)).map(
      (words) => words.replace("sees it marked", "sees each marked"),
    ),
    "Name any of them by its title or its id in from, arrange or withdraw.",
    ...(stopped === undefined ? [] : [notAllWords(stopped, asked - mine.length)]),
    ...[othersWords(others), overlapWords(out)].flatMap((words) => words ?? []),
  ].join(" ");
}

function placedWords({ setting, where, seat, by, note }: Stood): string {
  const called = calledOf(setting);
  if (where === "inside") return `${called} inside the console`;
  if (where === "beside") {
    const because = note === undefined || by === undefined ? "" : ` (${note})`;
    return `${called} as a card beside the conversation${because}`;
  }
  if (by === undefined || seat === undefined) return `${called} outside, its seat not yet reported`;
  return `${called} in ${seatWords(seat)}`;
}

function theyGoWhen(until: string, lasting: string | undefined): string {
  if (until === "seen") return "They stay until the keeper has seen them.";
  if (until === "rests") return "They go when this thread rests.";
  return lasting === undefined ? `They go at ${until}.` : `They go in ${lasting}, at ${until}.`;
}

function notAllWords(stopped: string, left: number): string {
  const rest = left === 1 ? "The next thing was not set out" : `The other ${left} were not set out`;
  return `${rest}: ${stopped.replace(/^Not set out: /, "")}`;
}
