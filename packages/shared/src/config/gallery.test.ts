import { describe, expect, it } from "vitest";
import { gallery, themeNamed, wardrobe } from "./gallery.ts";
import { contrastFailures, parseTheme, type Theme } from "./theme.ts";

const adjustedFromCanonical: readonly Adjustment[] = [
  { theme: "nord", path: "tokens.error", canonical: "#bf616a", adjusted: "#db7a82" },
  { theme: "nord", path: "terminal.red", canonical: "#bf616a", adjusted: "#c4666e" },
  { theme: "nord", path: "terminal.brightRed", canonical: "#bf616a", adjusted: "#c4666e" },
  { theme: "nord", path: "syntax.invalid", canonical: "#bf616a", adjusted: "#ce6f77" },
  { theme: "nord-light", path: "tokens.success", canonical: "#a3be8c", adjusted: "#90aa79" },
  { theme: "nord-light", path: "terminal.green", canonical: "#a3be8c", adjusted: "#a3bd8c" },
  { theme: "nord-light", path: "terminal.brightGreen", canonical: "#a3be8c", adjusted: "#a3bd8c" },
  { theme: "nord-light", path: "terminal.yellow", canonical: "#ebcb8b", adjusted: "#d1b172" },
  { theme: "nord-light", path: "terminal.cyan", canonical: "#88c0d0", adjusted: "#87bece" },
  { theme: "nord-light", path: "syntax.string", canonical: "#a3be8c", adjusted: "#9db786" },
  { theme: "nord-light", path: "syntax.type", canonical: "#8fbcbb", adjusted: "#8bb7b7" },
  { theme: "nord-light", path: "syntax.attribute", canonical: "#8fbcbb", adjusted: "#8bb7b7" },
  { theme: "nord-light", path: "syntax.function", canonical: "#88c0d0", adjusted: "#80b7c7" },
  { theme: "nord-light", path: "syntax.link", canonical: "#88c0d0", adjusted: "#80b7c7" },
  { theme: "gruvbox-dark", path: "tokens.error", canonical: "#fb4934", adjusted: "#ff523c" },
  { theme: "gruvbox-dark", path: "terminal.red", canonical: "#cc241d", adjusted: "#e13d31" },
  { theme: "gruvbox-dark", path: "terminal.blue", canonical: "#458588", adjusted: "#478789" },
  { theme: "gruvbox-dark", path: "terminal.magenta", canonical: "#b16286", adjusted: "#b36488" },
  {
    theme: "everforest-dark",
    path: "diff.insertedLine",
    canonical: "#425047",
    adjusted: "#3e4c43",
  },
  { theme: "kanagawa-wave", path: "terminal.red", canonical: "#c34043", adjusted: "#cf4c4d" },
  { theme: "kanagawa-wave", path: "syntax.invalid", canonical: "#e82424", adjusted: "#ec2927" },
  { theme: "rose-pine", path: "tokens.border", canonical: "#403d52", adjusted: "#403e53" },
  { theme: "rose-pine", path: "terminal.green", canonical: "#31748f", adjusted: "#3d809b" },
  { theme: "rose-pine", path: "terminal.brightGreen", canonical: "#31748f", adjusted: "#3d809b" },
  { theme: "rose-pine", path: "syntax.keyword", canonical: "#31748f", adjusted: "#3f829d" },
  { theme: "flexoki-dark", path: "tokens.error", canonical: "#d14d41", adjusted: "#e55f51" },
];

