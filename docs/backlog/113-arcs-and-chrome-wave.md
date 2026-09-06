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
| **W6 · arc-close and the closing agent** | C73 flat verb commands, J28 steered distillation at close | 4 | `tui/arc-commands.ts`, `workspace-commands.ts`, `cli/arcs.ts`, `cli/memory.ts`, `engine/memory/arcs/`, `gardener.ts` judgment seam, the IR-14 role map |
| **W1 · audit phase 3** | C15, C16, e2e runner reports all failures, release runs e2e | 5 | held for Jordan's go |
| **W4 · trays and pointer** | FR3.8 / FR3.9, H4 / H6 | 5 | landed, see ledger |
| **W8 · drag depth** | FR1.1 pane drag with ghost drop preview, H5 drag semantics | 5 | `pointer-routing.ts`, `layout*.ts`, `app-core.ts` drag state, `view/frame.ts` preview box |
| **W9 · the feel pass** | C74 masthead presence + rungs + toggle, C53 / C54 remainder, C51 scrims, FR5.15 tips, candidate renders for the decision batch | 7 | `masthead.ts`, `stroke-face.ts`, `motion.ts`, `transcript-*`, `marks.ts`, `memory-rows.ts`, `context-gauge.ts` |
| **W10 · intelligence, no LSP** | F2 / F3 repo map, D9 http / sse MCP transport, D11 `.keyworkignore` | 8 | `engine/src/` new repo-map module, `engine/mcp/`, `engine/tools/`, `cli` wiring |
| **W11 · memory deepening** | J13 recall citations, J22 point-of-action recall, J23 return delta, J21 briefing as a spec proposal | 7 | `engine/memory/`, `cli/memory.ts`, `arc-pane*` only on the TUI side |

Merge bar per lane: `bun run check && bun run test && bun run e2e` green, adversarial tests
in the lane's own files, self-review of the diff, a ledger row below.

## W6 tasks (sized)

### C73 (1pt): flat verb commands
The first word after `/` is the whole command; everything after it is one free-text operand.
`/arc [slug]` keeps the picker and switch; `/arc-new [slug]`, `/arc-close [direction]`,
`/arc-abandon [slug]`, `/arc-release`, `/arc-open [slug]`; `/workspace [slug]`,
`/workspace-new [slug]`, `/workspace-default`. The old verb-in-argument forms keep working as
silent aliases for one release. Each command registers its own palette row, description, and
tray completion; the help overlay follows.

### J28 (3pt): the closing agent
`/arc-close <direction>` distills with intent: an auxiliary-role model (IR-14) reads the arc
layer plus the direction and produces the candidate notes and the delivery record the digest
shows; the direction is stamped into the delivery record as provenance; with no direction it
still runs; with no model bound it degrades to the deterministic sweep that exists today. The
digest surface is unchanged; only what fills it improves.

## W9 task: C74 (2pt): masthead presence, rungs, and the toggle

Jordan's live feedback (2026-08-31): the newspaper titling is starting to look great and he
loves the direction; it applies inconsistently; the title-to-page transition should follow
window focus rather than typing; it needs a disable option; and it needs more sizing layers so
various title lengths fit more consistently. So: presence becomes a focus rule (an unfocused
idle pane wears the masthead when it fits, the focused pane is the working page; asks and
lifecycle states still outrank ceremony), the block face gains intermediate rungs between the
current brush scales and the caps floor so the fit degrades gradually instead of jumping, one
audit makes the presence rule the only trigger, and a described config option turns the masthead
off entirely.

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

### W6 · arc-close and the closing agent · landed 2026-08-31 (uncommitted)

- **C73 flat verb commands.** `arc-commands.ts` / `workspace-commands.ts` dispatch on typed
  `ArcInvocation` / `WorkspaceInvocation` unions; the string-verb switches are gone.
  `legacyArcInvocation` / `legacyWorkspaceInvocation` are pure one-release alias mappings into
  the same handlers. Registered flat: `/arc [slug]`, `/arc-new`, `/arc-close [direction]`,
  `/arc-abandon`, `/arc-release`, `/arc-open`, `/workspace [slug]`, `/workspace-new`,
  `/workspace-default`, each with its own registry description; the tray and palette complete
  them with no changes on their side. `commands.ts` gained `verbAndOperand`.
