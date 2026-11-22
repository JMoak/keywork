import { z } from "zod";
import {
  type Arrangement,
  type ArrangementAsk,
  type OwnPane,
  outsideAtOnce,
  paneCalled,
  type SeatedPane,
  sharedNameWords,
} from "../show/arrangement.ts";
import { markOf } from "../show/input.ts";
import { quotedNameOf, saidOnOneLine } from "../show/naming.ts";
import type { PlacementsReport } from "../show/placements.ts";
import { Reading } from "../show/reading.ts";
import { seatWrittenInput } from "../show/seat.ts";
import { markLength, type Setting, type SettingSignal } from "../show/setting.ts";
import { overlapWords, standingWords } from "../show/standing.ts";
import type { Marking, Signalled, Signalling } from "../show/store.ts";
import {
  mannerOf,
  moodWords,
  noSignal,
  reachWords,
  relationWords,
  restWords,
  shapeWords,
  sideWords,
  signalWords,
} from "../show/vocabularies.ts";
import { quoted, wordInput } from "../show/words.ts";
import type { Tool } from "../tools.ts";
import { defineTool } from "./define.ts";
import type { ShowSettings, ShowTarget } from "./show.ts";

export const arrangeToolName = "arrange";

export function arrangeTool(target: ShowTarget): Tool {
  return defineTool({
    name: arrangeToolName,
    description:
      'Arrange the windows you have outside, at any sizes in any combination. This is IDE control over the console\'s own windows, never the computer; it never takes focus and asks for no permission. Say it one of three ways: a shape by name, {shape: "lead-and-stack", lead: "<id>"}; how the things relate, {relation: "alternatives"}, and the console lays them out; or a seat for each pane, {seats: [{id: "<id>", seat: "left-two-thirds"}, {id: "<id>", seat: "right-third"}]}. With none of the three the console chooses, and lead with side says who has the large seat and where: {lead: "<id>", side: "right"}. {back: true} puts your windows back in the seats they had before your last arrangement, and again to go further. {seats: {"<id>": "center"}, rest: "beside"} leaves one pane standing alone. panes says which things, and leaving it out means everything you have outside; naming something still beside the conversation moves it outside, and panes "all" names everything you have out. A shape or a relation re-lays every pane it names, and when you name only some they take the stage while the rest step back beside the conversation as cards, still out, until you name them again; seats move only the panes you seat, and the rest stay where they stand, so the answer tells you when windows now overlap. The console snaps seats to halves, thirds and quarters of the stage (lines 0, 3, 4, 6, 8, 9 and 12), may correct them and leaves alone what the keeper has placed, and the answer says where everything now stands. Once you have composed seats by hand the console keeps them, and a later show finds room around them or waits as a card until you arrange again. mark changes the word or two the keeper reads on a pane, {mark: {"<id>": "chosen"}}, and signal raises or lowers its outline, {signal: {"<id>": "needs-you"}}, or {signal: {"<id>": "critical"}, why: "<what is wrong>"}, with null to lower it; either goes alone or with any arrangement, and moves nothing by itself. Name panes by id or by title everywhere. At most twelve arrangements a minute.',
    schema: arrangeArgs,
    run: async (args) => {
      const settings = target.settings();
      if (settings === undefined) return noKeeperSurface;
      const reading = new Reading();
      const ask = askOf(args, reading);
      if (reading.problem !== undefined) return `Not arranged: ${reading.problem}.`;
      const marks = marksOf(args.mark, settings, target);
      if (typeof marks === "string") return `Not arranged: ${marks}.`;
      const signals = signalsOf(args.signal, settings, target, reading);
      if (reading.problem !== undefined) return `Not arranged: ${reading.problem}.`;
      if (typeof signals === "string") return `Not arranged: ${signals}.`;
      if (args.why !== undefined && !signals.some(({ signal }) => signal !== undefined))
        return whyWithoutASignal;
      if ((marks.length > 0 || signals.length > 0) && onlyMarks(args))
        return markedOnly(settings, target, { marks, signals, why: args.why });
      const arrangement = settings.arrange(target, ask);
      if ("refused" in arrangement) return `Not arranged: ${arrangement.error}.`;
      const marked = marks.length === 0 ? [] : settings.mark(target, marks, false);
      const marking = "refused" in marked || marked.length === 0 ? [] : [markedWords(marked)];
      const signalling = signalledAlongside(settings, target, signals, args.why);
      const report = await settings.reportNaming(
        (heard) => heard.arrangement?.id === arrangement.id,
      );
      if (report === undefined)
        return [askedWords(arrangement), ...marking, ...signalling].join(" ");
      const how = { back: ask.back === true, moodSaid: args.mood };
      const arranged = arrangedWords(arrangement, report, nowStanding(settings, target), how);
      return [arranged, ...marking, ...signalling].join(" ");
    },
  });
}

