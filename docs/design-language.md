# keywork — Design Language (visual vocabulary of record)

> Decided by Jordan, 2026-08-10; chroma section added 2026-08-15 (98/PD8). This is the
> one system every surface speaks — memory pane (95/J9), MCP status dock (D14),
> staging/airlock (95/J11), notifications (G6/P2.4), status line (C18), permission
> presets (E2), pane chrome (98/C44–C45). Placeholder glyphs in earlier planning docs
> (`●◐○ ◇ M+ S±`) are superseded by this direction; exact characters below are the
> working set, refined in implementation against real terminal fonts.

## The material: density

One ramp (`░ ▒ ▓ █`) carries every meaning: state as *texture*, not icons. Terminal-
native (block elements render everywhere), theme-token colored, legible at one cell.
This is the "terminal video game" identity: ink density is the signal.

| Surface | Mapping |
|---|---|
| Curing (memory freshness) | `░` fresh → `▒` → `▓` → `█` settled; the garden gains ink as knowledge settles |
| Provenance | `█` user-stated · `▓` agent-inferred · `░` external/untrusted — denser = closer to you |
| Staging | `░` prefix + count (`░3` in the status line): staged items are low-density by definition |
| MCP server state (D14) | `█` connected · `▒` connecting · `░` down; per-server one-cell mark |
| Loading (all progress) | density fills: `░░▒▓█` |
| Notification badge | needs-you is the *only* notifying state (see formula) — rendered full-density, everything else stays quiet |

Rules: color is the second axis, never the only one (`NO_COLOR`/colorblind-safe by
construction — density survives monochrome); both light and dark themes map density to
contrast against the pane ground (C17 tokens); reduced-motion honored — animations
degrade to stepped density changes.

## The chroma: gradient depth (added 2026-08-15, 98/PD8)

The second axis gets its systematic role: **hue carries identity and depth, never
state.** Density says *what condition* a thing is in; hue says *which* thing it is among
many. The theme owns a **ramp** — ordered accent stops (keywork-night: violet → blue →
cyan, Tokyo Night natives), interpolated perceptually (OKLCH) — and every hued surface
draws from it:

| Surface | Mapping |
|---|---|
| Pane borders (ungrouped) | spawn-rank sweep along the ramp — window 1 violet, window 12 cyan; one pane ≡ today's flat accent |
| Focus | the pane's *own* hue lifted (luminance/saturation), never a separate global accent |
| Arc identity (98/PD9) | each arc claims an anchor hue (golden-angle spread); member panes micro-gradient around it |
| Cross-surface arc marks | the same anchor hue on sessions-overview rows, memory-pane arc headers, status-line arc chips |

Rules: hue is identity, so it travels with its pane/arc — never re-derived from screen
position; transitions are stepped (reduced-motion honored); every arc-hued surface also
carries the arc's slug tag, so grouping survives `NO_COLOR` and monochrome as text;
state stays density's job — a hue never means fresh/staged/failed. One clarification
(2026-08-16, 98 addendum): **saturation/luminance of an identity hue may *reinforce* a
density-carried state** — e.g. the garden's distillation *heat* (98/C47) renders as
density first, warmed by saturation lift within the note's arc hue — but hue itself
never acquires a state meaning, and density alone must always suffice (monochrome-safe
by construction).

## The glyphs: three tiers (added 2026-08-16, 100/PD14)

Every mark declares its tier and its fallback one tier down: **tier 0** pure ASCII (the
floor every surface must survive at) · **tier 1** Unicode box/block (this document's
working set — the default material) · **tier 2** sub-cell (half-blocks `▀▄`, quadrants
`▘▝`, braille `⣿` for fine sparklines and tile-fill). Nerd Fonts are **never a
dependency**: detected and opted-in, a garnish tier may refine marks; absent, nothing
is missing — a default-terminal render and a riced render must both look finished.

## The signature animation: tile-fill

Progress marks are **the dwindle layout in miniature** — a one-cell rectangle splits and
fills as phases complete, the tiler's own geometry as its smallest animation:

