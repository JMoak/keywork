# Themes

A theme is keywork's one theming unit (100/PD15, renamed from "flavor" on 2026-10-11): a
single readable record that dresses every surface, the terminal UI and keywork-app alike.
The schema lives in `packages/shared/src/config/theme.ts`, the derivation rule in
`complete-theme.ts`, and the curated gallery in `gallery.ts` with one file per family under
`config/themes/`. `GET /themes` is how a client receives them.

## The record

| Field | Required | What it carries |
|---|---|---|
| `name` | yes | lowercase slug; the palette command is `theme-<name>` |
| `appearance` | yes | `dark` or `light` |
| `tokens` | yes | the thirteen base tokens plus the 1 to 6 stop `ramp` |
| `density` | yes | which ink each density step (`light`, `medium`, `heavy`, `full`) wears |
| `gap`, `chromeWeight`, `instruments` | yes | composition taste: cells between panes, `regular` / `seams` / `borderless`, `calm` / `cockpit` |
| `terminal` | no | the ANSI 16: `black red green yellow blue magenta cyan white` and their `bright*` twins |
| `syntax` | no | `comment keyword string number type function variable constant operator punctuation tag attribute heading link invalid` |
| `diff` | no | `insertedLine deletedLine insertedText deletedText` grounds |
| `selection` | no | `background`, optional `text` |
| `cursor` | no | one color |
| `pair` | no | the opposite-appearance twin's name, so `system` can follow the OS |

Every section is optional, so every theme file written before them still loads.

## Contrast floors

`parseTheme` refuses a theme that fails any floor and names every failing pair in one
message. Base tokens keep their floors (text 60 on every ground, textMid 30, textDim 15,
border 5, borderFocus, accent, success, and error 40, accentSoft 25; density light 15,
medium 30, heavy 45, full 40). The sections add, in APCA Lc:

| Pair | Floor |
|---|---|
| every `syntax` role on `panel` | 30 (`comment` 15) |
| `terminal` red, green, yellow, blue, magenta, cyan and their bright twins on `background` | 30 |
| `selection.text` (else `text`) on `selection.background` | 45 |
| `text` on `diff.insertedLine` and on `diff.deletedLine` | 60 |
| `cursor` on `background` | 40 |

`black`, `white`, `brightBlack`, and `brightWhite` carry no floor: by convention one of each
pair sits near the ground. `pair` is proved in the gallery test (it must name a gallery
theme of the opposite appearance that names this one back), not in the schema.

## The derivation rule

`completeTheme(theme)` fills every missing section from the thirteen base tokens, the same
way on every surface, and keeps every section the theme states by hand. Terminal: black
`panelLift`, red `error`, green `success`, yellow the OKLab midpoint of `success` and
`error`, blue `ramp[1]` (else `accent`), magenta `accent`, cyan `ramp[2]` (else
`accentSoft`), white `textMid`, brightBlack `textDim`, brightWhite `text`, and each bright hue
its normal hue mixed 20% toward `text`. Syntax: comment `textDim`; keyword and heading
`accent`; string `success`; number, constant, and attribute the derived yellow; type the
derived cyan; function and link the derived blue; variable `text`; operator and punctuation
`textMid`; tag and invalid `error`. Every floored ink then steps toward `text` in 1% OKLab
mixes until it clears its floor. Diff: `success` and `error` mixed into `panel` in OKLab at
14% for lines and 28% for text spans, the line mix stepping back toward `panel` until `text`
clears 60. Selection: `accentSoft` mixed 30% into `panelLift`, stepping back until `text`
clears 45. Cursor: `accent`. Because each step ends at a color the base floors already
guarantee (`text`, `panel`, `panelLift`), the rule always produces a theme that parses.

Palette overrides in config (`palette`) re-tailor the base tokens, so the worn theme's
hand-set sections are dropped and re-derived from the overridden palette rather than kept
out of key with it.

## The gallery

Every gallery theme states all five sections by hand.

| Theme | Appearance | Pair | chromeWeight | gap | instruments | Source |
|---|---|---|---|---|---|---|
| `keywork-night` | dark | `keywork-day` | seams | 0 | calm | Tokyo Night (enkia, MIT) |
| `keywork-day` | light | `keywork-night` | seams | 0 | calm | keywork's own |
| `catppuccin-mocha` | dark | `catppuccin-latte` | seams | 1 | calm | Catppuccin (MIT) |
| `catppuccin-latte` | light | `catppuccin-mocha` | seams | 1 | calm | Catppuccin (MIT) |
| `nord` | dark | `nord-light` | regular | 0 | calm | Nord (MIT) |
| `nord-light` | light | `nord` | regular | 0 | calm | Nord's palette, Snow Storm as ground |
| `gruvbox-dark` | dark | `gruvbox-light` | regular | 0 | calm | gruvbox (MIT) |
| `gruvbox-light` | light | `gruvbox-dark` | regular | 0 | calm | gruvbox (MIT) |
| `everforest-dark` | dark | `everforest-light` | seams | 1 | calm | Everforest (MIT) |
| `everforest-light` | light | `everforest-dark` | seams | 1 | calm | Everforest (MIT) |
| `kanagawa-wave` | dark | `kanagawa-lotus` | seams | 0 | calm | Kanagawa (MIT) |
| `kanagawa-lotus` | light | `kanagawa-wave` | seams | 0 | calm | Kanagawa (MIT) |
| `rose-pine` | dark | `rose-pine-dawn` | seams | 1 | calm | Rosé Pine (MIT) |
| `rose-pine-dawn` | light | `rose-pine` | seams | 1 | calm | Rosé Pine (MIT) |
| `matte-black` | dark | none | borderless | 1 | cockpit | after Omarchy's Matte Black (MIT) |
| `osaka-jade` | dark | none | borderless | 0 | calm | after Omarchy's Osaka Jade (MIT) |
| `ristretto` | dark | none | seams | 0 | cockpit | keywork's own warm espresso palette |
| `flexoki-dark` | dark | `flexoki-light` | seams | 1 | calm | Flexoki (Steph Ango, MIT) |
| `flexoki-light` | light | `flexoki-dark` | seams | 1 | calm | Flexoki (Steph Ango, MIT) |

Twins share composition (chrome weight, gap, instruments), so following the OS between
them never relayouts. Density varies by palette: the Catppuccin and Kanagawa twins set
`medium` on `accentSoft`, and Everforest, Rosé Pine, Flexoki, and ristretto ring the
needs-you `full` step in `error`.

`ristretto` borrows a name, not a palette: Monokai Pro is not MIT, so ristretto is an
original warm-espresso design. Where a project's canonical shade misses a floor, the
gallery uses the smallest OKLCh lightness step that clears it; `gallery.test.ts` tables
every such shade with its canonical value and proves the canonical one fails, so a
deviation is always visible. Attributions are in `NOTICE` under "Themes".

## Choosing a theme

`theme` in `keywork.json` names the startup theme (a gallery name, a closet theme, or
`system`, which derives a theme from the terminal's own colors). `palette` holds
token-by-token overrides laid over whichever theme is worn. The pre-rename keys still load
for one release: `flavor` reads as `theme`, and an object under `theme` reads as `palette`.
In the TUI every theme is a palette command (`theme-catppuccin-latte`), swapped live.

The terminal UI paints from the base tokens only: its design language keeps syntax inside
the existing tokens, and its diff pane colors outcome words rather than line grounds. The
sections exist for surfaces that paint code, terminals, and selections directly, today
keywork-app, which receives them complete from `GET /themes`.
