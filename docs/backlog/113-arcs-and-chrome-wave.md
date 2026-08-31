# Arcs and Chrome Wave: Plan + Ledger (2026-08-30)

> **Plan + ledger overlay.** The wave after [`112`](112-feel-and-look-wave.md): the fully
> specified leftovers, run as disjoint lanes. Where this file speaks it wins; where silent,
> [`104`](104-the-page.md) (C69, C66), [`100`](100-visual-craft.md) (C50, the restraint rules),
> [`98`](98-chroma-and-arcs.md) (J18 airlock), [`110`](110-arcs-on-screen.md) (arc surfaces and
> the `/arc close` clean door), [`101`](101-feedback-round-4.md) (FR2.6, FR3) apply.
>
> **Standing guardrails unchanged:** Anthropic is API-key / Agent-SDK only, nothing before
> G1; Crush is never a source; the user commits.

## Baseline

`bccb058` (branch `KEY-4`): `bun run check` clean, vitest 2874 passed / 1 skipped. **e2e was not
green:** run scenario by scenario on a clean worktree (2026-08-30), 11 of the 13 non-manual
scenarios failed (only `discovery` and `defect-repros` passed). The 2026-08-25 look commits
(`2cb1891`, `bccb058`) landed without recapturing the suite, and the runner stops at the first
failure, which hid the rest. Restoring e2e green is part of this wave (W2 carries the chrome
scenarios, W3 `memory-browser`), and the true count belongs in every future gate line.

## Lanes

| Lane | Tasks | Points | Territory |
|---|---|---|---|
| **W2 · title row and chrome** | C69 own title row + needs-you chrome, C50 remainder (gap cells, borderless luminance focus, tier-gated corners), C66 title-bar rung, pin-mark dim ink | 5 | `tui/pane-chrome.ts`, `tui/chroma.ts`, `tui/title-bar.ts`, `tui/slug.ts`, `tui/view/seams.ts`, `tui/view/frame.ts`, `tui/pane.ts`, `shared/config/flavor.ts`, page-tier and discovery goldens |
| **W3 · arcs finish** | J18 digest surface (triage resolve / carry / drop, force-complete with flush), arc jump rows in quick-open, memory-pane arc-layer header in arc hue | 5 | `engine/memory/arcs/`, `cli/arcs.ts`, `tui/arc-commands.ts`, `tui/arc-pane*`, `tui/arcs-pane*`, `tui/memory-pane-model.ts`, `tui/memory-rows.ts`, quick-open jump source |
| **W5 · engine queue and workspaces node** | C17 queue half of A8, FR2.6 workspaces node + focus dirs, `--workspace` for `run` / `chat` | 4 | held until the C17 keybinding decision |
| **W1 · audit phase 3** | C15, C16 | 5 | held for Jordan's go |
| **W4 · trays and pointer** | FR3.8 / FR3.9, H4 / H6 | 5 | queued |

Merge bar per lane: `bun run check && bun run test && bun run e2e` green, adversarial tests
in the lane's own files, self-review of the diff, a ledger row below.

## Ledger

### W2 · title row and chrome · landed 2026-08-30 (uncommitted)

- **C69 own title row + needs-you chrome.** `paneChrome` composes the title row itself as one
  `StyledText` from a `PaneTitle` (`pane-chrome.ts` `titleRow`): lead cell, dim pin mark, stamp,
  slug words, telemetry, mode word, each in its own ink; boxed weight places the row over the
  border, header-row weights (`seams`, `borderless`) make it the pane's first line. One resolver
  `lifecycleChrome(state, focused, hue, theme)` in `chroma.ts` beside `paneBorder`: needs-you
  inverts (ink `background`, ground ramp hue) and warms the border by an OKLCH `saturationLift`;
  finished-unseen and failed only step the name ink. `PaneContext` carries `hue` + `glyphs`,
  `Pane.lifecycle?()` lets the seams layer ink shared hairlines through the same resolver, and a
  `ground:<id>` quick-tempo arrival fades the inverted ground up when an ask appears.
- **C66 title-bar rung.** The slug renders through `slugParts` in the title row (words lit,
  `-` dim, arc colon `accentSoft`); the 104 constraint of record is closed. The pin mark `▪` is
  `textDim` (112 flag closed).
- **C50 remainder.** `pane-geometry.ts` `drawnRect(rect, field, { chrome, gap })` trims gap cells
  on every inner edge for both drawing and pointer hit-testing (gap 0 pinned byte-identical);
  boxed corners `rounded` from glyph tier 1, ascii `+ - |` at tier 0; `chromeWeight:
  "borderless"` lifts the focused ground to `panel` and leads the header with a `▎` / `>` focus
  mark so focus survives monochrome.
