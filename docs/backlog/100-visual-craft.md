# Visual Craft — The Sexy Pass (2026-08-16)

> Authoritative overlay, 2026-08-16, from Jordan's visual-craft vision session. Where
> this file speaks it wins; where silent, [`99`](99-workspace-and-modes.md) →
> [`98`](98-chroma-and-arcs.md) → [`97`](97-product-direction.md) → earlier overlays →
> workstream files.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing
> before workstream G; Pi/OpenCode are MIT — adapt with attribution in `NOTICE`; Crush is
> FSL — never a source. The user commits; agents never `git commit`/`git push`.
>
> **The bar, in Jordan's words:** top-charts r/designporn × r/computers × r/programming,
> simultaneously — with Omarchy's status/metrics craft (Alacritty-on-Omarchy as the
> reference feel) as one flavor of many. The route there is restraint: material craft +
> composition + motion + honest instrumentation + poster-worthy moments, nothing
> decorative that isn't also informative.

## The sixteen items, dispositioned

| # | Item | Jordan's disposition | Home |
|---|---|---|---|
| 1 | Glyph strategy & typography tiers | Adopted; **Nerd Fonts refused as dependency, supported as enhancement** | PD14 → C48 |
| 2 | Light theme first-class + contrast floor | Adopted; dark default, light first-class, **theme system itself first-class** — simple, clear | PD15 → C49 |
| 3 | Depth without pixels (dimming, scrims) | Try it — **testable, configurable** | C51 |
| 4 | Gaps & chrome minimalism | Adopted, top-tier bar; Alacritty-on-Omarchy reference | PD15 → C50 |
| 5 | In-pane typographic rhythm + syntax highlighting | Adopted — major improvements wanted | C52 |
| 6 | Motion grammar | Adopted; **initial world-class draft entrusted — drafted in design-language.md** | PD16 → C53 |
| 7 | Streaming feel | Adopted 100% — tasteful, and **beat the flagships' known streaming complaints** | C54 |
| 8 | The cockpit | Adopted; add a **context fullness indicator in keywork's own character** | PD17 → C55 |
| 9 | Ambient motion budget | Adopted, conservative start | PD16 rule |
| 10 | Hero states / poster test as review gate | Skeptical ("idk how we are effective") — **no formal gate**; hero frames emerge from C56's demo scenes | soft, via C56 |
| 11 | Built-in capture & share | Adopted enthusiastically; **agent-facing tool + arc-facing compound commands** | C56 |
| 12 | Zero states & onboarding choreography | **Parked** — discuss/choreograph later | — |
| 13 | Terminal capability ladder | Adopted; base on the most common, **support the majors foremost** | PD14 → C48 |
| 14 | Performance as aesthetics | Adopted strongly; **develop the bar together** over char-frame captures | C57 |
| 15 | Flavor system | Adopted — "we need that if we can capture it" | PD15 → C49 |
| 16 | Restraint as enforcement | Adopted — "vigilant in the best way if we can define it" | principles below |

## PD14 — Glyphs & the capability ladder

Beauty may depend on what renders everywhere, and degrades deliberately:

- **Three sanctioned glyph tiers:** tier 0 pure ASCII (always works, the floor every
  surface must survive at) · tier 1 Unicode box/block (the design-language working set —
  the default material) · tier 2 sub-cell (half-blocks `▀▄`, quadrants `▘▝`, braille
  `⣿` for 2×4-dot sparklines and finer tile-fill). Every mark in the design language
  declares its tier and its fallback one tier down.
- **Nerd Fonts: never a dependency, always a citizen.** Nothing keywork ships requires
  a patched font; when one is detected (opt-in confirm, never sniffed silently into
  ugliness), a garnish tier may refine marks. A default-terminal screenshot and a
  riced-terminal screenshot must both look *finished* — the Nerd Font one is merely
  richer.
- **The majors come first** (Jordan): capability profiles and font-reality fixtures for
  Windows Terminal, Alacritty, kitty, ghostty, and tmux-nested variants; detection for
  truecolor, synchronized output (DEC 2026), and glyph-tier support; `keywork doctor`
  prints the resolved profile so degradation is never a mystery.