- **J28 the closing agent.** `engine/memory/arcs/closing.ts` `closingJudgment({ provider,
  direction?, onDegrade? })` builds a `CurationJudgmentPort` over the existing Gardener seam
  (defensive JSON parsing, clamped confidence, direction folded into the instruction); one
  degrade notice on provider failure, then inert, the close never wedges. Role map: `roles`
  record in `keywork.json` (IR-14, `.describe()`d, user layer only); `cli/inference/roles.ts`
  resolves `roles.closing` through the existing registry, silent fallback to the session's
  provider. Direction rides `CloseDecisions.direction` into the delivery record as a
  `direction:` body line, shows in the digest header (`steered: <text>`), and every proposal
  still passes staging, R6, and digest approval.
- **Tests.** +22 (214 files): direction visibly changes candidates, no-model close
  byte-comparable to the deterministic sweep, provider throw degrades with one notice,
  hallucinated ids rejected, nothing delivered unapproved, alias round-trips, `/arc-` prefix
  completion.

**Gate after W6 (lead-run):** check clean, vitest 3021 passed / 1 skipped (214 files), e2e 21/21.

### W4 · trays and pointer · landed 2026-08-31 (uncommitted)

- **FR3.8 one row primitive.** `tray.ts` already backed the palette, the chat slash suggestions,
  and every pane tray; the lane finished it: glyph-tiered selection mark (`▸`, `>` at tier 0),
  `TrayStyle.glyphs` threaded from `PaneContext` / `FrameInputs` into palette rows, chat tray and
  `paneTrayView`; chat tray rows are hover / click live through
  `ConversationModel.traySelect / trayAccept` riding the exact enter path; the `⏎` shortcut
  glyph became `enter` so the column survives tier 0.
- **FR3.9 entity trays.** All six tray-bearing panes share `paneTrayMouse` in `pane-tray.ts`:
  hover moves the selection, click runs, outside press dismisses, all through
  `AppCore.handleMouse` and the probe; `handleMouse` / route return booleans so hover repaints
  without storms.
- **H4 interior split drag.** `splitHandleAt` / `dragSplitHandle` on `Layout` extend the
  dock-drag shape in `pointer-routing.ts`; drag and keyboard verbs share `steppedRatio`
  (0.05 lattice, clamped) with a property test proving the reachable width sets identical both
  ways; gap cells hit-test as seams. Behavior change: clicking a shared border is a grip, not a
  focus click (pinned).
- **H6 pointer reality.** Nothing from Track L existed; new `pointer: "on" | "off"` config
  (described per D9) through `compose-panes.ts` to `AppOptions.pointer`; off means
  `useMouse: false`, no pointer plane, no SGR write (OpenTUI 0.5.1 enables once at start and
  disables on destroy, gated on `useMouse`). e2e `pointer-off` proves click inertness.
- **FR3.10 coverage.** Entity tray tables exported and walked for distinct parseable keys; every
  node kind summons via a registered command; the probe gained `createWorkspacesPane` (real gap:
  `/workspaces` was untestable). Deliberate keyboard-only list in the lane ledger.
- **Tests.** +18 (3039 / 1 skipped); e2e +2 scenarios (`tray-tour` with first tray goldens,
  `pointer-off`) plus a drag leg in `pointer-tour`; no pre-existing goldens recaptured.
  `long-session` flakes its compaction-notice wait only under two packs at once; passes alone
  and in the clean full pack.

**Gate after W4 (lead-run):** check clean, vitest 3039 passed / 1 skipped, e2e 23/23.

### W8 · drag depth · landed 2026-08-31 (uncommitted)

- **Finding of record:** FR1.1 / H5's core machinery already existed from the 2026-08-16 wave
  (`Layout.dropTargetAt` / `applyDrop` with all four target kinds, `routePaneDrag`,
  `dropPreviewBox`); the lane built the real gaps only.