- **Reconciliation with L7.** C69 predates the seams chrome; in `seams` it means span
  composition plus the inversion and ink steps. Where they disagreed L7 won: the unfocused
  resting label is `textMid` in every weight, so finished-unseen steps to `text`.
- **Tests.** About +37 across `pane-chrome`, `chroma`, `title-bar`, `conversation-pane`,
  `pane-geometry` (gap property suite), `pointer-routing`, `view/frame`, e2e `frame-queries`,
  `mask`. New capture scenarios `chrome-states` (7 goldens) and `chrome-states-ascii` (tier 0).
  `cold-start/no-provider-guidance` recaptured: it was stale from before L7.
- **Crossings (additive):** `app-core.ts` `drawnRect?` option, `app.ts` wiring, `pointer-routing.ts`
  optional `drawnRect`, `index.ts` exports, e2e `harness`/`scenario` `glyphs?`, five scenario
  markers `"╭─ "` to `"│ "`, one assertion in `arcs-pane.test.ts`.

### W2 follow-up · the stale e2e scenarios · 2026-08-30

The four chrome-adjacent scenarios red on the clean tree were re-read against the decisions
they had drifted from; none had caught a regression.

- `first-conversation`, `session-lifecycle`: waited for the gauge right after turn 1; 112 L7
  gates the gauge until half the flush reserve. They now wait for the resting header
  (`│ session-1 │`). `session-lifecycle` runs at 132x32 so its three panes clear the masthead
  threshold (104 C63) and the `· done` tool row is visible.
- `long-session`: three gauge assertions hit the same L7 rule; turn 1 and post-fold wait for
  the resting header, the darkening `▒ 1.1k → ▒ 1.6k` assertion stands, the manual fold is judged
  by `/context` before and the `context now 277 of 2k` notice after. New capture
  `context-before-compact`.
- `page-tiers`: expected caps at 32 columns; under the stroke masthead (112 L7, C63's
  every-word-sets rule) `session` sets at 28 cells so 32 keeps the block face. The caps
  assertion moved to a new `masthead-26` capture.
- Harness: `Stage.until` accepts a RegExp (`scripts/e2e/scenario.ts`, `harness.ts`); markers
  still name something visible.

**Gate after W2:** `bun run check` clean, vitest 2946 passed / 1 skipped (210 files), e2e 16/16.

### W3 · arcs finish · landed 2026-08-30 (uncommitted)

- **J18 digest surface, one airlock path.** Engine `memory/arcs/airlock.ts` gains `review(slug)`
  (read-only candidates + open questions; `completeClose` reads through it), delivered notes
  carry a `delivered in [[arc <slug> delivery]]` line so the delivery record links round-trip,
  and the new `arcs/draft.ts` `ArcCloseDraft` holds decisions between keystrokes
  (deliver / leave, resolve / carry / drop, successor, last sweep, `undecided`). `memory/flush.ts`
  gains `flushNow` (the J8 flush on demand). CLI `arcs.ts` `ArcsPort.airlock` =
  `digest / triageCandidate / triageQuestion / deliverEligible / finish({ force })`, composed
  strictly from `prepareClose / review / completeClose / abandon / routeStragglers`; `/arc close`
  runs the ack sweep through a `flushFor` seam, `finish` re-sweeps, auto-leaves below-bar notes,
  then completes; `attached()` settles a binding to an archived arc and routes stragglers. The
  memory browser's garden lens shows the digest under the focused arc layer: sweep header
  (`2 flushed · 1 didn't flush`), per-candidate and per-question decision rows, one folded row for
  below-bar notes, and a close row (`░ close #slug · 2 to decide` to `█ close #slug · enter
  closes`, `f` forces past wedged sessions, `a` on it delivers all eligible). Keys `a` / `d` / `c`,
  `i` lands on the digest. Raw airlock cards carry no `inboxId`, so nothing can discard one
  around the kernel. Pane titles and tree rows drop `#slug` when the arc archives.
- **Two digest treatments rendered (options-first, Jordan picks):** `tail` (default,
  `▓ Fold Habit · 3d → deliver`; captures `airlock-digest`, `airlock-triaged`, `arc-delivered` in
  `memory-browser`) and `stamp` (`█▓ deliver · Fold Habit · 3d`; scenario
  `memory-airlock-stamp`), switched by `AppOptions.memoryDigest` through a new `Scenario.app`
  seam.