## PD15 — The theme system is first-class

Jordan's directive: the theme system itself is a headline surface — **simple,
understandable, clear** — these systems lose clarity as they grow, so clarity is the
design constraint, not an aspiration. Shape:

- **A flavor is the unit, and it's one readable file.** A flavor bundles the token
  palette + the chroma ramp + density-contrast mapping + gap width + chrome weight +
  instrumentation density (calm ↔ cockpit). One schema, every field
  `.describe()`-justified (D9), no second theming mechanism anywhere — the existing
  token overrides remain the inside of a flavor, not a parallel system.
- **Curated gallery, Omarchy-grade:** keywork-night (default, dark) · one
  **first-class light** (designed with the same love, not inverted) · a neo-tokyo ·
  a lavender family · and the **omarchy-cockpit flavor** (instrument-heavy status in
  the Alacritty-on-Omarchy feel) — each art-directed with Jordan, admission by taste.
  The format is documented and open; the gallery is curated.
- **Live hot-swap** (Omarchy 2.6): flavor switching is a palette command, not a
  restart; every surface repaints from tokens (the no-hard-coded-color rule already
  holds).
- **Contrast floor enforced in the validator:** an APCA-style minimum for every
  token-pair the design language uses, both light and dark — a flavor that fails
  contrast doesn't load, it errors helpfully.

## PD16 — The motion grammar

Drafted per Jordan's mandate ("I trust you for an initial world-class draft I'd hope we
can keep") — **the draft of record lives in
[`../design-language.md`](../design-language.md)**, seven rules; its signature law:
**motion lives in ink, never in geometry** (layout snaps because rects are truth —
PD7 — and animated geometry lies to hit-testing; what animates is density, saturation,
dimming — the terminal's native crossfade is `░▒▓█`). Named tempos (instant · quick ·
settle · ceremony), arrival/departure step-shapes, one-mover-per-region, input always
outranking motion, atomic frames via synchronized output, reduced-motion ending at
final-frame-immediately. The **ambient budget** (item 9) is codified there
conservatively: ambient motion only from real events, whisper amplitude, one ambient
mark on screen at a time.

## PD17 — The cockpit & the context gauge

Omarchy's status/metrics appeal translated under the C18 grammar (every element
justified or absent; only real measurements; no decorative gauges, ever):

- **Instrument tier of the status line** + optional dock instruments pane (D14
  precedent): braille sparklines (tier 2, tier-1 ramp fallback) for tokens-per-turn and
  spend, Gardener/index activity as tile-fill, session timing.
