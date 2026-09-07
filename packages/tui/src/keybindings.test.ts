import { describe, expect, it } from "vitest";
import type { DebounceTiming } from "./debounce.ts";
import {
  applyKeybindings,
  type KeybindingSource,
  keybindingQuietMs,
  reloadedNotice,
  resolveBindings,
  watchKeybindings,
} from "./keybindings.ts";
import { type BindingSpec, Keymap, KeymapError } from "./keymap.ts";
import { parseChord } from "./keys.ts";

const defaults: Record<string, BindingSpec> = {
  "pane.split": "leader s",
  "app.quit": "ctrl+q",
};

interface Bench {
  keymap: Keymap;
  overrides: Record<string, BindingSpec>;
  notices: string[];
  changed: () => void;
  clock: FakeClock;
  unwatch: () => void;
  reads: number;
}

function bench(): Bench {
  const clock = fakeClock();
  const state = { changed: (): void => {}, reads: 0 };
  const notices: string[] = [];
  const overrides: Record<string, BindingSpec> = {};
  const source: KeybindingSource = {
    read: async () => {
      state.reads += 1;
      return { ...overrides };
    },
    watch: (changed) => {
      state.changed = changed;
      return () => {
        state.changed = () => {};
      };
    },
  };
  const keymap = new Keymap({ leader: "ctrl+k", bindings: defaults });
  const unwatch = watchKeybindings({
    keymap,
    source,
    defaults,
    timing: clock,
    notice: (text) => notices.push(text),
  });
  return {
    keymap,
    overrides,
    notices,
    changed: () => state.changed(),
    clock,
    unwatch,
    get reads() {
      return state.reads;
    },
  };
}

function actionOf(keymap: Keymap, spec: string): string | undefined {
  const result = keymap.press(parseChord(spec), 0);
  return result.type === "action" ? result.action : undefined;
}

async function settled(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve();
}

describe("resolveBindings", () => {
  it("lays overrides over the defaults", () => {
    expect(resolveBindings(defaults, { "app.quit": ["ctrl+t", "ctrl+d"] })).toEqual({
      "pane.split": "leader s",
      "app.quit": ["ctrl+t", "ctrl+d"],
    });
  });

  it("names an action that does not exist instead of binding it silently", () => {
    expect(() => resolveBindings(defaults, { "app.qiut": "ctrl+t" })).toThrow(
      new KeymapError('no action named "app.qiut"'),
    );
  });
});

describe("applyKeybindings", () => {
  it("rebinds the live keymap from the source", async () => {
    const keymap = new Keymap({ leader: "ctrl+k", bindings: defaults });
    const notices: string[] = [];
    const applied = await applyKeybindings({
      keymap,
      defaults,
      source: { read: async () => ({ "app.quit": "ctrl+t" }) },
      notice: (text) => notices.push(text),
    });
    expect(applied).toBe(true);
    expect(actionOf(keymap, "ctrl+t")).toBe("app.quit");
    expect(actionOf(keymap, "ctrl+q")).toBeUndefined();
    expect(notices).toEqual([]);
  });

  it("keeps the old keymap and posts the error when the source cannot be read", async () => {
    const keymap = new Keymap({ leader: "ctrl+k", bindings: defaults });
    const notices: string[] = [];
    const applied = await applyKeybindings({
      keymap,
      defaults,
      source: {
        read: async () => {
          throw new Error("keywork.json:3:17 is not valid JSON");
        },
      },
      notice: (text) => notices.push(text),
    });
    expect(applied).toBe(false);
    expect(actionOf(keymap, "ctrl+q")).toBe("app.quit");
    expect(notices).toEqual(["keybindings kept · keywork.json:3:17 is not valid JSON"]);
  });
});

describe("watchKeybindings", () => {
  it("fires the new chord one quiet period after the file changes", async () => {
    const it = bench();
    it.overrides["app.quit"] = "ctrl+t";
    it.changed();
    expect(actionOf(it.keymap, "ctrl+t")).toBeUndefined();
    it.clock.advance(keybindingQuietMs);
    await settled();
    expect(actionOf(it.keymap, "ctrl+t")).toBe("app.quit");
    expect(actionOf(it.keymap, "ctrl+q")).toBeUndefined();
    expect(it.notices).toEqual([reloadedNotice]);
  });

  it("coalesces a burst of change events into one reload", async () => {
    const it = bench();
    it.changed();
    it.clock.advance(keybindingQuietMs / 2);
    it.changed();
    it.clock.advance(keybindingQuietMs / 2);
    await settled();
    expect(it.reads).toBe(0);
    it.clock.advance(keybindingQuietMs / 2);
    await settled();
    expect(it.reads).toBe(1);
    expect(it.notices).toEqual([reloadedNotice]);
  });

  it("posts the parse error and keeps the previous binding live", async () => {
    const it = bench();
    it.overrides["app.quit"] = "ctrl+t";
    it.changed();
    it.clock.advance(keybindingQuietMs);
    await settled();
    it.overrides["pane.split"] = "ctrl+t";
    it.changed();
    it.clock.advance(keybindingQuietMs);
    await settled();
    expect(it.notices).toEqual([
      reloadedNotice,
      'keybindings kept · "ctrl+t" is bound to both "pane.split" and "app.quit"',
    ]);
    expect(actionOf(it.keymap, "ctrl+t")).toBe("app.quit");
  });

  it("stops reloading once unwatched", async () => {
    const it = bench();
    it.unwatch();
    it.changed();
    it.clock.advance(keybindingQuietMs);
    await settled();
    expect(it.reads).toBe(0);
  });

  it("does nothing for a source that cannot be watched", () => {
    const keymap = new Keymap({ leader: "ctrl+k", bindings: defaults });
    const unwatch = watchKeybindings({
      keymap,
      source: { read: async () => ({}) },
      notice: () => {},
    });
    expect(unwatch).not.toThrow();
  });
});

interface FakeClock extends DebounceTiming {
  advance(ms: number): void;
}

function fakeClock(): FakeClock {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    after: (delayMs, run) => {
      const timer = { at: now + delayMs, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    advance: (ms) => {
      now += ms;
      while (true) {
        const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) return;
        timers.splice(timers.indexOf(due), 1);
        due.run();
      }
    },
  };
}