- **Arc jump rows in quick-open.** `arcJumpCommands` in `arc-index.ts` (`jump: true`, label
  `#slug`, hint `n sessions`; enter focuses the docked arc pane, else summons the arcs node
  drilled into the arc); pane jump rows skip arc panes. Capture `quick-open-arc` in `arc-fold`.
- **Arc-layer header hue** was already wired by L6 (`arcInk` through `chroma.arcAnchor`); the close
  row shares it and a test pins both, with the grouping legible from text alone.
- **Tests.** +36 (30 in existing files, 6 in `draft.test.ts`); the J18 fixture in `cli/arcs.test.ts`
  walks the 98 acceptance list end to end (two sessions flush, rubric, all three question
  outcomes, delivered stamps and round-trip links, temporal query, wedged / force, straggler on
  reattach, abandon keeps every file, audit entry). `memory-browser` e2e is green again with
  the clock pinned through `Scenario.app.clock` and the `4d` age assertions restored.
- **Crossings (additive):** `engine/memory/flush.ts`, `engine/index.ts`, `cli/compose.ts`,
  `cli/compose-panes.ts`, `cli/memory.ts`, `cli/sessions/ports.ts`, `tui/app.ts`,
  `tui/core-commands.ts`, `tui/session-panes.ts`, `tui/session-attachment.ts`, `tui/index.ts`,
  e2e `scenario.ts` / `harness.ts` / `scenarios/index.ts`.

**Gate after W2 + W3 (lead-run on the combined tree):** `bun run check` clean, vitest 2946
passed / 1 skipped (210 files), e2e 16/16, 65 files changed. Suggested commit message:
`feat: own title row, gap chrome, and the arc airlock digest (113 W2 + W3)`.

### W2 follow-up · focus corners · landed 2026-08-30

Jordan reported the focus highlight overshooting corners on Windows Terminal (inverse corners,
little crosses, 30 to 100 px). Two rules landed, both surviving tier 0:

