# The Page Pass — Decision Overlay (2026-08-16)

> **Authoritative overlay** (wins over 103 and below where it speaks). Decision session
> on transcript typography — closing the "raw TUI" gap with the flagship coding agents
> while keeping keywork's newspaper identity. Candidates were rendered options-first
> (the page-pass mock gallery, real keywork-night palette, one fixture turn across all
> frames); Jordan picked per section. The decided vocabulary is written into
> `../design-language.md` ("The page" section — the record); this file carries the
> rationale, the deltas, and the tasks.

## PD18 — The page (Jordan, 2026-08-16)

1. **The newspaper is embraced, then governed.** No centered floating columns, ever.
   A **width-tier grammar** (broadsheet ≥100 cols · column 70–99 · clipping 40–69 ·
   masthead <40) is the one resolution every page property derives from: padding,
   prose measure, tonal depth, and the masthead treatment. Terminal reality stated
   honestly: cell size is fixed, so the type scale is a **content scale** — what
   renders and how condensed, never font size; big type exists only as block-glyph
   headlines. The goldilocks tuning of thresholds happens against real captures.
2. **Adaptive measure + the density rail, combined** (mock routes R1 ⊕ R2). Prose
   obeys the tier's measure; machine output always runs full bleed; a two-cell left
   rail owns voice stamps and body text hangs from it, never touching the border. The
   rail is arc hue's future home. R3 (hard prose cap at every width) not adopted.
3. **Masthead tier**: below ~40 cols the transcript yields — session topic fitted as a
   block-glyph headline (tier-2; tier-0 caps fallback) plus one status line. A tiny
   pane becomes a labeled tile instead of an unreadable text slit.
4. **Markdown renders — "louder with simplicity maintained."** Louder structure
   (heading density mark, accent list markers, fence rail + language tag), quiet
   palette (highlighting through existing theme tokens only; the ramp does double
   duty; no dedicated highlight colors). Literal markdown characters never render.
5. **Tonal ladder**: `textMid` + `panelLift` added now (landed with this overlay —
   before C49 freezes the flavor schema); `textFaint` exists as a concept but is
   **reserved to the broadsheet tier**, shipping only if a real capture earns it.
   Tone depth is tier-resolved: three tones everywhere, the full ladder above the
   broadsheet threshold.
6. **Block voice = density stamps** (mock V4), pushed further: `█` user · `▓` agent ·
   `░` machine, riding the rail. This **resolves the ramp-overload question in favor
   of reuse** — voice IS provenance ("denser = closer to you" applied to the page),
   not a second meaning. Next-level obligations: the agent's stamp builds `░→▒→▓`
   while streaming (motion in ink, stepped, settles at `▓`); the stamp doubles as the
   fold/disclosure handle on tool blocks; further creative elevation explored in C61's
   options round.
7. **The tool row**: fold-stamp · verb · subject · duration/size · outcome (only
   colored word); expanded detail under a faint rule; V2.1's tail streams in-row and
   settles to the one-liner.

## Landed with this overlay