- **Landed:** the lifted-source ghost (`dragPreview()` ghosts the dragged pane's own rect while
  no landing target is under the pointer), `cancelDrag()` on escape (consumed only when a drag
  was lifted, routed ahead of overlays), probe `dragHold` / `release` so tests inspect mid-drag
  state, and the keyboard-parity proof: every drag commit is BFS-reachable via keyboard verbs to
  a byte-identical layout tree (hand-built cases for all four target kinds plus a seeded random
  walk). No new `Layout` primitive was needed. W4 composition pinned: a split-boundary press
  resizes, a title-row press lifts, both orientations, both chromes.
- **Tests:** +14 (vitest 3053 passed / 1 skipped); e2e drag leg inside `pointer-tour` with
  `drag-ghost` and `pane-swapped` captures; no goldens recaptured.

**Gate after W8 (lead-run):** check clean, vitest 3053 passed / 1 skipped; e2e full pack ran
green in the lane (23/23), lead rerun deferred until W9 lands to avoid the two-pack flake.

### W9 · the feel pass · landed 2026-08-31 (uncommitted)

- **C74 masthead.** Presence is a focus rule: one pure `wearsMasthead(moment)` with one call
  site (enabled, masthead tier, unfocused, no pending ask, not backtracking or disclosing, no
  unseen failure), pinned by an exhaustive 256-row truth table; typing no longer flips it. New
  condensed bitmap rungs between the faces and caps so `session-1` degrades stroke(34) to
  half-block(28) to condensed(24) to caps(18), fit ladder captured in `masthead-ladder`
  (4 goldens). Per-word scale drop considered and rejected: mixed scales break line coherence
  and make every-word-sets unverifiable. Toggle `masthead: "on" | "off"`, described.
- **C53 / C54 honest remainder.** Found done and not redone: tempo tables, one-mover
  arbitration, settling, arrival / pulse / drain inks, reduced-motion in `Animator`, streaming
  stamp ramp. Landed as missing: input settles all motion on every keypress, `motion: "full" |
  "reduced"` as declared config, the streaming cursor (`▌`, tier-0 `_`) on the streaming entry's
  last line, and scroll stability while streaming (a scrolled-back read never moves as tokens
  arrive; snap-to-live untouched).
- **C51.** Overlay scrim landed (`theme.background + "99"` behind palette / pickers, OpenTUI
  alpha-blend verified, `scrim: "on" | "off"` default off = byte-identical). Unfocused-pane
  dimming deliberately not landed: the honest seam is `PaneContext` construction in
  `view/frame.ts`, which W8 owned this round; follow-up, not workaround.
- **FR5.15 tips.** Four curated tips keyed to state signals, 10-minute clock rotation, no
  timers, quiet-tail only, `tips: "on" | "off"` described; harness pins tips off for golden
  determinism; `status-tips` scenario covers on. Idle-main slot is the same frame.ts follow-up.
- **Coordinator picks applied:** digest default is `stamp`; `memory-airlock-stamp` became
  `memory-airlock-tail`.
- **Decision renders (nothing wired as default):** `elevation-{arc-stamps,turn-age,scroll-map}`,
  `garden-heat-{lead,ink}`, `gauge-{ramp,steps,tile}/fill-1..5` (tile walks the full stage
  progression; steps is the brightening variant), `gauge-{bare,bar}/fill-3`,
  `masthead-ladder/ladder-*`. Ink-only candidates differ in the SVG artifacts.
- **Tests.** Lane delta about +73; e2e 35/35 in-lane with gauge goldens proven stable across
  three clean runs; only recaptures: `focus-corners` mid-edge and nav-ring (focused narrow pane
  now shows the page; condensed rung sets `session` in blocks), corner-pane byte-identical.

Follow-up of record: unfocused-pane dimming and the idle-main tip slot, both one seam in
`view/frame.ts`, free now that W8 landed.

### W10 · intelligence, no LSP · landed 2026-08-31 (uncommitted)

- **D11 `.keyworkignore`.** `shared/src/ignore.ts`, hand-rolled gitignore semantics
  (last-match-wins, negation, dir-only, anchoring, `**`, `?`, classes, escapes, trailing-space
  rule, layered nested files with deeper-wins, excluded-parent rule); malformed lines reported
  once with file / line / reason and skipped.
