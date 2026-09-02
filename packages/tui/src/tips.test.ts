import { describe, expect, it } from "vitest";
import { AppCore } from "./app-core.ts";
import { curatedTips, rotatingTip, type TipSignals, tipRotationMs } from "./tips.ts";

const everythingUsed: TipSignals = {
  paneCount: 3,
  costsShown: true,
  memoryUntouched: false,
  arcsUntouched: false,
};

const nothingUsed: TipSignals = {
  paneCount: 1,
  costsShown: false,
  memoryUntouched: true,
  arcsUntouched: true,
};

describe("rotatingTip", () => {
  it("says nothing once every feature is in use", () => {
    expect(rotatingTip(everythingUsed, 0)).toBeUndefined();
  });

  it("offers only tips for features the workspace has not used yet", () => {
    const tip = rotatingTip({ ...everythingUsed, costsShown: false }, 0);
    expect(tip).toBe("/show-costs puts spend in the pane headers");
  });

  it("rotates through the eligible tips on the interval clock", () => {
    const seen = new Set(
      Array.from({ length: curatedTips.length }, (_, step) =>
        rotatingTip(nothingUsed, step * tipRotationMs),
      ),
    );
    expect(seen.size).toBe(curatedTips.length);
  });

  it("holds one tip steady inside a single interval", () => {
    expect(rotatingTip(nothingUsed, 0)).toBe(rotatingTip(nothingUsed, tipRotationMs - 1));
  });

  it("keeps the curated list free of em dashes and shouting", () => {
    for (const tip of curatedTips) {
      expect(tip.text).not.toMatch(/\u2014/);
      expect(tip.text).toBe(tip.text.toLowerCase());
    }
  });
});

describe("AppCore.tip", () => {
  const coreWith = (tips: { enabled: boolean; now?: () => number }) =>
    new AppCore({
      screen: () => ({ width: 100, height: 30 }),
      createPane: () => undefined,
      onExit: () => {},
      tips,
    });

  it("offers a tip for the untouched features when enabled", () => {
    expect(coreWith({ enabled: true, now: () => 0 }).tip()).toBe(
      "ctrl+k s splits a second session in",
    );
  });

  it("says nothing when the kill switch is off", () => {
    expect(coreWith({ enabled: false, now: () => 0 }).tip()).toBeUndefined();
  });
});
