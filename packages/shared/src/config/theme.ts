import { z } from "zod";
import { hexColor } from "../color.ts";
import { apcaLc } from "../contrast.ts";

export function parseTheme(candidate: unknown): Theme {
  const theme = readShape(candidate);
  const failures = contrastFailures(theme);
  if (failures.length === 0) return theme;
  throw new Error(
    `theme "${theme.name}" fails the contrast floor:\n  ${failures.join("\n  ")}\n` +
      "raise the ink or deepen the ground, then reload it.",
  );
}

export function contrastFailures(theme: Theme): string[] {
  return [...tokenFailures(theme), ...densityFailures(theme), ...sectionFailures(theme)];
}

export const sectionFloors = {
  syntax: 30,
  syntaxComment: 15,
  terminal: 30,
  selection: 45,
  diffLine: 60,
  cursor: 40,
} as const;

export function syntaxFloor(role: SyntaxRole): number {
  return role === "comment" ? sectionFloors.syntaxComment : sectionFloors.syntax;
}

const inkToken = z.enum([
  "text",
  "textMid",
  "textDim",
  "accent",
  "accentSoft",
  "success",
  "error",
  "borderFocus",
]);

export const themeTokensSchema = z
  .object({
    background: hexColor.describe(
      "The screen ground; every readability floor the validator enforces is measured against it.",
    ),
    panel: hexColor.describe(
      "Raised surface behind status rows, trays, and fences; exists so elevated blocks separate from the ground without borders.",
    ),
    panelLift: hexColor.describe(
      "One step above panel for code spans and highlighted rows; exists because the page needs a second elevation that stays quiet.",
    ),
    text: hexColor.describe(
      "Primary reading ink; held to body-text contrast on every surface it composes with.",
    ),
    textMid: hexColor.describe(
      "Supporting-fact ink for paths, counts, and results; exists as the middle rung of the tonal ladder.",
    ),
    textDim: hexColor.describe(
      "Chrome ink for labels and separators; quiet by design, floored so chrome never disappears.",
    ),
    border: hexColor.describe(
      "Resting pane border; a hairline that only needs to be findable, so it carries the lowest floor.",
    ),
    borderFocus: hexColor.describe(
      "Focus strength and the focus-lift target; floored high because focus must survive a glance.",
    ),
    accent: hexColor.describe(
      "The identity color; the ramp starts here so a single pane renders exactly the flat look.",
    ),
    accentSoft: hexColor.describe("Muted accent for secondary marks and hints."),
    success: hexColor.describe(
      "Outcome ink for good results; only outcome words wear it, so it must read at a glance.",
    ),
    error: hexColor.describe("Outcome ink for failures; floored like success for the same glance."),
    ramp: z
      .array(hexColor)
      .min(1)
      .max(6)
      .describe(
        "Ordered accent stops that gradient chrome sweeps perceptually (98/PD8); one stop reproduces the flat single-accent look exactly.",
      ),
  })
  .strict()
  .describe(
    "The complete token palette; a theme is self-contained, so every token is stated rather than inherited.",
  );

export const themeTokenOverridesSchema = themeTokensSchema.partial();

const density = z
  .object({
    light: inkToken.describe("Ink for the lightest density step; staged and fresh things wear it."),
    medium: inkToken.describe("Ink for the settling middle step."),
    heavy: inkToken.describe("Ink for settled, full-presence marks."),
    full: inkToken.describe("Ink for the one notifying state (needs-you)."),
  })
  .strict()
  .describe(
    "Maps the density material onto palette tokens; density carries state (design-language), and each theme chooses how loudly that material reads.",
  );

export const terminalSlots = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export const flooredTerminalSlots = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
] as const satisfies readonly TerminalSlot[];

export const syntaxRoles = [
  "comment",
  "keyword",
  "string",
  "number",
  "type",
  "function",
  "variable",
  "constant",
  "operator",
  "punctuation",
  "tag",
  "attribute",
  "heading",
  "link",
  "invalid",
] as const;

const terminalSchema = z
  .object(
    Object.fromEntries(
      terminalSlots.map((slot, index) => [
        slot,
        hexColor.describe(
          `ANSI color ${index} as the terminal pane and any embedded terminal paint it; the six hues and their bright twins are floored at Lc ${sectionFloors.terminal} on background so program output stays legible.`,
        ),
      ]),
    ) as Record<TerminalSlot, typeof hexColor>,
  )
  .strict()
  .describe(
    "The sixteen ANSI colors, so one theme dresses terminal output as well as chrome. Derived when absent: black panelLift, red error, green success, yellow the OKLab midpoint of success and error, blue ramp[1] (else accent), magenta accent, cyan ramp[2] (else accentSoft), white textMid, brightBlack textDim, brightWhite text, each bright hue its normal hue mixed 20% toward text; every floored slot then steps toward text until it clears its floor.",
  );