const paneInput = z.string().trim().min(1).max(2_000);

const signalInput = wordInput(signalWords).nullable();

const arrangeArgs = z
  .object({
    panes: z
      .union([z.array(paneInput).min(1).max(outsideAtOnce), paneInput])
      .optional()
      .describe(
        'Which things to arrange, in the order they should read: each by its id, or by the ref or title you showed it with. Leave it out for everything you have outside, or say "all" for everything you have out, beside the conversation too.',
      ),
    shape: wordInput(shapeWords)
      .optional()
      .describe(
        "A layout by name: grid (equal seats), columns (tall, side by side), rows (wide, stacked), lead-and-cards (one large, the rest as cards around it), lead-and-stack (one large beside a column of the rest), split (two large side by side, the rest as cards beneath) or board (columns of cards, for tasks).",
      ),
    relation: wordInput(relationWords)
      .optional()
      .describe(
        "How the things relate, leaving the layout to the console: sequence, alternatives, tasks or notes.",
      ),
    seats: z
      .union([
        z
          .array(z.object({ id: paneInput, seat: seatWrittenInput }).strict())
          .min(1)
          .max(outsideAtOnce),
        z.record(paneInput, seatWrittenInput),
      ])
      .optional()
      .describe(
        'A seat for each pane you place, as {"<id or title>": seat} or [{id, seat}], with seats written as in show: a named seat, lattice lines, or {x, y, w, h}.',
      ),
    lead: paneInput.optional().describe("The pane that should have the large seat."),
    side: wordInput(sideWords)
      .optional()
      .describe(
        "Where the lead stands when the console lays the panes out: left (the default), right, top or bottom. The rest take the other side. It goes with a shape, a relation or neither, and with or without lead: unnamed, the first pane leads.",
      ),
    mark: z
      .record(paneInput, z.string().trim().max(markLength).nullable())
      .optional()
      .describe(
        'The word or two the keeper reads on a pane, by its id or title: {"<id>": "chosen"}. An empty string or null clears it. It goes alone, or with any arrangement.',
      ),
    signal: z
      .record(paneInput, signalInput)
      .optional()
      .describe(
        'How much a pane wants the keeper, drawn as an outline, by its id or title: {"<id>": "needs-you"} outlines it in amber until it is answered, {"<id>": "critical"} in red, and null lowers it. Critical needs why, goes only on what you set out yourself, and you may hold one at a time; only you or the keeper lower it. It moves nothing, and goes alone or with any arrangement.',
      ),
    why: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "With signal, the one sentence the keeper reads on the pane you raise: what you need from them, or what is wrong. Critical needs it.",
      ),
    rest: wordInput(restWords)
      .optional()
      .describe(
        "What becomes of your other windows outside, the ones this arrangement does not name: stay (the default with seats) leaves them where they stand; beside steps them back beside the conversation as cards, still out, so the panes you name stand alone.",
      ),
    back: z
      .boolean()
      .optional()
      .describe(
        "true puts your windows back in the seats they had before your last arrangement, wherever those seats came from: the way back after you rearranged. Say it again to go back further. It goes alone or with a mood.",
      ),
    over: wordInput(reachWords)
      .optional()
      .describe(
        'room (the default) arranges on the stage, the room beside the console; display arranges across the whole screen, where your windows may stand over the console. Say display when the keeper speaks of the screen, as in "a quarter of the screen".',
      ),
    mood: wordInput(moodWords)
      .optional()
      .describe(
        "How the panes move into place, as motion only: one of show's moods, brisk when left out. The answer names the mood it moved with.",
      ),
  })
  .strict();

type ArrangeArgs = z.infer<typeof arrangeArgs>;

const noKeeperSurface = "Not arranged: no keeper surface takes settings here.";

function askOf(args: ArrangeArgs, reading: Reading): ArrangementAsk {
  const meansBack = args.shape !== undefined && wordsForBack.has(args.shape.trim().toLowerCase());
  return {
    back: args.back === true || meansBack ? true : undefined,
    panes: typeof args.panes === "string" ? [args.panes] : args.panes,
    shape: meansBack ? undefined : reading.word("shape", shapeWords, args.shape),
    relation: reading.word("relation", relationWords, args.relation),
    seats: seatsOf(args.seats, reading),
    lead: args.lead,
    side: reading.word("side", sideWords, args.side),
    over: reading.word("over", reachWords, args.over),
    rest: reading.word("rest", restWords, args.rest),
    mood: reading.word("mood", moodWords, args.mood),
  };
}