```
connecting   ▌  →  ▌▀  →  ▌▀▗  →  █      ready: █ (holds)
failed       ▛ (a tile missing — the gap is the message)
```

Determinate when phases are known (MCP handshake → tools listed → ready); a gentle
split-cycle when not. Reused everywhere something works: D14 connections, Gardener
sweeps, index rebuilds, embedding warmup. Never a spinner.

## The motion grammar (drafted 2026-08-16, 100/PD16 — initial draft of record)

Seven rules. The first is the signature law; everything else serves it.

1. **Motion lives in ink, never in geometry.** Layout changes *snap* — rects are truth
   (97/PD7), and animated geometry lies to hit-testing and reflows text mid-read. What
   animates is ink: density, saturation, luminance. The terminal's native crossfade is
   `░▒▓█` — a pane arrives by gaining ink in place, never by sliding.
2. **Stepped and cell-honest.** No easing illusions fighting the grid; animation is
   discrete frames. Ease by *step distribution*: arrivals **snap-settle** (large first
   step, soft final steps, so they present immediately and then finish cleanly); departures
   **gather** (soft first, decisive last).
3. **Four named tempos, used by name:** `instant` (≤1 frame — state flips, focus) ·
   `quick` (~120ms, 2–3 steps — chips, marks, hover) · `settle` (~240ms, 4–6 steps —
   pane ink-in/out, dock moves, dim transitions) · `ceremony` (600–900ms — startup
   key-turn, airlock open; at most one per moment, never on the hot path, always
   skippable). No animation exists outside these four.
4. **One mover per region.** Concurrent triggers arbitrate; a second animation in the
   same region settles the first to final frame. The screen never swarms.
5. **The ambient budget** (conservative by decision): ambient motion only from *real
   events*, at whisper amplitude, **one ambient mark on screen at a time** — and
   nothing moves while the user is typing or reading scrollback.
6. **Input outranks motion, always.** Any keypress settles all animation to final
   frames immediately — the interface is never waiting for its own choreography.
7. **Every frame is atomic.** Synchronized output (DEC 2026) wraps every paint where
   supported; tearing is a bug rather than a degradation. Reduced-motion is the grammar's
   floor, not an exception: stepped degradation ends at *final frame immediately*, and
   every choreographed surface must be complete and legible there.

## The notification formula: needs-you only

A keywork notification always means **a keystroke is wanted**. Exactly two triggers,
both derived from work state, both when the workspace is unfocused:

