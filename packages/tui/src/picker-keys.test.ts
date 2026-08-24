import { describe, expect, it } from "vitest";
import { type Chord, parseChord } from "./keys.ts";
import { isPrintable, type PickerKeyTarget, rankByFuzzy, runPickerKey } from "./picker-keys.ts";

function recording(query = "ab"): PickerKeyTarget & { moves: number[]; retyped: string[] } {
  const target = {
    query,
    moves: [] as number[],
    retyped: [] as string[],
    move(step: 1 | -1) {
      target.moves.push(step);
    },
    retype(next: string) {
      target.retyped.push(next);
    },
  };
  return target;
}

describe("runPickerKey", () => {
  it.each([
    ["escape", undefined, "close", [], []],
    ["return", undefined, "choose", [], []],
    ["enter", undefined, "choose", [], []],
    ["down", undefined, "stay", [1], []],
    ["up", undefined, "stay", [-1], []],
    ["tab", undefined, "stay", [1], []],
    ["shift+tab", undefined, "stay", [-1], []],
    ["backspace", undefined, "stay", [], ["a"]],
    ["c", "c", "stay", [], ["abc"]],
    ["pagedown", undefined, "stay", [], []],
    ["ctrl+c", "", "stay", [], []],
  ] as const)("%s reads as %s", (spec, sequence, outcome, moves, retyped) => {
    const target = recording();
    expect(runPickerKey(parseChord(spec), sequence, target)).toBe(outcome);
    expect(target.moves).toEqual(moves);
    expect(target.retyped).toEqual(retyped);
  });

  it("types multi-character sequences as one piece", () => {
    const target = recording("");
    runPickerKey(parseChord("x"), "日本", target);
    expect(target.retyped).toEqual(["日本"]);
  });
});

describe("isPrintable", () => {
  const plain = (name: string): Chord => ({ name, ctrl: false, shift: false, meta: false });

  it("accepts visible text and refuses control characters and modified keys", () => {
    expect(isPrintable(plain("a"), "a")).toBe(true);
    expect(isPrintable(plain("a"), "ä")).toBe(true);
    expect(isPrintable(plain("a"), String.fromCharCode(1))).toBe(false);
    expect(isPrintable(plain("a"), String.fromCharCode(127))).toBe(false);
    expect(isPrintable(plain("a"), "")).toBe(false);
    expect(isPrintable(plain("a"), undefined)).toBe(false);
    expect(isPrintable({ ...plain("a"), ctrl: true }, "a")).toBe(false);
    expect(isPrintable({ ...plain("a"), meta: true }, "a")).toBe(false);
  });
});

describe("rankByFuzzy", () => {
  const names = ["refresh", "fork", "label", "rename"];

  it("keeps source order for an empty needle and returns a fresh array", () => {
    const ranked = rankByFuzzy(names, "", (name) => name);
    expect(ranked).toEqual(names);
    expect(ranked).not.toBe(names);
  });

  it("drops non-matches and puts the best score first", () => {
    expect(rankByFuzzy(names, "re", (name) => name)).toEqual(["rename", "refresh"]);
    expect(rankByFuzzy(names, "rena", (name) => name)).toEqual(["rename"]);
    expect(rankByFuzzy(names, "zz", (name) => name)).toEqual([]);
  });

  it("ranks through the key the caller chooses", () => {
    const items = [
      { id: 1, slug: "dock-v2" },
      { id: 2, slug: "infra" },
    ];
    expect(rankByFuzzy(items, "inf", (item) => item.slug).map((item) => item.id)).toEqual([2]);
  });
});
