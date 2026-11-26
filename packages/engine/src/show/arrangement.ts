import { calledOf } from "./naming.ts";
import { refused, type ShowRefusal } from "./refusal.ts";
import { type Seat, seatProblemOf } from "./seat.ts";
import type { Mood, Setting } from "./setting.ts";
import { listed, quoted } from "./words.ts";

export const arrangementShapes = [
  "grid",
  "columns",
  "rows",
  "lead-and-cards",
  "lead-and-stack",
  "split",
  "board",
] as const;

export type ArrangementShape = (typeof arrangementShapes)[number];

export const arrangementRelations = ["sequence", "alternatives", "tasks", "notes"] as const;

export type ArrangementRelation = (typeof arrangementRelations)[number];

export const arrangementReaches = ["room", "display"] as const;

export type ArrangementReach = (typeof arrangementReaches)[number];

export const arrangementRests = ["stay", "beside"] as const;

export type ArrangementRest = (typeof arrangementRests)[number];

export const arrangementSides = ["left", "right", "top", "bottom"] as const;

export type ArrangementSide = (typeof arrangementSides)[number];

export interface SeatedPane {
  readonly id: string;
  readonly seat: Seat;
}

export interface Arrangement {
  readonly id: string;
  readonly creature: string | null;
  readonly sessionId: string;
  readonly at: string;
  readonly panes: readonly string[];
  readonly shape?: ArrangementShape;
  readonly relation?: ArrangementRelation;
  readonly seats?: readonly SeatedPane[];
  readonly lead?: string;
  readonly side?: ArrangementSide;
  readonly over?: ArrangementReach;
  readonly rest?: ArrangementRest;
  readonly mood?: Mood;
}

export interface ShowArranged {
  arrangement: Arrangement;
}

export type ArrangementBody = Omit<Arrangement, "id" | "creature" | "sessionId" | "at">;

export interface ArrangementAsk {
  panes?: readonly string[] | undefined;
  shape?: ArrangementShape | undefined;
  relation?: ArrangementRelation | undefined;
  seats?: readonly SeatedPane[] | undefined;
  lead?: string | undefined;
  side?: ArrangementSide | undefined;
  over?: ArrangementReach | undefined;
  mood?: Mood | undefined;
  back?: boolean | undefined;
  rest?: ArrangementRest | undefined;
}

export interface OwnPane {
  readonly setting: Setting;
  readonly outside: boolean;
}

export const outsideAtOnce = 12;

export const arrangementsPerMinute = 12;

export const placementWaitMs = 1_500;

export const arrangementsRemembered = 16;

export function earlierBodyOf(
  ask: ArrangementAsk,
  history: readonly (readonly SeatedPane[])[],
  own: readonly OwnPane[],
): ArrangementBody | ShowRefusal {
  const { panes, shape, relation, seats, lead, side, over, rest, mood } = ask;
  const alsoAsked = [panes, shape, relation, seats, lead, side, over, rest].some(
    (asked) => asked !== undefined,
  );
  if (alsoAsked)
    return refused(
      "invalid",
      "back goes alone or with a mood: it puts your windows back in the seats they had before your last arrangement, so leave out panes, shape, relation, seats, lead, side, over and rest",
    );
  const before = history.at(-1);
  if (before === undefined)
    return refused(
      "missing",
      "there is nothing to go back to: you have made no arrangement in this conversation since your windows last stood outside",
    );
  const still = before.filter(({ id }) => own.some(({ setting }) => setting.id === id));
  if (still.length === 0)
    return refused(
      "missing",
      "there is nothing to go back to: none of the windows that stood outside before your last arrangement is still out",
    );
  return arrangementBodyOf({ seats: still, mood }, own);
}

