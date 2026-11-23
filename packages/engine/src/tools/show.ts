import { z } from "zod";
import {
  type Arrangement,
  type ArrangementShape,
  outsideAtOnce,
  paneCalled,
} from "../show/arrangement.ts";
import {
  lastingOf,
  lastingPattern,
  lastingWords,
  markOf,
  markSaidInput,
  settingFromInput,
  settingWhatInput,
  settingWhatOf,
  toneInput,
  toneSaidOf,
} from "../show/input.ts";
import { calledOf, quotedNameOf } from "../show/naming.ts";
import { noPlaceBook, type PlaceBook, placeCalled, placeSaid } from "../show/places.ts";
import { Reading } from "../show/reading.ts";
import { sameSeat, seatInput, seatWords, seatWrittenInput } from "../show/seat.ts";
import {
  type MachinePane,
  machinePanes,
  type Rung,
  rungs,
  type Setting,
  type SettingAgent,
  type SettingSignal,
  type SettingWhat,
  type SteadPlace,
  settingKinds,
  settingPanes,
} from "../show/setting.ts";
import { overlapWords, type Stood, standingWords } from "../show/standing.ts";
import type { SetOut, SettingStore, ShowProposal, ShowRefusal } from "../show/store.ts";
import {
  mannerOf,
  moodsDescribed,
  moodWords,
  noSignal,
  paneWords,
  placeWords,
  type SignalSaid,
  shapeWords,
  signalWords,
  sizeWords,
  tonesDescribed,
  toneWords,
  weightWords,
} from "../show/vocabularies.ts";
import { quoted, wordInput } from "../show/words.ts";
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
  | "signal"
  | "standingFor"
  | "reportNaming"
>;

export interface ShowTarget {
  creature: string | null;
  sessionId: string;
  agent?: SettingAgent | undefined;
  home?: SteadPlace | undefined;
  places?: PlaceBook | undefined;
  settings(): ShowSettings | undefined;
}

export const showToolName = "show";

export function showTool(target: ShowTarget): Tool {
  return defineTool({
    name: showToolName,
    description: `Set out something for the keeper, the person you work with, to see in their app: a file, a diff, a report, a thread, a chore, a link, a short markdown note, or one of the app's own panes by name (${settingPanes.join(", ")}). It opens beside your conversation, or in a window of its own with where "outside"; seat picks its spot ("left-half", "top-right") and shape lays out several at once. A terminal or a screen acts on the keeper's machine, so the keeper is asked every time. It rises from a place: your workshop, unless from names another (the porch, the storehouse, the mill, a project by name or path, another creature's workshop) or something of yours already out, which it grows from. Showing the same thing again changes it in place; a note with the same title is the same note. mark puts a word or two on it, with a tone; signal outlines it when your work waits on the keeper (needs-you) or something is broken (critical, with why). Every answer gives its id, for arrange and withdraw.`,
    schema: showArgs,
    alwaysAsks: (args) => machinePaneIn(args) !== undefined,
    run: async (args) => {
      const settings = target.settings();
      if (settings === undefined) return noKeeperSurface;
      const things = Array.isArray(args.what) ? args.what : [args.what];
      if (things.length > 1 && args.seat !== undefined) return oneSeatForSeveral;
      const reading = new Reading();
      const asked = things.map((thing) => proposalOf(target, args, thing, reading));
      const shape = reading.word("shape", shapeWords, args.shape);
      if (reading.problem !== undefined) return `Not set out: ${reading.problem}.`;
      if (shape !== undefined && asked.some(({ where }) => where === "beside")) return shapeBeside;
      const [alone] = asked;
      if (asked.length === 1 && alone !== undefined && shape === undefined) {
        const proposal =
          alone.from === null ? alone : await arisingOf(settings, target, alone, alone.from);
        if (typeof proposal === "string") return proposal;
        const outcome = settings.propose(proposal);
        if ("refused" in outcome) return `Not set out: ${outcome.error}.`;
        const told = { moodSaid: args.mood, replaced: outcome.replaced !== undefined };
        const outside = await standingOutside(settings, target, outcome.setting, told);
        const first = onlyOnesOut(settings, target, [outcome.setting]);
        return sentenceOf(outcome, outside, {
          lasting: lastingSaid(args.until),
          first,
          signalSaid: things[0] === undefined ? undefined : signalAsked(things[0], args),
          timeAsked: args.until !== undefined,
          placeNamed: proposal.place !== undefined && proposal.place !== target.home,
          caller: target.creature,
        });
      }
      const laidOut = shape === undefined ? asked : asked.map(outsideTogether);
      const { done, stopped } = await setOutInTurn(settings, target, laidOut);
      if (done.length === 0) return stopped ?? noKeeperSurface;
      const arranged =
        shape === undefined ? undefined : arrangedTogether(settings, target, done, shape);
      return severalWords(settings, target, { done, stopped, asked: asked.length, arranged }, args);
    },
  });
}

