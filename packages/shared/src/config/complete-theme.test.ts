import { describe, expect, it } from "vitest";
import { apcaLc } from "../contrast.ts";
import { completeTheme, derivedSyntax, derivedTerminal } from "./complete-theme.ts";
import { gallery, themeNamed } from "./gallery.ts";
import { contrastFailures, parseTheme, type Theme, terminalSlots } from "./theme.ts";

const bareSections = (theme: Theme): Theme => {
  const { terminal, syntax, diff, selection, cursor, ...base } = theme;
  return base;
};

const night = bareSections(galleryTheme("keywork-night"));

const quietLight = parseTheme({
  name: "quiet-light",
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
    ramp: ["#5a35c8"],
  },
  density: { light: "textDim", medium: "textMid", heavy: "text", full: "accent" },
  gap: 0,
  chromeWeight: "regular",
  instruments: "calm",
});

describe("completeTheme", () => {
  it("fills every section a bare theme leaves out", () => {
    const complete = completeTheme(night);
    expect(Object.keys(complete.terminal)).toEqual([...terminalSlots]);
    expect(complete.syntax).toBeDefined();
    expect(complete.diff).toBeDefined();
    expect(complete.selection.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(complete.cursor).toBe(night.tokens.accent);
  });

  it("keeps every section the theme states by hand", () => {
    const handSet = galleryTheme("gruvbox-light");
    expect(completeTheme(handSet)).toEqual(handSet);
  });

  it("derives sections that clear every floor, dark and light", () => {
    for (const theme of [night, quietLight, ...gallery.map(bareSections)]) {
      expect(contrastFailures(completeTheme(theme)), theme.name).toEqual([]);
    }
  });

  it("falls back to accent and accentSoft for a one-stop ramp", () => {
    const terminal = derivedTerminal(quietLight.tokens);
    expect(terminal.blue).toBe(quietLight.tokens.accent);
    expect(apcaLc(terminal.cyan, quietLight.tokens.background)).toBeGreaterThanOrEqual(30);
  });

  it("lifts a derived ink toward text until it reads on panel", () => {
    const sunk = { ...night.tokens, textDim: "#262a3e" };
    const comment = derivedSyntax(sunk).comment;
    expect(comment).not.toBe(sunk.textDim);
    expect(apcaLc(comment, sunk.panel)).toBeGreaterThanOrEqual(15);
  });
});

function galleryTheme(name: string): Theme {
  const theme = themeNamed(name);
  if (theme === undefined) throw new Error(`no gallery theme ${name}`);
  return theme;
}
