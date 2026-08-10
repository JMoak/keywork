# keywork — UX & Interaction Principles

> **Status of this document.** Section 1 (Design Principles) and Section 4 (Simplicity
> Budget) are the distilled position of the research phase and are intended to be stable.
> **Sections 2 and 3 are PROPOSALS** — concrete starting points for the upcoming vision
> discussion, drawn from what the researched tools verifiably do. They are not decisions.
>
> **Update (2026-08-10):** Crush is no longer a design source for keywork. Crush citations
> below stand as research history only; every formerly Crush-credited feature (trust-ladder
> UX, notifications, skill discovery, `.keyworkignore`, LSP registration UX, shared
> workspaces, palette-invocable skills) is now an original keywork design — see the `OWN`
> tags in `backlog/`.
>
> **Licensing ground rules (apply throughout):**
> - **Pi** ([earendil-works/pi](https://github.com/earendil-works/pi)) and **OpenCode**
>   ([sst/opencode](https://github.com/sst/opencode)) are **MIT** — code may be lifted with
>   attribution.
> - **Crush** ([charmbracelet/crush](https://github.com/charmbracelet/crush)) is
>   **FSL-1.1-MIT** — **ideas only, never copy its source.**
> - **Never** integrate Anthropic subscription-OAuth. Anthropic access in keywork is
>   **API-key / Agent-SDK only** (hard ToS guardrail).
>
> Companion research: `docs/influencers/omarchy-ux.md`, `docs/influencers/pi.md`,
> `docs/influencers/opencode.md`, `docs/influencers/crush.md`, `docs/mit-feature-candidates.md`.

---

## 1. Design Principles

Thirteen named, numbered principles. Each merges an Omarchy heuristic with the strongest
matching interaction idea from Pi, OpenCode, or Crush, and ends with what it concretely
means for keywork.

### P1. Everything Happens via the Keyboard. Everything.

Omarchy's manual states it verbatim; Crush reviewers praise the same trait ("keeps your
hands on the keyboard"); Pi and OpenCode are keyboard-complete by construction. The mouse
may work, but no operation may *require* it, and no keyboard path may be slower than the
mouse path.

**In keywork this means:** every action — approve a tool call, jump a pane, yank a diff
hunk, switch sessions — has a binding, and "is this reachable without the mouse, in how
many keystrokes?" is a review question on every PR that touches UI.

### P2. One Leader, One Grammar

Omarchy hangs the entire system off Super with consistent modifier layers (plain = act,
Shift = stronger variant, extra modifier = system layer), so users guess bindings and are
right. OpenCode applies the same idiom inside a TUI: a `ctrl+x` leader with a 2000 ms
timeout, deliberately sidestepping terminal keybinding conflicts.

**In keywork this means:** exactly one leader key for harness-level operations, modifier
layers with fixed meanings shared by every pane, and a hard rule that no two panes
interpret the same chord differently. A guessable binding is a correct binding.

### P3. The Hot Path Is One Keystroke Deep

Omarchy gives every dozens-a-day operation a single chord (`Super+W` close, `Super+F`
fullscreen). OpenCode tiers its bindings by frequency: submit, newline, agent-cycle, and
session navigation skip the leader; rarer actions live behind it.

**In keywork this means:** identify the ~10 constant operations (interrupt, steer,
approve/deny tool call, pane jump, zoom, new session, palette, submit) and give each a
single leaderless chord. Measure the hot path in keystrokes and defend it in review;
everything else may live one layer deeper.

### P4. Discoverability Is a Live Overlay, Not Documentation

Omarchy's `Super+K` hotkey overlay is daily-driver reviewers' favorite feature. OpenCode's
`ctrl+p` palette lists every command *with its binding*, doubling as documentation. Pi
keeps bindings in a hot-reloadable `keybindings.json` so the truth lives in one place.

**In keywork this means:** a `?` / leader-`k` overlay generated from the actual keymap,
filtered to the current focus context — never a hand-maintained doc that drifts. Bonus:
each overlay row is executable, turning the cheat sheet into a command palette.

### P5. Omakase: Zero Config Is the Best Config

Omarchy's whole value is that the choices are already made; config is possible, never
required, and user config is kept separate from shipped defaults so updates never clobber
it. OpenCode's `system` theme is the same instinct in code: it derives a grayscale ramp
from the terminal background so the app looks native with zero effort.

**In keywork this means:** first run with an empty config file must be the best
experience — one great theme, one keymap, one layout algorithm, one default model setup.
Every new config option is a design failure to be justified. Shipped defaults and user
overrides live in separate files.

### P6. Minimal Core, Primitives Not Features

Pi ships exactly four tools (`read`, `write`, `edit`, `bash`) and the shortest system
prompt in the field — and third-party benchmarking cited in its research found ~3x less
context per turn than heavier agents. Plan mode, permission gates, sub-agents, and to-dos
are deliberately absent from core and buildable as extensions.

**In keywork this means:** start with the four-tool core and a minimal prompt (liftable
from Pi, MIT, with attribution); treat context-per-turn as a first-class metric; push
everything non-essential into the extension layer rather than the core loop.

### P7. Interruption Is a First-Class Primitive

Pi makes message delivery a keyboard-level distinction: `Enter` *steers* (interrupts the
current tool batch), `Alt+Enter` queues a follow-up — mirrored identically in its RPC
protocol. Omarchy's rule is the same in spirit: escape hatches are one key, and getting
out of any state is as fast as getting in.

**In keywork this means:** interrupt is a single, always-available keystroke that never
queues behind output; `Esc` always does the obvious safe thing (close overlay, cancel
input, stop streaming); and steer-vs-follow-up delivery semantics are adopted at both the
key level and the API level. Test every state for "can I leave in one key?"

### P8. Type to Find, Never Navigate

Omarchy's launcher and menus are all typeahead; no arrow-key spelunking. OpenCode's
`@file` fuzzy search, the `ctrl+p` palette, and Crush's `Ctrl+P` command palette (idea
only) all converge on the same pattern.

**In keywork this means:** every list — sessions, files, commands, panes, history, models
— is fuzzy-filterable the moment it opens, with typing as the default interaction. One
palette reaches every operation by name: nothing is more than "palette, three letters,
Enter" away.

### P9. Calm Coherence: One Palette Paints Every Pixel

Omarchy's theme system restyles every surface from one `colors.toml`, hot-swapped live;
DHH's claim is that beauty motivates and productivity is downstream of motivation.
OpenCode's JSON theme format (dark/light variants, `"none"` to inherit terminal colors,
the `system` theme) is the liftable implementation of the same idea.

**In keywork this means:** one theme token set drives every pane and widget — no
hard-coded colors anywhere — with live switching, popular palettes (Tokyo Night,
Catppuccin) supported, and a terminal-adaptive default. The resting state is visually
calm: quiet borders, one accent for focus, muted metadata, nothing flashing while the
user reads.

### P10. The Layout Manages Itself

Hyprland auto-tiles; Omarchy users only split, rotate, zoom, and close — four verbs, four
keys, no dragging. The zoom (temporary fullscreen of one pane, same key restores the
layout) is essential for reading long output.

**In keywork this means:** panes tile by a predictable algorithm; border-dragging is
never a primary interaction; the layout verbs are a tiny fixed set of single chords; and
zoom-to-fullscreen/restore is one key. This is the TUI translation of `Super+F`.

### P11. Trust Through Visible, Reversible State

OpenCode's git-backed `/undo` / `/redo` restores *file* state, not just chat state — the
highest-leverage trust feature per line of code (MIT, liftable). Codex CLI shows the
active sandbox/permission state before acting (Apache-2.0). Crush's graduated trust
ladder — prompt → allowlist → yolo — is a UX flow worth reinterpreting (ideas only). Pi's
tree sessions make the conversation itself branch-and-restorable.

**In keywork this means:** what the agent is *allowed to do right now* is always visible
in the status line; every agent change is undoable via git snapshots; permission
escalation is a designed ladder with a visible current level; and sessions are trees you
can fork, label, and return to — never a log you can only scroll.

### P12. One Muscle Memory Across Every Pane

Omarchy unifies clipboard, search, and navigation across all apps so one set of habits
serves the whole system. Crush's Ctrl-clickable code references that open `$EDITOR` (idea
only) show the complementary move: bridge out to the user's real tools instead of
reinventing them.

**In keywork this means:** copy, search, scroll, and select behave identically in chat,
diff, file, and log panes; "copy last code block / last message / this hunk" are
first-class; and code references deep-link into `$EDITOR` rather than keywork pretending
to be an editor.

### P13. Polish the Corners; the Harness Extends Itself

Omarchy budgets for details nobody demanded (OCR hotkey, reminders, compose key) —
that's where trust is built. Crush's notification modes (native/OSC/bell) design the
"come back, I need a decision" moment for users who tabbed away (idea only). Pi's deepest
corner-polish is structural: the agent writes its own TypeScript extensions into
`.pi/extensions/` and `/reload`s them live — customization without a marketplace.

**In keywork this means:** ship notification modes, elapsed/token counters that appear
exactly when useful, a "what just happened" recap after interrupts, smart session titles,
and first-run onboarding that teaches the five keys that matter. Adopt Pi's ExtensionAPI
shape (MIT, liftable) so power users — and the agent itself — extend keywork in
user-space TypeScript with hot reload.

---

## 2. Keyboard Interaction Model — PROPOSAL

> **PROPOSAL — to be shaped in the vision discussion, not a decision.**

### 2.1 Grammar: leader-key, not modal

The researched tools split two ways: modal editing (vim-style modes) appears in none of
them; all four references converge on **leader-key grammar + palette + hot-path chords**.
Proposal: keywork follows suit — no modal editing in v1. The input box is always live;
"modes" exist only as *agent* modes (Plan/Build-style), not input modes.

| Layer | Binding shape | Examples (illustrative, not final) |
|---|---|---|
| Hot path (leaderless) | single chord | `Enter` steer-submit, `Alt+Enter` follow-up (Pi semantics), `Esc` interrupt/close, `Tab` cycle agent mode (OpenCode), `Ctrl+P` palette |
| Leader layer | `<leader>` + key, bounded by a timeout | `<leader>n` new session, `<leader>t` session tree, `<leader>z` zoom pane, `<leader>1..9` pane jump |
| Meta layer | `<leader>` + Shift/second modifier | theme switch, layout rotate, harness settings |

- **Leader key:** default `ctrl+x` with a configurable ~2000 ms timeout, per OpenCode's
  production-proven model (MIT — lift the binding-resolution config directly:
  string/array/object formats, `"none"` to disable, platform-aware defaults).
- **Modifier grammar** (Omarchy): plain = act on focused pane; `Shift` = stronger/inverse
  variant; second modifier = harness/meta. Enforced project-wide.

### 2.2 Command palette

One palette (`Ctrl+P` proposed) reaching every command, session, and user-invocable skill
by fuzzy name, showing each command's current binding (OpenCode's pattern — the palette
*is* the keybinding documentation). Crush's palette-invocable `SKILL.md` skills with
`user:`/`project:` prefixes is the idea-level reference for surfacing skills there.

### 2.3 Single-keystroke priorities

The proposed leaderless top-ten, to be measured and defended per P3:

1. Submit as steer (`Enter`) 2. Queue follow-up (`Alt+Enter`) 3. Interrupt / escape
(`Esc`) 4. Approve tool call 5. Deny tool call 6. Cycle agent mode (`Tab`) 7. Command
palette (`Ctrl+P`) 8. Pane focus jump 9. Zoom focused pane 10. Keybinding overlay (`?` in
non-input focus / leader-`k`).

### 2.4 Discoverability

- **Live overlay** (P4): generated from the real keymap, context-filtered, rows
  executable while open.
- **Palette shows bindings** next to every command.
- **First-run onboarding** teaches five keys: submit, interrupt, palette, pane jump,
  overlay.

### 2.5 Configuration

Everything rebindable via a single keybindings file with namespaced action IDs
(`pane.zoom`, `session.fork`) and hot reload — Pi's `keybindings.json` + `/reload` model
and OpenCode's `tui.json` value formats are both MIT; lift the better parts of each.
Emacs/Vim preset maps ship as optional bundles (Pi documents this pattern).

---

## 3. Multi-Window/Pane Model — PROPOSAL

> **PROPOSAL — to be shaped in the vision discussion, not a decision.** This is keywork's
> differentiation opportunity: OpenCode has no persistent split panes (multi-context work
> is sessions), and Crush's live shared workspaces are the closest prior art (idea only).

### 3.1 Pane types

| Pane | Role | Prior art |
|---|---|---|
| **Conversation** | The agent transcript + input editor; one per session leaf | Every tool; Pi's transcript scroll + editor |
| **Diff / review** | Hunk-level accept/reject of agent changes, multi-file | Zed's review pane is the high-water mark — GPL, **reimplement from observed behavior only**; Codex `/review` (Apache-2.0) for the read-only findings variant |
| **Terminal / process** | Long-running processes (dev server, tests) the agent can monitor | Cline's background terminal monitoring (Apache-2.0, liftable) |
| **Session tree** | Pi-style tree of the current session + list of other sessions; fork/label/jump | Pi `/tree` (MIT, lift the JSONL tree format); OpenCode parent/child navigation |
| **Files (optional, later)** | Read-only preview of files the agent touches; "follow the agent" | Zed's follow mode — reimplement only |

Palette, pickers, dialogs, and the keybinding overlay are **overlays, not panes** —
pi-tui and OpenTUI both treat overlays as first-class, and overlays keep the tiled layout
stable (P10).

### 3.2 Focus and layout

- Auto-tiling with a small verb set: split, rotate, zoom, close — single chords (P10).
- Focus jump: directional (`<leader>h/j/k/l`-style) and ordinal (`<leader>1..9`);
  focused pane marked by the single accent color (P9).
- Zoom any pane fullscreen and restore with the same key.
- Multiple sessions ↔ panes: a pane is a view onto a session leaf. Pi's tree-session
  format (id/parentId, active leaf) maps naturally: two panes can show two branches of
  one tree, or two independent sessions. Subagent runs surface as child-session panes
  (OpenCode models them as navigable child sessions — keywork gives them a pane).
- **Shared workspace by cwd** (Crush idea, reinterpret independently): keywork instances
  opened in the same project see the same live sessions — the architectural prerequisite
  is a headless core emitting typed events (OpenCode's server + SSE shape, MIT, is the
  liftable reference).

### 3.3 What OpenTUI makes feasible

OpenTUI (Zig core, TypeScript bindings, Bun) powers OpenCode's TUI in production after
its migration from Go/Bubble Tea — keywork's exact stack is proven at the scale of an AI
coding interface, and `packages/tui` in sst/opencode is MIT reference code for component
structure, overlays, scroll performance, and input handling. Constraints and lessons to
carry in:

- OpenCode proves a single chat column with overlays; persistent splits are new ground —
  prototype layout/perf early.
- Steal pi-tui's contracts even though we're on OpenTUI: width-constrained rendering,
  per-component output caching for flicker-free differential updates, `invalidate()` on
  theme change, IME-correct hardware-cursor placement (CURSOR_MARKER pattern), and
  first-class overlays. These are the mechanics behind "no flicker."

---

## 4. Simplicity Budget — What keywork Refuses to Build

In the spirit of Pi's "notable absences," these are explicit refusals. Each needs a
strong argument *and* a principle amendment to overturn.

| Refusal | Rationale |
|---|---|
| **No MCP in the core loop** | Pi's measured argument: MCP servers cost 13k–18k tokens of schema at startup and aren't composable. Prefer CLI scripts + Bash + extensions; an extension may bridge MCP for those who need it. |
| **No Anthropic subscription-OAuth, ever** | Hard ToS guardrail. API-key / Agent-SDK only. Excise any such code paths when lifting from OpenCode's provider layer. |
| **No embedded editor** | Deep-link to `$EDITOR` (Crush idea). keywork reviews and dispatches; it does not compete with Neovim. |
| **No mouse-required or mouse-first features** | P1. Mouse support may exist as garnish only. |
| **No Electron/desktop app, web UI, or IDE plugins in v1** | OpenCode's client zoo is enabled by its server split; keywork may adopt the server *shape*, but ships one excellent TUI. |
| **No share-link cloud service, enterprise/SSO, or Slack integration** | Out of scope for a single-user keyboard-first harness (Omarchy's target-user discipline). |
| **No 75-provider matrix** | A few providers done excellently beats twenty done adequately. Use the Vercel AI SDK layer (MIT lift from OpenCode) with a short curated list. |
| **No plugin marketplace** | Pi's alternative is better: the agent writes local extensions, hot-reloaded. Distribution is npm/git, not a store. |
| **No built-in permission matrix beyond a thin default gate** | Pi builds permission gates as extensions on the `tool_call` hook; keywork ships one thin default gate (softer than Pi's bare metal) and keeps the rest in user-space. |
| **No hand-maintained keybinding docs** | The overlay and palette are generated from the keymap (P4). Docs that can drift, will. |
| **No "pick your layout engine / theme engine" choice screens** | Omakase (P5). One blessed option per job; overrides live in config, not dialogs. |
| **No modal input editing in core** | Leader + palette grammar instead; a Vim-preset keymap bundle can exist, a modal core cannot. |
| **No speculative panes or features without daily use** | Omarchy's curation rule: every pane type, command, and integration justifies itself with daily use or gets cut. |
| **No config option without a fight** | Every new option is a design failure to be justified (P5). |

---

## Sources

Primary research dossiers (in-repo, each with full inline citations):

- `docs/influencers/omarchy-ux.md` — Omarchy heuristics
- `docs/influencers/pi.md` — Pi deep dive
- `docs/influencers/opencode.md` — OpenCode deep dive
- `docs/influencers/crush.md` — Crush dossier (FSL-1.1-MIT, ideas only)
- `docs/mit-feature-candidates.md` — broader ecosystem survey

Key external sources referenced above:

- Omarchy — <https://omarchy.org/> · The Omarchy Manual <https://learn.omacom.io/2/the-omarchy-manual> · <https://github.com/basecamp/omarchy> · daily-driver review <https://one2n.io/blog/daily-driving-omarchy-linux-and-hyprland-as-a-cto>
- Pi — <https://github.com/earendil-works/pi> (MIT) · <https://pi.dev/> · docs (`extensions.md`, `sessions.md`, `keybindings.md`, `rpc.md`, `tui.md`) <https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs> · Armin Ronacher, *Pi* <https://lucumr.pocoo.org/2026/1/31/pi/> · Mario Zechner, *What if you don't need MCP?* <https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/>
- OpenCode — <https://github.com/sst/opencode> (MIT) · keybinds <https://opencode.ai/docs/keybinds/> · TUI <https://opencode.ai/docs/tui/> · themes <https://opencode.ai/docs/themes/> · agents <https://opencode.ai/docs/agents/> · server <https://opencode.ai/docs/server/> · OpenTUI origin <https://www.stork.ai/blog/the-tui-library-thats-killing-ink>
- Crush — <https://github.com/charmbracelet/crush> (FSL-1.1-MIT, ideas only) · DeepWiki overview <https://deepwiki.com/charmbracelet/crush>
- Ecosystem — Aider <https://github.com/Aider-AI/aider> (Apache-2.0) · Codex CLI <https://developers.openai.com/codex/cli> (Apache-2.0) · Cline <https://github.com/cline/cline> (Apache-2.0) · Zed agent panel <https://zed.dev/docs/ai/agent-panel> (GPL — reimplement only)

*Synthesized 2026-08-09 from research verified against the sources above.*