const signalInput = wordInput(signalWords).nullable();

const ownPlacing = {
  seat: seatWrittenInput.optional(),
  why: z.string().trim().min(1).max(200).optional(),
  weight: wordInput(weightWords).optional(),
  from: settingFromInput.nullable().optional(),
  mark: markSaidInput.optional(),
  tone: toneInput.optional(),
  signal: signalInput.optional(),
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
        "The thing to set out, or a list of up to twelve set out together. Each may carry its own seat, why, weight, from, mark, tone and signal.",
      ),
    why: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("One sentence the keeper reads with it: why it matters now."),
    where: wordInput(placeWords)
      .optional()
      .describe("beside (the default) keeps it by your conversation; outside gives it a window."),
    seat: seatInput
      .optional()
      .describe(
        'Its spot outside, on a 12 by 12 grid: a name (full, left-half, right-half, top-half, bottom-half, left-third, middle-third, right-third, left-two-thirds, right-two-thirds, left-quarter, right-quarter, top-left, top-right, bottom-left, bottom-right, center, top-third, bottom-third), lines such as "columns 4 to 8, rows 0 to 6", or {x, y, w, h}. Leave it out and the app chooses.',
      ),
    shape: wordInput(shapeWords)
      .optional()
      .describe(
        "Lays out what this call sets out, in windows outside: grid, columns, rows, lead-and-cards, lead-and-stack, split or board.",
      ),
    weight: wordInput(weightWords)
      .optional()
      .describe("lead, support or aside: who gets the large spot. With from, lead drills in."),
    mood: wordInput(moodWords)
      .optional()
      .describe(`How it moves in, motion only: ${moodsDescribed}.`),
    mark: markSaidInput
      .optional()
      .describe(
        'A word or two on it while it is out, such as "draft" or "done", or {text, tone}. arrange changes it later.',
      ),
    tone: toneInput.optional().describe(`The mark's tone: ${tonesDescribed}.`),
    signal: signalInput
      .optional()
      .describe(
        "needs-you (amber) when your work waits on the keeper; critical (red) only when something is broken or about to be lost, with why; null lowers it. Use it rarely.",
      ),
    rung: z
      .enum(rungs)
      .optional()
      .describe(
        "Beside your conversation, how much attention it asks: lantern (least), card (the default), unfold or stage (most).",
      ),
    size: wordInput(sizeWords)
      .optional()
      .describe("card, readable or working: how large it first opens."),
    until: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(namesWhenItGoes)
      .optional()
      .meta({ examples: ["seen", "rests", "10 minutes", "2026-11-08T10:00:00-06:00"] })
      .describe(
        'When it goes: seen (the default: it stays until the keeper puts it away), rests (when this conversation goes quiet), a time from now such as "10 minutes", or an ISO 8601 time.',
      ),
    from: settingFromInput
      .nullable()
      .optional()
      .describe(
        "Where it rises from: a place (your workshop, the porch, the storehouse, the mill, a project by name or path, another creature's workshop such as \"pip's workshop\"), or something of yours already out (by id or title), which it then grows from.",
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

const shapeBeside =
  "Not set out: a shape lays things out in windows outside, so it cannot go with where beside; leave one of them out.";

export function machinePaneIn(args: unknown): MachinePane | undefined {
  const what = recordOf(args).what;
  const things = Array.isArray(what) ? what : [what];
  for (const thing of things) {
    const { kind, ref } = recordOf(thing);
    if (kind !== "pane" || typeof ref !== "string") continue;
    const pane = paneWords.understood(ref);
    const machine = machinePanes.find((named) => named === pane);
    if (machine !== undefined) return machine;
  }
  return undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

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
    const proposal = ask.from === null ? ask : await arisingOf(settings, target, ask, ask.from);
    if (typeof proposal === "string") return { done, stopped: proposal };
    const outcome = settings.propose(proposal);
    if ("refused" in outcome) return { done, stopped: `Not set out: ${outcome.error}.` };
    done.push(outcome);
  }
  return { done, stopped: undefined };
}