- **Frame on top (default, `focusOutline: "frame"`).** `seams.ts` `framedByOutline` rewrites
  the joints of every cell on the focused outline to the outline's own, so the lit rectangle
  closes with `╭ ╮ ╰ ╯` and straight sides; dim seams and the ring stop flush. While the leader
  is armed the accent ring keeps its grid joints (L7's ring-wins rule).
- **Per-arm weights (kept under both rules).** `seamGlyph` resolves from every light / heavy arm
  combination in U+2500..U+254B keyed by four arms; a heavy arm never points into a light
  segment. `weightIndex` is gone. `focusOutline: "grid"` keeps tees at the corners for comparison.
- Captures for the pick: `scripts/e2e/goldens/focus-corners-{frame,grid}/` (`corner-pane`,
  `mid-edge-seam`, `nav-ring`) plus `-ascii` tier-0 twins. Visible difference: `│───` versus
  `├───` at a mid-edge junction, `─╭─` versus `┬` on the ring.
- **The multi-cell live overshoot did not reproduce** in the deterministic frame or in the real
  OpenTUI test renderer: `focus-repaint` (bun, real renderer) moves focus and closes a pane and
  finds no stale hue cell; a property test pins every seam cell outside every drawn box. What
  the harness cannot see is the terminal's copy of the buffer: OpenTUI sends cell diffs, and a
  run the terminal drops or misapplies persists until those cells change again. Needs a live
  screenshot: glyphs or blanks in the overshoot, fresh repaint or only after focus moves,
  terminal size, whether synchronized output (mode 2026) is on, whether `grid` shows it too.
- Goldens recaptured for the corner cell only (`┬` to `╭`, `┴` to `╰`): `cold-start`,
  `chrome-states` (7), `discovery` (5).

**Gate after the corners pass:** check clean, vitest 2954 / 1 skipped, e2e 21/21.

### W5 · engine queue and workspaces node · landed 2026-08-30 (uncommitted)

- **C17, the queue in the engine.** `engine/agent.ts` gains `settleTurnsWith(settler)`,
  `hold(work)`, `adoptQueue(from)`: `runTurn`'s `finally` awaits the settler while the agent
  stays busy, a settler throw is emitted as `engine.error` and never blocks the drain, the next
  queued prompt starts after settlement; `adoptQueue` carries waiting prompts onto a replacement
  agent so a compaction rebuild loses nothing. `conversation-model.ts` lost its `held` list and
  `settling` flag (111 note 1 closed). Keys per the decision: `enter` queues, `alt+enter` steers,
  `esc` interrupts; the busy prompt hint says so and the help overlay pages `HelpRow`s including
  the prompt keys. `keywork chat` keeps reading mid-turn: plain lines queue, `/steer <text>`
  interrupts, `/queue <text>` is explicit.
- **FR2.6, the workspaces node.** `workspaces-pane-model.ts` + `workspaces-pane.ts`: rows
  `mark slug · focus dirs · n sessions · age`, current first then MRU; `enter` switches (confirm
  row when turns are running), `n` creates, `l` links a focus dir, `x` / `f` / `right` drill into
  focus dirs, tray on `/`. Summon `/workspaces`, dock-native, descriptor persisted. Focus dirs:
  `shared/config/declaration.ts` gains `focusDirs` (PD11.3, described), one writer through
  `cli/link.ts` `linkFocusDir` / `unlinkFocusDir`.
- **`--workspace <slug>` for `run` and `chat`**: unknown slug refused before any context opens,
  exit 2 with a usage line (`docs/headless.md` updated); headless goldens unchanged.
- **Tests.** +53 (212 files). `discovery/help-overlay` gained four prompt-key rows; the lead
  recaptured the five discovery goldens for that and the corner glyph.

**Gate after W2 + W3 + W5 (lead-run):** `bun run check` clean, vitest 2999 passed / 1 skipped
(212 files), e2e 21/21.

## Decisions (Jordan)

Raised 2026-08-30, open:

- **C17 keybinding**: decided (Jordan, 2026-08-30): `Enter` queues, `Alt+Enter` steers.
  Interrupting should be the rarer gesture. W5 starts on this.
- **Quick-open command prefix**: keep `>` or make `/` primary with `>` as a silent alias
  (112 recommended the latter). Rides W4.
- **C55 gauge form** for calm: ramp cell with count (today), bare `▒`, density bar, or tile-fill.
  The `long-session` captures 109 cites no longer exist; candidates need re-rendering first.
- **W1 audit phase 3**: go or hold; if go, sequenced after W2 (C16 touches `slug.ts`).
- **Focus corners**: decided (Jordan, 2026-08-30): the frame-on-top rule stays the default; Jordan
  confirmed it reads right live.
- **e2e enforcement**: decided (Jordan, 2026-08-30): the runner runs every scenario and reports
  all failures; the release `check` job runs `bun run e2e`. Carried by W1 if it goes, else by the
  lead.

W2 assumptions Jordan may reverse:

1. Unfocused resting label ink is `textMid` in the boxed weight too; finished-unseen steps to `text`.
2. Gap cells trim every inner edge symmetrically; layout minimums were not raised, so a tiny
   pane with a large gap shows the `⋯` tile.
3. Borderless focus is the `panel` ground plus the header mark; fences on `panel` lose elevation
   inside a focused borderless pane (`panelLift` is the fix if it bothers).
4. The needs-you stamp still pulses; the steady-inverted-label question (Q-P1) waits for the
   captures round.
5. Boxed title pads paint `background` over the border cells.

W3 assumptions Jordan may reverse:

1. The rubric's "cited" reads recall this run or persisted `usefulness > 0`, because no
   `CitationLedger` (J13) is composed in the app yet.
2. Per-session origin is shown at the sweep level plus provenance glyphs, not per candidate row:
   the kernel records no session lineage on daily entries or promoted notes, and adding it
   touches `notes.ts` / `store.ts` / `gardener.ts`.
3. Carry successor = the newest other active arc, named on the row; no picker.
4. Below-bar notes are left implicitly at finish; the draft lives in memory (a relaunch keeps
   cards, forgets decisions); no G6 notification moment yet; the CLI passes no judgment port,
   so daily-log distillation at close is a no-op in the app today.
5. Digest treatment: `tail` is the default until Jordan picks between `tail` and `stamp`.

W5 assumptions Jordan may reverse:

1. Settlement runs after every turn, before the next queued prompt.
2. `busy()` is true while settling, so `/model` and `/agent` also refuse during settlement.
3. The workspaces row shows `n sessions` on disk per workspace, since one process holds live
   panes for the current workspace only.
4. The switch confirm row fires only when a turn or settlement is in flight; idle panes switch
   without asking.
5. Focus dirs are declared and linkable but not yet consumed by retrieval, bootstrap, or the
   overview; no `keywork link --focus` CLI form yet.
6. The chat REPL reads while streaming, so the prompt and reply text interleave on a real
   terminal (debug REPL).
