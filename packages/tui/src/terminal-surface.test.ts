import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { keyEventOf } from "./terminal-surface.ts";

describe("keyEventOf", () => {
  it("carries the chord's name and modifiers with the host sequence as text", () => {
    const event = keyEventOf(parseChord("ctrl+c"), "\x03");
    expect(event).toMatchObject({
      name: "c",
      ctrl: true,
      shift: false,
      meta: false,
      option: false,
      sequence: "\x03",
      raw: "\x03",
      eventType: "press",
      source: "raw",
    });
  });

  it("keeps a shifted letter's typed text so the emulator sees the uppercase glyph", () => {
    expect(keyEventOf(parseChord("shift+a"), "A")).toMatchObject({
      name: "a",
      shift: true,
      sequence: "A",
    });
  });

  it("gives a sequence-less key an empty sequence rather than undefined", () => {
    expect(keyEventOf(parseChord("escape"), undefined)).toMatchObject({
      name: "escape",
      sequence: "",
    });
  });
});