export function arrangementBodyOf(
  ask: ArrangementAsk,
  own: readonly OwnPane[],
): ArrangementBody | ShowRefusal {
  const named = namedIn(ask, own);
  if ("refused" in named) return named;
  const { panes, seats, lead } = named;
  const refusal =
    instructionRefusal(ask) ??
    seatsRefusal(seats) ??
    membershipRefusal(panes, seats, lead) ??
    roomRefusal(panes, own);
  if (refusal !== undefined) return refusal;
  const { shape, relation, side, over, mood, rest } = ask;
  return {
    panes,
    ...(rest === "beside" && { rest }),
    ...(shape !== undefined && { shape }),
    ...(relation !== undefined && { relation }),
    ...(seats.length > 0 && { seats }),
    ...(lead !== undefined && { lead }),
    ...(side !== undefined && { side }),
    ...(over !== undefined && { over }),
    ...(mood !== undefined && { mood }),
  };
}

interface Named {
  panes: readonly string[];
  seats: readonly SeatedPane[];
  lead: string | undefined;
}

function namedIn(ask: ArrangementAsk, own: readonly OwnPane[]): Named | ShowRefusal {
  const seats: SeatedPane[] = [];
  for (const { id, seat } of ask.seats ?? []) {
    const pane = paneCalled(id, own);
    if (pane === undefined) return refused("missing", notYoursWords(id, own));
    seats.push({ id: pane, seat });
  }
  const lead = ask.lead === undefined ? undefined : paneCalled(ask.lead, own);
  if (ask.lead !== undefined && lead === undefined)
    return refused("missing", notYoursWords(ask.lead, own));
  const placed = [...seats.map(({ id }) => id), ...(lead === undefined ? [] : [lead])];
  const panes = panesIn(ask, own, placed);
  return "refused" in panes ? panes : { panes, seats, lead };
}

function panesIn(
  ask: ArrangementAsk,
  own: readonly OwnPane[],
  placed: readonly string[],
): readonly string[] | ShowRefusal {
  if (ask.panes === undefined && ask.rest === "beside" && placed.length > 0)
    return [...new Set(placed)];
  if (ask.panes === undefined) return everythingOutsideAnd(placed, own);
  if (meansEverything(ask.panes, own)) return everythingOut(own);
  const panes: string[] = [];
  for (const said of ask.panes) {
    const pane = paneCalled(said, own);
    if (pane === undefined) return refused("missing", notYoursWords(said, own));
    panes.push(pane);
  }
  return [...new Set(panes)];
}

function everythingOutsideAnd(
  placed: readonly string[],
  own: readonly OwnPane[],
): readonly string[] | ShowRefusal {
  const outside = own.filter((pane) => pane.outside).map(({ setting }) => setting.id);
  const panes = [...new Set([...outside, ...placed])];
  return panes.length > 0 ? panes : refused("missing", nothingOutsideWords(own));
}

const everythingWords: ReadonlySet<string> = new Set([
  "all",
  "all of them",
  "all panes",
  "everything",
  "every pane",
  "*",
]);

export function meansEverything(said: readonly string[], own: readonly OwnPane[]): boolean {
  const [only] = said;
  if (said.length !== 1 || only === undefined) return false;
  return paneCalled(only, own) === undefined && everythingWords.has(only.trim().toLowerCase());
}

function everythingOut(own: readonly OwnPane[]): readonly string[] | ShowRefusal {
  const panes = own.map(({ setting }) => setting.id);
  return panes.length > 0 ? panes : refused("missing", nothingOutsideWords(own));
}

export function paneCalled(said: string, own: readonly OwnPane[]): string | undefined {
  if (own.some(({ setting }) => setting.id === said)) return said;
  const wanted = said.trim().toLowerCase();
  const called = own.filter(({ setting: { what } }) =>
    [what.ref, what.title].some((name) => name?.toLowerCase() === wanted),
  );
  if (called.length === 1) return called[0]?.setting.id;
  return called.length === 0 ? replacementOf(said, own) : undefined;
}

function replacementOf(earlier: string, own: readonly OwnPane[]): string | undefined {
  return own.find(({ setting }) => setting.replaces === earlier)?.setting.id;
}