describe("the gallery", () => {
  it("ships the curated themes, each named once", () => {
    const names = gallery.map((theme) => theme.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "keywork-night",
        "keywork-day",
        "catppuccin-mocha",
        "catppuccin-latte",
        "nord",
        "nord-light",
        "gruvbox-dark",
        "gruvbox-light",
        "everforest-dark",
        "everforest-light",
        "kanagawa-wave",
        "kanagawa-lotus",
        "rose-pine",
        "rose-pine-dawn",
        "matte-black",
        "osaka-jade",
        "ristretto",
        "flexoki-dark",
        "flexoki-light",
      ]),
    );
  });

  it("clears every contrast floor in every theme, light and dark (T6)", () => {
    for (const theme of gallery) expect(contrastFailures(theme), theme.name).toEqual([]);
    expect(gallery.filter((theme) => theme.appearance === "light").length).toBeGreaterThan(1);
  });

  it("states every section by hand rather than leaning on derivation", () => {
    for (const theme of gallery) {
      expect(theme.terminal, theme.name).toBeDefined();
      expect(theme.syntax, theme.name).toBeDefined();
      expect(theme.diff, theme.name).toBeDefined();
      expect(theme.selection, theme.name).toBeDefined();
      expect(theme.cursor, theme.name).toBeDefined();
    }
  });

  it("pairs symmetrically across opposite appearances", () => {
    for (const theme of gallery.filter((candidate) => candidate.pair !== undefined)) {
      const twin = themeNamed(theme.pair ?? "");
      expect(twin, `${theme.name} names ${theme.pair}`).toBeDefined();
      expect(twin?.pair, `${theme.pair} names ${theme.name} back`).toBe(theme.name);
      expect(twin?.appearance).not.toBe(theme.appearance);
    }
    expect(gallery.filter((theme) => theme.pair !== undefined)).toHaveLength(16);
  });

  it("keeps keywork-night's palette byte-identical to the shipped default", () => {
    expect(themeNamed("keywork-night")?.tokens).toEqual({
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
    });
    expect(themeNamed("keywork-night")?.chromeWeight).toBe("seams");
  });

  it("varies taste so themes feel distinct, not recolored", () => {
    const chrome = new Set(gallery.map((theme) => theme.chromeWeight));
    expect(chrome).toEqual(new Set(["regular", "seams", "borderless"]));
    expect(gallery.some((theme) => theme.instruments === "cockpit")).toBe(true);
    expect(new Set(gallery.map((theme) => theme.gap)).size).toBeGreaterThan(1);
    expect(new Set(gallery.map((theme) => theme.density.full)).size).toBeGreaterThan(1);
    expect(new Set(gallery.map((theme) => theme.tokens.background)).size).toBe(gallery.length);
  });

  it("gives twins the same composition, so following the OS never relayouts", () => {
    for (const theme of gallery) {
      const twin = theme.pair === undefined ? undefined : themeNamed(theme.pair);
      if (twin === undefined) continue;
      expect([twin.chromeWeight, twin.gap, twin.instruments], theme.name).toEqual([
        theme.chromeWeight,
        theme.gap,
        theme.instruments,
      ]);
    }
  });
});

describe("shades adjusted from their project's canonical palette", () => {
  it.each(adjustedFromCanonical)(
    "$theme $path: $canonical misses its floor, $adjusted is the smallest step that clears it",
    ({ theme: name, path, canonical, adjusted }) => {
      const theme = themeNamed(name);
      if (theme === undefined) throw new Error(`no gallery theme ${name}`);
      expect(colorAt(theme, path)).toBe(adjusted);
      const failures = contrastFailures(withColorAt(theme, path, canonical));
      expect(failures.length).toBeGreaterThan(0);
    },
  );
});

describe("wardrobe", () => {
  it("hangs the whole gallery when the closet is empty", () => {
    expect(wardrobe()).toEqual(gallery);
  });

  it("lets a closet theme replace a gallery theme in place and appends new ones", () => {
    const night = themeNamed("keywork-night");
    if (night === undefined) throw new Error("keywork-night left the gallery");
    const tailored = parseTheme({ ...night, gap: 3 });
    const extra = parseTheme({ ...night, name: "my-night", pair: undefined });
    const hanging = wardrobe([tailored, extra]);
    expect(hanging[0]).toEqual(tailored);
    expect(hanging.at(-1)).toEqual(extra);
    expect(hanging).toHaveLength(gallery.length + 1);
  });
});

interface Adjustment {
  theme: string;
  path: string;
  canonical: string;
  adjusted: string;
}

function colorAt(theme: Theme, path: string): unknown {
  const [section, key] = path.split(".");
  const holder = (theme as unknown as Record<string, Record<string, unknown>>)[section ?? ""];
  return holder?.[key ?? ""];
}

function withColorAt(theme: Theme, path: string, color: string): Theme {
  const [section, key] = path.split(".");
  const record = theme as unknown as Record<string, Record<string, unknown>>;
  return {
    ...theme,
    [section ?? ""]: { ...record[section ?? ""], [key ?? ""]: color },
  } as Theme;
}
