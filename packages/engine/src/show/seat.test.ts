import { describe, expect, it } from "vitest";
import {
  namedSeats,
  type Seat,
  seatAsWritten,
  seatProblemOf,
  seatRead,
  seatSpanInput,
  seatWords,
} from "./seat.ts";

function seatOf(asked: unknown): Seat {
  const read = seatRead(asked);
  if ("problem" in read) throw new Error(read.problem);
  return read.seat;
}

function problemOf(asked: unknown): string {
  const read = seatRead(asked);
  if ("seat" in read) throw new Error(`read as ${JSON.stringify(read.seat)}`);
  return read.problem;
}

describe("a named seat", () => {
  it("is understood in the words a model reaches for", () => {
    const said: ReadonlyArray<[string, keyof typeof namedSeats]> = [
      ["left-half", "left-half"],
      ["Left Half", "left-half"],
      ["left_half", "left-half"],
      ["leftHalf", "left-half"],
      ["the left half", "left-half"],
      ["left", "left-half"],
      ["right side", "right-half"],
      ["upper right", "top-right"],
      ["right top", "top-right"],
      ["lower-left corner", "bottom-left"],
      ["top", "top-half"],
      ["lower half", "bottom-half"],
      ["centre", "center"],
      ["center third", "middle-third"],
      ["middle", "center"],
      ["left two thirds", "left-two-thirds"],
      ["left 2/3", "left-two-thirds"],
      ["right two-thirds", "right-two-thirds"],
      ["full screen", "full"],
      ["the whole stage", "full"],
    ];
    for (const [words, name] of said) expect(seatOf(words), words).toEqual(namedSeats[name]);
  });

  it("answers a name it cannot place with the nearest names and the other way to say a seat", () => {
    expect(problemOf("the attic")).toBe(
      'no seat is called "the attic"; the nearest are full, center and left-third, or give lattice lines such as "columns 4 to 8, rows 0 to 6"',
    );
  });
});

describe("a seat given as a span", () => {
  it("reads lattice lines, where 0 is the left and top edge and 12 the right and bottom", () => {
    expect(seatOf("columns 4 to 8, rows 0 to 6")).toEqual({ x: 4, y: 0, w: 4, h: 6 });
    expect(seatOf("cols 0-6")).toEqual(namedSeats["left-half"]);
    expect(seatOf("rows 6 to 12")).toEqual(namedSeats["bottom-half"]);
  });

  it("reads x, y, w and h, by those names or the ones a rectangle usually has", () => {
    expect(seatOf({ x: 8, y: 0, w: 4, h: 6 })).toEqual({ x: 8, y: 0, w: 4, h: 6 });
    expect(seatOf({ left: 0, top: 6, width: 12, height: 6 })).toEqual(namedSeats["bottom-half"]);
    expect(seatOf('{"x":0,"y":0,"w":6,"h":6}')).toEqual(namedSeats["top-left"]);
  });

  it("holds every edge inside the lattice, in whole twelfths", () => {
    const fits: Seat[] = [
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 11, y: 11, w: 1, h: 1 },
      { x: 0, y: 0, w: 12, h: 12 },
      { x: 5, y: 7, w: 7, h: 5 },
    ];
    const unfit: Seat[] = [
      { x: -1, y: 0, w: 6, h: 6 },
      { x: 0, y: -1, w: 6, h: 6 },
      { x: 12, y: 0, w: 1, h: 1 },
      { x: 0, y: 12, w: 1, h: 1 },
      { x: 0, y: 0, w: 0, h: 6 },
      { x: 0, y: 0, w: 6, h: 0 },
      { x: 7, y: 0, w: 6, h: 6 },
      { x: 0, y: 7, w: 6, h: 6 },
      { x: 0, y: 0, w: 13, h: 6 },
      { x: 0.5, y: 0, w: 6, h: 6 },
      { x: 0, y: 0, w: 6, h: Number.NaN },
    ];
    for (const seat of fits) {
      expect(seatProblemOf(seat), JSON.stringify(seat)).toBeUndefined();
      expect(seatSpanInput.safeParse(seat).success, JSON.stringify(seat)).toBe(true);
    }
    for (const seat of unfit) {
      expect(seatProblemOf(seat), JSON.stringify(seat)).toEqual(expect.any(String));
      expect(seatSpanInput.safeParse(seat).success, JSON.stringify(seat)).toBe(false);
    }
  });

  it("answers one that does not fit with the limit and the nearest seat that would", () => {
    expect(problemOf({ x: 8, y: 0, w: 6, h: 12 })).toBe(
      "x 8 + w 6 is 14, past the stage's 12 columns; the nearest seat that fits is the right third",
    );
    expect(problemOf("columns 0 to 6, rows 6 to 14")).toBe(
      "y 6 + h 8 is 14, past the stage's 12 rows; the nearest seat that fits is the bottom left",
    );
    expect(problemOf({ x: 0.5, y: 0, w: 6, h: 12 })).toContain("whole twelfths");
    expect(problemOf({ x: 0, y: 0, w: 6 })).toBe(
      "a seat is {x, y, w, h} in twelfths, and it has no h",
    );
    expect(problemOf({ x: 0, y: 0, w: 6, h: 6, depth: 2 })).toBe(
      "a seat is {x, y, w, h} in twelfths, and depth is none of them",
    );
    expect(problemOf(7)).toContain("a seat is a named seat");
  });
});

describe("a seat in words", () => {
  it("is its name when it has one and its lattice lines when it has none, both of which read back", () => {
    const seats: Seat[] = [...Object.values(namedSeats), { x: 4, y: 0, w: 4, h: 6 }];
    for (const seat of seats) {
      expect(seatOf(seatWords(seat)), seatWords(seat)).toEqual(seat);
      expect(seatOf(seatAsWritten(seat)), seatAsWritten(seat)).toEqual(seat);
    }
    expect(seatWords(namedSeats["left-two-thirds"])).toBe("the left two thirds");
    expect(seatWords(namedSeats.full)).toBe("the whole stage");
    expect(seatWords({ x: 4, y: 0, w: 4, h: 6 })).toBe("columns 4 to 8, rows 0 to 6");
    expect(seatAsWritten(namedSeats["top-right"])).toBe("top-right");
  });
});