- **F2 repo map.** `engine/src/repomap/{extract,scan,map}.ts`: honestly heuristic regex symbol
  extractors (ts / js / py / go / rs / md), walker honors nested `.gitignore` +
  `.keyworkignore`, skips every symlink, 10k-file cap with a truncated flag; ranking by
  cross-file identifier references; incremental cache on mtime + size; `serialize(budget)` with
  an honest `… n more files` tail. **Strategy of record: OWN, not LIFT:aider** (aider is Python
  over tree-sitter tag graphs with PageRank; nothing code-level transfers), NOTICE untouched.
  A 5,000-file tree builds in about 3s and truncates honestly.
- **F3 injection.** `repoMap: "auto" | "off"` (described, user layer only); map built for
  trusted workspaces in `composeWorkspace`, enters via `SystemPromptOptions.repoMap`, budgeted
  `min(2048, window / 32)` so reserves are never touched (4k window gets 128 tokens); disclosed
  through the memory-bootstrap injection seam (`source: "repo-map"`); tool saves mark it stale
  and refresh in the background; chat, run, and the TUI share one seam.
- **D9 MCP http / sse.** `engine/mcp/http.ts` + shared `wire.ts`; streamable HTTP per
  2025-06-18 (POST JSON / SSE, `Mcp-Session-Id`, GET notification stream with 405 tolerated,
  per-request timeout, 16MB bound, DELETE on close), static config headers only, no OAuth;
  dropped SSE surfaces as connection loss and the reconciler reconnects, tested against a real
  in-process fixture. MCP pane appends `· http` for http servers only, stdio rows
  byte-identical.
- **Doctor.** Repo map, ignore, and MCP transport rows with off / untrusted states named.
- **Tests.** +82 in lane files; NOTICE untouched.

### W11 · memory deepening · landed 2026-08-31 (uncommitted)

- **J13 recall citations.** `citations.ts` extended in place: recall / citation events carry
  layer and session, an audit codec rides the existing append-only reader (no new write path),
  `cli/memory.ts` `citationTrail` composes one ledger per session run and feeds
  `citationUsefulnessFeed`; citedness survives relaunch via persisted audit events. Usefulness
  signal of record: a wikilink citation in the completed reply (R6-validated) or a `memory_get`
  re-read of a note first surfaced elsewhere, once per note per run; deterministic, no LLM. The
  closing agent's rubric now reads real citations; the W3 stopgap (`recalledArcNotes`) is
  deleted and W3 assumption 6 is closed. Ledger-lens rows appear for free.
- **J22 point-of-action recall.** `point-of-action.ts`: subject from the mutating call, once
  per subject and note per run, relevance floor, `min(1024, flushReserve / 8)` token cap, max 3
  notes, 150 ms race that skips on miss and swallows every failure; hooked via
  `AgentOptions.actionRecall` for `tool.mutates` calls only, recall text appended to the tool
  result so the JSONL is honest and the call can never block. Journaled as `memory-action`.
- **J23 return delta.** `return-delta.ts`, pure and byte-stable, silent when empty; arc pane
  renders up to 3 dim rows above the members; `keywork chat` prints one
  `since you were here: …` line on resume.
- **J21 briefing:** spec-only proposal delivered for Jordan (three open questions), no code.
- **Tests.** About +44 in ten lane files; R6 rejection at ledger, trail, and airlock level;
  citation-driven eligibility flips extend the J18 / W6 fixture; 100-draw budget property test;
  audit round-trip. Self-review caught and fixed a duplicate reply tap on persistent buses, a
  throwing listener that could fail a decorated tool call, and a Windows audit-persist race.

**Gate after W9 + W10 + W11 (lead-run):** check clean, vitest 3195 passed / 1 skipped
(221 files), e2e 35/35.

### W12 · frame follow-ups · landed 2026-08-31 (uncommitted)

- **C51 second half, unfocused dimming.** One resolver in `chroma.ts`: `dimStep` (single OKLCH
  mix toward the ground, blend 0.22 in one constant, the `focusLift` grammar) and `dimmedTheme`
  receding the seven content inks toward `background`; grounds, borders, and the ramp stay.
  Seam exactly where W9 pointed: `body()` computes one `unfocusedTheme` per frame; seams,
  status bar, overlays, and the needs-you inversion keep full strength. `dim: "on" | "off"`
  described; ink-only, so the char frame never moves and monochrome / NO_COLOR are exact
  no-ops (pinned by byte-identical dim-on / dim-off text goldens with span-level hex
  assertions).
