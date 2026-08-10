# Workstream C — TUI, Keyboard & Tiling

> `packages/tui`. OpenTUI on Bun. The identity workstream: Hyprland-grade dynamic tiling
> (C8–C11 acceptance bar set in `../tasks.md` C4), leader-key grammar, palette-as-docs,
> flicker-free rendering. Read `sst/opencode` `packages/tui` before writing a line (MIT).

---

### C1 (2pt) — App shell
OpenTUI bootstrap: full-screen app, alternate screen, clean mount/unmount, resize handling,
crash-safe terminal restore (never leave the user's terminal broken), global error boundary
rendering a readable failure.
**Accept:** launches/quits cleanly on Windows Terminal + a Linux terminal; deliberate throw
restores terminal state.
**Strategy:** `LIFT:opencode` `packages/tui` bootstrap patterns.

### C2 (2pt) — Render discipline
The no-flicker contracts as tests: width-constrained rendering, differential updates (only
dirty regions), output caching per component; a perf budget test (render 200-message
conversation < 16ms/frame on CI hardware).
**Accept:** perf test in CI; scroll of a long buffer produces no full-screen repaints
(instrumented).
**Strategy:** `LIFT:pi` pi-tui *contracts* as spec (framework differs); `LIFT:opencode`
component patterns.

### C3 (3pt) — Keybinding engine
Chord parsing (`ctrl+x`, sequences), **leader key with configurable timeout** (default
`ctrl+x`, 2000ms), namespaced actions (`pane.split`, `session.fork`), JSON config from M0.6
schema: string/array forms, `"none"` to unbind, platform-specific defaults.
**Accept:** unit-tested resolution incl. leader timeout expiry, shadowing, unbind; config
round-trips through schema validation.
**Strategy:** `LIFT:opencode` binding-resolution model (`tui.json`).

### C4 (1pt) — Keybinding hot reload
Watch config file; rebind live without restart; emit reload event (status-line toast).
**Accept:** E2E: edit file, binding changes take effect within 1s.
**Strategy:** `LIFT:pi` `/reload` pattern (scoped to keybindings here; D8 generalizes).

### C5 (2pt) — Command palette
Overlay with fuzzy filter over all registered actions; **every row shows its live
keybinding** (palette as living documentation); Enter runs the action; recently-used ranking.
**Accept:** palette opens via leader+p; fuzzy match test; displayed bindings update after a
rebind.
**Strategy:** `LIFT:opencode` palette; Omarchy palette-as-docs principle.

### C6 (1pt) — Keybinding overlay
Omarchy `Super+K`-style cheat-sheet overlay: grouped current bindings, searchable, rendered
from the live keymap (never a hardcoded list).
**Accept:** overlay reflects a rebind immediately; groups match action namespaces.
**Strategy:** Omarchy idea; `OWN`.

### C7 (2pt) — Input editor
The prompt editor: multiline (`shift+enter`), history (per project), kill/yank basics, paste
handling, `ctrl+g` external `$EDITOR` escape hatch, IME-correct hardware cursor placement.
**Accept:** manual test script + unit tests for history/multiline; `$EDITOR` round-trip works
on Windows (Notepad fallback).
**Strategy:** `LIFT:pi` (CURSOR_MARKER idea, `Ctrl+G`); `LIFT:opencode` editor components.

### C8 (3pt) — Dwindle layout tree
The tiling core: binary split tree with dwindle auto-placement (new pane splits the focused
leaf along its longer axis), automatic re-balance on close, min-size constraints, resize
verbs (optional, never required).
**Accept:** property tests — any sequence of open/close yields a gapless, overlap-free layout
filling the screen; resize clamps at min sizes.
**Strategy:** `OWN` (window-manager literature; no influencer has this).

### C9 (2pt) — Directional navigation & swap
Spatial focus movement (leader+h/j/k/l and arrows) — geometric nearest-neighbor, not
list-order; directional swap/move of panes; focus follows visibly (border/title highlight).
**Accept:** unit tests on fixture layouts (incl. ambiguous-neighbor cases); focus indicator
snapshot test.
**Strategy:** `OWN`.

### C10 (1pt) — Zoom & layout cycle
Zoom-toggle: focused pane temporarily fullscreen, same key restores exact prior layout;
layout cycle (rotate split orientations).
**Accept:** zoom→unzoom restores byte-identical layout tree; cycle test.
**Strategy:** `OWN` (Hyprland fullscreen-toggle semantics).

### C11 (2pt) — Pane registry & one-keystroke summon
Pane type registry (id, title, factory, bus subscriptions); leader+key summon per type
(conversation/diff/terminal/tree); summoning an open pane focuses it instead of duplicating
(configurable); panes declare what they subscribe to — the bus does the rest.
**Accept:** summon-or-focus behavior tested; a toy pane registers and receives only its
subscribed events.
**Strategy:** `OWN` composition on A4 bus.

### C12 (3pt) — Conversation pane
The flagship pane: streamed markdown rendering, syntax-highlighted code blocks, collapsed
tool-call blocks (expandable), steer (`Enter`) vs queue (`Alt+Enter`) wired to A8, scrollback
with C2 discipline, image placeholder handling.
**Accept:** E2E with mock provider — streaming renders progressively, steer visibly aborts a
running tool, queue delivers after; long-session scroll perf within budget.
**Strategy:** `LIFT:opencode` message components; `LIFT:pi` steer UX.

### C13 (2pt) — Session-tree pane
Renders B6's tree: branch structure, labels, active path highlighted; keyboard: jump to
node, fork here, label here; switching branches updates the conversation pane live via bus.
**Accept:** fixture-tree navigation E2E; branch switch round-trips.
**Strategy:** `OWN` UI over `LIFT:pi` data.

### C14 (2pt) — Diff pane
Live unified diff of session file changes (working tree vs session start, later vs E-stream
snapshots); per-file navigation; auto-updates on file-changed events.
**Accept:** mock tool writes appear in the pane within one frame of the event; large-diff
scroll within perf budget.
**Strategy:** `LIFT:opencode` diff rendering.

### C15 (3pt) — Terminal pane
Embedded PTY pane (Bun spawn + ConPTY on Windows): the agent's bash output mirrored live,
and/or a user shell scoped to the project. The Windows ConPTY story is the risk — timebox and
document limits honestly in `docs/windows.md`.
**Accept:** interactive shell usable on Windows Terminal + Linux; agent bash commands mirror
into it via events.
**Strategy:** `OWN` (evaluate `LIFT:opencode` if they ship one).

### C16 (2pt) — Theme system
Design-token palette (one palette drives every pane — Omarchy rule), JSON theme schema,
built-in default + high-contrast, hot-reloadable.
**Accept:** schema-validated theme loads; every pane color traces to a token (lint rule or
test over styles).
**Strategy:** `LIFT:opencode` theme schema.

### C17 (2pt) — `system` theme
Terminal-derived default: query terminal background (OSC 11), derive ramp, reuse ANSI 16 so
keywork looks native in any terminal with zero config. This is the Omarchy-grade default —
first-run beauty depends on it.
**Accept:** light and dark terminal fixtures produce legible, contrast-checked palettes;
graceful fallback when OSC query unsupported.
**Strategy:** `LIFT:opencode` system theme.

### C18 (2pt) — Status line
Single-line honest status: model + provider, session name/branch, token/cost (A15, live),
trust-level slot (E2 fills it), transient toasts (reloads, errors). No clutter — every item
justified or absent (Omarchy corner-polish).
**Accept:** updates live from bus events in E2E; layout degrades gracefully at narrow widths.
**Strategy:** `OWN`.