const syntaxSchema = z
  .object(
    Object.fromEntries(
      syntaxRoles.map((role) => [
        role,
        hexColor.describe(
          `Ink for ${role} tokens in highlighted code; floored on panel because fences sit there (Lc ${sectionFloors.syntax}, comments ${sectionFloors.syntaxComment}).`,
        ),
      ]),
    ) as Record<SyntaxRole, typeof hexColor>,
  )
  .strict()
  .describe(
    "Highlight inks for code in fences, file views, and diffs, so code wears the theme instead of a second scheme. Derived when absent: comment textDim, keyword and heading accent, string success, number, constant, and attribute the terminal yellow rule, type cyan, function and link blue, variable text, operator and punctuation textMid, tag and invalid error; each then steps toward text until it clears its floor on panel.",
  );

const diffSchema = z
  .object({
    insertedLine: hexColor.describe(
      `Ground behind an added line; text must read on it at Lc ${sectionFloors.diffLine}.`,
    ),
    deletedLine: hexColor.describe(
      `Ground behind a removed line; text must read on it at Lc ${sectionFloors.diffLine}.`,
    ),
    insertedText: hexColor.describe(
      "Stronger ground marking the exact characters added within a changed line.",
    ),
    deletedText: hexColor.describe(
      "Stronger ground marking the exact characters removed within a changed line.",
    ),
  })
  .strict()
  .describe(
    "Diff grounds, so review reads in the theme's own green and red. Derived when absent: success and error mixed into panel in OKLab at 14% for lines and 28% for text spans, the line mix stepping back toward panel until text clears its floor.",
  );

const selectionSchema = z
  .object({
    background: hexColor.describe(
      `Ground behind selected text; selection text (else text) must read on it at Lc ${sectionFloors.selection}.`,
    ),
    text: hexColor
      .describe("Ink for selected text when the theme wants it to differ from text.")
      .optional(),
  })
  .strict()
  .describe(
    "Selection paint, so a highlight never falls back to a surface default. Derived when absent: accentSoft mixed 30% into panelLift in OKLab, stepping back toward panelLift until text clears its floor.",
  );

const themeName = z.string().regex(/^[a-z][a-z0-9-]*$/, "theme names are lowercase slugs");

export const themeSchema = z
  .object({
    name: themeName.describe(
      "Slug the palette command, captures, and errors call this theme by; a theme must be addressable to hot-swap.",
    ),
    appearance: z
      .enum(["dark", "light"])
      .describe(
        "Which ground the theme composes on; surfaces and the validator learn polarity from this instead of guessing from luminance.",
      ),
    tokens: themeTokensSchema,
    density,
    gap: z
      .number()
      .int()
      .min(0)
      .max(4)
      .describe(
        "Breathing room in cells between panes (C50 renders it); composition taste that travels with the theme, and 0 keeps today's seam-to-seam layout byte-identical.",
      ),
    chromeWeight: z
      .enum(["regular", "seams", "borderless"])
      .describe(
        "regular boxes every pane in its own border (rounded from glyph tier 1, square ascii at tier 0); seams draws one shared hairline per split with a header row inside each pane; borderless draws no lines at all and lifts the focused pane's ground to panel with a density focus mark so focus survives monochrome (C50); chrome heft is theme taste, not layout truth.",
      ),
    instruments: z
      .enum(["calm", "cockpit"])
      .describe(
        "calm renders the minimal status set and cockpit the full instrument tier (C55); instrumentation density belongs to the theme rather than a separate mode.",
      ),
    terminal: terminalSchema.optional(),
    syntax: syntaxSchema.optional(),
    diff: diffSchema.optional(),
    selection: selectionSchema.optional(),
    cursor: hexColor
      .describe(
        `Text-cursor color; floored at Lc ${sectionFloors.cursor} on background because the cursor is where the next keystroke lands. Derived as accent when absent.`,
      )
      .optional(),
    pair: themeName
      .describe(
        "The counterpart theme across appearance (a dark theme names its light twin and back), so a client following the OS can swap between a matched light and dark; the gallery proves pairs symmetric.",
      )
      .optional(),
  })
  .strict();

