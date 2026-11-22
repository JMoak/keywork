import { apcaLc, parseTheme } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import {
  arcMemberPositions,
  dimmedTheme,
  focusLift,
  hexToOklch,
  inkClearingFloor,
  lifecycleChrome,
  oklchToHex,
  paneBorder,
  rampColor,
  spawnRankPositions,
} from "./chroma.ts";
import { keyworkNight } from "./palette.ts";
import type { LifecycleState } from "./pane.ts";

describe("inkClearingFloor", () => {
  it("lifts a dim ink on a dark ground just far enough to clear", () => {
    const cleared = inkClearingFloor("#3b4261", "#1a1b26", 60);
    expect(apcaLc(cleared, "#1a1b26")).toBeGreaterThanOrEqual(60);
    expect(apcaLc(cleared, "#1a1b26")).toBeLessThan(63);
    expect(Math.abs(hexToOklch(cleared).h - hexToOklch("#3b4261").h)).toBeLessThan(3);
  });

  it("hands back the extreme when nothing on the ramp can clear", () => {
    expect(inkClearingFloor("#808080", "#808080", 200)).toBe("#000000");
    expect(inkClearingFloor("#404040", "#404040", 200)).toBe("#ffffff");
  });
});

const ramp = keyworkNight.ramp;

const firstLight = parseTheme({
  name: "first-light",
  appearance: "light",
  tokens: {
    background: "#f2f2f7",
    panel: "#e6e6ef",
    panelLift: "#dcdce8",
    text: "#1a1b26",
    textMid: "#3f4468",
    textDim: "#5f6486",
    border: "#c0c4d8",
    borderFocus: "#5a35c8",
    accent: "#5a35c8",
    accentSoft: "#6f55c9",
    success: "#28691e",
    error: "#a4213f",
    ramp: ["#5a35c8", "#2f6bc4", "#1f8a99"],
  },
  density: { light: "textDim", medium: "textMid", heavy: "text", full: "accent" },
  gap: 0,
  chromeWeight: "regular",
  instruments: "calm",
}).tokens;

const borderFocusFloorLc = 40;

function channels(hex: string): number[] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function maxChannelDelta(a: string, b: string): number {
  const other = channels(b);
  return Math.max(...channels(a).map((channel, i) => Math.abs(channel - (other[i] ?? Number.NaN))));
}

function hueDelta(a: string, b: string): number {
  const raw = Math.abs(hexToOklch(a).h - hexToOklch(b).h);
  return Math.min(raw, 360 - raw);
}

describe("hexToOklch / oklchToHex", () => {
  it("round-trips every palette token and the sRGB extremes within 1/255 per channel", () => {
    const samples = [
      ...Object.values(keyworkNight).flat(),
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#808080",
      "#010203",
    ];
    for (const hex of samples) {
      expect(maxChannelDelta(oklchToHex(hexToOklch(hex)), hex)).toBeLessThanOrEqual(1);
    }
  });

  it("rejects malformed hex", () => {
    expect(() => hexToOklch("purple")).toThrow(/#rrggbb/);
    expect(() => hexToOklch("#fff")).toThrow(/#rrggbb/);
  });
});

describe("rampColor", () => {
  it("returns the exact stops at the endpoints and interior stop positions", () => {
    expect(rampColor(ramp, 0)).toBe("#bb9af7");
    expect(rampColor(ramp, 0.5)).toBe("#7aa2f7");
    expect(rampColor(ramp, 1)).toBe("#7dcfff");
  });

  it("returns the single stop for every t on a one-stop ramp", () => {
    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      expect(rampColor(["#7aa2f7"], t)).toBe("#7aa2f7");
    }
  });

  it("clamps t outside [0,1] to the ramp ends", () => {
    expect(rampColor(ramp, -1)).toBe("#bb9af7");
    expect(rampColor(ramp, 2)).toBe("#7dcfff");
  });

  it("rejects an empty ramp", () => {
    expect(() => rampColor([], 0)).toThrow(/at least one stop/);
  });
});

describe("spawnRankPositions", () => {
  it("spreads n panes evenly as i/(n-1)", () => {
    expect(spawnRankPositions(3)).toEqual([0, 0.5, 1]);
    expect(spawnRankPositions(5)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("puts a single pane at the ramp start", () => {
    expect(spawnRankPositions(1)).toEqual([0]);
  });
});

describe("focusLift", () => {
  it("lifts a dim border to focus luminance without changing its hue", () => {
    const lifted = focusLift(keyworkNight.border, keyworkNight.borderFocus);
    expect(hueDelta(lifted, keyworkNight.border)).toBeLessThan(2);
    const before = hexToOklch(keyworkNight.border);
    const after = hexToOklch(lifted);
    expect(after.l - before.l).toBeGreaterThan(0.2);
    expect(after.c - before.c).toBeGreaterThan(0.05);
  });

  it("never darkens or desaturates a stop already at focus strength", () => {
    for (const stop of ramp) {
      const lifted = hexToOklch(focusLift(stop, keyworkNight.borderFocus));
      const original = hexToOklch(stop);
      expect(lifted.l).toBeGreaterThanOrEqual(original.l - 0.005);
      expect(lifted.c).toBeGreaterThanOrEqual(original.c - 0.01);
    }
  });
});

describe("paneBorder", () => {
  it("renders today's exact tokens for a single pane", () => {
    expect(paneBorder(keyworkNight, 0, true)).toBe(keyworkNight.borderFocus);
    expect(paneBorder(keyworkNight, 0, false)).toBe(keyworkNight.border);
  });

  it("keeps focus legible in monochrome at every rank", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const lifted = hexToOklch(paneBorder(keyworkNight, t, true)).l;
      const rested = hexToOklch(paneBorder(keyworkNight, t, false)).l;
      expect(lifted - rested).toBeGreaterThan(0.25);
    }
  });

  it("keeps a light theme's focus border above its borderFocus contrast floor at every rank", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const focused = paneBorder(firstLight, t, true);
      expect(apcaLc(focused, firstLight.background)).toBeGreaterThanOrEqual(borderFocusFloorLc);
    }
    expect(paneBorder(firstLight, 0, true)).toBe(firstLight.borderFocus);
  });
});

