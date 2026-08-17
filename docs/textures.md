# keywork — Textures of Record

> The perceived-quality bar: small correctness details where users *feel* top-tier
> software without being able to name why. Each texture carries an acceptance bar and a
> ratchet — a CI check in `scripts/` that makes regression impossible, following the
> `check-pins.ts` / `check-guardrails.ts` precedent. A texture without a ratchet is an
> aspiration, not a texture of record.
>
> Companion docs: [`design-language.md`](design-language.md) (visual vocabulary),
> [`ux-principles.md`](ux-principles.md) §4 (refusals).

## T1 — Grapheme-correct editing

Cursor motion, selection, deletion, and width math treat grapheme clusters (emoji,
ZWJ sequences, CJK, combining marks) as single units in every text surface: composer,
buffer editor, pane labels, clipping.
**Accept:** a fixture corpus (emoji families, flags, Devanagari, CJK, skin-tone
modifiers) round-trips through edit operations with correct cursor positions and
rendered widths.
**Ratchet:** the corpus test runs in CI; new text surfaces must register against it.

## T2 — Paste-flood survival

Pasting multi-thousand-line content into the composer never drops input, blocks the
render loop, or corrupts bracketed-paste state; oversized pastes degrade explicitly
(attachment/summary), never silently.
**Accept:** 5k-line paste lands intact with UI responsive throughout; malformed
bracketed-paste sequences recover without garbling subsequent keystrokes.
**Ratchet:** paste-flood test in the C39 screen-capture harness.

## T3 — Windows parity, proven

Linux primary, Windows fully supported (92's binding priority) — proven, not asserted:
ConPTY behavior, process-tree kill, paths, clipboard, glyph fallbacks.
**Accept:** the full test suite plus the E2E harness run green on a Windows CI runner.
**Ratchet:** Windows runner is required-green for merge; skipped-on-Windows tests need
a written reason and an issue.

## T4 — Remote-terminal correctness

Copy works over SSH (OSC 52); the UI stays coherent on laggy links (no torn frames,
no interleaved escape soup); reconnection never corrupts pane state.
**Accept:** OSC 52 copy verified against a terminal capability matrix; artificial
200ms-latency session stays visually coherent in the capture harness.
**Ratchet:** capability-matrix test enumerates supported terminals and their verified
escape features.

## T5 — Degraded-terminal grace (PD14's ladder)

Nerd Fonts and rich glyphs are enhancement, never dependency. Every glyph in
`design-language.md` declares its fallback tier; a bare console renders something
intentional, not tofu. `keywork doctor` reports what the terminal supports.
**Accept:** every design-language glyph has a declared fallback; forced-minimum-tier
screenshots read as designed, not broken.
**Ratchet:** script walks the glyph table and fails on any glyph missing a fallback tier.

## T6 — First-class light (PD15's floor)

Light themes are designed, not inverted; every theme (light and dark) meets the
contrast floor for all token pairs actually composited in panes.
**Accept:** gallery ships ≥1 first-class light flavor; contrast checks pass for every
token pair in every shipped flavor.
**Ratchet:** contrast-floor script runs over all shipped flavors in CI.

## T7 — Empty states that teach

Every pane's zero-data state names the next action or the enabling config, in one calm
line (the mcp-pane and C24 precedent). No pane ever renders blank void.
**Accept:** pane inventory test — every registered pane kind has a non-empty empty
state; screenshots reviewed at theme extremes.
**Ratchet:** pane registration requires an empty-state renderer; CI fails a pane
without one.

## T8 — Latency honesty

Keystroke-to-echo stays under the C2 frame budget under load (streaming turn + three
live panes); input is never blocked by rendering or bus traffic.
**Accept:** instrumented perf test measuring input-echo latency during a streaming
fixture turn. C2's frame-time budget satisfies part of this bar; the input-echo
measurement under load is the addition.
**Ratchet:** perf test is required-green with a numeric budget; budget changes require
a written justification, pins-style.