const wordsForBack: ReadonlySet<string> = new Set([
  "back",
  "previous",
  "before",
  "earlier",
  "last",
  "undo",
  "restore",
  "as before",
  "as it was",
]);

function onlyMarks({ mark: _marks, signal: _signals, why: _why, ...rest }: ArrangeArgs): boolean {
  return Object.values(rest).every((asked) => asked === undefined);
}

const whyWithoutASignal =
  "Not arranged: why goes with signal, as the sentence the keeper reads on a pane you raise; name the signal, or leave why out.";

interface SignalAsked extends Signalling {
  said: string;
}

interface MarksAsked {
  marks: readonly Marking[];
  signals: readonly SignalAsked[];
  why: string | undefined;
}

function markedOnly(
  settings: ShowSettings,
  target: ShowTarget,
  { marks, signals, why }: MarksAsked,
): string {
  const signalled = signals.length === 0 ? [] : settings.signal(target, signals, why, true);
  if ("refused" in signalled) return `Not arranged: ${signalled.error}.`;
  const marked = marks.length === 0 ? [] : settings.mark(target, marks, signals.length === 0);
  if ("refused" in marked) return `Not arranged: ${marked.error}.`;
  return [
    ...(marks.length === 0 ? [] : [markedWords(marked)]),
    ...signalledWords(signalled, signals),
    ...(signals.length === 0 ? [] : [movedWords(signalled)]),
  ].join(" ");
}

function signalsOf(
  asked: ArrangeArgs["signal"],
  settings: ShowSettings,
  target: ShowTarget,
  reading: Reading,
): SignalAsked[] | string {
  if (asked === undefined) return [];
  const mine = ownPanes(settings, target);
  const signals: SignalAsked[] = [];
  for (const [named, word] of Object.entries(asked)) {
    const id = paneCalled(named, mine);
    if (id === undefined)
      return (
        sharedNameWords(named, mine) ??
        `signal names ${quoted(named)}, and nothing you set out is out as that; shown lists what is out`
      );
    const said = word ?? noSignal;
    const signal = reading.word("signal", signalWords, said);
    signals.push({ id, signal: signal === noSignal ? undefined : signal, said });
  }
  return signals;
}

function signalledAlongside(
  settings: ShowSettings,
  target: ShowTarget,
  signals: readonly SignalAsked[],
  why: string | undefined,
): string[] {
  if (signals.length === 0) return [];
  const signalled = settings.signal(target, signals, why, false);
  return "refused" in signalled
    ? [`Not signalled: ${signalled.error}.`]
    : signalledWords(signalled, signals);
}

function signalledWords(signalled: readonly Signalled[], asked: readonly SignalAsked[]): string[] {
  return signalled.map(({ setting, before }, at) => {
    const said = asked[at]?.said;
    const after = setting.signal;
    const nearest =
      after === undefined || said === undefined || sameWords(said, after)
        ? ""
        : ` (${after}, the nearest signal to ${quoted(said.trim().toLowerCase())})`;
    return `${signalChangeWords(quotedNameOf(setting.what), before, after)}${nearest}.`;
  });
}

function signalChangeWords(
  name: string,
  before: SettingSignal | undefined,
  after: SettingSignal | undefined,
): string {
  if (before === after)
    return after === undefined
      ? `${name} carries no signal, so there was nothing to lower`
      : `${name} ${signalStates[after]} already`;
  if (after === "critical")
    return `${name} is critical now: the keeper sees it outlined in red with your reason, and it stays out until they have seen it`;
  if (after === "needs-you")
    return before === "critical"
      ? `${name} is no longer critical, and needs the keeper now, outlined in amber`
      : `${name} needs the keeper now: it is outlined in amber until they answer it`;
  return before === "critical"
    ? `${name} is no longer critical`
    : `${name} no longer needs the keeper`;
}

const signalStates: Readonly<Record<SettingSignal, string>> = {
  "needs-you": "needs the keeper",
  critical: "is critical",
};

function movedWords(signalled: readonly Signalled[]): string {
  const changed = signalled.some(({ setting, before }) => setting.signal !== before);
  return changed ? "Nothing else moved." : "Nothing moved.";
}

function sameWords(said: string, word: string): boolean {
  const plainly = (words: string) =>
    words
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .trim();
  return plainly(said) === plainly(word);
}