async function arisingOf(
  settings: ShowSettings,
  target: ShowTarget,
  ask: ShowProposal,
  said: string,
): Promise<ShowProposal | string> {
  const from = namedFrom(settings, target, said);
  if (await settings.canGrowFrom(target, from)) return { ...ask, from };
  const reading = await placeCalled(said, target.creature, target.places ?? noPlaceBook);
  if ("place" in reading) return { ...ask, from: null, place: reading.place };
  return `Not set out: from names a place, something of yours that is out or a thread of yours, and ${reading.unknown}.`;
}

function namedFrom(settings: ShowSettings, target: ShowTarget, from: string): string {
  const mine = settings
    .standingFor(target, "another")
    .out.filter(({ setting }) => setting.origin === "creature")
    .map(({ setting, where }) => ({ setting, outside: where === "outside" }));
  return paneCalled(from, mine) ?? from;
}

function outsideTogether(proposal: ShowProposal): ShowProposal {
  return { ...proposal, where: "outside" };
}

function arrangedTogether(
  settings: ShowSettings,
  target: ShowTarget,
  done: readonly SetOut[],
  shape: ArrangementShape,
): Arrangement | ShowRefusal {
  const panes = done.map(({ setting }) => setting.id);
  const lead = done.find(({ setting }) => setting.weight === "lead")?.setting.id;
  return settings.arrange(target, { panes, shape, lead, mood: done[0]?.setting.mood });
}

// A pane is named in the keeper's words, and kept under the one name the console knows it by.
function whatOf(thing: Thing, reading: Reading): SettingWhat {
  const what = settingWhatOf(thing);
  if (what.kind !== "pane") return what;
  const pane = reading.word("pane", paneWords, what.ref);
  return pane === undefined ? what : { ...what, ref: pane };
}

function proposalOf(
  target: ShowTarget,
  args: ShowArgs,
  thing: Thing,
  reading: Reading,
): ShowProposal {
  const lasting = untilOf(args.until);
  const markSaid = thing.mark ?? args.mark;
  const mark = markOf(markSaid);
  const toneSaid = thing.tone ?? toneSaidOf(thing.mark) ?? args.tone ?? toneSaidOf(args.mark);
  const markTone = reading.word("tone", toneWords, toneSaid);
  const signal = reading.word("signal", signalWords, signalAsked(thing, args));
  return {
    creature: target.creature,
    sessionId: target.sessionId,
    what: whatOf(thing, reading),
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
    ...(markTone !== undefined && { markTone }),
    ...(signal !== undefined && { signal }),
    ...(target.agent !== undefined && { agent: target.agent }),
    ...(target.home !== undefined && { place: target.home }),
  };
}

function signalAsked(thing: Thing, args: ShowArgs): string | undefined {
  const asked = thing.signal !== undefined ? thing.signal : args.signal;
  return asked === null ? noSignal : asked;
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
  signalSaid: string | undefined;
  timeAsked: boolean;
  placeNamed: boolean;
  caller: string | null;
}

