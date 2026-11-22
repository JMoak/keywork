import { describe, expect, it } from "vitest";
import { Keymap, KeymapError } from "./keymap.ts";
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

describe("Keymap.rebind", () => {
  it("swaps the whole table in one step", () => {
    const map = keymap();
    map.rebind({ leader: "ctrl+k", timeoutMs: 500, bindings: { "pane.split": "ctrl+t" } });
    expect(map.press(parseChord("ctrl+t"), 0)).toEqual({
      type: "action",
      action: "pane.split",
      via: "chord",
    });
    expect(map.press(parseChord("ctrl+q"), 0)).toEqual({ type: "pass" });
    expect(map.timeoutMs).toBe(500);
    expect(map.describe("pane.split")).toBe("ctrl+t");
  });

  it("keeps the old table when the new one fails to compile", () => {
    const map = keymap();
    expect(() =>
      map.rebind({ bindings: { "pane.split": "ctrl+q", "app.quit": "ctrl+q" } }),
    ).toThrow(KeymapError);
    expect(map.press(parseChord("ctrl+q"), 0)).toEqual({
      type: "action",
      action: "app.quit",
      via: "chord",
    });
  });

  it("disarms a pending leader so stale scopes never fire", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    map.rebind({ leader: "ctrl+k", bindings: { "pane.split": "leader s" } });
    expect(map.armed(1)).toBe(false);
    expect(map.press(parseChord("s"), 1)).toEqual({ type: "pass" });
  });
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
    expect(keymap().press(parseChord("ctrl+q"), 0)).toEqual({
      type: "action",
      action: "app.quit",
      via: "chord",
    });
  });

  it("resolves leader sequences", () => {
    const map = keymap();
    expect(map.press(parseChord("ctrl+k"), 0)).toEqual({ type: "leader-pending" });
    expect(map.press(parseChord("s"), 100)).toEqual({
      type: "action",
      action: "pane.split",
      via: "leader",
    });
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

  it("keeps the leader armed through key-repeat of the leader chord", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("ctrl+k"), 10, true)).toEqual({ type: "leader-pending" });
    expect(map.press(parseChord("ctrl+k"), 20, true)).toEqual({ type: "leader-pending" });
    expect(map.press(parseChord("s"), 30)).toEqual({
      type: "action",
      action: "pane.split",
      via: "leader",
    });
  });

  it("arms on a repeated leader press even without the initial press", () => {
    const map = keymap();
    expect(map.press(parseChord("ctrl+k"), 0, true)).toEqual({ type: "leader-pending" });
  });

  it("limits a scoped arm to the allowed actions and re-presses the rest", () => {
    const map = keymap();
    map.arm(0, new Set(["pane.split"]));
    expect(map.press(parseChord("s"), 10)).toEqual({
      type: "action",
      action: "pane.split",
      via: "leader",
    });

    map.arm(20, new Set(["pane.split"]));
    expect(map.press(parseChord("z"), 30)).toEqual({ type: "pass" });

    map.arm(40, new Set(["pane.split"]));
    expect(map.press(parseChord("ctrl+q"), 50)).toEqual({
      type: "action",
      action: "app.quit",
      via: "chord",
    });
  });

  it("reports armed state and lets it lapse after the timeout", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    expect(map.armed(100)).toBe(true);
    expect(map.armed(2001)).toBe(false);
  });

  it("accepts multiple bindings per action", () => {
    const map = new Keymap({
      leader: "ctrl+k",
      bindings: { "focus.left": ["leader h", "leader left"] },
    });
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("h"), 1)).toEqual({
      type: "action",
      action: "focus.left",
      via: "leader",
    });
    map.press(parseChord("ctrl+k"), 2);
    expect(map.press(parseChord("left"), 3)).toEqual({
      type: "action",
      action: "focus.left",
      via: "leader",
    });
  });

  it("supports re-arming for sticky nav mode", () => {
    const map = keymap();
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("s"), 10)).toEqual({
      type: "action",
      action: "pane.split",
      via: "leader",
    });
    map.arm(10);
    expect(map.press(parseChord("x"), 20)).toEqual({
      type: "action",
      action: "pane.close",
      via: "leader",
    });
    expect(map.press(parseChord("x"), 30)).toEqual({ type: "pass" });
  });

  it("distinguishes shifted leader keys from plain ones", () => {
    const map = new Keymap({
      leader: "ctrl+k",
      bindings: { "focus.left": "leader h", "swap.left": "leader shift+h" },
    });
    map.press(parseChord("ctrl+k"), 0);
    expect(map.press(parseChord("shift+h"), 1)).toEqual({
      type: "action",
      action: "swap.left",
      via: "leader",
    });
    map.press(parseChord("ctrl+k"), 2);
    expect(map.press(parseChord("h"), 3)).toEqual({
      type: "action",
      action: "focus.left",
      via: "leader",
    });
  });
});

describe("Keymap registration", () => {
  it("rejects two actions claiming one chord, naming both", () => {
    expect(() => new Keymap({ bindings: { "a.one": "ctrl+p", "b.two": "ctrl+p" } })).toThrow(
      /"ctrl\+p" is bound to both "a.one" and "b.two"/,
    );
    expect(() => new Keymap({ bindings: { "a.one": "ctrl+p", "b.two": "ctrl+p" } })).toThrow(
      KeymapError,
    );
  });

  it("rejects binding the leader chord itself to an action", () => {
    expect(() => new Keymap({ leader: "ctrl+k", bindings: { "a.one": "ctrl+k" } })).toThrow(
      /"ctrl\+k" is the leader/,
    );
  });

  it("lets 'none' unbind without claiming anything", () => {
    const map = new Keymap({ bindings: { "a.one": "none", "b.two": "none" } });
    expect(map.actions()).toEqual([]);
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

  it("ignores key releases so leader state survives letting go of ctrl", () => {
    expect(chordOf({ name: "k", ctrl: true, eventType: "release" })).toBeUndefined();
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
