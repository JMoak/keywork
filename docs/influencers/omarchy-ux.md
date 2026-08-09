# Omarchy as a UX-Heuristics Reference

> **Scope note.** This document studies Omarchy purely as a *feel* reference — its interaction
> heuristics and attention-to-detail principles — not its implementation. keywork is a
> Bun/TypeScript/OpenTUI coding-agent harness; nothing here implies copying Omarchy code or
> shipping a Linux distro. (Omarchy itself is MIT-licensed, but it is a Hyprland/Arch config,
> so there is nothing to lift anyway — only lessons.)

---

## 1. What Omarchy Is, in Brief

Omarchy is DHH's (David Heinemeier Hansson / 37signals) "beautiful, modern & opinionated"
Arch Linux + Hyprland distribution: a pre-configured, keyboard-driven tiling desktop for
developers, shipped as an ISO with sensible defaults, ~19 coordinated themes, and a curated
toolset (Neovim, tmux, fzf, ripgrep, lazygit/lazydocker, Alacritty). Its manual states the
core ethos plainly: *"Everything in Omarchy happens via the keyboard — EVERYTHING!"* and
*"a beautiful system is a motivating system, and productivity has always been downstream
from motivation."*

The guiding philosophy is **omakase** — "I'll leave it up to you," trusting the chef.
Omarchy makes the package, configuration, and workflow choices so the user doesn't have to,
eliminating the choice overload that plagues traditional Linux ricing. The Super key is the
single command center; `Super + K` shows every hotkey; `Super + Space` is a type-to-find
launcher; themes hot-swap system-wide with one chord. Reviewers consistently describe the
result as "macOS-cohesive" polish on top of a tiling WM, with the real innovation being
curation and presentation rather than new technology.

**Sources:**
- https://omarchy.org/ (official site)
- https://learn.omacom.io/2/the-omarchy-manual (the Omarchy Manual — philosophy, hotkeys, themes)
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

### 2.2 Single-Keystroke Reach for the Hot Path

**Omarchy:** The operations you do dozens of times a day are one chord deep: `Super + W`
close window, `Super + F` fullscreen, `Super + J` toggle split orientation, `Super + T`
toggle tiling/floating. No menus on the hot path.

**keywork:** Identify the ten operations an agent-harness user does constantly — new session,
interrupt agent, approve/deny a tool call, jump between agent panes, toggle diff view, send
message — and give each a single chord with no intermediate menu. Everything else can live
one layer deeper. Measure the hot path in keystrokes and defend it in review.

### 2.3 Discoverability via a Live Overlay, Not Documentation

**Omarchy:** `Super + K` displays the complete hotkey reference in an overlay. The one2n
daily-driver review calls this menu the author's *favorite feature* — it "eliminates config
file edits and memorization needs." You never leave the environment to learn the environment.

**keywork:** Ship a `?`/leader-`k` overlay that lists every binding *for the current focus
context*, generated from the actual keymap (never a hand-maintained doc that drifts). Bonus
Omarchy-grade detail: make each overlay row executable — press the key while the overlay is
open and it runs, turning the cheat sheet into a command palette.

### 2.4 Omakase: Opinionated Defaults Over Configuration

**Omarchy:** The distribution's entire value proposition is that DHH already made the choices:
terminal, editor, fonts, themes, keymap, window rules. Reviewers credit this curation — "carefully
curated, not bloated" — for the out-of-box polish. Configuration is *possible* (user config in
`~/.config`, system files kept separately in `~/.local/share/omarchy`) but never *required*.

