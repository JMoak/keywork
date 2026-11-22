import { z } from "zod";
import { listed, quoted, vocabularyOf } from "./words.ts";

export interface Seat {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const latticeSpan = 12;

export const namedSeats = {
  full: seatAt(0, 0, 12, 12),
  "left-half": seatAt(0, 0, 6, 12),
  "right-half": seatAt(6, 0, 6, 12),
  "top-half": seatAt(0, 0, 12, 6),
  "bottom-half": seatAt(0, 6, 12, 6),
  "left-third": seatAt(0, 0, 4, 12),
  "middle-third": seatAt(4, 0, 4, 12),
  "right-third": seatAt(8, 0, 4, 12),
  "left-two-thirds": seatAt(0, 0, 8, 12),
  "right-two-thirds": seatAt(4, 0, 8, 12),
  "top-left": seatAt(0, 0, 6, 6),
  "top-right": seatAt(6, 0, 6, 6),
  "bottom-left": seatAt(0, 6, 6, 6),
  "bottom-right": seatAt(6, 6, 6, 6),
  center: seatAt(3, 3, 6, 6),
  "top-third": seatAt(0, 0, 12, 4),
  "bottom-third": seatAt(0, 8, 12, 4),
  "left-quarter": seatAt(0, 0, 3, 12),
  "right-quarter": seatAt(9, 0, 3, 12),
  "left-three-quarters": seatAt(0, 0, 9, 12),
  "right-three-quarters": seatAt(3, 0, 9, 12),
  "middle-half": seatAt(3, 0, 6, 12),
} as const satisfies Record<string, Seat>;

export type SeatName = keyof typeof namedSeats;

export const seatNames = Object.keys(namedSeats) as SeatName[];

export const seatVocabulary = vocabularyOf(seatNames, {
  aliases: {
    left: "left-half",
    right: "right-half",
    top: "top-half",
    bottom: "bottom-half",
    middle: "center",
    "top left quarter": "top-left",
    "top right quarter": "top-right",
    "bottom left quarter": "bottom-left",
    "bottom right quarter": "bottom-right",
    "middle column": "middle-half",
  },
  synonyms: {
    upper: "top",
    lower: "bottom",
    center: "middle",
    centre: "middle",
    central: "middle",
    whole: "full",
    entire: "full",
    everything: "full",
    fullscreen: "full",
    maximized: "full",
    maximised: "full",
    thirds: "third",
    quarters: "quarter",
    "2/3": "two third",
    "1/3": "third",
    "1/2": "half",
    "1/4": "quarter",
    "3/4": "three quarter",
    "2": "two",
    "3": "three",
  },
  filler: ["the", "a", "of", "on", "in", "at", "side", "hand", "corner", "screen", "stage", "one"],
});

export const seatSpanInput = z
  .object({ x: edge(), y: edge(), w: extent(), h: extent() })
  .strict()
  .refine((span) => seatProblemOf(span) === undefined);

export const seatInput = z.unknown().meta({
  anyOf: [
    { type: "string", examples: ["left-half", "top-right", "columns 4 to 8, rows 0 to 6"] },
    {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0, maximum: latticeSpan - 1 },
        y: { type: "integer", minimum: 0, maximum: latticeSpan - 1 },
        w: { type: "integer", minimum: 1, maximum: latticeSpan },
        h: { type: "integer", minimum: 1, maximum: latticeSpan },
      },
      required: ["x", "y", "w", "h"],
      additionalProperties: false,
    },
  ],
});

export const seatWrittenInput = z
  .unknown()
  .meta({ anyOf: [{ type: "string" }, { type: "object" }] });

const seatGrammar = `a named seat (${listed(seatNames, "or")}), lattice lines such as "columns 4 to 8, rows 0 to 6" (0 is the left and top edge, 12 the right and bottom), or {x, y, w, h} in twelfths`;

export type SeatRead = { seat: Seat } | { problem: string };

export function seatRead(asked: unknown): SeatRead {
  if (typeof asked === "string") return seatSaid(asked);
  if (isRecord(asked)) return seatSpanned(asked);
  return { problem: `a seat is ${seatGrammar}` };
}

export function seatProblemOf({ x, y, w, h }: Seat): string | undefined {
  if (![x, y, w, h].every(Number.isInteger))
    return "x, y, w and h are whole twelfths of the stage (half is 6, a third is 4, a quarter is 3)";
  if (x < 0 || y < 0) return "x and y start at 0, the left and top edge";
  if (w < 1 || h < 1) return "a seat is at least 1 column wide and 1 row tall";
  if (x + w > latticeSpan)
    return `x ${x} + w ${w} is ${x + w}, past the stage's ${latticeSpan} columns`;
  if (y + h > latticeSpan)
    return `y ${y} + h ${h} is ${y + h}, past the stage's ${latticeSpan} rows`;
  return undefined;
}

