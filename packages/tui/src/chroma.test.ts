import { apcaLc, parseFlavor } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import {
  arcAnchor,
  arcAnchorPosition,
  arcMemberPositions,
  dimmedTheme,
  dimStep,
  focusLift,
  hexToOklch,
  lifecycleChrome,
  oklchToHex,
  paneBorder,
  rampColor,
  rampPositions,
  saturationLift,
  spawnRankPositions,
} from "./chroma.ts";
import type { LifecycleState } from "./pane.ts";
import { keyworkNight } from "./theme.ts";

const ramp = keyworkNight.ramp;

const firstLight = parseFlavor({
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

function adjacentDeltas(values: number[]): number[] {
  return values.slice(1).map((value, i) => value - (values[i] ?? Number.NaN));
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

  it("clamps an out-of-gamut chroma back to sRGB while preserving hue and lightness", () => {
    const clamped = oklchToHex({ l: 0.9, c: 0.4, h: 30 });
    expect(clamped).toMatch(/^#[0-9a-f]{6}$/);
    const { l, c, h } = hexToOklch(clamped);
    expect(Math.abs(l - 0.9)).toBeLessThan(0.005);
    expect(Math.abs(h - 30)).toBeLessThan(1);
    expect(c).toBeLessThan(0.4);
  });

  it("clamps impossible lightness to the gamut poles", () => {
    expect(oklchToHex({ l: 1.2, c: 0, h: 0 })).toBe("#ffffff");
    expect(oklchToHex({ l: -0.2, c: 0.1, h: 200 })).toBe("#000000");
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

  it("starts the ramp at today's flat accent", () => {
    expect(rampColor(ramp, 0)).toBe(keyworkNight.accent);
  });

  it("sweeps hue monotonically across the default ramp", () => {
    const hues = Array.from({ length: 25 }, (_, i) => hexToOklch(rampColor(ramp, i / 24)).h);
    for (const delta of adjacentDeltas(hues)) {
      expect(delta).toBeLessThan(0);
    }
  });

  it("keeps midpoints chromatic instead of muddy", () => {
    for (let i = 0; i <= 24; i++) {
      expect(hexToOklch(rampColor(ramp, i / 24)).c).toBeGreaterThan(0.1);
    }
  });

  it("clamps t outside [0,1] to the ramp ends", () => {
    expect(rampColor(ramp, -1)).toBe("#bb9af7");
    expect(rampColor(ramp, 2)).toBe("#7dcfff");
  });

  it("normalizes stop casing", () => {
    expect(rampColor(["#BB9AF7"], 0.3)).toBe("#bb9af7");
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

  it("returns nothing for no panes", () => {
    expect(spawnRankPositions(0)).toEqual([]);
    expect(spawnRankPositions(-2)).toEqual([]);
  });
});

describe("focusLift", () => {
  it("maps today's accent exactly onto today's borderFocus token", () => {
    expect(focusLift(keyworkNight.accent, keyworkNight.borderFocus)).toBe(keyworkNight.borderFocus);
  });

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

  it("keeps neutral input neutral instead of inventing a hue", () => {
    expect(hexToOklch(focusLift("#808080", keyworkNight.borderFocus)).c).toBeLessThan(0.001);
  });

  it("lifts toward the given focus token, not the built-in palette", () => {
    expect(focusLift(firstLight.accent, firstLight.borderFocus)).toBe(firstLight.borderFocus);
    expect(focusLift(firstLight.accent, keyworkNight.borderFocus)).not.toBe(firstLight.borderFocus);
  });
});

describe("arcAnchor", () => {
  it("gives the first arc the ramp start", () => {
    expect(arcAnchor(ramp, 0)).toBe("#bb9af7");
  });

  it("spreads the first eight arcs onto pairwise-distinct, well-separated hues", () => {
    const anchors = Array.from({ length: 8 }, (_, k) => arcAnchor(ramp, k));
    expect(new Set(anchors).size).toBe(8);
    const hues = anchors.map((anchor) => hexToOklch(anchor).h).sort((a, b) => a - b);
    for (const gap of adjacentDeltas(hues)) {
      expect(gap).toBeGreaterThan(5);
    }
  });
});

describe("paneBorder", () => {
  it("renders today's exact tokens for a single pane", () => {
    expect(paneBorder(keyworkNight, 0, true)).toBe(keyworkNight.borderFocus);
    expect(paneBorder(keyworkNight, 0, false)).toBe(keyworkNight.border);
  });

  it("renders today's exact tokens at every rank when the ramp is one accent stop", () => {
    const flat = { ...keyworkNight, ramp: [keyworkNight.accent] };
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(paneBorder(flat, t, false)).toBe(keyworkNight.border);
      expect(paneBorder(flat, t, true)).toBe(keyworkNight.borderFocus);
    }
  });

  it("sweeps unfocused hue monotonically while holding the border's dimness", () => {
    const positions = [0, 0.25, 0.5, 0.75, 1];
    const rested = positions.map((t) => hexToOklch(paneBorder(keyworkNight, t, false)));
    const base = hexToOklch(keyworkNight.border);
    for (const border of rested) {
      expect(Math.abs(border.l - base.l)).toBeLessThan(0.01);
      expect(Math.abs(border.c - base.c)).toBeLessThan(0.01);
    }
    for (const delta of adjacentDeltas(rested.map((border) => border.h))) {
      expect(delta).toBeLessThan(0);
    }
  });

  it("keeps focus legible in monochrome at every rank", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const lifted = hexToOklch(paneBorder(keyworkNight, t, true)).l;
      const rested = hexToOklch(paneBorder(keyworkNight, t, false)).l;
      expect(lifted - rested).toBeGreaterThan(0.25);
    }
  });

  it("keeps a light flavor's focus border above its borderFocus contrast floor at every rank", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const focused = paneBorder(firstLight, t, true);
      expect(apcaLc(focused, firstLight.background)).toBeGreaterThanOrEqual(borderFocusFloorLc);
    }
    expect(paneBorder(firstLight, 0, true)).toBe(firstLight.borderFocus);
  });
});

describe("rampPositions", () => {
  it("sweeps ungrouped panes by spawn rank", () => {
    expect(rampPositions(["a", "b", "c"])).toEqual(
      new Map([
        ["a", 0],
        ["b", 0.5],
        ["c", 1],
      ]),
    );
  });

  it("puts a single pane at the ramp start", () => {
    expect(rampPositions(["only"])).toEqual(new Map([["only", 0]]));
  });

  it("clusters arc members around their anchor while ungrouped panes keep the sweep", () => {
    const arcOf = (id: string) => (id.startsWith("x") ? 7 : undefined);
    const positions = rampPositions(["x1", "a", "x2", "b"], arcOf);
    expect(positions.get("a")).toBe(0);
    expect(positions.get("b")).toBe(1);
    const anchor = arcAnchorPosition(7);
    for (const member of ["x1", "x2"]) {
      expect(Math.abs((positions.get(member) ?? Number.NaN) - anchor)).toBeLessThan(0.1);
    }
    expect(positions.get("x1")).not.toBe(positions.get("x2"));
  });
});

describe("arcMemberPositions", () => {
  it("puts a lone member exactly on the anchor", () => {
    expect(arcMemberPositions(0.42, 1)).toEqual([0.42]);
  });

  it("slides the micro-gradient window inside the ramp near its ends", () => {
    for (const anchor of [0, 0.999]) {
      for (const position of arcMemberPositions(anchor, 4)) {
        expect(position).toBeGreaterThanOrEqual(0);
        expect(position).toBeLessThanOrEqual(1);
      }
    }
  });

  it("spreads members evenly across a narrow window", () => {
    const positions = arcMemberPositions(0.5, 3);
    expect(positions).toHaveLength(3);
    const [first, mid, last] = positions;
    expect(mid).toBeCloseTo(0.5, 10);
    expect((last ?? 0) - (first ?? 0)).toBeLessThan(0.1);
  });
});

describe("arcAnchorPosition", () => {
  it("agrees with arcAnchor on every ramp", () => {
    for (let k = 0; k < 8; k++) {
      expect(arcAnchor(ramp, k)).toBe(rampColor(ramp, arcAnchorPosition(k)));
    }
  });
});

describe("dimStep", () => {
  const themes = [keyworkNight, firstLight];

  it("moves ink toward the ground in lightness on both polarities", () => {
    for (const theme of themes) {
      const ink = hexToOklch(theme.text);
      const ground = hexToOklch(theme.background);
      const dimmed = hexToOklch(dimStep(theme.text, theme.background));
      expect(Math.abs(dimmed.l - ground.l)).toBeLessThan(Math.abs(ink.l - ground.l));
    }
  });

  it("keeps the ink's hue while it recedes", () => {
    for (const theme of themes) {
      const dimmed = hexToOklch(dimStep(theme.accent, theme.background));
      expect(hueDelta(dimStep(theme.accent, theme.background), theme.accent)).toBeLessThan(15);
      expect(dimmed.c).toBeGreaterThan(0);
    }
  });

  it("steps subtly, never a plunge", () => {
    for (const theme of themes) {
      const ink = hexToOklch(theme.text);
      const dimmed = hexToOklch(dimStep(theme.text, theme.background));
      const delta = Math.abs(ink.l - dimmed.l);
      expect(delta).toBeGreaterThan(0.02);
      expect(delta).toBeLessThan(0.2);
    }
  });
});

describe("dimmedTheme", () => {
  const themes = [keyworkNight, firstLight];
  const inkTokens = [
    "text",
    "textMid",
    "textDim",
    "accent",
    "accentSoft",
    "success",
    "error",
  ] as const;

  it("recedes every content ink token", () => {
    for (const theme of themes) {
      const dimmed = dimmedTheme(theme);
      for (const token of inkTokens) {
        expect(Math.abs(apcaLc(dimmed[token], theme.background))).toBeLessThan(
          Math.abs(apcaLc(theme[token], theme.background)),
        );
      }
    }
  });

  it("leaves grounds, borders, and the ramp untouched", () => {
    for (const theme of themes) {
      const dimmed = dimmedTheme(theme);
      expect(dimmed.background).toBe(theme.background);
      expect(dimmed.panel).toBe(theme.panel);
      expect(dimmed.panelLift).toBe(theme.panelLift);
      expect(dimmed.border).toBe(theme.border);
      expect(dimmed.borderFocus).toBe(theme.borderFocus);
      expect(dimmed.ramp).toEqual(theme.ramp);
    }
  });

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

  it("agrees with paneBorder for the quiet states at every rank", () => {
    for (const t of positions) {
      const hue = rampColor(ramp, t);
      for (const focused of [true, false]) {
        for (const state of ["idle", "working", "finished-unseen", "failed"] as const) {
          expect(lifecycleChrome(state, focused, hue, keyworkNight).borderColor).toBe(
            paneBorder(keyworkNight, t, focused),
          );
        }
      }
    }
  });

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

  it("steps the quiet states' name ink and leaves failed in outcome ink", () => {
    const hue = ramp[2] as string;
    expect(lifecycleChrome("idle", false, hue, keyworkNight).labelInk).toBe(keyworkNight.textMid);
    expect(lifecycleChrome("idle", true, hue, keyworkNight).labelInk).toBe(
      paneBorder(keyworkNight, 1, true),
    );
    expect(lifecycleChrome("finished-unseen", false, hue, keyworkNight).labelInk).toBe(
      keyworkNight.text,
    );
    expect(lifecycleChrome("failed", false, hue, keyworkNight).labelInk).toBe(keyworkNight.error);
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

describe("saturationLift", () => {
  it("keeps luminance and takes the target hue with at least the target chroma", () => {
    const lifted = hexToOklch(saturationLift(keyworkNight.border, keyworkNight.ramp[2] as string));
    const from = hexToOklch(keyworkNight.border);
    const target = hexToOklch(keyworkNight.ramp[2] as string);
    expect(Math.abs(lifted.l - from.l)).toBeLessThan(0.02);
    expect(lifted.c).toBeGreaterThanOrEqual(Math.min(target.c, lifted.c));
    expect(Math.abs(lifted.h - target.h)).toBeLessThan(2);
  });

  it("leaves an already saturated color where it stands", () => {
    const hue = keyworkNight.ramp[0] as string;
    expect(saturationLift(hue, hue)).toBe(hue);
  });
});

describe("chrome elevation depth", () => {
  it("steps resting label and border toward the arc hue as depth climbs", () => {
    const hue = "#cc6644";
    const shallow = lifecycleChrome("idle", false, hue, keyworkNight, 0);
    const deep = lifecycleChrome("idle", false, hue, keyworkNight, 1);
    const rest = lifecycleChrome("idle", false, hue, keyworkNight);
    expect(shallow.labelInk).toBe(rest.labelInk);
    expect(shallow.borderColor).toBe(rest.borderColor);
    expect(deep.labelInk).toBe(hue);
    expect(deep.borderColor).toBe(hue);
    const half = lifecycleChrome("idle", false, hue, keyworkNight, 0.5);
    expect(half.labelInk).not.toBe(rest.labelInk);
    expect(half.labelInk).not.toBe(hue);
  });

  it("leaves every lifecycle state above idle untouched by depth", () => {
    const hue = "#cc6644";
    for (const state of ["needs-you", "finished-unseen", "failed"] as const) {
      expect(lifecycleChrome(state, false, hue, keyworkNight, 1)).toEqual(
        lifecycleChrome(state, false, hue, keyworkNight),
      );
    }
  });
});