1. An agent is blocked on a decision (ask-gate prompt, protected-core proposal).
2. The review inbox crossed its configured threshold (95/P3's long-session door).

Completions, failures, and milestones stay silent; they're dock/status state you see on return.
Transports (native toast / OSC 777 / bell / off) auto-select per terminal underneath and
are policy-configurable; the *formula* is not a mode enum.

## The status line grammar (C18)

`keywork · <model> · <preset-word> · ░n` — the E2 permission preset as a plain lowercase
word (policy-file bundle names, Jordan's naming call; divergence renders `custom`), the
staging count in ramp texture, token/cost per A15. Every item justified or absent.

## The page: transcript typography (added 2026-08-16, the page pass — 104/PD18)

The reading surface gets its grammar. One honest constraint frames everything: terminal
cell size is fixed, so **the type scale is a content scale** — what renders and how
condensed varies, font size never does; "big type" exists only as block-glyph headlines.

**The width-tier grammar.** A pane's width tier governs the page the way flavors govern
chrome — one resolution, every page property derives from it (working thresholds,
refined in implementation):

| Tier | Width | Padding | Measure | Tones | Treatment |
|---|---|---|---|---|---|
| broadsheet | ≥100 cols | 2 cells | prose ~88, left-anchored, never centered | full ladder (`textFaint` unlocked) | the full page |
| column | 70–99 | 1 cell | none — the rail composes full bleed | three | the working default |
| clipping | 40–69 | half | none | three | density-first, chrome shed |
| masthead | <40 | — | — | — | transcript yields to a fitted headline: session topic in block glyphs (tier-2; tier-0 caps fallback) + one status line |

Prose obeys the measure; machine output (tool detail, diffs, fences, tables) always
runs full bleed. The newspaper look is embraced where it naturally occurs and composed
where there's room.

**The density rail.** A two-cell left rail owns the voice stamps; body text hangs from
it and never touches the border. Full-bleed ink, composed ink — the rail is also where
arc hue lives when chroma arrives.

**Voice is provenance.** The transcript's spine reuses the provenance ramp — `█` user
(closest to you) · `▓` agent · `░` machine output — the same "denser = closer to you"
rule this document already binds, applied to the page rather than a new meaning. The
agent's stamp builds `░→▒→▓` while the turn streams and settles at `▓` (motion in ink,
stepped); on tool blocks the stamp doubles as the fold — the disclosure handle for
collapsed detail.

**Markdown renders, never shows.** Louder in structure, quiet in palette: headings =
accent + one density mark; list markers accent; code spans on `panelLift`; fences on
`panel` with a rail and a dim language tag; syntax highlighting through existing theme
tokens only — the ramp does double duty, no dedicated highlight colors.

**The tonal ladder.** `text` · `textMid` (supporting facts: paths, counts, results) ·
`textDim` (chrome), with `textFaint` reserved to the broadsheet tier. The `panel`
surface earns its keep (fences, elevated blocks). `textMid`/`panelLift` land before
C49 freezes the flavor schema.

**The tool row.** One designed line: fold-stamp · verb · subject · duration/size ·
outcome — outcome is the only colored word. Expanded detail hangs under a faint rule;
V2.1's live tail streams inside the row, then settles to the one-liner.

## The title bar (added 2026-08-16, the page pass addendum — 104/PD19)

Two zones on the top border, width-tier resolved by the same grammar as the page:

`╭ [stamp] name · telemetry ─ mode ╮`

- **The lifecycle stamp** (one cell, left of the name — identity intertwined with
  status) reuses the tile-fill states wholesale: **working** = the tile filling ·
  **awaiting approval** = full-density accent `█` (the needs-you state, the only
  notifying one) · **finished, unseen** = the completed tile held quietly until the
  pane is focused, then the ink drains away (completions stay silent per the
  notification formula — this is the return-state made visible) · **failed turn** =
  `▛`, the missing tile · **idle, read** = blank. A calm pane wears zero marks.
- **Telemetry** is the 102 lens slot — one value, workspace-lens resolved, never a
  bespoke per-surface detail. Hidden on unfocused panes below the column tier.
- **Mode word** (PD12): dim, rendered only for non-default modes (`plan`, `recall`);
  Agent renders nothing — mark the exception, never the default.
- **Arc** stays off the title text below broadsheet width; the border's arc hue carries
  identity, and the monochrome slug tag appears at broadsheet only (overview rows
  always carry it).
- **Real-estate priority order** under narrowing: stamp survives last (1 cell), then
  the fitted name, then telemetry, then the mode word — telemetry and mode yield
  first, the stamp never does.
- **Needs-you chrome** (added 2026-08-21, 104/PD25): the pane answers its stamp.
  Awaiting approval inverts the title label (ground = the pane's own ramp hue, ink =
  `background`) — the selection/cursor inversion's existing meaning, *the thing your
  keystroke targets*, applied to a pane — and the border takes its identity hue with a
  saturation lift only (PD8's reinforce-never-carry clause; luminance stays focus's).
  Finished-unseen lifts the name to `textMid`, failed-unseen sets it in `error`; neither
  inverts or touches the border. No other state changes a cell. Hue still never means
  state; the stamp alone must read in monochrome.

## Ledger chips

Session-ledger durable-write chips stay textual (`+mem ±skill ±cfg` styling to be
refined) with density prefix carrying provenance — e.g. `░+mem` = staged memory write
from an untrusted turn.