- **FR5.15 second half, the idle-main tip slot.** `idleMainLines(tip)` / `noSessionsLines(tip)`
  append the current tip as one dim line through the same `core.tip()` seam; hints never
  replaced; off or ineligible renders nothing.
- **Tests.** +9; e2e +2 scenarios (`chrome-states-dim-{on,off}`, idle-main tip leg); zero
  pre-existing goldens recaptured.

**CI flake fix (2026-09-02):** the first PowerShell shell-session test timed out at 20s on a
cold `windows-latest` runner (Windows PowerShell 5.1 cold start under CI contention, not a
hang; the suite passes locally in about 5s). A `beforeAll` warmup session now pays the cold
start once, outside any assertion, so the per-test timeouts stay meaningful.

**Wave-final gate (lead-run):** check clean, vitest 3204 passed / 1 skipped, e2e all scenarios
green, zero comments and zero `any` across the wave's diffs.

## Decisions (Jordan)

Raised 2026-08-30, open:

- **C17 keybinding**: decided (Jordan, 2026-08-30): `Enter` queues, `Alt+Enter` steers.
  Interrupting should be the rarer gesture. W5 starts on this.
- **Quick-open command prefix**: decided (Jordan, 2026-08-31): `/` is the commands prefix in
  quick-open, matching keywork's own vocabulary; `>` keeps working and stays reserved as an open
  namespace for future non-slash features. `paletteModeOf` accepts both (landed); the hint
  strings and their golden recaptures follow once W8 / W9 land.
- **Airlock digest treatment**: decided (Jordan, 2026-08-31): `stamp` becomes the default;
  `tail` stays as the alternative. W9 flips it and recaptures.
- **Context gauge**: held for renders (Jordan, 2026-08-31): wants tile-fill developed through
  all stages before locking, and a ramp-cell variant that brightens segment by segment as it
  fills; W9 renders both.
- **Audit phase 3 (W1)**: on hold (Jordan, 2026-08-31), kept in sight for the next quiet window.
- **LSP (FR6.16)**: deferred (Jordan, 2026-08-31): OpenCode's LSP integration reads heavy; if
  keywork integrates LSP it must land in the right spot (behind an engine port, its own scoping
  overlay first). W10 does the non-LSP intelligence work now.
- **FR6.17 subagent transparency**: parked; keywork has no subagent spawn mechanism yet, so the
  transparency contract has nothing to attach to. It binds whenever spawning is designed.
- **Launch runway**: [`../launch-runway.md`](../launch-runway.md) written 2026-08-31; Jordan
  runs the Linux walk.

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
   Confirmed (Jordan, 2026-08-31): stays as is.
3. The workspaces row shows `n sessions` on disk per workspace, since one process holds live
   panes for the current workspace only.
4. The switch confirm row fires only when a turn or settlement is in flight; idle panes switch
   without asking.
5. Focus dirs are declared and linkable but not yet consumed by retrieval, bootstrap, or the
   overview; no `keywork link --focus` CLI form yet.
6. The chat REPL reads while streaming, so the prompt and reply text interleave on a real
   terminal (debug REPL).

W6 assumptions Jordan may reverse:

1. Direction provenance is a body line in the delivery record, not a frontmatter key.
2. Role resolution failure falls back silently to the session's provider; the notice covers
   runtime failures only.
3. The closing model reads daily logs and note pairs; staged items and open questions stay on
   the deterministic path.
4. Legacy forms take the operand as the rest of the line, so `/arc new my slug` complains about
   the slug instead of silently dropping words.

W4 assumptions Jordan may reverse:

1. Clicking a shared border grips it for resize; it no longer focuses the pane behind it.
2. Drag resize quantizes to the keyboard's 0.05 lattice.
3. The chat tray dismisses on esc; an outside click leaves it open.
4. Tray shortcut column spells `enter` rather than `⏎`.
5. The quick-open `>` prefix is untouched by W4; decided 2026-08-31, see Decisions.

W8 assumptions Jordan may reverse:

