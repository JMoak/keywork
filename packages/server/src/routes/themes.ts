import type { ThemesPort } from "../host.ts";
import { servedBy } from "./answers.ts";
import { json, type RouteFamily, type RouteSpec } from "./family.ts";

export const themeRoutes = [
  {
    method: "GET",
    path: "/themes",
    operationId: "listThemes",
    summary:
      "Every theme the server can hand a client whole: the curated gallery (keywork-night, keywork-day, and the Catppuccin, Nord, Gruvbox, Everforest, Kanagawa, Rosé Pine, Flexoki, matte-black, osaka-jade, and ristretto themes) plus any closet theme, which replaces a gallery theme of the same name. Each record is complete: name, appearance, tokens, density, gap, chromeWeight, instruments, and always terminal (the ANSI 16), syntax, diff, selection, and cursor, filled by keywork's derivation rule where the theme leaves one out, so every client paints from the same colors. `pair` names the opposite-appearance twin when there is one, so a client following the OS swaps between a matched light and dark. `active` is the configured startup theme. `placeholders` names themes the terminal derives from its own environment (`system`, from the terminal's colors); a client fills those from its own surface so both surfaces list the same names.",
    authenticated: true,
    responses: { "200": "The themes.", "503": "This host serves no themes." },
  },
] as const satisfies readonly RouteSpec[];

export const themeFamily = {
  routes: themeRoutes,
  handlers: ({ host }) => {
    const themes = servedBy((): ThemesPort | undefined => host.themes, "themes");
    return { listThemes: themes(async (port) => json(200, await port.list())) };
  },
} satisfies RouteFamily<typeof themeRoutes>;
