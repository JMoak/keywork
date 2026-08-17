import { describe, expect, it } from "vitest";
import {
  arcAnchor,
  arcAnchorPosition,
  arcMemberPositions,
  focusLift,
  hexToOklch,
  oklchToHex,
  paneBorder,
  rampColor,
  rampPositions,
  spawnRankPositions,
} from "./chroma.ts";
import { keyworkNight } from "./theme.ts";

const ramp = keyworkNight.ramp;

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
    expect(focusLift(keyworkNight.accent)).toBe(keyworkNight.borderFocus);
  });

  it("lifts a dim border to focus luminance without changing its hue", () => {
    const lifted = focusLift(keyworkNight.border);
    expect(hueDelta(lifted, keyworkNight.border)).toBeLessThan(2);
    const before = hexToOklch(keyworkNight.border);
    const after = hexToOklch(lifted);
    expect(after.l - before.l).toBeGreaterThan(0.2);
    expect(after.c - before.c).toBeGreaterThan(0.05);
  });

  it("never darkens or desaturates a stop already at focus strength", () => {
    for (const stop of ramp) {
      const lifted = hexToOklch(focusLift(stop));
      const original = hexToOklch(stop);
      expect(lifted.l).toBeGreaterThanOrEqual(original.l - 0.005);
      expect(lifted.c).toBeGreaterThanOrEqual(original.c - 0.01);
    }
  });

  it("keeps neutral input neutral instead of inventing a hue", () => {
    expect(hexToOklch(focusLift("#808080")).c).toBeLessThan(0.001);
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
    const flat = { border: keyworkNight.border, ramp: [keyworkNight.accent] };
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
