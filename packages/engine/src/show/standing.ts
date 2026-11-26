import { calledOf, quotedNameOf } from "./naming.ts";
import type { Placement, PlacementMover, PlacementPlace, Stage, Standing } from "./placements.ts";
import { type Seat, seatWords } from "./seat.ts";
import type { Setting } from "./setting.ts";
import { listed } from "./words.ts";

export interface Stood {
  setting: Setting;
  where: PlacementPlace;
  seat?: Seat;
  by?: PlacementMover;
  note?: string;
}

export interface StandingPicture {
  out: readonly Stood[];
  stage: Stage | undefined;
}

export function stoodOf(setting: Setting, placement: Placement | undefined): Stood {
  const { where, seat } = placement ?? askedOf(setting);
  return {
    setting,
    where,
    ...(where === "outside" && seat !== undefined && { seat }),
    ...(placement !== undefined && { by: placement.by }),
    ...(placement?.note !== undefined && { note: placement.note }),
  };
}

export function askedOf({ where = "beside", seat }: Setting): Standing {
  return seat === undefined ? { where } : { where, seat };
}

export function standingWords(out: readonly Stood[], heading: string): string | undefined {
  const outside = out.filter(({ where }) => where === "outside");
  const inside = out.filter(({ where }) => where === "inside");
  const setBack = out.filter(({ where, by }) => where === "beside" && by === "keeper");
  const putBack = out.filter(
    ({ where, by, note }) => where === "beside" && by !== "keeper" && note !== undefined,
  );
  const sentences = [
    ...(outside.length === 0 ? [] : [`${heading}: ${outside.map(seatedWords).join("; ")}.`]),
    ...heldByTheKeeper("Inside the console, where the keeper brought", inside),
    ...heldByTheKeeper("Beside the conversation, where the keeper set", setBack),
    ...putBackWords(putBack),
  ];
  return sentences.length === 0 ? undefined : sentences.join(" ");
}

export function overlapWords(out: readonly Stood[]): string | undefined {
  const outside = out.filter(({ where, seat }) => where === "outside" && seat !== undefined);
  const pairs = outside.flatMap((one, at) =>
    outside
      .slice(at + 1)
      .filter((other) => overlapping(one, other))
      .map((other) => `${quotedNameOf(one.setting.what)} with ${quotedNameOf(other.setting.what)}`),
  );
  if (pairs.length === 0) return undefined;
  const named = pairs.slice(0, mostOverlapsNamed).join("; ");
  const more =
    pairs.length > mostOverlapsNamed ? `; and ${pairs.length - mostOverlapsNamed} more` : "";
  return `Overlapping now: ${named}${more}.`;
}

const mostOverlapsNamed = 4;

const roundedOverlap = 2;

function overlapping(one: Stood, other: Stood): boolean {
  if (one.seat === undefined || other.seat === undefined) return false;
  if (one.by === undefined || other.by === undefined) return false;
  const wide = sharedSpan(one.seat.x, one.seat.w, other.seat.x, other.seat.w);
  const tall = sharedSpan(one.seat.y, one.seat.h, other.seat.y, other.seat.h);
  const exact = one.by !== "console" && other.by !== "console";
  const least = exact ? 1 : roundedOverlap;
  return wide >= least && tall >= least;
}

function sharedSpan(
  start: number,
  length: number,
  otherStart: number,
  otherLength: number,
): number {
  return Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart);
}

export function stageWords({ room, cardsAcross, cardsDown, consoleMaximised }: Stage): string {
  const fits = `the smallest seats fit ${cardsAcross} across and ${cardsDown} down`;
  const maximised = consoleMaximised ? "is maximised" : "is not maximised";
  return `The stage, where your windows outside stand, is ${roomWords[room]}: ${fits}, and the console ${maximised}.`;
}

const roomWords: Readonly<Record<Stage["room"], string>> = {
  beside: "the free room beside the console",
  over: "over the far side of the console",
  display: "the whole display",
};

function seatedWords({ setting, seat, by }: Stood): string {
  return `${calledOf(setting)} ${by === undefined ? askedWords(seat) : reportedWords(seat, by)}`;
}

function askedWords(seat: Seat | undefined): string {
  return seat === undefined
    ? "not yet reported by the console"
    : `asked for ${seatWords(seat)}, not yet reported by the console`;
}

function reportedWords(seat: Seat | undefined, by: PlacementMover): string {
  const place = seat === undefined ? "with no seat reported" : `in ${seatWords(seat)}`;
  return by === "keeper" ? `${place}, placed by the keeper` : place;
}

function putBackWords(held: readonly Stood[]): string[] {
  if (held.length === 0) return [];
  const called = listed(
    held.map(({ setting }) => calledOf(setting)),
    "and",
  );
  const [first] = held;
  const reason = first?.note === undefined ? "" : ` (${first.note})`;
  const again = held.length === 1 ? "it" : "them";
  return [
    `Back beside the conversation${reason}: ${called}. Name ${again} in arrange to set ${again} out again.`,
  ];
}

function heldByTheKeeper(place: string, held: readonly Stood[]): string[] {
  if (held.length === 0) return [];
  const called = listed(
    held.map(({ setting }) => calledOf(setting)),
    "and",
  );
  return [`${place} ${held.length === 1 ? "it" : "them"}: ${called}.`];
}