export function sameSeat(one: Seat | undefined, other: Seat | undefined): boolean {
  if (one === undefined || other === undefined) return one === other;
  return one.x === other.x && one.y === other.y && one.w === other.w && one.h === other.h;
}

export function seatNameOf(seat: Seat): SeatName | undefined {
  return seatNames.find((name) => sameSeat(namedSeats[name], seat));
}

export function seatWords(seat: Seat): string {
  const name = seatNameOf(seat);
  if (name === "full") return "the whole stage";
  return name === undefined ? latticeLinesOf(seat) : `the ${name.replaceAll("-", " ")}`;
}

export function seatAsWritten(seat: Seat): string {
  return seatNameOf(seat) ?? latticeLinesOf(seat);
}

function seatAt(x: number, y: number, w: number, h: number): Seat {
  return { x, y, w, h };
}

function edge() {
  return z
    .int()
    .min(0)
    .max(latticeSpan - 1);
}

function extent() {
  return z.int().min(1).max(latticeSpan);
}

function seatSaid(said: string): SeatRead {
  const written = writtenSpanOf(said);
  if (written !== undefined) return seatSpanned(written);
  const name = seatVocabulary.understood(said);
  if (name !== undefined) return { seat: namedSeats[name] };
  const span = spanOnLines(said);
  if (span !== undefined) return fitted(span);
  if (/\b(beside|inside|cards?|rail)\b/i.test(said))
    return {
      problem: `${quoted(said)} is not a seat on the stage; to step a window back beside the conversation, arrange the windows that should stay and add rest: "beside"`,
    };
  return {
    problem: `no seat is called ${quoted(said)}; the nearest are ${listed(seatVocabulary.nearestTo(said), "and")}, or give lattice lines such as "columns 4 to 8, rows 0 to 6"`,
  };
}

function writtenSpanOf(said: string): Record<string, unknown> | undefined {
  if (!said.trim().startsWith("{")) return undefined;
  try {
    const written: unknown = JSON.parse(said);
    return isRecord(written) ? written : undefined;
  } catch {
    return undefined;
  }
}

function latticeLinesOf({ x, y, w, h }: Seat): string {
  return `columns ${x} to ${x + w}, rows ${y} to ${y + h}`;
}

function spanOnLines(said: string): Seat | undefined {
  const columns = linesNamed("col(?:umn)?s?", said);
  const rows = linesNamed("rows?", said);
  if (columns === undefined && rows === undefined) return undefined;
  const [x, right] = columns ?? [0, latticeSpan];
  const [y, bottom] = rows ?? [0, latticeSpan];
  return { x, y, w: right - x, h: bottom - y };
}

function linesNamed(axis: string, said: string): [number, number] | undefined {
  const found = new RegExp(`\\b${axis}\\s*(\\d+)\\s*(?:to|through|-)\\s*(\\d+)`, "i").exec(said);
  return found === null ? undefined : [Number(found[1]), Number(found[2])];
}

function seatSpanned(written: Record<string, unknown>): SeatRead {
  const span = new Map<SpanKey, number>();
  for (const [key, value] of Object.entries(written)) {
    const named = spanKeys.get(key.toLowerCase());
    if (named === undefined)
      return {
        problem: `a seat is {x, y, w, h} in twelfths, and ${key.slice(0, longestKey)} is none of them`,
      };
    span.set(named, twelfthsOf(value));
  }
  const missing = (["x", "y", "w", "h"] as const).filter((key) => !span.has(key));
  if (missing.length > 0)
    return {
      problem: `a seat is {x, y, w, h} in twelfths, and it has no ${listed(missing, "or")}`,
    };
  return fitted(
    seatAt(span.get("x") ?? 0, span.get("y") ?? 0, span.get("w") ?? 0, span.get("h") ?? 0),
  );
}

function twelfthsOf(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
}

type SpanKey = "x" | "y" | "w" | "h";

const longestKey = 40;

const spanKeys: ReadonlyMap<string, SpanKey> = new Map([
  ["x", "x"],
  ["left", "x"],
  ["col", "x"],
  ["column", "x"],
  ["y", "y"],
  ["top", "y"],
  ["row", "y"],
  ["w", "w"],
  ["width", "w"],
  ["cols", "w"],
  ["columns", "w"],
  ["h", "h"],
  ["height", "h"],
  ["rows", "h"],
]);

function fitted(span: Seat): SeatRead {
  const problem = seatProblemOf(span);
  if (problem === undefined) return { seat: span };
  return { problem: `${problem}; the nearest seat that fits is ${seatWords(nearestFitTo(span))}` };
}

function nearestFitTo({ x, y, w, h }: Seat): Seat {
  const left = within(x, 0, latticeSpan - 1);
  const top = within(y, 0, latticeSpan - 1);
  return seatAt(left, top, within(w, 1, latticeSpan - left), within(h, 1, latticeSpan - top));
}

function within(value: number, least: number, most: number): number {
  const whole = Number.isFinite(value) ? Math.round(value) : least;
  return Math.min(most, Math.max(least, whole));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
