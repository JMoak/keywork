import { parseTheme, type Theme, themeNamed, wardrobe } from "@keywork/shared";
import type { CommandRegistry } from "./commands.ts";
import type { Palette, PaletteOverrides } from "./palette.ts";

export type { Theme } from "@keywork/shared";

export const keyworkNightTheme: Theme = galleryTheme("keywork-night");

export function paletteOf(theme: Theme): Palette {
  return theme.tokens;
}

export function startupThemes(
  overrides: PaletteOverrides = {},
  closet: readonly Theme[] = [],
  wear: string = keyworkNightTheme.name,
): Theme[] {
  const hanging = wardrobe(closet);
  const worn =
    hanging.find((theme) => theme.name === wear) ??
    hanging.find((theme) => theme.name === keyworkNightTheme.name) ??
    keyworkNightTheme;
  return [dressedIn(worn, overrides), ...hanging.filter((theme) => theme !== worn)];
}

export function dressedIn(theme: Theme, overrides: PaletteOverrides = {}): Theme {
  if (Object.keys(overrides).length === 0) return theme;
  const { terminal, syntax, diff, selection, cursor, ...base } = theme;
  return parseTheme({ ...base, tokens: { ...theme.tokens, ...overrides } });
}

export class ThemeSwitch {
  private readonly closet: Map<string, Theme>;
  private worn: Theme;

  constructor(themes: readonly Theme[]) {
    const [first, ...rest] = themes;
    if (first === undefined) throw new Error("ThemeSwitch needs at least one theme");
    this.closet = new Map([first, ...rest].map((theme) => [theme.name, theme]));
    this.worn = first;
  }

  get active(): Theme {
    return this.worn;
  }

  get palette(): Palette {
    return paletteOf(this.worn);
  }

  names(): string[] {
    return [...this.closet.keys()];
  }

  swap(name: string): Theme {
    const next = this.closet.get(name);
    if (next === undefined) throw new Error(`no theme named "${name}"`);
    this.worn = next;
    return next;
  }

  refit(theme: Theme): boolean {
    if (!this.closet.has(theme.name)) return false;
    this.closet.set(theme.name, theme);
    if (this.worn.name !== theme.name) return false;
    this.worn = theme;
    return true;
  }
}

export function registerThemeCommands(
  registry: CommandRegistry,
  themes: ThemeSwitch,
  seams: { repaint(): void; notice(text: string): void },
): void {
  for (const name of themes.names()) {
    registry.register({
      name: `theme-${name}`,
      description: `repaint every surface in the ${name} theme`,
      run: () => {
        if (themes.active.name === name) {
          seams.notice(`already wearing ${name}`);
          return;
        }
        themes.swap(name);
        seams.repaint();
        seams.notice(`theme now ${name}`);
      },
    });
  }
}

function galleryTheme(name: string): Theme {
  const theme = themeNamed(name);
  if (theme === undefined) throw new Error(`the gallery has no theme named "${name}"`);
  return theme;
}