export type Theme = z.infer<typeof themeSchema>;
export type ThemeTokens = Theme["tokens"];
export type ThemeTokenOverrides = z.infer<typeof themeTokenOverridesSchema>;
export type ThemeTerminal = z.infer<typeof terminalSchema>;
export type ThemeSyntax = z.infer<typeof syntaxSchema>;
export type ThemeDiff = z.infer<typeof diffSchema>;
export type ThemeSelection = z.infer<typeof selectionSchema>;
export type TerminalSlot = (typeof terminalSlots)[number];
export type SyntaxRole = (typeof syntaxRoles)[number];
export type ThemeInkToken = z.infer<typeof inkToken>;
export type ThemeGroundToken = "background" | "panel" | "panelLift";
export type ThemeReadableToken = ThemeInkToken | "border";

interface ReadabilityFloor {
  ink: ThemeReadableToken;
  ground: ThemeGroundToken;
  floor: number;
}

const readabilityFloors: readonly ReadabilityFloor[] = [
  { ink: "text", ground: "background", floor: 60 },
  { ink: "text", ground: "panel", floor: 60 },
  { ink: "text", ground: "panelLift", floor: 60 },
  { ink: "textMid", ground: "background", floor: 30 },
  { ink: "textDim", ground: "background", floor: 15 },
  { ink: "border", ground: "background", floor: 5 },
  { ink: "borderFocus", ground: "background", floor: 40 },
  { ink: "accent", ground: "background", floor: 40 },
  { ink: "accentSoft", ground: "background", floor: 25 },
  { ink: "success", ground: "background", floor: 40 },
  { ink: "error", ground: "background", floor: 40 },
];

const densityLevels = ["light", "medium", "heavy", "full"] as const;
const densityFloors: Record<(typeof densityLevels)[number], number> = {
  light: 15,
  medium: 30,
  heavy: 45,
  full: 40,
};

function tokenFailures({ tokens }: Theme): string[] {
  return readabilityFloors.flatMap(({ ink, ground, floor }) =>
    shortfall(ink, tokens[ink], ground, tokens[ground], floor),
  );
}

function densityFailures({ tokens, density }: Theme): string[] {
  return densityLevels.flatMap((level) =>
    shortfall(
      density[level],
      tokens[density[level]],
      "background",
      tokens.background,
      densityFloors[level],
    ).map((failure) => `density ${level}: ${failure}`),
  );
}

function sectionFailures(theme: Theme): string[] {
  return [
    ...terminalFailures(theme),
    ...syntaxFailures(theme),
    ...diffFailures(theme),
    ...selectionFailures(theme),
    ...cursorFailures(theme),
  ];
}

function terminalFailures({ terminal, tokens }: Theme): string[] {
  if (terminal === undefined) return [];
  return flooredTerminalSlots.flatMap((slot) =>
    shortfall(
      `terminal.${slot}`,
      terminal[slot],
      "background",
      tokens.background,
      sectionFloors.terminal,
    ),
  );
}

function syntaxFailures({ syntax, tokens }: Theme): string[] {
  if (syntax === undefined) return [];
  return syntaxRoles.flatMap((role) =>
    shortfall(`syntax.${role}`, syntax[role], "panel", tokens.panel, syntaxFloor(role)),
  );
}

function diffFailures({ diff, tokens }: Theme): string[] {
  if (diff === undefined) return [];
  return (["insertedLine", "deletedLine"] as const).flatMap((line) =>
    shortfall("text", tokens.text, `diff.${line}`, diff[line], sectionFloors.diffLine),
  );
}

function selectionFailures({ selection, tokens }: Theme): string[] {
  if (selection === undefined) return [];
  return shortfall(
    selection.text === undefined ? "text" : "selection.text",
    selection.text ?? tokens.text,
    "selection.background",
    selection.background,
    sectionFloors.selection,
  );
}

function cursorFailures({ cursor, tokens }: Theme): string[] {
  if (cursor === undefined) return [];
  return shortfall("cursor", cursor, "background", tokens.background, sectionFloors.cursor);
}

function shortfall(
  ink: string,
  inkHex: string,
  ground: string,
  groundHex: string,
  floor: number,
): string[] {
  const value = apcaLc(inkHex, groundHex);
  if (value >= floor) return [];
  return [`${ink} on ${ground} measures Lc ${value.toFixed(1)}, needs at least ${floor}`];
}

function readShape(candidate: unknown): Theme {
  const parsed = themeSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
  const why = issue?.message ?? "unreadable theme";
  throw new Error(`theme file does not fit the schema${where}: ${why}`);
}