**keywork:** Zero-config first run must be the best experience, not a degraded one. Pick one
great theme, one keymap, one layout algorithm, one default model config, and make them
excellent. Allow overrides in a user config file, but treat every new config option as a
design failure to be justified. Keep user config and shipped defaults in separate files so
updates never clobber customization (Omarchy's `~/.config` vs `~/.local/share` split).

### 2.5 Beauty Is a Feature: Visual Calm Reduces Cognitive Friction

**Omarchy:** DHH's explicit claim: beauty motivates, and productivity is downstream of
motivation. The one2n review credits the "deliberately considered visual design" with reducing
"cognitive friction" over 8–12 hour days. No busy chrome, no clashing colors, no visual noise.

**keywork:** Treat the TUI's resting state as a design artifact: quiet borders, one accent
color for focus, restrained status line, no flashing or scrolling noise while the user reads.
Agent output streams should be typographically calm — clear speaker separation, muted
metadata, syntax-highlighted diffs — so a 10-hour session doesn't grind. If a UI element
isn't earning attention, dim it.

### 2.6 System-Wide Theme Coherence, Hot-Swappable

**Omarchy:** One theme choice restyles desktop, terminal, Neovim, notifications, topbar, and
lock screen together — ~19 themes (Tokyo Night, Catppuccin, …) defined in a simple
`colors.toml`, swapped live with `Super + Ctrl + Shift + Space`. No app is left off-palette.

**keywork:** One theme token set drives *every* pane and widget — chat, diff viewer, file
tree, status bar, dialogs — from a single palette definition; no widget hard-codes a color.
Theme switching is a live keybinding, not a restart. Support the popular terminal palettes
(Tokyo Night, Catppuccin) so keywork lands on-palette inside users' existing terminals.

### 2.7 Tiling Discipline: The Layout Manages Itself

**Omarchy:** Hyprland auto-tiles — windows organize into a non-overlapping grid with no manual
placement; the user only toggles orientation (`Super + J`), fullscreen (`Super + F`), full
width (`Super + Alt + F`), or floating (`Super + T`). Reviewers cite real daily time savings
from never mousing windows around.

**keywork:** Panes tile automatically by a predictable algorithm; users never drag borders as
a primary interaction. Provide a tiny set of layout verbs — split, rotate/toggle orientation,
zoom pane to full screen (and back), close — all single chords. A "zoom" (temporary
fullscreen of one pane, one key to restore the layout) is the TUI equivalent of `Super + F`
and is essential for reading long agent output.

### 2.8 Type-to-Find, Never Navigate

**Omarchy:** `Super + Space` opens a launcher where you *type* what you want; fuzzy matching
does the rest. Menus exist (`Super + Alt + Space` control menu) but even they are typeahead.
No arrow-key spelunking through nested menus.

**keywork:** Every list in the harness — sessions, files, commands, panes, history — is
fuzzy-filterable the moment it opens, with typing as the default interaction and arrows as
the fallback. A single command palette (leader + `p` or similar) reaches every operation by
name, so nothing is ever more than "open palette, type three letters, Enter" away.

### 2.9 Escape Hatches Are Also One Key

**Omarchy:** `Super + Escape` is the system menu (suspend/restart/lock); `Super + W` closes
anything; `Super + Ctrl + L` locks instantly. Getting *out* of a state is as fast as getting in.

**keywork:** `Esc` must always do the obvious safe thing — close overlay, cancel input,
interrupt streaming — and interrupting a running agent must be a single, always-available
keystroke that never queues behind output. A user who feels trapped in a mode for even a
second loses trust in the whole tool. Test every state for "can I leave in one key?"

### 2.10 Cross-App Consistency: One Muscle Memory

**Omarchy:** A unified clipboard grammar works across all apps — `Super + C/X/V` copy/cut/paste
everywhere, plus `Super + Ctrl + V` for clipboard history — papering over the terminal-vs-GUI
clipboard mess so one muscle memory serves the whole system.

**keywork:** Copy, search, scroll, select, and yank must behave identically in every pane
type — chat transcript, diff, file preview, logs. Selection-and-copy from streaming agent
output should be first-class (copy last code block, copy last message, yank a diff hunk) with
one consistent set of keys, plus a history picker for previously copied items.

### 2.11 Curated Toolbelt, Zero Bloat

**Omarchy:** The manual is explicit: only actively-used software ships. What does ship is the
best-in-class TUI tooling (lazygit, lazydocker each get their own hotkey — `Super + Shift + D`).
Reviewers note the flip side: closed-source tools are included when they're simply the best
choice (Obsidian, Typora) — pragmatism over purity.

**keywork:** Ship few features and make each excellent. Every pane type, command, and
integration must justify its existence with daily use; cut speculative features ruthlessly.
Prefer integrating one great tool per job (one diff view, one file picker) over offering
three mediocre alternatives. Pragmatism over purity in dependency choices, provided licenses
allow it (Pi and OpenCode are MIT — code may be lifted with attribution; Crush is
FSL-1.1-MIT — ideas only, never copy its source; Anthropic access is API-key/Agent-SDK only,
never subscription-OAuth).

### 2.12 Small Delights in the Corners

**Omarchy:** The details nobody would demand but everyone notices: Caps Lock remapped as a
compose key for emoji, `Super + Ctrl + R` sets a reminder, `Super + Ctrl + PrtScr` OCRs text
from the screen, a comprehensive single manual replaces scattered forum posts. These signal
that someone *cared* about the whole surface.

**keywork:** Budget for corner-polish: elapsed-time and token counters that appear exactly
when useful and hide otherwise, a "what just happened" recap after an interrupt, smart
titles on session panes, first-run onboarding that teaches the five keys that matter, and a
single well-written manual. Delight lives in the tenth-percentile interactions.

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

Known honest limitations reviewers flag — multi-monitor rough edges, screen-share polish,
single-user only — are themselves a lesson: Omarchy would rather be superb for its target
user than mediocre for everyone.

---

## 4. The keywork Feel — a Manifesto

1. Everything happens via the keyboard. Everything.
2. One leader, one grammar; a binding you can guess is a binding done right.
3. The hot path is one keystroke deep. Always. No menu ever stands between you and the agent.
4. `?` shows every key that works right now — the cheat sheet is alive, generated, and runnable.
5. Zero config is the best config; opinions are a feature we take responsibility for.
6. Panes tile themselves; you split, rotate, zoom, close — four verbs, four keys, no dragging.
7. One key zooms any pane to fullscreen; the same key puts the world back exactly as it was.
8. Escape always works. Interrupt always works. You are never trapped.
9. Type to find, never navigate: every list filters as you type.
10. One palette paints every pixel; no widget is off-theme, and themes swap live.
11. Calm by default: quiet borders, one accent for focus, nothing flashes while you read.
12. Copy, search, and scroll feel identical in every pane — one muscle memory.
13. Few features, each excellent; anything not used daily gets cut.
14. Polish the corners nobody demanded — that's where trust is built.
15. Beauty is not decoration; a beautiful session is a session you want to stay in.

---

## Sources

- Omarchy official site — https://omarchy.org/
- The Omarchy Manual (philosophy, hotkeys, themes, window management) — https://learn.omacom.io/2/the-omarchy-manual
- Omarchy GitHub repository (basecamp/omarchy, MIT) — https://github.com/basecamp/omarchy
- "Daily driving Omarchy and Hyprland as a CTO," One2N Engineering Blog — https://one2n.io/blog/daily-driving-omarchy-linux-and-hyprland-as-a-cto
- "Omarchy Linux Review: Opinionated Arch + Hyprland for Developers," Thinklet — https://www.thinklet.blog/omarchy-linux-review-arch-hyprland
- "Omarchy: A New Arch Linux Distro from 37signals," OpenReplay Blog — https://blog.openreplay.com/omarchy-new-arch-linux-distro-37signals/
