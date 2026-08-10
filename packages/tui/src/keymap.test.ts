import { describe, expect, it } from "vitest";
import { Keymap } from "./keymap.ts";
import { chordOf, formatChord, parseChord } from "./keys.ts";

const keymap = () =>
  new Keymap({
    leader: "ctrl+k",
    timeoutMs: 2000,
    bindings: {
      "pane.split": "leader s",
      "pane.close": "leader x",
      "pane.zoom": "leader z",
      "app.quit": "ctrl+q",
      "app.never": "none",
    },
  });

describe("parseChord", () => {
  it("parses modifiers in any order", () => {
    expect(parseChord("ctrl+shift+p")).toEqual({ name: "p", ctrl: true, shift: true, meta: false });
    expect(parseChord("alt+enter")).toEqual({
      name: "enter",
      ctrl: false,
      shift: false,
      meta: true,
    });
  });

  it("rejects unknown modifiers", () => {
    expect(() => parseChord("hyper+x")).toThrow(/Unknown modifier/);
  });

  it("round-trips through formatChord", () => {
    expect(formatChord(parseChord("ctrl+alt+d"))).toBe("ctrl+alt+d");
  });
});

describe("Keymap", () => {
  it("resolves direct chords to actions", () => {
    expect(keymap().press(parseChord("ctrl+q"), 0)).toEqual({ type: "action", action: "app.quit" });
  });

  it("passes through unbound keys", () => {
    expect(keymap().press(parseChord("a"), 0)).toEqual({ type: "pass" });
  });

  it("resolves leader sequences", () => {
    const map = keymap();
    expect(map.press(parseChord("ctrl+k"), 0)).toEqual({ type: "leader-pending" });
    expect(map.press(parseChord("s"), 100)).toEqual({ type: "action", action: "pane.split" });
  });

  it("expires the leader after the timeout", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("s"), 2001)).toEqual({ type: "pass" });
  });

  it("cancels the leader with escape or an unbound key", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("escape"), 10)).toEqual({ type: "cancelled" });
    map.press(parseChord("ctrl+k"), 20);
    expect(map.press(parseChord("q"), 30)).toEqual({ type: "cancelled" });
  });

  it("ignores actions bound to none", () => {
    expect(keymap().actions()).not.toContain("app.never");
  });

  it("disarms on a second leader press instead of resolving leader+leader-key", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("ctrl+k"), 10)).toEqual({ type: "cancelled" });
    expect(map.press(parseChord("s"), 20)).toEqual({ type: "pass" });
  });

  it("cancels instead of resolving when an armed chord carries ctrl or alt", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("ctrl+x"), 10)).toEqual({ type: "cancelled" });
    map.press(parseChord("ctrl+k"), 20);
    expect(map.press(parseChord("alt+s"), 30)).toEqual({ type: "cancelled" });
    map.press(parseChord("ctrl+k"), 40);
    expect(map.press(parseChord("ctrl+s"), 50)).toEqual({ type: "cancelled" });
  });

  it("re-presses modified chords during a scoped chain instead of resolving letters", () => {
    const map = keymap();
    map.arm(0, new Set(["pane.close"]));
    expect(map.press(parseChord("ctrl+x"), 10)).toEqual({ type: "pass" });
    map.arm(20, new Set(["pane.close"]));
    expect(map.press(parseChord("ctrl+q"), 30)).toEqual({ type: "action", action: "app.quit" });
  });

  it("keeps the leader armed through key-repeat of the leader chord", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("ctrl+k"), 10, true)).toEqual({ type: "leader-pending" });
    expect(map.press(parseChord("ctrl+k"), 20, true)).toEqual({ type: "leader-pending" });
    expect(map.press(parseChord("s"), 30)).toEqual({ type: "action", action: "pane.split" });
  });

  it("arms on a repeated leader press even without the initial press", () => {
    const map = keymap();
    expect(map.press(parseChord("ctrl+k"), 0, true)).toEqual({ type: "leader-pending" });
  });

  it("limits a scoped arm to the allowed actions and re-presses the rest", () => {
    const map = keymap();
    map.arm(0, new Set(["pane.split"]));
    expect(map.press(parseChord("s"), 10)).toEqual({ type: "action", action: "pane.split" });

    map.arm(20, new Set(["pane.split"]));
    expect(map.press(parseChord("z"), 30)).toEqual({ type: "pass" });

    map.arm(40, new Set(["pane.split"]));
    expect(map.press(parseChord("ctrl+q"), 50)).toEqual({ type: "action", action: "app.quit" });
  });

  it("reports armed state and lets it lapse after the timeout", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    expect(map.armed(100)).toBe(true);
    expect(map.armed(2001)).toBe(false);
  });

  it("clears the scope on a fresh leader press", () => {
    const map = keymap();
    map.arm(0, new Set(["pane.split"]));
    map.press(parseChord("ctrl+k"), 10);
    map.press(parseChord("ctrl+k"), 20);
    expect(map.press(parseChord("z"), 30)).toEqual({ type: "action", action: "pane.zoom" });
  });

  it("describes bindings for palette display", () => {
    const map = keymap();
    expect(map.describe("pane.split")).toBe("ctrl+k s");
    expect(map.describe("app.quit")).toBe("ctrl+q");
    expect(map.describe("app.never")).toBeUndefined();
  });

  it("accepts multiple bindings per action", () => {
    const map = new Keymap({
      leader: "ctrl+k",
      bindings: { "focus.left": ["leader h", "leader left"] },
    });
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("h"), 1)).toEqual({ type: "action", action: "focus.left" });
    map.press(parseChord("ctrl+k"), 2);
    expect(map.press(parseChord("left"), 3)).toEqual({ type: "action", action: "focus.left" });
  });

  it("supports re-arming for sticky nav mode", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("s"), 10)).toEqual({ type: "action", action: "pane.split" });
    map.arm(10);
    expect(map.press(parseChord("x"), 20)).toEqual({ type: "action", action: "pane.close" });
    expect(map.press(parseChord("x"), 30)).toEqual({ type: "pass" });
  });

  it("distinguishes shifted leader keys from plain ones", () => {
    const map = new Keymap({
      leader: "ctrl+k",
      bindings: { "focus.left": "leader h", "swap.left": "leader shift+h" },
    });
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("shift+h"), 1)).toEqual({ type: "action", action: "swap.left" });
    map.press(parseChord("ctrl+k"), 2);
    expect(map.press(parseChord("h"), 3)).toEqual({ type: "action", action: "focus.left" });
  });
});

describe("chordOf", () => {
  it("normalizes a KeyEvent-shaped object", () => {
    expect(chordOf({ name: "S", ctrl: true })).toEqual({
      name: "s",
      ctrl: true,
      shift: false,
      meta: false,
    });
  });

  it("returns undefined for nameless events", () => {
    expect(chordOf({})).toBeUndefined();
  });

  it("ignores key releases so leader state survives letting go of ctrl", () => {
    expect(chordOf({ name: "k", ctrl: true, eventType: "release" })).toBeUndefined();
  });

  it("ignores bare modifier presses", () => {
    expect(chordOf({ name: "ctrl", ctrl: true })).toBeUndefined();
    expect(chordOf({ name: "shift", shift: true })).toBeUndefined();
  });

  it("treats the kitty option modifier as alt", () => {
    expect(chordOf({ name: "x", option: true })).toEqual({
      name: "x",
      ctrl: false,
      shift: false,
      meta: true,
    });
  });
});