1. With no landing target under the pointer, the ghost sits on the source pane as the
   drop-in-place signal.
2. Escape cancels only a lifted drag; an unmoved title press still passes escape to the pane.
3. The ghost uses the landing slot's layout rect, not the gap-trimmed drawn rect.

W9 taste flags for Jordan:

1. The stamp digest lead `░▓` is glyph-identical to a fresh agent note's lead row.
2. Tips replace the static nav-hint tail while one is eligible.
3. Garden heat maxes at `▓` when a note has no recalls yet.
4. The steps gauge uses the density ramp for both zones and brightness (double duty).
5. Masthead stays threshold-gated: an unfocused wide idle pane still shows the page;
   an unseen failure blocks ceremony.

W10 assumptions Jordan may reverse:

1. The repo map builds only for trusted workspaces.
2. Budget shape is `min(2048, window / 32)`; the window is read from `config.models`
   declarations only.
3. Refresh triggers on tool saves; external edits are picked up on the next agent rebuild.
4. No on-demand `repo_map` tool yet (F3 mentions one; deliberately not built this round).
5. Tool-side ignore filtering was documented as inapplicable: read / write / edit / bash have
   no listing or globbing surface today, so there was nothing to filter.

W11 assumptions Jordan may reverse:

1. Usefulness comes only from citations now; the memory pane's per-note recall count shows
   citation-fed events, not raw recalls.
2. Only the completed turn's final reply is scanned for citations.
3. Headless `run` composes no citation trail yet; point-of-action recall has no off switch.
4. Chat's return delta has no minimum-absence gap; silence-when-unchanged is the gate.

W12 assumptions Jordan may reverse:

1. Dim blend strength is 0.22, one constant.
2. Outcome inks (`success` / `error`) dim with everything else; needs-you stays loud.
3. The tip shows on both idle surfaces.
4. `dim` is app-level config like `scrim`, not flavor-carried, honored from any layer.

### W13 · the medium rung remade · landed 2026-09-02 (uncommitted)

Jordan's live read: the condensed masthead rung was borderline fuzzy. The defect was
segmentation, not resolution: gap 0 fused adjacent 3-wide bitmaps into false ligatures.
Two fixes landed, picked from rendered candidates.

- **The quadrant face, the new tier-2 medium.** `quadrant-face.ts`: a purpose-drawn
  5x6-subpixel font (`I` and `1` narrow at 3) rendered through the full 2x2 quadrant set,
  one subpixel between letters, words joined at the cell level so every letter carves
  identically at any position. `session` sets at 20 cells across 3 rows with real letter
  gaps intact. Ladder of record at tier 2: stroke → half-block → quadrant → caps;
  `half-block-condensed` is retired (the quadrant face is never wider, so the rung was
  unreachable).
- **Condensed ink alternation, the tier-1 medium.** `block-condensed` stays for tier 1:
  `Headline` carries `dim` spans (every second letter), and the masthead view steps those
  letters toward the ground (`alternatedDimBlend` 0.35), restoring boundaries at zero width
  cost. Monochrome gate: `GlyphSupport` gains optional `colorDepth`; at `mono` the
  condensed rung leaves the ladder entirely, since ink cannot separate what geometry fused.
- **Goldens.** `masthead-ladder/ladder-condensed` became `ladder-quadrant`;
  `focus-corners-{frame,grid}/{mid-edge-seam,nav-ring}` recaptured: the narrow panes'
  digits recarve in quadrant, frames and seams byte-identical.

W13 assumptions Jordan may reverse:

1. Quadrant glyph coverage matches the bitmap faces (A-Z, 0-9); unsupported words still
   fall to caps.
2. The alternation blend is one constant (0.35 toward the ground); no config option.
3. Quadrant charset (U+2596..259F) is assumed renderable wherever glyph tier 2 is detected;
   if a live terminal draws them poorly, the reversal is one line in `facesAt`.

**Gate after W13 (lead-run):** check clean, vitest 3211 passed / 1 skipped (222 files),
e2e 36/36.

### W13 follow-up · the gauge decided, elevation redirected · 2026-09-02 (uncommitted)