function sentenceOf(
  { setting, replaced }: SetOut,
  outside: StandingOutside | undefined,
  { lasting, first, signalSaid, timeAsked, placeNamed, caller }: Said,
): string {
  const saidAlready = outside?.arrived.startsWith(replacedInPlace) === true;
  return [
    outside?.arrived ?? placedAs[setting.rung],
    ...(placeNamed ? [`It rises from ${placeSaid(setting.place, caller)}.`] : []),
    goesWhen(setting.until, lasting),
    ...(replaced === undefined || saidAlready
      ? []
      : ["It replaces what you set out for this before."]),
    ...markedWords([setting]),
    ...signalledWords(setting, replaced, { said: signalSaid, timeAsked }),
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
    return [`The keeper reads ${JSON.stringify(only.mark)}${toneOf(only)} on it.`];
  const each = marked.map(
    (setting) =>
      `${JSON.stringify(setting.what.title ?? setting.what.ref)} as ${JSON.stringify(setting.mark)}${toneOf(setting)}`,
  );
  return [`Marked: ${each.join("; ")}.`];
}

function toneOf({ markTone }: Setting): string {
  return markTone === undefined ? "" : `, in ${markTone}`;
}

interface SignalTold {
  said: string | undefined;
  timeAsked: boolean;
}

function signalledWords(
  { signal }: Setting,
  replaced: Setting | undefined,
  { said, timeAsked }: SignalTold,
): string[] {
  if (signal === undefined)
    return replaced?.signal === undefined
      ? []
      : ["Its signal is lowered: the keeper no longer sees it outlined."];
  const held = signal === "critical" && timeAsked ? [criticalOutlastsTime] : [];
  return [`${signalOutlines[signal]}${nearestSignal(signal, said)}`, ...held];
}

const signalOutlines: Readonly<Record<SettingSignal, string>> = {
  "needs-you":
    "The keeper sees it outlined in amber, as needing them, until they answer it or you lower it with arrange and signal null.",
  critical:
    "It is critical: the keeper sees it outlined in red with your reason, and it is the one critical you may hold; only you or the keeper lower it.",
};

const criticalOutlastsTime = "Critical holds it out until then, past the time you gave.";

function nearestSignal(signal: SignalSaid, said: string | undefined): string {
  return said === undefined || sameWords(said, signal)
    ? ""
    : ` It reads ${signal}, the nearest signal to ${quoted(said.trim().toLowerCase())}.`;
}

function sameWords(said: string, word: string): boolean {
  const plainly = (words: string) =>
    words
      .toLowerCase()
      .replace(/[^a-z]+/g, " ")
      .trim();
  return plainly(said) === plainly(word);
}

function severalSignalledWords(settings: readonly Setting[]): string[] {
  const signalled = settings.filter(({ signal }) => signal !== undefined);
  if (signalled.length === 0) return [];
  const each = signalled.map(({ what, signal }) => `${quotedNameOf(what)} as ${signal}`);
  return [`Signalled: ${each.join("; ")}.`];
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
  arranged: Arrangement | ShowRefusal | undefined;
}

async function severalWords(
  settings: ShowSettings,
  target: ShowTarget,
  { done, stopped, asked, arranged }: Several,
  args: ShowArgs,
): Promise<string> {
  const mine = done.map(({ setting }) => setting);
  const ids = new Set(mine.map(({ id }) => id));
  const outside = mine.filter(({ where }) => where === "outside").map(({ id }) => id);
  if (arranged !== undefined && !("refused" in arranged))
    await settings.reportNaming((heard) => heard.arrangement?.id === arranged.id);
  else if (outside.length > 0)
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
    ...laidOutWords(arranged),
    ...mannered,
    theyGoWhen(first?.until ?? "seen", lastingSaid(args.until)),
    ...(replaced === 0 ? [] : [`${replaced} of them replaced what you set out before.`]),
    ...markedWords(mine),
    ...severalSignalledWords(mine),
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

function laidOutWords(arranged: Arrangement | ShowRefusal | undefined): string[] {
  if (arranged === undefined) return [];
  if ("refused" in arranged) return [`They were not laid out together: ${arranged.error}.`];
  return [`Laid out together as ${arranged.shape ?? "the console chose"}.`];
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