function ownPanes(settings: ShowSettings, target: ShowTarget): OwnPane[] {
  return settings
    .standingFor(target, "another")
    .out.filter(({ setting }) => setting.origin === "creature")
    .map(({ setting, where }) => ({ setting, outside: where === "outside" }));
}

function marksOf(
  asked: ArrangeArgs["mark"],
  settings: ShowSettings,
  target: ShowTarget,
): Marking[] | string {
  if (asked === undefined) return [];
  const mine = ownPanes(settings, target);
  const marks: Marking[] = [];
  for (const [said, words] of Object.entries(asked)) {
    const id = paneCalled(said, mine);
    if (id === undefined)
      return (
        sharedNameWords(said, mine) ??
        `mark names ${quoted(said)}, and nothing you set out is out as that; shown lists what is out`
      );
    marks.push({ id, mark: markOf(words) });
  }
  return marks;
}

function markedWords(marked: readonly Setting[]): string {
  const each = marked.map(({ what, mark }) =>
    mark === undefined
      ? `${quotedNameOf(what)} carries no mark now`
      : `the keeper reads ${JSON.stringify(mark)} on ${quotedNameOf(what)}`,
  );
  return `Marked: ${each.join("; ")}.`;
}

function seatsOf(asked: ArrangeArgs["seats"], reading: Reading): SeatedPane[] | undefined {
  if (asked === undefined) return undefined;
  const pairs = Array.isArray(asked)
    ? asked.map(({ id, seat }): [string, unknown] => [id, seat])
    : Object.entries(asked);
  const seats = pairs.flatMap(([id, written]) => {
    const seat = reading.seat(written);
    return seat === undefined ? [] : [{ id, seat }];
  });
  return seats.length === 0 ? undefined : seats;
}

function nowStanding(settings: ShowSettings, target: ShowTarget): string {
  const { out } = settings.standingFor(target);
  const mine = out.filter(({ setting }) => setting.origin === "creature");
  const standing = standingWords(mine, "Outside now") ?? "Nothing of yours is outside.";
  const overlap = overlapWords(out);
  return overlap === undefined ? standing : `${standing} ${overlap}`;
}

function askedWords({ panes }: Arrangement): string {
  return `Asked: the arrangement of ${countedPanes(panes)} went to the console, which has not answered yet. shown will tell where things stand.`;
}

function arrangedWords(
  arrangement: Arrangement,
  { arrangement: answer }: PlacementsReport,
  standing: string,
  how: How,
): string {
  const said = saidOnOneLine(answer?.said ?? "", longestSaid);
  return [
    `${how.back ? wentBackWords(arrangement, how) : doneWords(arrangement, how)}.`,
    standing,
    ...(said === "" ? [] : [`The console says: ${said}`]),
  ].join(" ");
}

const longestSaid = 900;

interface How {
  back: boolean;
  moodSaid: string | undefined;
}

function movingWords(mood: Arrangement["mood"], { moodSaid }: How): string {
  return mood === undefined ? "" : `, moving ${mannerOf(mood, moodSaid)}`;
}

function wentBackWords({ seats, mood }: Arrangement, how: How): string {
  const moving = movingWords(mood, how);
  const count = seats?.length ?? 0;
  const back =
    count === 1 ? "1 pane is back in the seat it" : `${count} panes are back in the seats they`;
  return `Went back one arrangement${moving}: ${back} had before it`;
}

function doneWords(arrangement: Arrangement, how: How): string {
  const { panes, seats, mood } = arrangement;
  const moving = movingWords(mood, how);
  const left = seats === undefined ? 0 : panes.length - seats.length;
  if (seats === undefined || left <= 0)
    return `Arranged ${countedPanes(panes)}${howWords(arrangement)}${moving}`;
  const stays =
    left === 1 ? "the other 1 stays where it stood" : `the other ${left} stay where they stood`;
  return `Seated ${countedPanes(seats)} where you composed${moving}; ${stays}`;
}

function howWords({ shape, relation, seats, side }: Arrangement): string {
  const led = side === undefined ? "" : `, the large seat ${sideSaid[side]}`;
  if (shape !== undefined) return ` as ${shape}${led}`;
  if (relation !== undefined) return ` as ${relation}${led}`;
  return seats === undefined
    ? `, the layout left to the console${led}`
    : " in the seats you composed";
}

const sideSaid: Readonly<Record<NonNullable<Arrangement["side"]>, string>> = {
  left: "on the left",
  right: "on the right",
  top: "at the top",
  bottom: "at the bottom",
};

function countedPanes(panes: readonly unknown[]): string {
  return panes.length === 1 ? "1 pane" : `${panes.length} panes`;
}