describe("arcMemberPositions", () => {
  it("slides the micro-gradient window inside the ramp near its ends", () => {
    for (const anchor of [0, 0.999]) {
      for (const position of arcMemberPositions(anchor, 4)) {
        expect(position).toBeGreaterThanOrEqual(0);
        expect(position).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("dimmedTheme", () => {
  const themes = [keyworkNight, firstLight];
  it("keeps the tonal ladder ordered so hierarchy survives the dim", () => {
    for (const theme of themes) {
      const dimmed = dimmedTheme(theme);
      const contrast = (hex: string): number => Math.abs(apcaLc(hex, theme.background));
      expect(contrast(dimmed.text)).toBeGreaterThan(contrast(dimmed.textMid));
      expect(contrast(dimmed.textMid)).toBeGreaterThan(contrast(dimmed.textDim));
    }
  });

  it("keeps the primary reading ink legible", () => {
    for (const theme of themes) {
      expect(Math.abs(apcaLc(dimmedTheme(theme).text, theme.background))).toBeGreaterThan(45);
    }
  });
});

describe("lifecycleChrome", () => {
  const states: LifecycleState[] = ["idle", "working", "needs-you", "finished-unseen", "failed"];
  const positions = [0, 0.25, 0.5, 0.75, 1];

  it("grounds only needs-you, in the pane's own hue with background ink", () => {
    for (const state of states) {
      const chrome = lifecycleChrome(state, false, ramp[1] as string, keyworkNight);
      if (state === "needs-you") {
        expect(chrome.labelGround).toBe(ramp[1]);
        expect(chrome.labelInk).toBe(keyworkNight.background);
      } else {
        expect(chrome.labelGround).toBeUndefined();
      }
    }
  });

  it("lifts saturation only on needs-you, holding luminance so focus stays unambiguous", () => {
    for (const t of positions) {
      const hue = rampColor(ramp, t);
      for (const focused of [true, false]) {
        const rested = hexToOklch(lifecycleChrome("idle", focused, hue, keyworkNight).borderColor);
        const warmed = hexToOklch(
          lifecycleChrome("needs-you", focused, hue, keyworkNight).borderColor,
        );
        expect(Math.abs(warmed.l - rested.l)).toBeLessThan(0.02);
        expect(warmed.c).toBeGreaterThanOrEqual(rested.c - 0.005);
        if (!focused) expect(warmed.c - rested.c).toBeGreaterThan(0.02);
      }
    }
  });

  it("keeps the inverted label readable on both grounds", () => {
    for (const theme of [keyworkNight, firstLight]) {
      for (const t of positions) {
        const chrome = lifecycleChrome("needs-you", false, rampColor(theme.ramp, t), theme);
        expect(Math.abs(apcaLc(chrome.labelInk, chrome.labelGround as string))).toBeGreaterThan(40);
      }
    }
  });
});