- **Gauge picks (Jordan, 2026-09-02).** Round-two renders decided it: the rising steps are
  the focused-pane gauge, and the twin tile becomes the unfocused-pane gauge as one combined
  ladder (each cell climbs the braille dots, goes solid, and only then does the next cell
  start; 18 sub-steps). The picks are now what `steps` and `tile` mean; `gaugeStyleFor`
  resolves cockpit → `bar`, focused → `steps`, unfocused → `tile`, and `liveStatus` reads
  focus from the pane context. Retired: the darkening steps, the zone tile, and the
  `steps-rise` / `tile-quad` / `tile-fine` candidate styles, scenarios, and goldens;
  `gauge-steps` and `gauge-tile` recaptured as the picked forms. The 109 options round on
  C55 is closed.
- **Quadrant face kept (Jordan, 2026-09-02):** confirmed from the round-one renders.
- **Elevation redirected (Jordan, 2026-09-02):** the transcript-tint candidates step back;
  the direction is coloring on the borders and title cells, arc-relative within the theme's
  gradients. Candidate landed: `elevation: "chrome"` steps the calm resting label and border
  along `[theme → arc hue]` by context fill (asks, failures, and finished-unseen outrank it);
  scenario `elevation-chrome`, judged in the SVG artifact. Open dials if it ships: depth
  source (context fill vs turn count) and how far toward the hue the ink may travel.

W13 follow-up assumptions Jordan may reverse:

1. Unfocused panes always wear the twin tile; width pressure was not made a separate trigger
   (the tile is already the narrow form at 2 cells).
2. A pane with no focus signal in `liveStatus` reads as focused (steps).
3. The twin tile needs glyph tier 2 (braille); below it, the old single tile-fill glyph.

### W1 · audit phase 3 · in progress 2026-09-02

- **Release gate.** `release.yml`'s check job runs `bun run e2e` (decision of 2026-08-30; the
  runner already reported all failures).
- **C16 slug rename.** `tui/slug.ts` → `slug-ink.ts` with its test and eight importers; the
  same-filename clash with `shared/slug.ts` is gone.
- **C16 doctor unification (decision 10).** One report, both surfaces: `DoctorFacts` gains a
  `crashLog` section (`crashLogFacts` reader in `crash-log.ts`, exported for the CLI), and
  `keywork doctor` prints it. The TUI `/doctor` posts the same rendered report into the
  focused conversation through a new `AppOptions.doctorReport` port that `composePanes`
  implements over `doctorReport` + `workspaceDoctorFacts`; `/crashlog` remains as its own
  command opening the raw log, and a bare App without the port keeps the old open-the-log
  behavior. `SessionPanes.postNotice` is the one new TUI seam.
- Gate at this point: check clean, vitest 3221 passed / 1 skipped, e2e all green.

### W1 · the R-15 sweep · landed 2026-09-02 (uncommitted)

One pass over the surviving duplicates (earlier waves had already retired several of the
listed items):

- **Hoisted.** `shared/text.ts` gains `toUnixEol` + `countOccurrences` (the edit tool and the
  TUI diff preview now share one implementation, so the preview cannot lie);
  `isReservedDeviceName` joins `shared/config/slug.ts` and replaces the twin regexes in
  `memory/naming.ts` and the slug grammar; `sessionsFact` joins `pluralize.ts` (three copies
  gone); `isRecord` joins `defined.ts` (two copies, unified on the array-excluding form);
  `chroma.ts` uses `clamp.ts`.
- **Converted.** The five remaining `(cause as Error).message` casts read through shared
  `toError`; `markdown-commands.ts` uses `isMissingFileError`; `mcp-pane-model` clips through
  the cell-aware `width.ts` clip; `probe.ts` reads `ConversationPane.model` directly (the
  cast was never needed, the field is public); `cli/mcp.ts` `serverView` is a spread;
  `presetsPortFor` drops its redundant `isPresetName` guards (the port types already narrow).
- **Deliberate keeps.** `excerpt` x3 (three different semantics: response body, one-line
  flatten, cell text), the two engine `truncate`s (different notice strings are part of tool
  output and compaction records), `firstLine` pair (limit-parameterized vs fixed-80),
  `megabytes` (single site). Named here so the next audit does not re-litigate them.

