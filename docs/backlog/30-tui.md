# Workstream C: TUI, Keyboard & Tiling

> `packages/tui`. OpenTUI on Bun. The identity workstream: Hyprland-grade dynamic tiling
> (C8–C11 carry the tiling acceptance bar), leader-key grammar, palette-as-docs,
> flicker-free rendering. Read `sst/opencode` `packages/tui` before writing a line (MIT).

---

### C1 (2pt): App shell
OpenTUI bootstrap: full-screen app, alternate screen, clean mount/unmount, resize handling,
crash-safe terminal restore (never leave the user's terminal broken), global error boundary
rendering a readable failure.
**Accept:** launches/quits cleanly on Windows Terminal + a Linux terminal; deliberate throw
restores terminal state.
**Strategy:** `LIFT:opencode` `packages/tui` bootstrap patterns.

### C2 (2pt): Render discipline
The no-flicker contracts as tests: width-constrained rendering, differential updates (only
dirty regions), output caching per component; a perf budget test (render 200-message
conversation < 16ms/frame on CI hardware).
**Accept:** perf test in CI; scroll of a long buffer produces no full-screen repaints
(instrumented).
**Strategy:** `LIFT:pi` pi-tui *contracts* as spec (framework differs); `LIFT:opencode`
component patterns.

### C3 (3pt): Keybinding engine
Chord parsing (`ctrl+x`, sequences), **leader key with configurable timeout** (default
`ctrl+x`, 2000ms), namespaced actions (`pane.split`, `session.fork`), JSON config from M0.6
schema: string/array forms, `"none"` to unbind, platform-specific defaults.
**Accept:** unit-tested resolution incl. leader timeout expiry, shadowing, unbind; config
round-trips through schema validation.
**Strategy:** `LIFT:opencode` binding-resolution model (`tui.json`).

### C4 (1pt): Keybinding hot reload
Watch config file; rebind live without restart; emit reload event (status-line toast).
**Accept:** E2E: edit file, binding changes take effect within 1s.
**Strategy:** `LIFT:pi` `/reload` pattern (scoped to keybindings here; D8 generalizes).

### C5 (2pt): Command palette
Overlay with fuzzy filter over all registered actions; **every row shows its live
keybinding** (palette as living documentation); Enter runs the action; recently-used ranking.
**Accept:** palette opens via leader+p; fuzzy match test; displayed bindings update after a
rebind.
**Strategy:** `LIFT:opencode` palette; Omarchy palette-as-docs principle.

### C6 (1pt): Keybinding overlay
Omarchy `Super+K`-style cheat-sheet overlay: grouped current bindings, searchable, rendered
from the live keymap (never a hardcoded list).
**Accept:** overlay reflects a rebind immediately; groups match action namespaces.
**Strategy:** Omarchy idea; `OWN`.

### C7 (2pt): Input editor
The prompt editor: multiline (`shift+enter`), history (per project), kill/yank basics, paste
handling, `ctrl+g` external `$EDITOR` escape hatch, IME-correct hardware cursor placement.
**Accept:** manual test script + unit tests for history/multiline; `$EDITOR` round-trip works
on Windows (Notepad fallback).
**Strategy:** `LIFT:pi` (CURSOR_MARKER idea, `Ctrl+G`); `LIFT:opencode` editor components.

### C8 (3pt): Dwindle layout tree
The tiling core: binary split tree with dwindle auto-placement (new pane splits the focused
leaf along its longer axis), automatic re-balance on close, min-size constraints, resize
verbs (optional, never required).
**Accept:** property tests: any sequence of open/close yields a gapless, overlap-free layout
filling the screen; resize clamps at min sizes.
**Strategy:** `OWN` (window-manager literature; no influencer has this).

### C9 (2pt): Directional navigation & swap
Spatial focus movement (leader+h/j/k/l and arrows), geometric nearest-neighbor rather than
list-order; directional swap/move of panes; focus follows visibly (border/title highlight).
**Accept:** unit tests on fixture layouts (incl. ambiguous-neighbor cases); focus indicator
snapshot test.
**Strategy:** `OWN`.

### C10 (1pt): Zoom & layout cycle
Zoom-toggle: focused pane temporarily fullscreen, same key restores exact prior layout;
layout cycle (rotate split orientations).
**Accept:** zoom→unzoom restores byte-identical layout tree; cycle test.
**Strategy:** `OWN` (Hyprland fullscreen-toggle semantics).

### C11 (2pt): Pane registry & one-keystroke summon
Pane type registry (id, title, factory, bus subscriptions); leader+key summon per type
(conversation/diff/terminal/tree); summoning an open pane focuses it instead of duplicating
(configurable); panes declare what they subscribe to and the bus does the rest.
**Accept:** summon-or-focus behavior tested; a toy pane registers and receives only its
subscribed events.
**Strategy:** `OWN` composition on A4 bus.

### C12 (3pt): Conversation pane
The flagship pane: streamed markdown rendering, syntax-highlighted code blocks, collapsed
tool-call blocks (expandable), steer (`Enter`) vs queue (`Alt+Enter`) wired to A8, scrollback
with C2 discipline, image placeholder handling.
**Accept:** E2E with mock provider: streaming renders progressively, steer visibly aborts a
running tool, queue delivers after; long-session scroll perf within budget.
**Strategy:** `LIFT:opencode` message components; `LIFT:pi` steer UX.

### C13 (2pt): Session-tree pane
Renders B6's tree: branch structure, labels, active path highlighted; keyboard: jump to
node, fork here, label here; switching branches updates the conversation pane live via bus.
**Accept:** fixture-tree navigation E2E; branch switch round-trips.
**Strategy:** `OWN` UI over `LIFT:pi` data.

### C14 (2pt): Diff pane
Live unified diff of session file changes (working tree vs session start, later vs E-stream
snapshots); per-file navigation; auto-updates on file-changed events.
**Accept:** mock tool writes appear in the pane within one frame of the event; large-diff
scroll within perf budget.
**Strategy:** `LIFT:opencode` diff rendering.

### C15 (3pt): Terminal pane
Embedded PTY pane (Bun spawn + ConPTY on Windows): the agent's bash output mirrored live,
and/or a user shell scoped to the project. The Windows ConPTY story is the risk; timebox and
document limits honestly in `docs/windows.md`.
**Accept:** interactive shell usable on Windows Terminal + Linux; agent bash commands mirror
into it via events.
**Strategy:** `OWN` (evaluate `LIFT:opencode` if they ship one).

### C16 (2pt): Theme system
Design-token palette (one palette drives every pane, the Omarchy rule), JSON theme schema,
built-in default + high-contrast, hot-reloadable.
**Accept:** schema-validated theme loads; every pane color traces to a token (lint rule or
test over styles).
**Strategy:** `LIFT:opencode` theme schema.

### C17 (2pt): `system` theme
Terminal-derived default: query terminal background (OSC 11), derive ramp, reuse ANSI 16 so
keywork looks native in any terminal with zero config. This is the Omarchy-grade default;
first-run beauty depends on it.
**Accept:** light and dark terminal fixtures produce legible, contrast-checked palettes;
graceful fallback when OSC query unsupported.
**Strategy:** `LIFT:opencode` system theme.

### C18 (2pt): Status line
Single-line honest status: model + provider, session name/branch, token/cost (A15, live),
trust-level slot (E2 fills it), transient toasts (reloads, errors). No clutter: every item
justified or absent (Omarchy corner-polish).
**Accept:** updates live from bus events in E2E; layout degrades gracefully at narrow widths.
**Strategy:** `OWN`.

## Ledger

### C4 keybinding hot reload (landed 2026-09-07)

**What landed.** `config.keybindings` now reaches the live keymap; before this it was
validated by the schema and then ignored (`AppCore` built its `Keymap` from `appBindings`
alone). `Keymap.rebind(options)` compiles a fresh binding table and swaps it in one step, so a
table that fails to compile leaves the old one untouched and a pending leader is disarmed.
`packages/tui/src/keybindings.ts` holds the loader: `resolveBindings(defaults, overrides)`
lays the config over the built-in chords and names an action that does not exist,
`applyKeybindings` reads the source and rebinds (posting `keybindings kept · <why>` on
failure), and `watchKeybindings` debounces change events through the `DebounceTiming` seam
(150ms quiet) before reloading and posting `keybindings reloaded`. The CLI side
(`packages/cli/src/keybindings.ts`) reads the `keybindings` section through `loadConfig` so
the user and trusted-project layering stays the one in `load.ts`, watches each layer's
directory for `keywork.json` (untrusted projects stay unwatched), and turns a JSON slip into
`keywork.json:3:17 is not valid JSON` through its own scanner because Bun's `JSON.parse`
message carries no position. `runApp` applies the bindings once at startup and watches
until exit.

**Evidence.** `packages/tui/src/keybindings.test.ts` (9 tests: the new chord fires one quiet
period after the injected change event, a burst coalesces into one read, a conflicting file
posts the error and keeps the old binding live, unwatch stops reloads),
`packages/tui/src/keymap.test.ts` (3 rebind tests), `packages/cli/src/keybindings.test.ts`
(9 tests over real temp files: layering, empty config, line and column of a slip, schema
complaint on one line, watched directories per trust level, the scanner). No real timers in
any test.

**Crossings.** `app.ts` gained one startup hunk and one line in `onExit`;
`compose-panes.ts` passes `fileKeybindings(...)` into `AppOptions.keybindings`. Config parse
errors on the other sections of `keywork.json` also surface through this notice, since the
whole file is re-read; that is honest rather than a bug.

**Assumptions Jordan may reverse.**
- The leader stays `ctrl+k` and is not configurable from the file yet; the schema has no
  `leader` field and adding one is a separate decision.
- A reload that changes nothing still posts `keybindings reloaded` (any write to the file
  counts as a reload).
- Watching the directory rather than the file is deliberate (editors rename on save), so
  other writes into `~/.keywork` trigger a harmless re-read.

### C17 `system` flavor (landed 2026-09-07)

**What landed.** `system` is a flavor, not a theme value. Rationale: after R-07/C7 `theme`
is a partial token override laid over the worn flavor, and PD15 says the flavor is the unit;
folding "system" into `theme` would have made a second mechanism. `config.flavor` (new,
`.describe()`-justified) names which closet flavor is worn at startup, `theme` overrides lay
over whichever that is, and `/flavor-system` hot-swaps like every other flavor because the
closet always holds it. `packages/tui/src/osc.ts` gained the query bytes (OSC 11, OSC 10, OSC
4;0..15 in one burst) and `parseColorReplies`, a pure bytes-in colors-out parser for X11
`rgb:` specs at every digit width, hash forms, and both terminators.
`packages/tui/src/system-theme.ts` holds `queryTerminalColors` (injected transport, timer
from the `DebounceTiming` seam, 200ms cap, resolves early once all 18 replies arrive),
`colorsFromEnv` (`COLORFGBG` as xterm indices), `detectTerminalColors` (skips the query off a
tty or on `TERM=dumb`), `systemTokens` (ground and ink from the terminal, panel and panelLift
as lightness steps away from the ground, textMid, textDim, and border as blends of ink toward
ground, accent and ramp from ANSI 12 and 14, success and error from 10 and 9, accentSoft from
4, each lifted through `inkClearingFloor` until it clears the same floors `flavor.ts`
enforces), and `stdioColorTransport`, which borrows raw mode for the reply and hands the
stream back paused before OpenTUI takes it. `chroma.ts` gained `inkClearingFloor`,
`shiftLightness`, and `blendToward`. Fallback order: terminal answer, then `COLORFGBG`, then
keywork-night under the `system` name.

**Evidence.** `packages/tui/src/system-theme.test.ts` (14 tests: dark Tokyo Night fixture
wears its own ground, ink, and ANSI accents; dark, light, pure black, and Solarized-light
fixtures all pass `contrastFailures`; bright green on white deepens until it reads; the query
writes the burst and resolves on the last reply with the listener and timer released; the
timeout settles for the ground alone; silence yields undefined; env parsing; the stdio
transport restores raw mode and pauses). `packages/tui/src/osc.test.ts` (4 query and parser
tests), `packages/tui/src/chroma.test.ts` (6 tests for the new helpers),
`packages/tui/src/flavor.test.ts` (3 tests for wearing a named closet flavor with overrides
on top).

**Crossings.** `openPanes` runs the query before `runApp` and passes `flavors:
[systemFlavor(colors)]`; `PanesSeams.terminalColors` lets tests skip stdin. `runApp` posts
`no flavor named "x" · wearing keywork-night` when `config.flavor` names nothing in the
closet.

**Assumptions Jordan may reverse.**
- The query runs at every interactive start, even when the worn flavor is keywork-night, so
  `/flavor-system` always has a real palette. A terminal that never answers OSC 11 pays the
  200ms cap once per launch; the cap can drop or the query can move behind `config.flavor`.
- Accent is ANSI bright blue and the ramp is two stops (bright blue to bright cyan); the
  ANSI 16 have no purple family that reads on every terminal, so the keywork-night sweep is
  not reproduced.
- `systemFlavor` wears `seams` chrome and `calm` instruments like keywork-night; a
  terminal-native flavor might want `borderless`.
- A silent terminal with no `COLORFGBG` gets keywork-night under the `system` name rather
  than a notice.
### C15 terminal pane (2026-09-07, lane-run: 25 tests / 2 files green, `terminal-mirror` e2e passing)

**Landed.** One pane kind `terminal` with two modes. **Mirror** (default; `/terminal`,
`leader shift+t`, summon-or-focus) follows the focused conversation pane's agent bus and
shows each `bash` call as `$ command`, its `tool.output` chunks as they stream, and a
`· done` or `· failed` marker on `tool.finished` (when nothing streamed, the finished
output is shown once instead). **Shell** (`/terminal shell`, `/term shell`) spawns a
non-interactive shell over pipes in the workspace root through the additive engine seam
`openInteractiveShell` (`shell-session.ts`, reusing `spawnShell` and `killTree`), sends
each typed line to the child's stdin, renders its stdout and stderr, marks exits, and
restarts on the next `enter`. Both modes render through `TerminalScrollback`: ANSI stripped,
`\r` rewrites the line, CRLF is one newline, 2000 lines kept, `pageup`/`pagedown`/`home`/
`end` in both modes and `j`/`k`/`g`/`G` in mirror mode (shell mode keeps letters for
typing). The pane opens docked right, describes as `{ kind: "terminal", mode, sessionId? }`,
and revives from the workspace file; a revived mirror finds its session by id once that
conversation pane has an agent, retrying on each frame until then. Shell mode refuses to
open in an untrusted workspace with the notice `shell mode needs a trusted workspace ·
/init to trust it`; typed commands are the user's own and never enter the agent's
permission gate. No PTY: OpenTUI 0.5.1 ships no terminal renderable, Bun's `spawn` has no
ConPTY option, and the honest limits are in `docs/windows.md`.

**Evidence.** `terminal-model.test.ts`: "shows the started command, streamed chunks, and the
finished marker", "falls back to the finished output when nothing streamed and marks
failures", "ignores tools that are not shells and output for unknown calls", "keeps trying
to locate a bus until one exists and unsubscribes on dispose", "scrolls with j/k and pages,
pinned to the end by default", "spawns on construction, sends typed lines to the child, and
renders its output", "does not steer scrollback with plain letters while a shell is live",
"marks a child exit and restarts the shell on the next enter", "kills the child on dispose
and ignores its later output", "stays without a shell when no spawner is wired", "strips
ANSI, honors carriage returns, and drops control bytes", "keeps a partial line open across
chunks and clips to the width", "is bounded to the configured line limit".
`terminal-pane.test.ts`: "renders the mirror mode empty hint, then the mirrored command
within one frame", "renders the shell prompt with the typed line and the child's output",
"bounds scrollback and keeps the newest lines in view", "kills the child on dispose",
"/terminal opens a mirror pane docked right and focused", "leader shift+t summons the
terminal and refocuses it instead of duplicating", "/term shell opens a shell pane beside
the mirror and refocuses by mode", "refuses shell mode in an untrusted workspace with a
notice", "terminal is absent when no terminal factory is wired", "describes both modes and
revives them from the saved workspace", "round-trips a mirror descriptor with its session
id and rejects bad modes", "revived mirrors find their session by id once its pane has an
agent". E2E `terminal-mirror` (golden `mirrored`): a mock agent's `bash` call streams three
lines into the pane opened with `leader shift+t`. Windows smoke 2026-09-07: Git Bash and
`powershell.exe` both run typed lines, keep `cd`, and surface stderr through the seam.

**Crossings.** `pane.ts` (`TerminalMode`, descriptor variant), `pane-kinds.ts`
(`terminal` kind docked right, `TerminalPaneFactory`, `PaneBuildSeams.conversationPane`),
`workspace-state.ts` (`parseTerminalPane`), `restore-plan.ts` (`terminal` restorable),
`app-actions.ts` (`terminal.summon` on `leader shift+t`, which moved the help overlay's
golden), `app-core.ts` (`openTerminal(mode)` beside `openBrowser`, `conversationPane()`
seam), `core-commands.ts` (`/terminal [mirror|shell]`, alias `/term`), `probe.ts`
(`createTerminalPane` in the probe options), `app.ts` (`AppOptions.terminalPane` port and
the factory registration), `compose-panes.ts` (`terminalPane: { trusted: projectTrusted }`),
engine `shell-session.ts` and `index.ts` (`InteractiveShell`, `openInteractiveShell`).
`conversation-pane.ts`, `conversation-model.ts`, `transcript-view.ts`, `file-pane.ts` and
`packages/server` untouched.

**Windows limits.** No ConPTY, no signals to the child, no readline, no full-screen
programs; see the terminal-pane table in `docs/windows.md`.

**Assumptions Jordan may reverse.**
- The summon key is `leader shift+t` (mnemonic beside `leader t` for the tree); `y`, `Y`
  and `d` were left for the copy and diff verbs.
- The pane docks right by default; a bottom dock does not exist in the layout today.
- Mirror mode follows tools named `bash` or `shell` only; other tools' output stays in the
  transcript.
- Mirror mode binds to the focused conversation pane at open time (by pane id) and to the
  session id after revival; it does not switch panes when focus moves.
- Shell mode uses `detectShell()`, so Git Bash wins over PowerShell on a Windows machine
  that has `bash` on `PATH`, matching the agent's own `bash` tool.
- Typed input is a single line with backspace only; no cursor movement, history or
  completion in v1.
- One `AppOptions.terminalPane` port (`trusted`, optional `spawn`) rather than a config
  option; the shell pane needs no user-facing setting.

### C14 diff pane (landed 2026-09-07)

**What landed.** A `diff` pane kind: a file list on top (path, `+added -deleted`, and
`turn N` when the checkpoint tags know which mutation-bearing turn last touched the file),
a cursor over those files, and the selected file's unified diff below, rendered through
keywork's own `diff-render.ts` (nothing lifted from OpenCode, so `NOTICE` is unchanged).
The baseline is the session-start checkpoint tree when checkpoints are open; without
checkpoints in a git repository it is `HEAD` through an injected `GitRunner`; untrusted
folders and folders with neither get a notice line instead of a diff. The pane refreshes on
`tool.finished` for `write` and `edit` (every agent bus is tapped once in `runApp` through
`announcingFileChanges`, which also wraps `checkpoints.undo`/`redo`/`restoreTo` so `/undo`
and `/redo` refresh it), and on `r`; there is no polling. Diffs are computed lazily per
selected file and cached until the next refresh; `diff-render.ts` caps a body at 160 lines
(`maxDiffLines`) with a trailing `… N more diff lines …` note, and its LCS falls back to a
bulk replace above 250k cells, so a 5000-line rewrite renders and scrolls inside the budget.
Keys: `j`/`k`/arrows walk files (body scroll resets), `enter` opens the file through
`PaneIntents.openFile(path, { line })` at the first hunk's new-side line, `r` refreshes,
`pagedown`/`pageup`/`space`/`ctrl+d`/`ctrl+u`/`home`/`end` scroll the body. Wiring matches
the browser: `/diff` (alias `/changes`), `leader g` summon-or-focus (`d` is reserved for the
copy verbs in 96 and `t` is the session tree), `PaneRequest { kind: "diff" }`, workspace
descriptor `{ kind: "diff" }`, docked right by default.

**Engine seam.** `Checkpoints` now implements `CheckpointReads`: `baseline()` (the first
captured tree, or a snapshot taken on first ask when nothing has been captured yet),
`changedSince(tree)` (`git diff-tree -r --numstat -z` between the baseline and a fresh
snapshot, each path stamped with the last turn that touched it from an incrementally
attributed map of turn-start trees), and `contentAt(tree, path)` (`git cat-file -p`, raw
stdout so trailing newlines survive). `git()` keeps trimming; `gitRaw()` is the untrimmed
sibling.

**Evidence.** `checkpoints.test.ts` (+3: baseline listing with counts, raw content at a
tree, per-turn attribution across three turns), `diff-model.test.ts` (12: the mock write
lands in the list and the diff on the next notify, `j`/`k` walk with lazy loads, enter at the
first hunk of a change deep in a file, refresh after an undo through the wrapper, bounded
rendering and page scrolling of a 5000-line change, no-baseline and untrusted notices, a
failing baseline read, `r` re-reads and dispose unsubscribes, `followMutations` announces
only write/edit, `gitHeadBaseline` over a fake runner, `firstHunkLine`), `diff-pane.test.ts`
(6: title totals and rendered rows, empty state naming the baseline, enter intent, `/diff`
docks right and `leader g` focuses the same pane, descriptor round-trip, open-at-hunk through
the app into a file pane), e2e `diff-pane` with goldens `after-write` and `after-undo`
(mock write appears with `turn 1`, `/undo` empties the pane, `/redo` brings the row back,
enter opens `notes.txt` in a viewer). Gate for this lane: the touched test files (110 tests
across 7 files) plus the scenario, with `bun run check:types` and `biome check` clean on the
touched files.

**Crossings.** `pane.ts` (`FileOpenOptions.line`, descriptor), `pane-kinds.ts`,
`workspace-state.ts`, `restore-plan.ts` (one `case`), `app-actions.ts` (`diff.summon`),
`core-commands.ts`, `app.ts` (options wrapped once at the top of `runApp`, factory
registration), `probe.ts` and `command-coverage.test.ts` (`createDiffPane`), `index.ts`
exports, `compose-panes.ts` (`diffPort` picks the baseline; `gitRunnerIn` spawns git for the
HEAD fallback), `engine/index.ts` exports, `scripts/e2e/scenarios/index.ts`.

**Assumptions Jordan may reverse.**
- `leader g` is the summon chord; `d` stays free for the copy verbs.
- The pane docks right (beside `arc` and `mcp`) rather than left with the browser.
- `FileOpenOptions.line` is carried by the intent but `FileModel` only honors `atEnd` today;
  the file-pane owner can scroll to it in a follow-up, the diff side needs no change.
- Untrusted folders get the notice even though checkpoints run for them; the memory pane
  draws the same line.
- "turn N" counts mutation-bearing turns since the app started, one ordinal per
  `takeTurnTag` boundary, and is app-wide rather than per session.
- Every refresh runs `git add -A` plus `write-tree` in the shadow repo; on a very large tree
  that is the cost of exact diffs, and the refresh is event-driven so it stays bounded.
- Renames show as a delete plus an add; binary files show a `binary file` note.
- The body cap reuses `diff-render.ts`'s 160 lines rather than a pane-specific limit.
