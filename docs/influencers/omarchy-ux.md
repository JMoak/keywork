# Omarchy as a UX-Heuristics Reference

> **Scope note.** This document studies Omarchy purely as a *feel* reference (its interaction
> heuristics and attention-to-detail principles), not its implementation. keywork is a
> Bun/TypeScript/OpenTUI coding-agent harness; nothing here implies copying Omarchy code or
> shipping a Linux distro. (Omarchy itself is MIT-licensed, but it is a Hyprland/Arch config,
> so there is nothing to lift anyway, only lessons.)

> **Status 2026-10-02.** The body below is the August 2026 study and stands as written. The
> repo moved to `omacom/omarchy` (still MIT), and Omarchy 4 rebuilt the whole shell; what
> changed and what keywork takes from it is in "Since 2026-08" just below. Each §2 heuristic now
> carries a status line: **landed** with the task or file that carries it, **open** with the
> [`117`](../backlog/117-influence-sweep.md) task where one exists, or **unverified**.

## Since 2026-08

**Omarchy 4.0 "Quattro"** (2026-08-14,
[release](https://github.com/omacom/omarchy/releases/tag/v4.0.0)):

- The whole shell is rebuilt in Quickshell as one process.
- The launcher merged into the `Super + Space` menu, now a nested, filterable JSONC command
  palette.
- A notification daemon keeps replayable history: `Super + Shift + Alt + ,` replays the last
  ten, including ones silenced by do-not-disturb.
- Bar panels open by ordinal with `Super + Ctrl + 1..9` and renumber themselves.
- The theme palette grew from 8 to 24 base colors, so the nvim, btop and VS Code configs are
  generated from it. Themes are picked from a visual carousel.
- One knob moves text size across the shell, GTK and the terminal together.
- Foot is the default terminal.
- It ships Herdr, an agent-aware multiplexer, beside tmux with matching bindings.
- It cleans up after an SSH drop: no mouse tracking or alternate screen left armed.
- The default-agent picker lists Claude Code, Codex, OpenCode, Pi and others. keywork is not
  listed.

Point releases: v4.0.1 (08-25) launches Claude and Codex with auto-review instead of full
bypass and runs notification click actions as safe argv; v4.0.3 (09-08) adds agents to the
picker and restricts kitty remote control to local sockets; v4.0.4 (09-15) is kernel only.

**The terminal platform around it:**

- **Herdr** v0.9.3 (2026-09-29, [herdrdev/herdr](https://github.com/herdrdev/herdr),
  Apache-2.0) marks each pane working, blocked or idle. Agents can self-report through a
  documented protocol: env `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`,
  then `"$HERDR_BIN_PATH" pane report-agent <pane> --source --agent --state
  idle|working|blocked --seq`, resume argv after `--` (0.9.2+), and `pane release-agent` on
  exit. It ports to Windows.
  ([add-support doc](https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/add-herdr-support.mdx))
- **Windows Terminal 1.25** stable (2026-10-02,
  [release](https://github.com/microsoft/terminal/releases/tag/v1.25.2733.0)): kitty keyboard
  protocol; OSC 52 writes only while focused; built-in glyphs U+1FB00 to U+1FB94 (sextants,
  eighth blocks); closing a tab jumps to the most recent tab. The 1.26 preview adds OSC 777
  notifications and bell-as-notification (both off by default) and "Workspaces" named windows.
- **kitty 0.49.0** (2026-09-21): custom shaders, `remap_modifiers`, color-protocol hardening.
  **Ghostty** has shipped nothing since 1.3.1 (2026-03-13).
- **Mode 2031** color-scheme change reports (`CSI ?2031h`, then `CSI ?997;1 n` or `CSI ?997;2 n`
  on change; [spec](https://contour-terminal.org/vt-extensions/color-palette-update-notifications/))
  work in Ghostty, kitty and Contour. keywork does not handle them yet (SW21).
- **zellij 0.45.0** (2026-08-20,
  [release](https://github.com/zellij-org/zellij/releases/tag/v0.45.0)): Kitty graphics; OSC 133
  prompt jumping and copy-last-output; title-line pane frames by default instead of full
  borders; stacked panes as one-line titles; `FocusLastPane`; a no-UI fullscreen; OSC 9/777/99
  notifications reduced to what the host terminal supports; a release-notes screen that offers
  missing new keybindings with one keypress.
- **Bun:** 1.3.14 (keywork's pin, 2026-05-13) already shipped `Bun.Terminal` and
  `Bun.spawn({ terminal })` on Windows via ConPTY. 1.4.0 (2026-08-20) rewrote the runtime in
  Rust, starts 2.5x faster on Windows, and adds `Bun.stringWidth` / `sliceAnsi` / `wrapAnsi`
  and `--compile --asset`. 1.4.1 (09-04) fixes Windows stdin corruption and Ctrl+C; 1.4.2
  (09-05) fixes regressions. Whether to bump is decision 117-3, still open.

**What keywork takes** ([`117`](../backlog/117-influence-sweep.md) group 3): SW19 keep the
machine awake during a turn, SW20 focus-last-pane with MRU focus on close (zellij
`FocusLastPane`, Windows Terminal's MRU tab), SW21 live theme follow over mode 2031, SW22 OSC 8
file:line links, SW23 a zellij notification transport, SW24 Herdr self-report from keywork's
own lifecycle state, SW26 a kill test for terminal-mode hygiene (Omarchy's SSH-drop cleanup is
the same bar).

**Declined:** swapping keywork's width math for `Bun.stringWidth` (T1 regression risk), image
panes, coupling to Omarchy's theme files, a zellij-style web UI, and Herdr-style screen
scraping (keywork reports its own state).

---

## 1. What Omarchy Is, in Brief

Omarchy is DHH's (David Heinemeier Hansson / 37signals) "beautiful, modern & opinionated"
Arch Linux + Hyprland distribution: a pre-configured, keyboard-driven tiling desktop for
developers, shipped as an ISO with sensible defaults, ~19 coordinated themes, and a curated
toolset (Neovim, tmux, fzf, ripgrep, lazygit/lazydocker, Alacritty). Its manual states the
core ethos plainly: *"Everything in Omarchy happens via the keyboard: EVERYTHING!"* and
*"a beautiful system is a motivating system, and productivity has always been downstream
from motivation."*

The guiding philosophy is **omakase**: "I'll leave it up to you," trusting the chef.
Omarchy makes the package, configuration, and workflow choices so the user doesn't have to,
eliminating the choice overload that plagues traditional Linux ricing. The Super key is the
single command center; `Super + K` shows every hotkey; `Super + Space` is a type-to-find
launcher; themes hot-swap system-wide with one chord. Reviewers consistently describe the
result as "macOS-cohesive" polish on top of a tiling WM, with the real innovation being
curation and presentation rather than new technology.

**Sources:**
- https://omarchy.org/ (official site)
- https://learn.omacom.io/2/the-omarchy-manual (the Omarchy Manual: philosophy, hotkeys, themes)
- https://github.com/basecamp/omarchy (repo; MIT license)
- https://one2n.io/blog/daily-driving-omarchy-linux-and-hyprland-as-a-cto (daily-driver review)
- https://www.thinklet.blog/omarchy-linux-review-arch-hyprland (review)
- https://blog.openreplay.com/omarchy-new-arch-linux-distro-37signals/ (overview)

---

## 2. The Attention-to-Detail Heuristics

Twelve named principles extracted from the manual and third-party daily-driver reports, each
with its translation to a multi-pane terminal coding-agent TUI.

### 2.1 One Leader, One Grammar

**Omarchy:** Every system operation hangs off the Super key. Modifier layers add meaning
consistently: `Super + X` acts, `Super + Shift + X` is the stronger/alternate form
(`Super + Return` terminal → `Super + Shift + Return` browser), `Super + Ctrl + X` is the
system/meta layer (`Super + Ctrl + L` lock, `Super + Ctrl + Shift + Space` theme picker).
Users learn the grammar once, then guess correctly.

**keywork:** Reserve exactly one leader (e.g. `Ctrl+Space` or a configurable prefix) for
harness-level operations, and make modifier layers mean the same thing everywhere:
plain = act on the focused pane, `Shift` = the stronger/inverse variant, second modifier =
harness/meta. Never let two panes interpret the same chord differently. If a user can guess
a binding from the grammar and be right, the grammar is working.

**Status 2026-10-02: landed.** One leader, `ctrl+k` with a 2000ms timeout (C3,
`packages/tui/src/keymap.ts`); `Shift` is the stronger form throughout `app-actions.ts`
(`leader s` split / `leader shift+s` split into a new arc, `leader h` focus / `leader shift+h`
move). The leader itself is not rebindable from `keywork.json` yet (C4 ledger assumption).
Whether any pane reads a global chord differently is unverified.

### 2.2 Single-Keystroke Reach for the Hot Path

**Omarchy:** The operations you do dozens of times a day are one chord deep: `Super + W`
close window, `Super + F` fullscreen, `Super + J` toggle split orientation, `Super + T`
toggle tiling/floating. No menus on the hot path.

**keywork:** Identify the ten operations an agent-harness user does constantly (new session,
interrupt agent, approve/deny a tool call, jump between agent panes, toggle diff view, send
message) and give each a single chord with no intermediate menu. Everything else can live
one layer deeper. Measure the hot path in keystrokes and defend it in review.

**Status 2026-10-02: landed in part.** Split, close, zoom, focus, move and summon are each one
leader chord (`app-actions.ts`); `enter` sends, `alt+enter` steers and `esc` interrupts
(`overlays/help.ts` prompt keys). Open: the copy verbs have no chords yet (96 V2.15 proposes
`leader y` / `leader shift+y` / `leader d`). Approve/deny chord count is unverified.

### 2.3 Discoverability via a Live Overlay, Not Documentation

**Omarchy:** `Super + K` displays the complete hotkey reference in an overlay. The one2n
daily-driver review calls this menu the author's *favorite feature*; it "eliminates config
file edits and memorization needs." You never leave the environment to learn the environment.

**keywork:** Ship a `?`/leader-`k` overlay that lists every binding *for the current focus
context*, generated from the actual keymap (never a hand-maintained doc that drifts). Bonus
Omarchy-grade detail: make each overlay row executable. Press the key while the overlay is
open and it runs, turning the cheat sheet into a command palette.

**Status 2026-10-02: landed.** The keys overlay (C6, `overlays/help.ts`, `leader /` or `f1`)
is built from the live keymap, so a rebind shows at once. The runnable half lives in the
palette (C5, `overlays/palette.ts`): every row shows its live shortcut and `enter` runs it.
Open: the keys overlay itself is neither searchable nor runnable (no task).

### 2.4 Omakase: Opinionated Defaults Over Configuration

**Omarchy:** The distribution's entire value proposition is that DHH already made the choices:
terminal, editor, fonts, themes, keymap, window rules. Reviewers credit this curation ("carefully
curated, not bloated") for the out-of-box polish. Configuration is *possible* (user config in
`~/.config`, system files kept separately in `~/.local/share/omarchy`) but never *required*.

**keywork:** Zero-config first run must be the best experience, not a degraded one. Pick one
great theme, one keymap, one layout algorithm, one default model config, and make them
excellent. Allow overrides in a user config file, but treat every new config option as a
design failure to be justified. Keep user config and shipped defaults in separate files so
updates never clobber customization (Omarchy's `~/.config` vs `~/.local/share` split).

**Status 2026-10-02: landed.** Defaults live in code (keywork-night flavor, `appBindings`);
user and trusted-project `keywork.json` layers sit over them (`shared/src/config/load.ts`,
`tui/src/keybindings.ts` `resolveBindings`). Every config option carries a `.describe()`
justification (vision D9).

### 2.5 Beauty Is a Feature: Visual Calm Reduces Cognitive Friction

**Omarchy:** DHH's explicit claim: beauty motivates, and productivity is downstream of
motivation. The one2n review credits the "deliberately considered visual design" with reducing
"cognitive friction" over 8–12 hour days. No busy chrome, no clashing colors, no visual noise.

**keywork:** Treat the TUI's resting state as a design artifact: quiet borders, one accent
color for focus, restrained status line, no flashing or scrolling noise while the user reads.
Agent output streams should be typographically calm (clear speaker separation, muted
metadata, syntax-highlighted diffs) so a 10-hour session doesn't grind. If a UI element
isn't earning attention, dim it.

**Status 2026-10-02: landed.** [`design-language.md`](../design-language.md) is the
vocabulary of record (density ramp, needs-you-only notifications, the motion grammar); `seams`
chrome draws one hairline per split (C50 part 1, 112 L7); overlay scrims and opt-in unfocused
dimming (C51, 113 W9 and W11); the highlighter (C52, `tui/highlighter.ts`); the motion and
streaming remainders (C53 / C54, 113 W9). Open: C50 gap cells and borderless mode, C57
frame-budget bar.

### 2.6 System-Wide Theme Coherence, Hot-Swappable

**Omarchy:** One theme choice restyles desktop, terminal, Neovim, notifications, topbar, and
lock screen together: ~19 themes (Tokyo Night, Catppuccin, …) defined in a simple
`colors.toml`, swapped live with `Super + Ctrl + Shift + Space`. No app is left off-palette.

**keywork:** One theme token set drives *every* pane and widget (chat, diff viewer, file
tree, status bar, dialogs) from a single palette definition; no widget hard-codes a color.
Theme switching is a live keybinding, not a restart. Support the popular terminal palettes
(Tokyo Night, Catppuccin) so keywork lands on-palette inside users' existing terminals.

**Status 2026-10-02: landed in part.** One token set drives every surface (C16, `tui/theme.ts`);
`/flavor-<name>` repaints everything live (`tui/flavor.ts`); the `system` flavor reads the
terminal's own colors at startup (C17, `tui/system-theme.ts`, landed 2026-09-07), which is how
keywork lands on-palette in a Tokyo Night or Catppuccin terminal. Open: SW21 live follow when
the terminal switches light and dark; the C49 gallery (only keywork-night and `system` ship).
Coupling to Omarchy's theme files is declined.

### 2.7 Tiling Discipline: The Layout Manages Itself

**Omarchy:** Hyprland auto-tiles: windows organize into a non-overlapping grid with no manual
placement; the user only toggles orientation (`Super + J`), fullscreen (`Super + F`), full
width (`Super + Alt + F`), or floating (`Super + T`). Reviewers cite real daily time savings
from never mousing windows around.

**keywork:** Panes tile automatically by a predictable algorithm; users never drag borders as
a primary interaction. Provide a tiny set of layout verbs, all single chords: split,
rotate/toggle orientation, zoom pane to full screen (and back), close. A "zoom" (temporary
fullscreen of one pane, one key to restore the layout) is the TUI equivalent of `Super + F`
and is essential for reading long agent output.

**Status 2026-10-02: landed.** Dwindle tiling (C8), spatial focus and move (C9), and the zoom
toggle on `leader z` (C10, `app-core.ts` `zoomPane`). Open: SW20 focus-last-pane and MRU focus
on close.

### 2.8 Type-to-Find, Never Navigate

**Omarchy:** `Super + Space` opens a launcher where you *type* what you want; fuzzy matching
does the rest. Menus exist (`Super + Alt + Space` control menu) but even they are typeahead.
No arrow-key spelunking through nested menus.

**keywork:** Every list in the harness (sessions, files, commands, panes, history) is
fuzzy-filterable the moment it opens, with typing as the default interaction and arrows as
the fallback. A single command palette (leader + `p` or similar) reaches every operation by
name, so nothing is ever more than "open palette, type three letters, Enter" away.

**Status 2026-10-02: landed.** `ctrl+p` jumps to panes and `>` or `/` switches to commands, all
fuzzy-scored (C5, `tui/commands.ts` `fuzzyScore`); pickers share `tui/filter-picker.ts`.
Whether every list in the harness filters as you type is unverified.

### 2.9 Escape Hatches Are Also One Key

**Omarchy:** `Super + Escape` is the system menu (suspend/restart/lock); `Super + W` closes
anything; `Super + Ctrl + L` locks instantly. Getting *out* of a state is as fast as getting in.

**keywork:** `Esc` must always do the obvious safe thing (close overlay, cancel input,
interrupt streaming), and interrupting a running agent must be a single, always-available
keystroke that never queues behind output. A user who feels trapped in a mode for even a
second loses trust in the whole tool. Test every state for "can I leave in one key?"

**Status 2026-10-02: landed in part.** `esc` interrupts the running turn and closes the palette, keys,
connect, preset and setup overlays (`overlays/*.ts`). Open: SW26, the kill test that proves a dead keywork leaves no title,
focus reporting, mouse mode, kitty flags or alternate screen armed. "Never queues behind
output" is unverified.

### 2.10 Cross-App Consistency: One Muscle Memory

**Omarchy:** A unified clipboard grammar works across all apps (`Super + C/X/V` copy/cut/paste
everywhere, plus `Super + Ctrl + V` for clipboard history), papering over the terminal-vs-GUI
clipboard mess so one muscle memory serves the whole system.

**keywork:** Copy, search, scroll, select, and yank must behave identically in every pane
type: chat transcript, diff, file preview, logs. Selection-and-copy from streaming agent
output should be first-class (copy last code block, copy last message, yank a diff hunk) with
one consistent set of keys, plus a history picker for previously copied items.

**Status 2026-10-02: landed in part.** `/copy-message`, `/copy-code` and `/copy-diff` write
through OSC 52 (96 V2.15, `tui/copy-commands.ts`). Open: pane-local copy chords, a clipboard
history picker (no task), SW22 OSC 8 file:line links. Identical search and scroll across every
pane type is unverified.

### 2.11 Curated Toolbelt, Zero Bloat

**Omarchy:** The manual is explicit: only actively-used software ships. What does ship is the
best-in-class TUI tooling (lazygit, lazydocker each get their own hotkey, `Super + Shift + D`).
Reviewers note the flip side: closed-source tools are included when they're simply the best
choice (Obsidian, Typora); pragmatism over purity.

**keywork:** Ship few features and make each excellent. Every pane type, command, and
integration must justify its existence with daily use; cut speculative features ruthlessly.
Prefer integrating one great tool per job (one diff view, one file picker) over offering
three mediocre alternatives. Pragmatism over purity in dependency choices, provided licenses
allow it (Pi and OpenCode are MIT, so code may be lifted with attribution; Crush is
FSL-1.1-MIT, ideas only, never copy its source; Anthropic access is API-key/Agent-SDK only,
never subscription-OAuth).

**Status 2026-10-02: landed as a rule.** Vision D9 makes every config option justify itself in
the schema, and each overlay keeps a declined list (117's covers image panes, voice,
marketplaces and more). Crush is now retired as a source entirely (2026-08-10).

### 2.12 Small Delights in the Corners

**Omarchy:** The details nobody would demand but everyone notices: Caps Lock remapped as a
compose key for emoji, `Super + Ctrl + R` sets a reminder, `Super + Ctrl + PrtScr` OCRs text
from the screen, a comprehensive single manual replaces scattered forum posts. These signal
that someone *cared* about the whole surface.

**keywork:** Budget for corner-polish: elapsed-time and token counters that appear exactly
when useful and hide otherwise, a "what just happened" recap after an interrupt, smart
titles on session panes, first-run onboarding that teaches the five keys that matter, and a
single well-written manual. Delight lives in the tenth-percentile interactions.

**Status 2026-10-02: landed in part.** The turn's elapsed time in the conversation pane
(`conversation-pane.ts` `elapsedLabel`), costs in pane headers on `/show-costs`, the context
gauge (C55, `tui/context-gauge.ts`), state-keyed rotating tips (FR5.15, `tui/tips.ts`), the
terminal title carrying the lifecycle glyph (96 V2.12), needs-you notifications (P2.4). Open:
the recap after an interrupt (nearest task: 96 V2.17 away summary), self-naming session titles (C65; only
`fitTitle` has landed), SW19 keep the machine awake, SW23 zellij notifications, SW24 Herdr
self-report. A single manual is unverified.

---

## 3. Anti-Patterns Omarchy Deliberately Avoids

| Anti-pattern | How Omarchy avoids it | keywork implication |
|---|---|---|
| **Choice overload** | Omakase curation; one blessed option per job | No "pick your layout engine" dialogs; one great default |
| **Config-before-use** | Works beautifully from first boot; config optional | keywork must be excellent with an empty config file |
| **Mouse dependence** | Every operation has a hotkey; mouse is optional by design | No TUI action may be mouse-only |
| **Scattered documentation** | One comprehensive manual + in-app `Super + K` overlay | Single manual + live keybinding overlay; no wiki sprawl |
| **Inconsistent chrome/theming** | One theme styles every surface simultaneously | One token palette for all panes; no off-theme widget |
| **Feature bloat** | Only actively-used software ships | Every feature earns its keep or gets cut |
| **Ideological purity over experience** | Ships closed-source tools when they're the best (per reviewer commentary) | Choose the best-experience option within licensing rules |
| **Update-clobbered customization** | User config (`~/.config`) separated from system files | Shipped defaults and user overrides in separate files |
| **Enterprise everything-for-everyone scope** | Explicitly a single-user developer workstation; doesn't chase mission-critical/enterprise use cases | keywork targets the individual keyboard-first developer, not every workflow |

Known honest limitations reviewers flag (multi-monitor rough edges, screen-share polish,
single-user only) are themselves a lesson: Omarchy would rather be superb for its target
user than mediocre for everyone.

---

## 4. The keywork Feel: a Manifesto

1. Everything happens via the keyboard. Everything.
2. One leader, one grammar; a binding you can guess is a binding done right.
3. The hot path is one keystroke deep. Always. No menu ever stands between you and the agent.
4. `?` shows every key that works right now; the cheat sheet is alive, generated, and runnable.
5. Zero config is the best config; opinions are a feature we take responsibility for.
6. Panes tile themselves; you split, rotate, zoom, close: four verbs, four keys, no dragging.
7. One key zooms any pane to fullscreen; the same key puts the world back exactly as it was.
8. Escape always works. Interrupt always works. You are never trapped.
9. Type to find, never navigate: every list filters as you type.
10. One palette paints every pixel; no widget is off-theme, and themes swap live.
11. Calm by default: quiet borders, one accent for focus, nothing flashes while you read.
12. Copy, search, and scroll feel identical in every pane: one muscle memory.
13. Few features, each excellent; anything not used daily gets cut.
14. Polish the corners nobody demanded; that's where trust is built.
15. Beauty is not decoration; a beautiful session is a session you want to stay in.

Status 2026-10-02: each line maps to a §2 heuristic, and its status line there is the record.

---

## Sources

- Omarchy official site: https://omarchy.org/
- The Omarchy Manual (philosophy, hotkeys, themes, window management): https://learn.omacom.io/2/the-omarchy-manual
- Omarchy GitHub repository (basecamp/omarchy, MIT): https://github.com/basecamp/omarchy (moved to https://github.com/omacom/omarchy by 2026-10)
- "Daily driving Omarchy and Hyprland as a CTO," One2N Engineering Blog: https://one2n.io/blog/daily-driving-omarchy-linux-and-hyprland-as-a-cto
- "Omarchy Linux Review: Opinionated Arch + Hyprland for Developers," Thinklet: https://www.thinklet.blog/omarchy-linux-review-arch-hyprland
- "Omarchy: A New Arch Linux Distro from 37signals," OpenReplay Blog: https://blog.openreplay.com/omarchy-new-arch-linux-distro-37signals/