function notYoursWords(said: string, own: readonly OwnPane[]): string {
  return (
    sharedNameWords(said, own) ??
    `nothing you set out is out as ${quoted(said)}; ${whatIsOutWords(own)}`
  );
}

export function sharedNameWords(said: string, own: readonly OwnPane[]): string | undefined {
  const wanted = said.trim().toLowerCase();
  const called = own.filter(({ setting: { what } }) =>
    [what.ref, what.title].some((name) => name?.toLowerCase() === wanted),
  );
  if (called.length < 2) return undefined;
  const ids = called.map(({ setting }) => setting.id);
  return `${called.length} of your settings are called ${quoted(said)}, so name the one you mean by its id: ${listed(ids, "or")}`;
}

function nothingOutsideWords(own: readonly OwnPane[]): string {
  return `nothing of yours is outside to arrange; show something with where outside, or say panes "all" to move what you have out beside the conversation outside: ${whatIsOutWords(own)}`;
}

function whatIsOutWords(own: readonly OwnPane[]): string {
  if (own.length === 0) return "you have nothing out, so show something first";
  const named = own.slice(-panesNamed).map(({ setting }) => calledOf(setting));
  const more = own.length > named.length ? `, and ${own.length - named.length} older` : "";
  return `what you have out is ${listed(named, "and")}${more}`;
}

const panesNamed = 6;

function instructionRefusal(ask: ArrangementAsk): ShowRefusal | undefined {
  const { shape, relation, seats, rest, side } = ask;
  const given = [shape, relation, seats].filter((instruction) => instruction !== undefined);
  if (side !== undefined && seats !== undefined)
    return refused(
      "invalid",
      "side says where the lead stands when the console lays the panes out, and seats already place each pane; give one of them",
    );
  if (rest === "stay" && seats === undefined && given.length === 1)
    return refused(
      "invalid",
      "a shape or a relation re-lays the stage for the panes it names, so your other windows step back beside the conversation; rest stay goes with seats",
    );
  if (given.length <= 1) return undefined;
  return refused(
    "invalid",
    "shape, relation and seats are three ways to ask for one arrangement; give one of them, or none and the console chooses",
  );
}

function seatsRefusal(seats: readonly SeatedPane[]): ShowRefusal | undefined {
  const ids = seats.map(({ id }) => id);
  const twice = ids.find((id, at) => ids.indexOf(id) !== at);
  if (twice !== undefined)
    return refused("invalid", `seats places ${twice} twice; give it one seat`);
  for (const { id, seat } of seats) {
    const problem = seatProblemOf(seat);
    if (problem !== undefined)
      return refused("invalid", `the seat for ${id} does not fit: ${problem}`);
  }
  return undefined;
}

function membershipRefusal(
  panes: readonly string[],
  seats: readonly SeatedPane[],
  lead: string | undefined,
): ShowRefusal | undefined {
  const unlisted = seats.find(({ id }) => !panes.includes(id));
  if (unlisted !== undefined)
    return refused(
      "invalid",
      `seats places ${unlisted.id}, which is not among panes; add it to panes, or leave panes out`,
    );
  if (lead !== undefined && !panes.includes(lead))
    return refused(
      "invalid",
      `lead names ${lead}, which is not among the panes being arranged; add it to panes, or leave panes out`,
    );
  return undefined;
}

function roomRefusal(panes: readonly string[], own: readonly OwnPane[]): ShowRefusal | undefined {
  const alreadyOutside = own.filter((pane) => pane.outside).map(({ setting }) => setting.id);
  const outside = new Set([...alreadyOutside, ...panes]).size;
  if (outside <= outsideAtOnce) return undefined;
  return refused(
    "limited",
    `that would put ${outside} of your settings outside, and ${outsideAtOnce} is the most that may stand outside at once; name fewer panes, or withdraw what has gone stale first`,
  );
}
