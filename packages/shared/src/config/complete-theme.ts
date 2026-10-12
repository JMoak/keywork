import { apcaLc } from "../contrast.ts";
import { mixOklab } from "../oklab.ts";
import {
  flooredTerminalSlots,
  type SyntaxRole,
  sectionFloors,
  syntaxFloor,
  syntaxRoles,
  type TerminalSlot,
  type Theme,
  type ThemeDiff,
  type ThemeSelection,
  type ThemeSyntax,
  type ThemeTerminal,
  type ThemeTokens,
  terminalSlots,
} from "./theme.ts";

export type CompleteTheme = Theme & { [Section in DressSection]-?: NonNullable<Theme[Section]> };

type DressSection = "terminal" | "syntax" | "diff" | "selection" | "cursor";

export function completeTheme(theme: Theme): CompleteTheme {
  const { tokens } = theme;
  return {
    ...theme,
    terminal: theme.terminal ?? derivedTerminal(tokens),
    syntax: theme.syntax ?? derivedSyntax(tokens),
    diff: theme.diff ?? derivedDiff(tokens),
    selection: theme.selection ?? derivedSelection(tokens),
    cursor: theme.cursor ?? tokens.accent,
  };
}

export function derivedTerminal(tokens: ThemeTokens): ThemeTerminal {
  const hues = terminalHues(tokens);
  const brightened = (hue: string): string => mixOklab(hue, tokens.text, brightStep);
  const raw: ThemeTerminal = {
    black: tokens.panelLift,
    ...hues,
    white: tokens.textMid,
    brightBlack: tokens.textDim,
    brightRed: brightened(hues.red),
    brightGreen: brightened(hues.green),
    brightYellow: brightened(hues.yellow),
    brightBlue: brightened(hues.blue),
    brightMagenta: brightened(hues.magenta),
    brightCyan: brightened(hues.cyan),
    brightWhite: tokens.text,
  };
  return slotsOf(terminalSlots, (slot) =>
    isFloored(slot)
      ? clearingFloor(raw[slot], tokens.background, tokens.text, sectionFloors.terminal)
      : raw[slot],
  );
}

export function derivedSyntax(tokens: ThemeTokens): ThemeSyntax {
  const hues = terminalHues(tokens);
  const raw: ThemeSyntax = {
    comment: tokens.textDim,
    keyword: tokens.accent,
    string: tokens.success,
    number: hues.yellow,
    type: hues.cyan,
    function: hues.blue,
    variable: tokens.text,
    constant: hues.yellow,
    operator: tokens.textMid,
    punctuation: tokens.textMid,
    tag: tokens.error,
    attribute: hues.yellow,
    heading: tokens.accent,
    link: hues.blue,
    invalid: tokens.error,
  };
  return slotsOf(syntaxRoles, (role: SyntaxRole) =>
    clearingFloor(raw[role], tokens.panel, tokens.text, syntaxFloor(role)),
  );
}

export function derivedDiff(tokens: ThemeTokens): ThemeDiff {
  const line = (outcome: string): string =>
    groundKeepingInkReadable(tokens.panel, outcome, lineMix, tokens.text, sectionFloors.diffLine);
  return {
    insertedLine: line(tokens.success),
    deletedLine: line(tokens.error),
    insertedText: mixOklab(tokens.panel, tokens.success, textSpanMix),
    deletedText: mixOklab(tokens.panel, tokens.error, textSpanMix),
  };
}

export function derivedSelection(tokens: ThemeTokens): ThemeSelection {
  return {
    background: groundKeepingInkReadable(
      tokens.panelLift,
      tokens.accentSoft,
      selectionMix,
      tokens.text,
      sectionFloors.selection,
    ),
  };
}

const brightStep = 0.2;
const lineMix = 0.14;
const textSpanMix = 0.28;
const selectionMix = 0.3;
const mixStep = 0.01;

type Hues = Pick<ThemeTerminal, "red" | "green" | "yellow" | "blue" | "magenta" | "cyan">;

function terminalHues(tokens: ThemeTokens): Hues {
  return {
    red: tokens.error,
    green: tokens.success,
    yellow: mixOklab(tokens.success, tokens.error, 0.5),
    blue: tokens.ramp[1] ?? tokens.accent,
    magenta: tokens.accent,
    cyan: tokens.ramp[2] ?? tokens.accentSoft,
  };
}

function clearingFloor(ink: string, ground: string, readable: string, floor: number): string {
  if (apcaLc(ink, ground) >= floor) return ink;
  for (let toward = mixStep; toward < 1; toward += mixStep) {
    const candidate = mixOklab(ink, readable, toward);
    if (apcaLc(candidate, ground) >= floor) return candidate;
  }
  return readable;
}

function groundKeepingInkReadable(
  ground: string,
  tint: string,
  strength: number,
  ink: string,
  floor: number,
): string {
  for (let amount = strength; amount > 0; amount -= mixStep) {
    const candidate = mixOklab(ground, tint, amount);
    if (apcaLc(ink, candidate) >= floor) return candidate;
  }
  return ground;
}

function isFloored(slot: TerminalSlot): boolean {
  return (flooredTerminalSlots as readonly TerminalSlot[]).includes(slot);
}

function slotsOf<K extends string>(
  keys: readonly K[],
  colorOf: (key: K) => string,
): Record<K, string> {
  return Object.fromEntries(keys.map((key) => [key, colorOf(key)])) as Record<K, string>;
}
