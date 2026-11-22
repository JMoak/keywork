import { describe, expect, it } from "vitest";
import { completeTheme } from "./complete-theme.ts";
import { contrastFailures, parseTheme, type Theme, themeTokenOverridesSchema } from "./theme.ts";

const night: Theme = {
  name: "night-fixture",
  appearance: "dark",
  tokens: {
    background: "#1a1b26",
    panel: "#1f2335",
    panelLift: "#24283b",
    text: "#c0caf5",
    textMid: "#828bb8",
    textDim: "#565f89",
    border: "#3b4261",
    borderFocus: "#bb9af7",
    accent: "#bb9af7",
    accentSoft: "#9d7cd8",
    success: "#9ece6a",
    error: "#f7768e",
    ramp: ["#bb9af7", "#7aa2f7", "#7dcfff"],
  },
  density: { light: "textDim", medium: "textMid", heavy: "text", full: "accent" },
  gap: 0,
  chromeWeight: "regular",
  instruments: "calm",
};

function withTokens(tokens: Partial<Theme["tokens"]>): unknown {
  return { ...night, tokens: { ...night.tokens, ...tokens } };
}

describe("parseTheme", () => {
  it("round-trips a readable theme file through the schema", () => {
    const parsed = parseTheme(JSON.parse(JSON.stringify(night)));
    expect(parsed).toEqual(night);
  });

  it("fails a theme whose ink sinks into the ground, and says which pair", () => {
    expect(() => parseTheme(withTokens({ textDim: "#1c1d28" }))).toThrow(
      /night-fixture.*textDim on background measures Lc [\d.]+, needs at least 15/s,
    );
  });

  it("fails a density level mapped onto too quiet a token", () => {
    const theme = { ...night, density: { ...night.density, full: "textDim" } };
    expect(() => parseTheme(theme)).toThrow(/density full/);
  });

  it("points into the schema when the shape is wrong", () => {
    const { accent, ...missingAccent } = night.tokens;
    expect(() => parseTheme({ ...night, tokens: missingAccent })).toThrow(
      /does not fit the schema at tokens\.accent/,
    );
    expect(() => parseTheme({ ...night, extra: true })).toThrow(/does not fit the schema/);
    expect(() => parseTheme({ ...night, gap: 9 })).toThrow(/at gap/);
  });

  it("holds ramp stops to the same color rule as tokens", () => {
    expect(() => parseTheme(withTokens({ ramp: ["purple"] }))).toThrow(/rrggbb/);
    expect(() => parseTheme(withTokens({ ramp: [] }))).toThrow(/at tokens\.ramp/);
  });
});

describe("contrastFailures", () => {
  it("refuses a light theme that is a tinted dark one, sections included", () => {
    const tinted = { ...completeTheme(night), name: "tinted", appearance: "light" as const };
    expect(contrastFailures(tinted)).toEqual(
      expect.arrayContaining([
        "text on background reads light-on-dark in a light theme",
        "syntax.keyword on panel reads light-on-dark in a light theme",
        "cursor on background reads light-on-dark in a light theme",
      ]),
    );
    expect(() => parseTheme(tinted)).toThrow(/reads light-on-dark in a light theme/);
  });
});

describe("themeTokenOverridesSchema", () => {
  it("names a misspelled token and holds colors to the theme rule", () => {
    const misspelled = themeTokenOverridesSchema.safeParse({ acent: "#ff00ff" });
    expect(misspelled.success).toBe(false);
    expect(misspelled.error?.issues[0]?.message).toMatch(/Unrecognized key: "acent"/);
    const malformed = themeTokenOverridesSchema.safeParse({ accent: "purple" });
    expect(malformed.error?.issues[0]?.path).toEqual(["accent"]);
    expect(malformed.error?.issues[0]?.message).toMatch(/#rrggbb/);
  });
});

describe("optional sections", () => {
  const dressed = completeTheme(night);

  it("round-trips every section and the pair through the schema", () => {
    const paired = { ...dressed, pair: "day-fixture" };
    expect(parseTheme(JSON.parse(JSON.stringify(paired)))).toEqual(paired);
  });

  it("refuses an unknown terminal slot or syntax role", () => {
    expect(() =>
      parseTheme({ ...dressed, terminal: { ...dressed.terminal, orange: "#ff9e64" } }),
    ).toThrow(/at terminal/);
    expect(() =>
      parseTheme({ ...dressed, syntax: { ...dressed.syntax, regex: "#ff9e64" } }),
    ).toThrow(/at syntax/);
  });

  it("floors terminal hues on background and leaves black and white free", () => {
    expect(() =>
      parseTheme({ ...dressed, terminal: { ...dressed.terminal, brightBlue: "#1c1d2a" } }),
    ).toThrow(/terminal\.brightBlue on background measures Lc [\d.]+, needs at least 30/);
    expect(() =>
      parseTheme({ ...dressed, terminal: { ...dressed.terminal, black: "#1a1b26" } }),
    ).not.toThrow();
  });

  it("floors syntax on panel, comments more gently", () => {
    expect(() =>
      parseTheme({ ...dressed, syntax: { ...dressed.syntax, keyword: "#3b4261" } }),
    ).toThrow(/syntax\.keyword on panel measures Lc [\d.]+, needs at least 30/);
    expect(() =>
      parseTheme({ ...dressed, syntax: { ...dressed.syntax, comment: "#565f89" } }),
    ).not.toThrow();
    expect(() =>
      parseTheme({ ...dressed, syntax: { ...dressed.syntax, comment: "#2a2e44" } }),
    ).toThrow(/syntax\.comment on panel .* needs at least 15/);
  });

  it("measures selection with its own text when it has one", () => {
    const glaring = { background: "#c3a6ff" };
    expect(() => parseTheme({ ...dressed, selection: glaring })).toThrow(
      /text on selection\.background/,
    );
    expect(() =>
      parseTheme({ ...dressed, selection: { ...glaring, text: "#000000" } }),
    ).not.toThrow();
  });

  it("holds the pair to the theme name grammar", () => {
    expect(() => parseTheme({ ...night, pair: "Day Fixture" })).toThrow(/at pair/);
  });
});
