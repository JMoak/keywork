# E2E Screen-Capture Harness — Scope

> Research/scope doc, 2026-08-15 (Jordan's request: run the app end-to-end through
> common/critical workflows and screenshot each step, before the 97-overlay work goes
> deep). Tasks C39–C43 are registered in
> [`../backlog/97-product-direction.md`](../backlog/97-product-direction.md); this doc is
> the design of record for them. All load-bearing claims below were verified against the
> installed `@opentui/core` 0.5.1 and the working tree, including an empirical headless
> render under Bun with no TTY attached.

## Why now

- **PD6/PD7 need repro-and-verify fixtures.** The frame-overlap fix (C35) and the live
  sessions work (C36/C37) are visual/behavioral; a scripted run that captures the actual
  screen before and after is the honest acceptance evidence. `captureCharFrame()` output
  literally shows broken box-drawing when panes overlap.
- **The launch bar.** The M2 release posture calls for a "zero-to-working in 60 seconds"
  screencast and a tiling screenshot in the README. Scripted scenario capture is the
  groundwork for both.
- **Dogfooding confidence.** Today nothing renders OpenTUI output in any test — zero
  test files import `@opentui/core`. The probe harness (C0's `AppProbe`) drives the pure
  `AppCore` state machine with a fake screen; it proves the right content is in the
  tree, never what the user actually sees.

## Verified facts (what exists, what's missing)

**OpenTUI has a first-class headless surface.** `@opentui/core@0.5.1` exports
`./testing`: `createTestRenderer({width, height})` builds a full `CliRenderer` over fake
streams (`TestWriteStream` hardcodes `isTTY = true` with fixed columns/rows);
`captureCharFrame()` returns the rendered frame as plain text;
`captureSpans()` returns per-cell text/fg/bg/attributes (enough to render styled
screenshots without any external tool); `mockInput`/`mockMouse` emit through the
renderer's own stdin object into the real parser → real `KeyHandler` → the exact
`keypress` listener `runApp` registers — synthetic input exercises the genuine chord
path, not a bypass; `waitForFrame`/`waitForVisualIdle`/`flush` give deterministic
settling; `resize(w, h)` and an injectable `Clock` exist. Verified: a frame renders
headlessly under Bun in this repo.

**Two product seams are missing, both small.**
1. `runApp` hardcodes the renderer (`app.ts:107`
   `createCliRenderer({exitOnCtrlC: false, ...})`) — `AppOptions` has ~15 injectable
   ports but no renderer field. One optional `renderer` (or factory) field, defaulting
   to today's call, unlocks everything. `screen()` already reads dimensions from the
   renderer, so fixed-size determinism comes free.
2. `onExit` (`app.ts:208-219`) calls `process.exit(0)` after `renderer.destroy()` — a
   scripted quit would kill the harness process. Needs an injectable exit seam
   defaulting to `process.exit`.

**Runtime split: the renderer is Bun-only; the test suite is Node.** OpenTUI's native
core (Zig, `opentui.dll`/`.so`) loads via `bun:ffi`; under Node the backend is a lazy
stub that throws on first native call (verified: import succeeds, render throws on
Node v24). Root `test` runs `vitest run` — a Node program. Therefore rendering capture
**cannot join the vitest suite**; it runs as a standalone Bun entry, exactly the tier
shape `forensic-stress-harness.md` §1 already establishes for the MCP stress supervisor
("`bun run scripts/…` — NOT under vitest/bun:test").

**Offline needs no server, and no config change.** Config deliberately cannot supply a
base URL (`schema.ts` — strict schema, documented policy) and no endpoint env var
exists, so a localhost mock server is not reachable through the product path — and is
not needed: `AppOptions.agentFactory` is already injectable and `AppProbe` already wires
the engine's `MockProvider` (`probe.ts:152`). The harness composes `runApp` directly
with scripted mock turns. (If real SSE-parsing coverage is ever wanted, the engine's
`fetchFn` seam on the OpenAI-compatible provider takes an in-process stub — still no
sockets.)

**A live target exists.** `C:\src\keywork-playground` has real accumulated state under
the cwd-hash key `68f07dba4738`: real sessions, a saved pane layout, and — usefully —
ten header-only 150-byte session files, a live specimen of the PD6 empty-session
litter. Live runs double as the C36 repro corpus.

## Architecture: three tiers

| Tier | What | Runtime | Answers |
|---|---|---|---|
| **0 — model probe** (exists) | `AppProbe` over `AppCore`, fake screen, no rendering | Node/vitest | "is the right content in the tree?" |
| **1 — screen capture** (this scope) | real `runApp` + injected `createTestRenderer`; mock keys/mouse; `captureCharFrame` text frames + `captureSpans` → styled SVG; scripted scenarios | `bun run scripts/e2e-capture.ts [scenario…]` | "what does the user actually see, frame by frame?" |
| **2 — live run** (thin mode of tier 1) | same scenarios, real ports (real session dir, real provider from user config), `--cwd <target>` pointed at keywork-playground, explicit `--live` opt-in | Bun, local only | "does it hold against real accumulated state?" |

Deliberately **not** in scope: PTY/ConPTY-level capture of the real binary in a real
terminal (validates the terminal stack itself — kitty protocol, ConPTY quirks; that
remains Track L's manual pass), and GIF/video tooling (VHS-style; revisit for the launch
screencast once tier 1 exists — the span recorder's `TestRecorder` frame stream is the
natural input to it).

**Artifacts.** Each scenario writes `artifacts/e2e/<scenario>/NN-<step>.txt` (the char
frame — diffable, greppable, the assertion medium) and `NN-<step>.svg` (styled render
from `captureSpans` — the human/screenshot medium; a zero-dependency ~100-line SVG
writer: background rects + monospace text runs, theme colors flowing through
unmodified). `artifacts/` gets a `.gitignore` entry (part of C40 — it is not ignored
today); CI uploads it. SVG first because it needs no
native deps on any platform; PNG conversion is a later optional bolt-on if something
requires raster.

**Determinism.** Fixed renderer size (120×32 default, per-scenario overridable);
settle via `waitForVisualIdle` — never sleeps; scripted `MockProvider` turns; temp
`HOME`/session dir per scenario run (tier 1); dynamic regions (timestamps, kebab-case
titles, relative ages) masked by a normalization pass before any golden comparison.
One honest limit: the renderer `Clock` is injectable, but keymap timing is not — chord
handling reads real `performance.now()` and the leader-expiry timer is a real
`setTimeout` (2s), so captures of armed/leader states race wall-clock; practically fine
at that horizon, but don't expect `ManualClock` to freeze chord timing.
Golden text-frame assertions are **opt-in per step** — capture-everything,
assert-the-stable-subset — so the suite documents without flaking.

## Scenario set (v1)

| ID | Workflow | Features hit |
|---|---|---|
| S1 | Cold start, no provider → the no-provider conversation-pane state; quit path (exercises the C39 exit seam). Note: the C24 empty-state view is defensive-only since Track Q item 3 (last-pane close quits), so it is not normally reachable to capture | D12, C39 seam |
| S2 | First conversation: prompt → streamed reply → mutating-tool ask with diff preview → approve → `/undo` → `/redo` | C12, A6 ask, V2.2 diff, E3/E4 |
| S3 | Tiling tour: splits, directional nav, zoom, resize; dock browser + session tree + memory + MCP panes; dock verbs | C8–C11, C27/C28, C13/J9/D14 panes |
| S4 | Session lifecycle: fork from the tree pane, label, quit, relaunch → layout + sessions restored | B4/B5, C13, Track P persistence |
| S5 | Discovery surfaces: palette (ctrl+p), slash autocomplete, help overlay, preset picker | C26/C25/C6, E2 |
| S6 | Defect repros: 8-pane shrink (frame overlap — the C35 before/after fixture); rapid split-and-quit (empty-session litter — the C36 fixture) | PD7, PD6 |
| S7 | Live playground (tier 2, `--live`): open with restored state, sessions surfaces over real history, resume a real session | restore path against reality |

S1's *onboarding* flow is honestly out of frame: `onboardIfNeeded` runs CLI-side before
`runApp`, so the in-process harness can't see it. S1 captures the in-TUI no-provider
state instead; onboarding capture arrives if/when that flow moves in-TUI (C19's open
half).

**Coverage honesty.** Tier 1 composes `runApp` with harness ports, so `main.ts`'s
~190-line production wiring is *not* under capture. That gap shrinks to near zero when
D15 extracts the shared composition module — the harness then consumes the same
composition as the binary. Sequence C40 after D15 if both are in flight; do not block
on it.

**Live-run safety (tier 2).** `--live` is required to touch a real cwd's state; without
it the harness refuses non-temp targets. Live runs use the user's real provider key and
append to real session files by design; artifacts from live runs may contain transcript
content in the pixels — never committed, and the scenario runner prints a redaction
reminder when `--live` artifacts are written.

## Tasks (registered in 97)

- **C39 (1pt) — Harness seams in `runApp`**: optional `renderer` injection (factory,
  defaulting to `createCliRenderer`) and an injectable exit seam replacing the direct
  `process.exit(0)`. Zero behavior change without injection; existing tests green.
- **C40 (3pt) — Capture harness core**: `scripts/e2e-capture.ts` (Bun tier, forensic-doc
  precedent) — scenario runner (step = input burst → settle → capture), mock-port
  composition reusing the probe's fabric + `MockProvider`, char-frame + span capture,
  the zero-dep SVG writer, artifact layout + `.gitignore` entry, masking helper; S2 and
  S3 as the proving scenarios.
- **C41 (2pt) — Scenario pack**: S1, S4, S5, S6 scripted; golden text-frame assertions
  on the stable steps (masked); S6's two captures serve as supporting before/after
  evidence for C35/C36.
- **C42 (1pt) — CI wiring**: Linux CI job running the scenario pack headlessly,
  artifacts uploaded; **non-gating at first** (report-only), golden-gate flipped on once
  a week of runs shows no flakes.
- **C43 (1pt) — Live playground mode**: `--cwd`/`--live` (tier 2) with the safety rails
  above; S7 documented as a manual-invoke scenario, never CI.

~8pt total. C39 → C40 → {C41, C43} → C42; only C39 touches product code, and it is the
first PR.

## Risks

- **OpenTUI testing API stability**: `./testing` is a shipped export of an 0.x package;
  pin-exact (house rule) already protects us, and the fallback seam
  (`CliRendererConfig` accepts injected stdin/stdout/width/height/clock directly) means
  even a removed testing entry point costs a ~50-line local shim, not a redesign.
- **Render-loop coupling**: `runApp` rebuilds `renderer.root` per render and runs
  `renderer.auto()`; if idle-detection proves noisy, the harness falls back to
  frame-count settling via `TestRecorder` — both exist today.
- **Bun-tier drift**: a suite outside vitest can rot unwatched; C42's CI job is the
  mitigation and lands in the same wave, not later.
- **Golden brittleness**: theme or copy changes will churn frames; masking + opt-in
  goldens + report-only CI first is the designed answer — the artifact gallery is
  valuable even with zero gating.
