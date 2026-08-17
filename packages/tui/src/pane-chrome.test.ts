import { describe, expect, it } from "vitest";
import { paneBorder, rampPositions } from "./chroma.ts";
import type { PaneContext } from "./pane.ts";
import { paneChrome } from "./pane-chrome.ts";
import { AppProbe } from "./probe.ts";
import { keyworkNight } from "./theme.ts";

function contextWith(overrides: Partial<PaneContext> = {}): PaneContext {
  return { theme: keyworkNight, focused: false, width: 24, height: 8, ...overrides };
}

function borderOf(view: unknown): string | undefined {
  return (view as { props?: { borderColor?: string } }).props?.borderColor;
}

describe("paneChrome border color", () => {
  it("renders today's tokens when no chroma border is resolved", () => {
    expect(borderOf(paneChrome(contextWith(), " t "))).toBe(keyworkNight.border);
    expect(borderOf(paneChrome(contextWith({ focused: true }), " t "))).toBe(
      keyworkNight.borderFocus,
    );
  });

  it("renders the resolved chroma border when the context carries one", () => {
    const view = paneChrome(contextWith({ borderColor: "#123456" }), " t ");
    expect(borderOf(view)).toBe("#123456");
  });

  it("renders a single pane byte-identical to today", () => {
    for (const focused of [true, false]) {
      const chroma = paneChrome(
        contextWith({ focused, borderColor: paneBorder(keyworkNight, 0, focused) }),
        " t ",
      );
      const today = paneChrome(contextWith({ focused }), " t ");
      expect(borderOf(chroma)).toBe(borderOf(today));
    }
  });

  it("renders every rank byte-identical to today when chroma is off", () => {
    const flat = { ...keyworkNight, ramp: [keyworkNight.accent] };
    for (const focused of [true, false]) {
      for (const t of [0, 0.3, 0.7, 1]) {
        const chroma = paneChrome(
          contextWith({ focused, borderColor: paneBorder(flat, t, focused) }),
          " t ",
        );
        const today = paneChrome(contextWith({ focused }), " t ");
        expect(borderOf(chroma)).toBe(borderOf(today));
      }
    }
  });
});

describe("pane hue identity", () => {
  it("travels with the pane through dock moves and cycles", () => {
    const probe = new AppProbe();
    probe.keys("ctrl+k", "s", "s");
    const spawnOrder = () => [...probe.core.panes.keys()];
    const before = rampPositions(spawnOrder());
    expect(before.size).toBe(3);
    probe.keys("ctrl+k", "shift+l").keys("ctrl+k", "c").keys("ctrl+k", "shift+h");
    expect(rampPositions(spawnOrder())).toEqual(before);
  });

  it("recomputes the sweep when a pane closes", () => {
    const probe = new AppProbe();
    probe.keys("ctrl+k", "s", "s");
    expect(rampPositions([...probe.core.panes.keys()]).size).toBe(3);
    probe.command("exit");
    const survivors = [...probe.core.panes.keys()];
    expect(survivors.length).toBe(2);
    expect([...rampPositions(survivors).values()]).toEqual([0, 1]);
  });
});
