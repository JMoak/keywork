import { describe, expect, it } from "vitest";
import { ownerOf, type SettingSeat, type ShowThread, sameOwner, sees } from "./lineage.ts";

const wren: SettingSeat = { creature: "wren", sessionId: "s1" };
const plain: SettingSeat = { creature: null, sessionId: "s1" };

describe("a setting's owner", () => {
  it("is its creature when it has one and its thread otherwise", () => {
    expect(ownerOf(wren)).toBe("creature wren");
    expect(ownerOf(plain)).toBe("thread s1");
    expect(sameOwner(wren, { creature: "wren", sessionId: "s2" })).toBe(true);
    expect(sameOwner(plain, { creature: null, sessionId: "s2" })).toBe(false);
    expect(sameOwner(plain, wren)).toBe(false);
  });
});

describe("a thread in a caller's sight", () => {
  const cases: ReadonlyArray<[string, SettingSeat, ShowThread, boolean]> = [
    ["a child the creature spawned", wren, { creature: null, parent: "s1" }, true],
    ["a child a plain thread spawned", plain, { creature: null, parent: "s1" }, true],
    ["another thread of the same creature", wren, { creature: "wren", parent: null }, true],
    ["a child of that other thread", wren, { creature: "wren", parent: "s7" }, true],
    ["another creature's thread", wren, { creature: "hal", parent: null }, false],
    ["a stranger's thread, seen by a creature", wren, { creature: null, parent: null }, false],
    ["a stranger's thread, seen by a plain thread", plain, { creature: null, parent: null }, false],
    [
      "a creature's thread, seen by a plain thread",
      plain,
      { creature: "wren", parent: null },
      false,
    ],
    ["a sibling under another parent", plain, { creature: null, parent: "s2" }, false],
  ];

  it.each(cases)("%s", (_name, caller, thread, seen) => {
    expect(sees(caller, thread)).toBe(seen);
  });
});