- **The context gauge** (Jordan's addition): context fullness rendered in keywork's own
  character — candidates to draft and render (options-first, C40 captures, Jordan
  picks): the density-fill bar whose thresholds are *real events* (J8 flush reserve,
  B7 compaction reserve — the gauge marks where the flush will fire, so it's honest
  machinery made visible, not a progress bar); a keycap-fill variant (the icon gains
  ink); a tile-fill variant. Whichever wins, the thresholds shown are the resolved
  absolute values (the J-D8 readout rule).

## Restraint — the enforcement principles (item 16, defined)

The sexy pass goes *through* the refusals, never around them. Three vigilance rules,
binding on every task below:

1. **Nothing decorative that isn't also informative.** Every mark traces to a real
   value or state; delete-test every flourish (would removing it lose information? no →
   it goes).
2. **The hour-ten test outranks the screenshot.** A surface that wins the screenshot
   but grinds at hour ten of a workday fails review (Omarchy 2.5: calm is the feature).
3. **Beauty must survive the floor.** Tier-0 ASCII, monochrome, NO_COLOR,
   reduced-motion renders of every surface are acceptance fixtures, not afterthoughts —
   if the degraded render is embarrassing, the design is wrong, not the terminal.

## Tasks

### C48 (2pt) — Capability ladder & glyph tiers (implements PD14)
Detection (truecolor, DEC 2026, glyph tiers, opt-in Nerd Font garnish), per-terminal
profiles + font-reality fixtures for the majors, tier fallback resolution as one shared
module every mark renders through, `keywork doctor` readout.
**Accept:** forced tier-0/1/2 renders of a fixture screen all look finished (capture
goldens); Nerd Font absent ⇒ zero tofu anywhere; doctor output matches forced
capabilities; tmux-nested profile degrades sync-output gracefully.
**Strategy:** `OWN`.

### C49 (3pt) — Theme system v2: flavors & gallery (implements PD15)
The flavor schema (extends C44's landed ramp model), live hot-swap command, contrast
validator, and the curated gallery — keywork-night, the first-class light, neo-tokyo,
lavender, omarchy-cockpit — each art-directed with Jordan via rendered captures.
**Accept:** flavor file round-trips schema with every field justified; hot-swap
repaints all surfaces live (probe); contrast floor fails a seeded bad flavor helpfully;
gallery flavors each ship a both-themes capture pair Jordan approved; instrumentation
density actually varies between calm and cockpit flavors.
**Strategy:** `OWN` on C44's ramp foundation. After C44 render wiring.

### C50 (2pt) — Gaps & chrome minimalism (implements PD15 composition)
Gap cells as a layout parameter riding C35's rect truth (flavor-carried, default per
flavor taste), rounded corners tier-gated (`╭╮` tier 1, square tier 0), the
borderless/luminance-focus mode as a flavor option.
**Accept:** C35's property suite extended — gapped layouts stay gapless-in-content and
overlap-free at every ratio; hit-testing exact through gaps; borderless mode keeps
focus legible in monochrome capture; gap 0 is byte-identical to today.
**Strategy:** `OWN`. After C35/C38.

### C51 (1pt) — Depth: dimming & scrims (item 3; testable, configurable)
Unfocused-pane content dimming (luminance step, token-driven) and overlay scrims
behind palette/airlock — each independently configurable with `.describe()`
justification, each capture-tested.
**Accept:** dimming off ⇒ today's render byte-identical; scrim + dim captures approved
in both themes; NO_COLOR render unaffected (density carries focus).
**Strategy:** `OWN`. Rides C35's render seam.

### C52 (2pt) — Transcript typography & syntax highlighting (item 5)
The rhythm rules (speaker separation, muted metadata, padding grid) plus a minimal
own zero-dep tokenizer highlighting the major languages (ts/js, json, md, sh, py, go,
rust, diff) through theme tokens — no highlighting dependency, no grammar files.
**Accept:** fixture transcript capture approved; highlighting cost measured within the
frame budget on a 5k-line block (A18 bar); unknown languages render calmly unstyled;
diffs colored via the existing diff-render path, one system.
**Strategy:** `OWN` (tokenizer scope deliberately minimal — highlight well, never
parse).
**Landed** 2026-08-21 — the highlighter half (`tui/highlighter.ts`, fence interiors via
C60's renderer, theme-token palette only); details in `104-the-page.md` "Landed — stream 2".
Rhythm rules ride C59/C61's page grammar; the fixture-capture approval closes the task.

### C53 (2pt) — Motion grammar implementation (implements PD16)
One shared animator honoring the grammar (tempo tables, step-shapes, one-mover
arbitration, input-settles-all, reduced-motion final-frame), ink transitions wired
(border density fade-in, focus lift, dim transitions), synchronized-output frame wrap
via C48 detection.
**Accept:** probe-driven — every animation completes to its exact final frame on
keypress interrupt; one mover per region enforced under concurrent triggers; reduced-
motion renders final frames only; no unsynchronized partial frame observable in
capture under stress; tempos match the grammar's tables.
**Strategy:** `OWN`. After C48; coordinates with C44 render wiring.

### C54 (2pt) — The streaming feel (item 7)
Token arrival choreographed: per-frame chunk coalescing into a smooth cadence (never
letter-stutter, never paragraph-lurch), a designed streaming cursor, thinking/working
idle marks from the design language, scroll stability during stream (viewport never
jumps while reading scrollback — the flagship complaint this beats), zero reflow
flicker.
**Accept:** firehose fixture renders at cadence with frame time flat (A18); scrolled-
back viewport provably stable while streaming continues; stream-complete settles per
the grammar; side-by-side capture vs raw-append visibly smoother (demo scene kept as
evidence).
**Strategy:** `OWN`. Rides A18 + C53.

### C55 (2pt) — The cockpit & context gauge (implements PD17)
The status instrument tier + dock instruments pane variant, sparkline primitives
(tier-2 braille, tier-1 fallback), and the context gauge delivered **options-first**
(2–3 rendered candidates per PD17, Jordan picks) with real-threshold honesty.
**Accept:** every instrument traces to a measured value (no decorative element
survives the delete-test); gauge thresholds equal the resolved flush/compaction
reserves and fire visibly in a long-session fixture; calm flavor shows the minimal
set, cockpit flavor the full set; Jordan picked the gauge from real captures.
**Strategy:** `OWN`. After C49 (flavors carry instrumentation density).
**Landed (gauge half)** 2026-08-21 — `tui/context-gauge.ts` on the engine's context budget:
calm = one ramp cell + count, cockpit = ten-cell bar with the flush/compaction marks as
cells, tier-0 ASCII; thresholds are the resolved reserves and the `long-session` e2e fixture
shows them fire. Ledger and the open options round (ramp cell · bar · tile-fill) in
[`109-long-session-survivability.md`](109-long-session-survivability.md). Sparklines and the dock instruments pane
remain open under this task.

### C56 (2pt) — Capture as product (item 11; absorbs item 10 softly)
`/screenshot` (SVG/PNG via C40's writer) as a user command **and an agent-facing
tool** (screenshot lands in the transcript/filesystem like any tool artifact, root-
jailed); arc-facing compounds — a delivery poster frame optionally attached to the
J18 delivery record, `/arc` capture verbs; probe scenarios promoted to replayable
demo scenes (hero frames — startup key-turn, gradient sweep, garden heat — emerge
here as maintained scenes, no formal poster gate per Jordan).
**Accept:** one keystroke yields a shareable file of the live screen; agent can
capture and reference the frame in-session under the ordinary tool gate; arc close
can attach its poster to the delivery record; demo scenes replay deterministically
from probe scripts and render the launch-screencast frames.
**Strategy:** `OWN` over C40. After C40; arc compounds after J18.

### C57 (1pt) — The frame-budget bar (item 14; develop with Jordan)
The measured performance-as-aesthetics gate: input latency and effective fps under
firehose, measured over char-frame captures (the harness's native ASCII frames — the
"develop together as ascii" instrument), thresholds set with Jordan against real runs
and then enforced as fixtures.
**Accept:** the measurement harness reports latency/fps per scenario; thresholds
recorded in this file once Jordan sets them; regression fixture fails on breach.
**Strategy:** `OWN` over C40/A18.

## Sequencing

```
C48 ──► C53 ──► C54            C40 ──► C56 (arc compounds after J18) · C57
C44(render, after C35) ──► C49 ──► C55
C35/C38 ──► C50 · C51          C52 independent
```

Ten tasks, 19pt. C48 and C52 can ride any lull now; the flavor/cockpit chain follows
the C35→C44 render wiring already in flight (99's wave record); C56/C57 build on the
landed C40 harness.

## Supersession record

- design-language.md — **gains the motion grammar** (drafted 2026-08-16 per Jordan's
  mandate, intended to keep) and the glyph-tier declaration rule; remains the
  vocabulary of record.
- The Omarchy status/metrics direction — **lands as the omarchy-cockpit flavor +
  PD17 instrument tier**, not as a global default; calm remains keywork-night's
  posture.
- Items 10 (formal poster gate) — **not adopted**; hero frames live as C56 demo
  scenes. Item 12 (onboarding choreography) — **parked** for a later session by
  Jordan's call.
- ux-principles refusals — **unchanged and reaffirmed**; the restraint principles
  above are this pass's enforcement addendum, not amendments.
