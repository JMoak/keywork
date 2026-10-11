import { completeTheme, gallery, parseTheme } from "@keywork/shared";
import { describe, expect, it } from "vitest";
import { keyworkNight } from "./palette.ts";
import { AppProbe } from "./probe.ts";
import {
  keyworkNightTheme,
  paletteOf,
  registerThemeCommands,
  startupThemes,
  ThemeSwitch,
} from "./theme.ts";

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
});

describe("keyworkNightTheme", () => {
  it("carries today's palette exactly", () => {
    expect(paletteOf(keyworkNightTheme)).toEqual(keyworkNight);
  });
});

describe("startupThemes", () => {
  it("wears keywork-night untouched with no overrides", () => {
    const [worn] = startupThemes();
    expect(worn).toEqual(keyworkNightTheme);
  });

  it("folds token overrides into the worn theme instead of a second mechanism", () => {
    const [worn] = startupThemes({ accent: "#7dcfff", ramp: ["#7dcfff"] });
    expect(worn?.tokens.accent).toBe("#7dcfff");
    expect(worn?.tokens.ramp).toEqual(["#7dcfff"]);
    expect(worn?.tokens.text).toBe(keyworkNight.text);
  });

  it("leaves every token it was not handed equal to keywork-night's", () => {
    const [worn] = startupThemes({ accentSoft: "#7dcfff" });
    const { accentSoft, ...rest } = worn?.tokens ?? keyworkNight;
    const { accentSoft: night, ...nightRest } = keyworkNight;
    expect(accentSoft).toBe("#7dcfff");
    expect(accentSoft).not.toBe(night);
    expect(rest).toEqual(nightRest);
    expect(worn?.density).toEqual(keyworkNightTheme.density);
    expect(worn?.chromeWeight).toBe(keyworkNightTheme.chromeWeight);
    expect(worn?.pair).toBe("keywork-day");
  });

  it("keeps the gallery's hand-set sections when nothing is overridden", () => {
    const [worn] = startupThemes({}, [], "gruvbox-dark");
    expect(worn?.terminal?.brightYellow).toBe("#fabd2f");
    expect(worn?.syntax?.keyword).toBe("#fb4934");
  });

  it("drops the hand-set sections under overrides so they re-derive from the new palette", () => {
    const [worn] = startupThemes({ panel: "#3a3d52", panelLift: "#3a3d52" });
    expect(worn?.syntax).toBeUndefined();
    expect(worn?.terminal).toBeUndefined();
    const completed = completeTheme(worn ?? keyworkNightTheme);
    expect(() => parseTheme(completed)).not.toThrow();
  });

  it("refuses overrides that sink below the contrast floor, helpfully", () => {
    expect(() => startupThemes({ text: "#20222e" })).toThrow(/text on background/);
  });

  it("wears the named closet theme first and keeps the whole gallery hanging", () => {
    const [worn, ...rest] = startupThemes({}, [firstLight], "first-light");
    expect(worn).toEqual(firstLight);
    expect(rest).toEqual(gallery);
  });

  it("wears any gallery theme by name with no closet at all", () => {
    const [worn, ...rest] = startupThemes({}, [], "rose-pine-dawn");
    expect(worn?.name).toBe("rose-pine-dawn");
    expect(worn?.appearance).toBe("light");
    expect(rest.map((theme) => theme.name)).not.toContain("rose-pine-dawn");
    expect(rest).toHaveLength(gallery.length - 1);
  });

  it("lets a closet theme replace the gallery theme of the same name", () => {
    const tailored = parseTheme({ ...keyworkNightTheme, gap: 2 });
    const themes = startupThemes({}, [tailored]);
    expect(themes[0]).toEqual(tailored);
    expect(themes.filter((theme) => theme.name === "keywork-night")).toHaveLength(1);
  });

  it("lays overrides over the worn theme, whichever it is", () => {
    const [worn] = startupThemes(
      { accent: "#1f8a99", ramp: ["#1f8a99"] },
      [firstLight],
      "first-light",
    );
    expect(worn?.tokens.accent).toBe("#1f8a99");
    expect(worn?.tokens.background).toBe(firstLight.tokens.background);
  });

  it("falls back to keywork-night when the named theme is not in the closet", () => {
    const [worn, ...rest] = startupThemes({}, [firstLight], "neo-tokyo");
    expect(worn).toEqual(keyworkNightTheme);
    expect(rest.at(-1)).toEqual(firstLight);
    expect(rest).not.toContain(keyworkNightTheme);
  });
});

describe("theme hot-swap", () => {
  it("swaps the live theme through the palette command and repaints", () => {
    const probe = new AppProbe();
    const themes = new ThemeSwitch([keyworkNightTheme, firstLight]);
    let repaints = 0;
    registerThemeCommands(probe.core.registry, themes, {
      repaint: () => {
        repaints += 1;
      },
      notice: (text) => probe.core.postNotice(text),
    });
    expect(themes.palette.background).toBe(keyworkNight.background);
    expect(probe.command("theme-first-light")).toBe(true);
    expect(themes.active.name).toBe("first-light");
    expect(themes.palette.background).toBe("#f2f2f7");
    expect(repaints).toBe(1);
    expect(probe.snapshot().notice).toBe("theme now first-light");
  });

  it("stays put when asked for the theme already worn", () => {
    const probe = new AppProbe();
    const themes = new ThemeSwitch([keyworkNightTheme, firstLight]);
    let repaints = 0;
    registerThemeCommands(probe.core.registry, themes, {
      repaint: () => {
        repaints += 1;
      },
      notice: (text) => probe.core.postNotice(text),
    });
    expect(probe.command("theme-keywork-night")).toBe(true);
    expect(themes.active.name).toBe("keywork-night");
    expect(repaints).toBe(0);
    expect(probe.snapshot().notice).toBe("already wearing keywork-night");
  });

  it("offers one palette command per gallery theme", () => {
    const probe = new AppProbe();
    const themes = new ThemeSwitch(startupThemes());
    registerThemeCommands(probe.core.registry, themes, { repaint: () => {}, notice: () => {} });
    const names = probe.core.registry.all().map((command) => command.name);
    for (const theme of gallery) expect(names).toContain(`theme-${theme.name}`);
    expect(probe.command("theme-flexoki-light")).toBe(true);
    expect(themes.palette.background).toBe("#fffcf0");
  });

  it("refuses to wear a theme it never validated", () => {
    const themes = new ThemeSwitch([keyworkNightTheme]);
    expect(() => themes.swap("neo-tokyo")).toThrow(/no theme named "neo-tokyo"/);
  });
});