- **C58 (1pt) — tonal tokens** ✅ 2026-08-16: `textMid` (#828bb8) and `panelLift`
  (#24283b) in `tui/theme.ts`, override-validated like every token. Sequenced ahead of
  C49 deliberately.
- **C59 (3pt) — width-tier page grammar** ✅ 2026-08-17: `tui/page.ts` (tier resolution,
  `.describe()`-justified `page` threshold config through cli → runApp → ConversationPane,
  re-resolved every render so resize crosses tiers within a frame; prose folds at the
  tier measure behind the gutter while tool rows and fence interiors run full bleed —
  fences behind the two-cell `▎` rail). Capture leg: `page-tiers` e2e scenario renders
  the one fixture turn zoomed at 132/84/56/32 with structural assertions (fence intact
  only at broadsheet, prose never intact); the four captures in
  `artifacts/e2e/page-tiers/` await Jordan's approval, and the masthead-width capture
  honestly shows a condensed transcript until C63 builds the tile.
- **C61 (2pt) — density-stamp voice & the rail** — base LANDED 2026-08-17, options round
  OPEN: two-cell rail on every transcript entry (`█` user · `▓` agent · `░` machine ·
  blank for notices; continuation rows hang blank), streaming stamp steps `░→▒→▓` off
  text deltas (deterministic, no timers; settles `▓` on complete/interrupt — the C53
  animator integration can replace the delta clock later without changing the surface),
  stamp-as-fold on tool rows (click any tool row; tab on an empty prompt toggles the
  newest disclosed-capable row — reaching older rows by keyboard is an options-round
  question), the user `› ` transcript prefix retired (the rail carries voice; the prompt
  keeps `›`). Jordan's creative-elevation candidates (C40-rendered) still owed; noted
  nit for that round: an h2's `▓` heading mark sits beside the agent's `▓` stamp.
- **C62 (1pt) — the tool row** ✅ 2026-08-17: collapsed form `verb subject · duration ·
  size · outcome` with outcome the only colored word (failures append the reason dim:
  `· failed — declined by user`), replay suppresses meaningless durations, disclosure
  under a faint rule at the prose measure (args + output capped at 12 lines with an
  overflow mark), V2.1 tail now streams inside the row (`verb · <live line>`,
  ANSI-stripped via TailFollow) and settles to the one-liner — the separate tail block
  and its `tail` line kind are retired. Fixtures: `page-tiers` captures 01–03
  (rail/row/fold round-trip mouse-open → tab-close, structurally asserted).
- **C64 (2pt) — title-bar grammar & lifecycle stamp** ✅ 2026-08-17: `tui/title-bar.ts`
  two-zone composer over C59's tiers (broadsheet = stamp·name·telemetry·mode-word seam;
  column drops mode and shows telemetry focused-only; clipping/masthead = stamp + fitted
  name via engine `fitTitle` with live sibling avoid-sets; shed order mode → telemetry →
  name words, stamp last standing; calm idle pane = byte-identical ` name ` — goldens
  unchanged). Lifecycle stamp on conversation panes: working = event-stepped `░▒▓` fill
  (model activity ticks, no timers), **needs-you = `█⇄▓` pulse at quick tempo (Jordan's
  pick this session over a ▓-hold; caveat accepted: under reduced-motion/monochrome the
  settled pulse frame equals the finished-unseen `█` — accent color and the ask row
  disambiguate)**, finished-unseen = `█` held until focus then density-drain at settle
  tempo, failed = `▛` held-then-drain, idle = blank. **C53's Animator is now actually
  wired** (shared instance in runApp, onFrame → coalesced render, settled on exit);
  pulse is self-healing per render, drain uses departure shape. Telemetry zone renders
  `usageSummary` (cost-first) behind the seam until the 102 lens session; `title()`
  stays clean for jump-commands/snapshots — composition happens in `view()` where width
  and focus live. Tests: title-bar.test.ts (9) + conversation-pane.test.ts (8, manual-
  scheduler Animator; drain-only-on-focus, ask-stamp exactness, focused-completion
  skips the hold). Live pulse visible in the first-conversation ask capture
  (`▓ session-1`).

## Landed — stream 2, the page finished (2026-08-21)

- **C60 (2pt) — markdown in the transcript** ✅ 2026-08-21 (completes the 08-17 base):
  every page mark now resolves through one tier seam, `tui/marks.ts` —
  `pageMarks(GlyphSupport)` → voice stamps, streaming ramp, heading weights, bullet,
  rule, fence rail (tier-0 ASCII: `# + .` voice · `= - : .` headings · `-` bullet/rule ·
  `|` rail). `ConversationPane` takes `glyphs`; the default is the deterministic
  `assumedGlyphs` (tier 2) so captures never depend on the host terminal, and the
  `runApp` line (`glyphs: options.glyphs ?? detectCapabilities()`) lands after stream 1's
  `app.ts` entry settles. **Heading marks left the density ramp for a weight ramp**
  `█ ▌ ▎ ▏` (h1 · h2 · h3 · h4+): the `▓ ▓` heading-beside-agent-stamp nit is gone — the
  broadsheet capture now reads `▓  ▌ the page`. Accept met: literal `**`/backticks never
  visible, malformed markdown stays calm plain text, tier-0 render legible.
- **C52 (2pt) — fence highlighting** ✅ 2026-08-21: `tui/highlighter.ts`, a zero-dep
  lexical tokenizer written as grammar *data* over one scanner — ts/js/tsx/jsx, json
  (keys vs values), sh/bash/zsh (`$VAR`, boundary-only `#`), py (triple quotes), go, rust,
  diff (line marks), md — with per-fence block state so block comments, template
  literals, and docstrings carry across lines. Classes keyword · type · constant ·
  string · comment · punctuation · added · removed · hunk, colored **through theme tokens
  only**: keyword/type/constant = ramp stops 0/1/2 (the ramp does double duty), string =
  `success`, comment/hunk = `textDim`, punctuation = `textMid`, added/removed =
  `success`/`error`. Unknown languages render unstyled; hard-wrap preserves spans; a
  5k-line block tokenizes well inside the frame budget (bounded test). Rhythm rules ride
  C59/C61; the fixture-capture approval closes C52.
- **C63 (2pt) — the masthead** ✅ 2026-08-21: `tui/masthead.ts`, an own 3×5 block-letter
  face (A–Z, 0–9) rasterized as half-blocks at tier 2, full blocks at tier 1, caps at
  tier 0 — no figlet. The arc prefix is shed (the border hue carries the family), slug
  separators fall away, and `fitTitle` drops words by sibling rarity when rows run short.
  The block face is used only when **every** word of the title sets within the line;
  otherwise the whole headline goes to caps, so a too-wide word never degrades into a
  lone generic leftover (`session-1` at 26 cells → `SESSION 1`, not a giant `1`). One
  status line beneath (working · failed · idle, plus telemetry). Never renders while a
  draft, ask, backtrack, or disclosure is live — input outranks ceremony. Captures:
  `page-tiers/08-masthead-38` (block face), `09-masthead-32` (caps fallback), plus the
  typing leg that dismisses and restores the tile.
- **C61 options round — keyboard reach** ✅ 2026-08-21: `shift+tab` on an empty prompt
  walks a fold cursor to older disclosable rows (wrapping to newest), `tab` toggles the
  cursored row, `esc` or typing leaves; the cursored row borrows backtrack's inversion
  (no new vocabulary) and a hint row names the keys; the reveal scrolls the row into
  view. Captures `04-tool-row-keyboard-open` / `05-…-refolded`. Still owed from the round:
  the creative-elevation candidates (arc-hued user stamps, turn-age fading, stamp column
  as scroll map) as C40 renders for Jordan's pick.
- **C66 (1pt) — slug display grammar** — partial ✅ 2026-08-21: `tui/slug.ts` is the one
  renderer (`slugParts` → lit words, `textDim` separators, `accentSoft` colon;
  `slugWords` → human words), applied to overview rows and the masthead. **Constraint of
  record:** OpenTUI's border `title` is a single-color string, so the title-bar rung
  waits on keywork drawing its own top border (or an upstream styled title) — left
  honest rather than faked.
- **C55** gauge half ✅ 2026-08-21: the title-bar telemetry zone now carries the context gauge
  beside cost (`session-1 · ▒ 1.6k · $0.01`), the masthead status line carries it too; see
  [`109-long-session-survivability.md`](109-long-session-survivability.md) for the ledger and the open options round.

## Tasks

IDs continue the C-scheme. Same scale and style as the workstream files.

### C59 (3pt) — Width-tier page grammar
The one shared resolution module: pane width → tier → {padding, measure, tone depth,
masthead flag}, consumed by every transcript render path; re-resolves on pane resize.
**Accept:** capture fixtures of the same turn at all four tiers approved; prose obeys
the tier measure while tool output/diffs/fences run full bleed at every tier; resize
across a threshold re-renders within one frame; tier thresholds are named constants
with `.describe()`-justified config overrides.
**Strategy:** `OWN`. Rides C35 rect truth; before C52's rhythm lands on top.

### C60 (2pt) — Markdown rendering in the transcript
Inline (bold/italic/code spans/links) + block (headings, lists with hanging indents,
fences on `panel`, rules) rendered per PD18's louder-simple treatment; zero-dep parser
scoped to render well, never to parse the whole spec. C52's highlighter colors fence
interiors; C52 is **widened** to explicitly include this (its "typography" was
underspecified — this task is that half).
**Accept:** fixture doc capture approved; literal `**`/backticks never visible;
malformed markdown degrades to plain text calmly; tier-0 render legible (marks
ASCII-fallback per PD14).
**Strategy:** `OWN`.

### C61 (2pt) — Density-stamp voice & the rail
The two-cell rail with `█▓░` voice stamps; streaming stamp `░→▒→▓` through the C53
animator; stamp-as-fold on tool blocks; an options round for the creative elevation
Jordan asked for (candidates rendered via C40 — e.g. arc-hued user stamps, turn-age
fading, stamp column as scroll map), Jordan picks.
**Accept:** voice legible in monochrome capture (density alone suffices); streaming
stamp settles to final frame on interrupt (motion grammar); fold state round-trips
keyboard and mouse; chosen elevation approved from real captures.
**Strategy:** `OWN`. After C59; streaming leg rides C53.

### C62 (1pt) — The tool row
The one-line collapsed form (fold-stamp · verb · subject · duration/size · outcome)
and its disclosed form under a faint rule; V2.1 tail-follow rendered inside the row
while running, settling to the one-liner on finish.
**Accept:** every core tool renders the designed row in a fixture session; outcome is
the only colored word (capture-checked); tail settles without reflow flicker.
**Strategy:** `OWN`. Composes with C61's fold.

### C63 (2pt) — The masthead
Block-glyph headline fitted to tiny panes: an own minimal block-letter face (tier-2
half-blocks; tier-0 caps fallback — no figlet dependency), session-topic truncation
that keeps the distinctive words, one status line beneath; applies to any
transcript-bearing pane below the masthead threshold.
**Accept:** captures at several tiny geometries approved; tier-0 render finished, not
embarrassing (PD14 floor); headline updates when the session title changes; no
masthead ever renders in a pane the user is actively typing in (input outranks
ceremony).
**Strategy:** `OWN`. After C59 (tier resolution) and C48 (glyph tiers).

## Addendum — the title bar (PD19, Jordan, 2026-08-16, same session)

The chrome half of the page pass. Decided:

1. **Two-zone anatomy**: identity zone (lifecycle stamp, one cell, **left of the
   name**) + telemetry zone (the 102 lens slot — one value, workspace-lens resolved;
   FR4.12's "cost replaces `in▸out` in the title" lands *through* the lens, never as
   bespoke logic). Width-tier degradation rides C59's resolution: broadsheet = stamp ·
   name · telemetry · mode word; column drops the mode word; clipping = stamp +
   fitted name; masthead is the title.
2. **Identity intertwined with status — the lifecycle stamp** reuses tile-fill
   wholesale: working = filling · awaiting approval = accent `█` (needs-you) ·
   **finished-unseen** = completed tile held until the pane is focused, then ink
   drains (the notification formula's "state you see on return," made visible) ·
   failed = `▛` · idle/read = blank. No new vocabulary invented.
3. **Real-estate policy**: priority under narrowing is stamp > fitted name >
   telemetry > mode word; telemetry hides on unfocused panes below the column tier;
   the stamp is the last mark standing. Exact thresholds tuned against C40 captures
   with the C59 tiers.
4. Mode word dim and exception-only (PD12 chrome mandate satisfied); arc slug at
   broadsheet only, hue on the border otherwise; staleness marks live on overview
   rows, never on live pane titles.

### C64 (2pt) — Title-bar grammar & lifecycle stamp
The two-zone title composer over C59's tiers (replacing `paneTitle`'s flat
`name · detail`), the lifecycle stamp with its five states through the C53 animator
(finished-unseen hold-and-drain, failed `▛`), telemetry gated on focus + tier, mode
word for non-default modes.
**Accept:** capture fixtures across tiers × focused/unfocused × all five stamp states
approved; a calm read pane renders zero marks; finished-unseen drains only on focus
(probe); needs-you stamp matches the ask-gate state exactly (no stamp without a
pending ask); monochrome capture keeps every state legible (density alone).
**Strategy:** `OWN`. After C59; stamp animation rides C53; telemetry slot awaits the
102 lens session (renders today's usage summary until then, behind the same seam).

## Addendum 2 — the titling pipeline (PD20, Jordan, 2026-08-16, same session)

1. **The colon namespace.** The arc slug is both the constraint and the group mark:
   sessions render as `arc:session` with the colon as the grouping indicator, and the
   titler receives the arc's words as the hand-me-down avoid-set — the arc names the
   family, the session names only itself (`mcp-hardening:sleep-wake`, never
   `mcp-hardening:mcp-sleep-fix`). Width-relative: the prefix is the first thing
   `fitTitle` sheds (the border's arc hue already carries the family below broadsheet).
2. **Self-naming first, cheap call second.** The agent gets a `title_session` tool and
   is nudged to name the session as a side effect of its real turn — zero marginal
   calls, the model already holds the context. Fallback: if no title exists after
   turn two, the one-shot titler fires, pinned to a cheap model once the
   provider-factory seam lands (it is the canonical cheap call). Both paths flow
   through `kebabTitle` normalization, and titles are untrusted text (J7's
   hostile-title precedent applies to any surface that re-reads them).
3. **Retitle policy, next-level shape**: auto-apply until `userNamed` (flag split from
   `titleRequested`; user titles permanent); pivot triggers = compaction and
   fork-divergence (child retitles after its first post-fork turn, parent never);
   **title changes are session entries** (E5's rule), so the tree can show what a
   branch used to be called and renames carry provenance.
4. **Slug display grammar, size-relative**: the kebab slug is identity, but its
   *rendering* de-raws by surface — separators (hyphens, the colon) render in
   `textDim` while words hold `text`, so the slug reads as words at a glance and a
   slug on inspection; the colon may take `accentSoft`; at masthead the slug becomes
   human words (separators fall away entirely). One stored value, a rendering ladder.
5. **`fitTitle` decided as specced, landed** (see below): arc prefix first, then
   sibling-rarity-scored word drops (front-loaded generics go first on ties), floor of
   one word, head-ellipsis last. Property-tested: never wider than asked, and
   narrower widths never resurface dropped words.

### Landed with this addendum ✅ 2026-08-16
- `fitTitle(slug, width, siblings)` in `engine/titles.ts` — the shared fitting
  function for title bars, overview rows, and the masthead; exported from the engine.
- `suggestTitle` context: `{ arc, avoid }` — arc-word elision + sibling avoid-list in
  the prompt, backward-compatible. Wiring the real sibling/arc sets into the cli/TUI
  titler call sites rides C65.

### C65 (2pt) — The titling pipeline
`title_session` self-naming tool (nudge in the system posture, normalized through
`kebabTitle`, untrusted-title handling); turn-two fallback to the one-shot titler with
real `{arc, avoid}` context wired from the session store; `userNamed` split from
`titleRequested`; retitle on compaction + fork-divergence; title changes as session
entries surviving the Pi-format fixture.
**Accept:** self-named session never fires the fallback call (probe); fallback carries
sibling titles and arc in the prompt (fixture); user rename permanently silences both
paths; fork child retitles once, parent untouched; title-change entries round-trip
disk/branch/clone; a hostile self-title renders inert everywhere it is re-read.
**Strategy:** `OWN`. Cheap-model pin follows the provider-factory seam.

### C66 (1pt) — Slug display grammar
The rendering ladder over the stored slug: dim separators / lit words in title bars
and overview rows, `accentSoft` colon option (capture-decided), human-words
transformation at masthead; applied through one shared renderer so no surface
hand-rolls slug styling.
**Accept:** captures of the same slug across the ladder approved; monochrome render
still reads (dim separators survive NO_COLOR as plain hyphens); masthead words carry
no separators.
**Strategy:** `OWN`. Rides C64/C63. The title-bar rung's blocker (single-color
OpenTUI title, see the 2026-08-21 landed note) is lifted by C69's own title row.

## Addendum 3 — needs-you chrome (PD25, Jordan, 2026-08-21)

The lifecycle stamp (PD19 item 2, landed as C64) carries state in one cell. This
addendum lets the *rest* of the pane chrome answer it, under the rules already written:
the notification formula (needs-you is the only notifying state), PD8's "hue is
identity, never state" with its 2026-08-16 clause (saturation/luminance may reinforce a
density-carried state), and the existing meaning of inversion (the selected/cursored
row, borrowed by the fold cursor and backtrack). Decided:

1. **Inversion extends to the title label, needs-you only.** A pane with a pending ask
   renders its title label inverted: ground = the pane's own ramp hue, ink =
   `background`, one cell of padding each side, stamp `█` inside it. The meaning is the
   one inversion already has (*the thing your keystroke targets*), applied to a pane
   instead of a row. No other lifecycle state ever inverts; finished-unseen inverting
   would make completions notify, which the formula forbids.
2. **The outline reinforces, never carries.** On needs-you the pane border takes its
   own identity hue with a **saturation lift only** (luminance untouched, so the focused
   pane's luminance lift stays unambiguous). Hue acquires no state meaning; the
   density-carried state (inverted label + `█`) must read alone in monochrome.
3. **The quiet states get one quiet step each.** Finished-unseen: name ink steps from
   border ink to `textMid` ("something to read"), draining on focus with the stamp.
   Failed-unseen: name ink = `error` (outcome ink on the outcome word, the tool-row
   rule). Neither touches the border or the ground. Idle and working stay byte-identical
   to C64.
4. **Motion rides C53.** The inverted ground *arrives* at quick tempo (ground fades up
   from border ink to the full hue), leaves instantly on the next keystroke (input
   outranks motion); reduced-motion renders the final frame only.
5. **The away-state stays G6's.** This addendum is the return-state made visible in the
   TUI; terminal-unfocused delivery (focus tracking + OpenTUI's native
   `triggerNotification` / OSC 777 / bell) remains G6 (90-plan-review), decoupled.

Open, decided by C40 captures rather than argument:

- **Q-P1 Pulse vs. steady.** C64's `█⇄▓` pulse was chosen when inversion was not on the
  table; with the inverted label carrying needs-you the pulse is a second signal on the
  same cell and an unfocused pane pulsing while you read another is the "nothing flashing
  while the user reads" case. Recommendation: steady inverted label; the pulse retires to
  the monochrome / `NO_COLOR` floor where inversion cannot carry the state.
- **Q-P2 Saturation lift vs. border weight.** Heavy `┃━` is denser ink (monochrome-honest)
  but OpenTUI's heavy style has square corners and would break corner consistency against
  `╭╮` neighbors. Recommendation: saturation lift (item 2 as written).

### C69 (2pt) — Own title row & needs-you chrome (implements PD25)
`paneChrome` stops passing `title` to the OpenTUI Box: a borderless wrapper at the pane
rect holds the bordered Box plus an absolutely positioned `StyledText` title over the
border row (`zIndex` above), so `titleBar()` composes spans (stamp · name · telemetry ·
mode word, each with its own ink) instead of a string; `title()` stays clean for
jump-commands/snapshots as C64 left it. One resolver beside `paneBorder` in `chroma.ts`,
`lifecycleChrome(state, focused, hue, theme) → { labelInk, labelGround, borderColor }`,
fed by the `LifecycleState` the stamp already computes; `paneViewFor` and the
conversation pane read from it, never hand-pick colors. No new flavor tokens: ground =
ramp hue, ink = `background`, warmed border = OKLCH chroma step on the identity hue
(`focusLift`'s shape with a saturation-only target).
**Accept:** captures across the five stamp states × focused/unfocused × tier ×
monochrome approved; idle and working goldens byte-identical to C64; inversion appears
iff a pending ask exists (the ask-stamp exactness test, extended); finished-unseen and
failed never invert and never touch the border (pinning tests); monochrome capture reads
every state from density alone; arrival/settle timings match the C53 tables; the C66
slug rung renders through the same span composer with no second title path.
**Strategy:** `OWN`. Rides C64/C53; unblocks C66's title-bar rung. G6 separate.

## Deltas of record

- **C52 widened** — inline markdown rendering was unstated; C60 carries it; C52
  retains rhythm rules + the highlighter, now explicitly *on top of* C59's tiers.
- **Q6 of 102 (provenance-ink reuse) is resolved for the transcript**: reuse, by
  PD18 item 6's voice-is-provenance argument. The 102 design session still decides
  the *config-origin chip* case on its own merits.
- **C49 sequencing note**: the flavor schema now includes `textMid`/`panelLift`
  (landed) and reserves `textFaint` as an optional broadsheet-tier token.
- Mock gallery of record: the page-pass artifact (2026-08-16), fixture content, real
  palette.