### W1 follow-up · the long-session compaction race · fixed 2026-09-02

The W4-era "compaction-notice flake" turned reproducible and got diagnosed: `stage.settle()`
waits for visual idle, the thinking spinner never goes visually idle while the after-turn
settler runs, so the capture could land before the compaction notice posted; the assertion
then read a frame the notice had not reached. The scenario now waits for the notice itself
(`into a summary · context now` after the auto-fold; a two-notice pattern before the manual
fold capture), per the standing rule that markers name something visible. Three consecutive
solo runs green; no product change was involved.

**Gate after W1 C16 + R-15 (lead-run):** check clean, vitest 3224 passed / 1 skipped
(223 files), e2e 38/38 twice. Remaining in W1: C15 only (`testing/` module per package, the
52-file migration, the `workflows.test.ts` split); it lands cleanest on a fresh commit
boundary given the size of the tree already waiting.

### W1 · C15, the testing modules · landed 2026-09-02 (uncommitted)

The audit's last phase-3 item, run as three slices with the full suite green between each:

- **The modules.** `@keywork/shared/testing` (new subpath export beside `./config`):
  `scratchDirs(prefix)` (a scratch-dir maker with one registered afterEach sweep),
  `useTempDir(prefix)` (per-test dir accessor), `tick()`. `@keywork/engine/testing`:
  `recordingProvider(script?, identity?)`, which records every `ProviderRequest` and answers
  "ok" forever when unscripted (matching the four retired ad-hoc fakes exactly).
  `tui/src/testing/` (package-internal): `press` / `pressModel` (the two honest keypress
  shapes), `typedSequence`, `waitFor`, and `workflow-probe.ts` with the probe query helpers.
- **The migration.** 45 test files moved onto the canonical helpers: 23 temp-dir idioms, 22
  cleanups-array idioms (memory, arcs, extensions, checkpoints), 4 provider fakes, 10 press
  duplicates, 5 `typedSequence` copies, 1 `waitFor`. `pricing.test.ts`'s leaked temp dirs
  are cleaned with everything else. Kept local on purpose: `mcp-pane`'s settling press,
  `prompt-editor`'s outcome-returning press, `transcript-navigation`'s option-taking press,
  the two workspaces-pane presses (return values and width 10), and the domain vault
  fixtures (they differ in registry/clock/secrets, so only their scratch-root mechanics
  were canonicalized; a forced `openVault` would have been over-fitting). `steppingClock`
  from the audit list no longer had a surviving duplicate to hoist.
- **The split.** `workflows.test.ts` (2,932 lines, 36 describes) became seven files:
  `workflows-{layout,palette,pointer,panes,conversation,session,preset}.test.ts`, mapped by
  feature area; the memory-pane and mcp-wiring blocks moved into `memory-pane.test.ts` and
  `mcp-pane.test.ts` per the S-12 row. Shared fixtures live in `testing/workflow-probe.ts`.
- **Found and fixed along the way:** the migration exposed that `shell-session.test.ts`'s
  afterEach was doing double duty (dirs and live shells); the shell half now stands alone.
- **Real-timer sleeps:** reviewed against the 28 sites; the remaining ones are bounded
  polls on real processes and timers with no settle promise to await, so none were blind
  converts. `tick()` exists for the zero-delay flushes when files migrate naturally.

### W1 wave 2 · the launch doc pass · landed 2026-09-02 (uncommitted)

- README's mid-run keys bullet said `Enter` steers and `Alt+Enter` queues, the inverse of
  the decided C17 keybinding; fixed, and the Windows Terminal `ctrl+shift+p` reality plus
  the `leader i` chord are now stated where a Windows reader will see them.
- Public-repo sweep: NOTICE reviewed current, every local link in `README.md` and
  `docs/README.md` resolves, tree and history secret scans clean (the only pattern hits are
  the redaction test's documented EXAMPLE fixtures), prose check green. Both doc-pass rows
  in `docs/launch-runway.md` are closed; the remaining runway items are Jordan's (first
  tag, npm name, one-liner, the Linux walk) plus the runner-label check at first tag.

**Gate after C15 + the doc pass (lead-run):** check clean, vitest 3224 passed / 1 skipped
(229 files), e2e 38/38.
