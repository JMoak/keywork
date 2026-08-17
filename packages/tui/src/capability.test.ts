import { describe, expect, it } from "vitest";
import {
  border,
  type CapabilityProfile,
  density,
  detectCapabilities,
  frameWrap,
  type GlyphSupport,
  resolveMark,
  resolveRamp,
  sparkline,
  type TieredMark,
  tile,
} from "./capability.ts";

function detect(env: Record<string, string | undefined>, platform = "linux"): CapabilityProfile {
  return detectCapabilities({ env, platform });
}

describe("detectCapabilities", () => {
  it("profiles Windows Terminal as a full-capability major", () => {
    expect(detect({ WT_SESSION: "guid" }, "win32")).toMatchObject({
      terminal: "windows-terminal",
      colorDepth: "truecolor",
      synchronizedOutput: true,
      glyphTier: 2,
      tmux: false,
      nerdFont: false,
    });
  });

  it("profiles Alacritty, kitty, and ghostty as full-capability majors", () => {
    const byEnv: [string, Record<string, string>][] = [
      ["alacritty", { ALACRITTY_WINDOW_ID: "1" }],
      ["alacritty", { TERM: "alacritty" }],
      ["kitty", { KITTY_WINDOW_ID: "1" }],
      ["kitty", { TERM: "xterm-kitty" }],
      ["ghostty", { GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" }],
      ["ghostty", { TERM: "xterm-ghostty" }],
    ];
    for (const [terminal, env] of byEnv) {
      expect(detect(env)).toMatchObject({
        terminal,
        colorDepth: "truecolor",
        synchronizedOutput: true,
        glyphTier: 2,
      });
    }
  });

  it("keeps the host identity inside tmux but degrades synchronized output", () => {
    const profile = detect({ WT_SESSION: "guid", TMUX: "/tmp/tmux-1000/default,123,0" });
    expect(profile.terminal).toBe("windows-terminal");
    expect(profile.tmux).toBe(true);
    expect(profile.synchronizedOutput).toBe(false);
    expect(profile.glyphTier).toBe(2);
  });

  it("recognizes tmux from TERM when TMUX is absent", () => {
    expect(detect({ TERM: "tmux-256color" }).tmux).toBe(true);
    expect(detect({ TERM: "screen-256color" }).tmux).toBe(true);
  });

  it("gives an unknown UTF-8 terminal tier 1 and no synchronized output", () => {
    expect(detect({ TERM: "xterm-256color", LANG: "en_US.UTF-8" })).toMatchObject({
      terminal: "unknown",
      colorDepth: "palette256",
      synchronizedOutput: false,
      glyphTier: 1,
    });
  });

  it("drops an unknown terminal without a UTF-8 locale to tier 0", () => {
    expect(detect({ TERM: "vt100", LANG: "C" }).glyphTier).toBe(0);
  });

  it("reads truecolor from COLORTERM on unknown terminals", () => {
    expect(detect({ TERM: "xterm", COLORTERM: "truecolor" }).colorDepth).toBe("truecolor");
    expect(detect({ TERM: "xterm", COLORTERM: "24bit" }).colorDepth).toBe("truecolor");
  });

  it("treats TERM=dumb as the floor even inside a known terminal", () => {
    expect(detect({ WT_SESSION: "guid", TERM: "dumb" })).toMatchObject({
      colorDepth: "mono",
      synchronizedOutput: false,
      glyphTier: 0,
    });
  });

  it("profiles bare win32 as conhost at tier 1", () => {
    expect(detect({}, "win32")).toMatchObject({
      terminal: "conhost",
      synchronizedOutput: false,
      glyphTier: 1,
    });
  });

  it("honors NO_COLOR without touching the glyph tier", () => {
    const profile = detect({ WT_SESSION: "guid", NO_COLOR: "1" });
    expect(profile.colorDepth).toBe("mono");
    expect(profile.glyphTier).toBe(2);
  });

  it("ignores an empty NO_COLOR", () => {
    expect(detect({ WT_SESSION: "guid", NO_COLOR: "" }).colorDepth).toBe("truecolor");
  });

  it("forces the glyph tier from KEYWORK_TIER and says so", () => {
    const profile = detect({ WT_SESSION: "guid", KEYWORK_TIER: "0" });
    expect(profile.glyphTier).toBe(0);
    expect(profile.glyphTierForced).toBe(true);
    expect(detect({ TERM: "vt100", KEYWORK_TIER: "2" }).glyphTier).toBe(2);
    expect(detect({ WT_SESSION: "guid", KEYWORK_TIER: "9" }).glyphTierForced).toBe(false);
  });

  it("never sniffs Nerd Fonts, only honors the explicit opt-in", () => {
    expect(detect({ KITTY_WINDOW_ID: "1" }).nerdFont).toBe(false);
    expect(detect({ KITTY_WINDOW_ID: "1", KEYWORK_NERD_FONT: "1" }).nerdFont).toBe(true);
    expect(detect({ KITTY_WINDOW_ID: "1", KEYWORK_NERD_FONT: "true" }).nerdFont).toBe(true);
  });

  it("keeps the Nerd Font garnish off at tier 0, where glyphs are ASCII only", () => {
    expect(detect({ TERM: "dumb", KEYWORK_NERD_FONT: "1" }).nerdFont).toBe(false);
  });
});

describe("resolveMark / resolveRamp", () => {
  const mark: TieredMark = { tier2: "▖", tier1: "░", tier0: ".", garnish: "\ue0b0" };

  it("resolves the richest declared variant the tier supports", () => {
    expect(resolveMark(mark, support(2))).toBe("▖");
    expect(resolveMark(mark, support(1))).toBe("░");
    expect(resolveMark(mark, support(0))).toBe(".");
  });

  it("falls one tier down when a mark skips a tier", () => {
    expect(resolveMark(tile.failed, support(1))).toBe("x");
    expect(resolveRamp(density, support(0))).toEqual(density.tier0);
  });

  it("serves the garnish only under the opt-in", () => {
    expect(resolveMark(mark, { glyphTier: 2, nerdFont: true })).toBe("\ue0b0");
    expect(resolveMark(mark, { glyphTier: 2, nerdFont: false })).toBe("▖");
  });

  it("resolves ramps per tier", () => {
    expect(resolveRamp(sparkline, support(2))).toEqual(["⣀", "⣤", "⣶", "⣿"]);
    expect(resolveRamp(sparkline, support(1))).toEqual(["░", "▒", "▓", "█"]);
    expect(resolveRamp(sparkline, support(0))).toEqual([".", ":", "+", "#"]);
    expect(resolveRamp(tile.fill, support(2))).toEqual(["▖", "▌", "▙", "█"]);
  });
});

describe("the sanctioned glyph inventory", () => {
  const marks = [...Object.values(border), tile.failed];
  const ramps = [density, sparkline, tile.fill];

  it("renders zero tofu without a Nerd Font at every tier", () => {
    for (const tier of [0, 1, 2] as const) {
      const glyphs = [
        ...marks.map((entry) => resolveMark(entry, support(tier))),
        ...ramps.flatMap((ramp) => resolveRamp(ramp, support(tier))),
      ].join("");
      for (const glyph of glyphs) expect(sanctioned(glyph, tier)).toBe(true);
    }
  });

  it("keeps tier 0 pure ASCII", () => {
    const glyphs = [
      ...marks.map((entry) => resolveMark(entry, support(0))),
      ...ramps.flatMap((ramp) => resolveRamp(ramp, support(0))),
    ].join("");
    expect([...glyphs].every((glyph) => glyph.charCodeAt(0) <= 0x7e)).toBe(true);
  });
});

describe("frameWrap", () => {
  it("wraps frames in DEC 2026 markers when synchronized output is supported", () => {
    const wrap = frameWrap({ synchronizedOutput: true });
    expect(wrap("frame")).toBe("\x1b[?2026hframe\x1b[?2026l");
  });

  it("passes frames through untouched when it is not", () => {
    const wrap = frameWrap({ synchronizedOutput: false });
    expect(wrap("frame")).toBe("frame");
  });
});

function support(glyphTier: 0 | 1 | 2): GlyphSupport {
  return { glyphTier, nerdFont: false };
}

function sanctioned(glyph: string, tier: 0 | 1 | 2): boolean {
  const code = glyph.codePointAt(0) ?? 0;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (tier >= 1 && code >= 0x2500 && code <= 0x25ff) return true;
  if (tier >= 2 && code >= 0x2800 && code <= 0x28ff) return true;
  return false;
}
