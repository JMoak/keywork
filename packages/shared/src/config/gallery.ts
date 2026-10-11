import { parseTheme, type Theme } from "./theme.ts";
import { catppuccinLatte, catppuccinMocha } from "./themes/catppuccin.ts";
import { everforestDark, everforestLight } from "./themes/everforest.ts";
import { flexokiDark, flexokiLight } from "./themes/flexoki.ts";
import { gruvboxDark, gruvboxLight } from "./themes/gruvbox.ts";
import { kanagawaLotus, kanagawaWave } from "./themes/kanagawa.ts";
import { keyworkDay, keyworkNight } from "./themes/keywork.ts";
import { nord, nordLight } from "./themes/nord.ts";
import { matteBlack, osakaJade, ristretto } from "./themes/originals.ts";
import { rosePine, rosePineDawn } from "./themes/rose-pine.ts";

export const gallery: readonly Theme[] = [
  keyworkNight,
  keyworkDay,
  catppuccinMocha,
  catppuccinLatte,
  nord,
  nordLight,
  gruvboxDark,
  gruvboxLight,
  everforestDark,
  everforestLight,
  kanagawaWave,
  kanagawaLotus,
  rosePine,
  rosePineDawn,
  matteBlack,
  osakaJade,
  ristretto,
  flexokiDark,
  flexokiLight,
].map((theme) => parseTheme(theme));

export function themeNamed(name: string): Theme | undefined {
  return gallery.find((theme) => theme.name === name);
}

export function wardrobe(closet: readonly Theme[] = []): Theme[] {
  const byName = new Map([...gallery, ...closet].map((theme) => [theme.name, theme]));
  return [...byName.values()];
}
