# Coding-Agent Nuances — Survey & Triage

> Research analysis, 2026-08-10. **Analysis only — no adoption decisions are made here.**
> **Crush (charmbracelet/crush) is excluded entirely** per Jordan's 2026-08-10 decision:
> FSL-licensed, not a source for keywork in any form — no code, no design ideas. It is not
> surveyed, analyzed, or cited below.
>
> Scope: the "million little things" — nuanced behaviors, not headline features — of Claude
> Code, OpenCode, Pi, Aider, Codex CLI, Gemini CLI, Goose, and Amp, triaged against
> keywork's philosophy (`AGENTS.md`, `vision.md` D1–D10, `design-language.md`,
> `ux-principles.md`) and its backlog (`docs/backlog/`, overlays 90–95 authoritative).
> Licensing key: MIT/Apache = code adaptable with attribution in `NOTICE`
> (`LIFT:<project>`); proprietary = behavior observation only, reimplemented from first
> principles (`OWN`). Sizes use the backlog's 1–3pt scale.

---

## 1. Shortlist — fits the philosophy, fills a real gap

Ranked by value-per-point. Each item was checked against the backlog; none is already
tasked (near-misses carry an honesty note).

| # | Nuance | Pitch | Source (license) | Tag | Size | Seam |
|---|---|---|---|---|---|---|
| 1 | **Context gauge in the status line** | The density ramp `░▒▓█` filling as context fills — distance-to-compaction as texture, glanceable, honest. Gemini shows "(78%)" in the footer, Goose colors a dot at 80%, Claude buries it in `/context`; keywork can say it in one cell. | Gemini CLI (Apache-2.0), Goose (Apache-2.0), Claude Code (proprietary) — convergent | `OWN` | 1pt | C18 status line + A15 usage events + B7 threshold |
| 2 | **Esc-backtrack: step prompts, fork from one** | Empty-input `Esc Esc` walks backward through *user prompts* (semantic landmarks, not lines); selecting one drops its text in the editor and forks there, offering paired conversation+file restore. Wires B4 fork + E3 checkpoints into one gesture. Convergent across Codex, Claude (`/rewind` menu), Amp (Tab-navigate + edit/fork), Zed. | Codex CLI (Apache-2.0), Claude Code (proprietary), Amp (proprietary) | `OWN` | 2pt | ConversationPane keys + B4 fork API + `Checkpoints` restore |
| 3 | **Terminal-title ambient state** | OSC 0/2 title carries workspace state when unfocused — Gemini stamps ◇ ready / ✋ action-required / ✦ working into the title. The needs-you formula's zero-cost transport: the taskbar becomes the dock. | Gemini CLI (Apache-2.0) | `OWN` (trivial; spec-level) | 1pt | AppCore subscribing bus events (`agent_settled`, ask-gate); ships with G6 |
| 4 | **Render-only live tail: frames to the human, final output to the model** | Amp renders ANSI progress bars live in the transcript but sends *only the final output* to the model — progress frames never cost context. Splits the A18 entry into a display stream and a model payload. | Amp (proprietary) | `OWN` | 2pt | bash tool streaming events + A18 bounded entries |
| 5 | **`!` shell prefix + `KEYWORK=1` env marker** | Bang-prefix runs a command as *you* (through the trust gate, mirrored into the C15 pane), and child processes can detect the harness via env. Universal grammar: Pi `!`/`!!`, Codex `!`, Gemini `!` (toggle), Aider `/run`. D5's `` !`cmd` `` covers markdown commands only — the interactive prefix is untasked. | Pi (MIT — `user_bash` event is interceptable), Gemini CLI (Apache-2.0) | `LIFT:pi` | 1pt | C7 input editor + ToolGuard + C15 mirror events |
| 6 | **Edit-the-proposed-diff in `$EDITOR` before approving** | Gemini's edit confirmation offers "modify with external editor": the *proposed diff* opens in your editor, your tweaks become the approved write. Approval stops being binary without keywork ever embedding an editor. | Gemini CLI (Apache-2.0, TypeScript) | `LIFT:gemini` | 1pt | E1 gate prompt + C22 `$EDITOR` bridge |
| 7 | **Lint/test auto-fix loop with a hard reflection cap** | Aider runs linters after every edit (default on) and feeds failures back — but caps reflections at 3, so the loop can never spiral. F1's CLI recipes supply the commands; the bounded loop itself is untasked. | Aider (Apache-2.0) | `LIFT:aider` (design; Python source → TS) | 2pt | D2 post-edit hook + F1 recipes + A6 loop |
| 8 | **Copy verbs: last code block / last message / this hunk, with OSC 52** | P12 declares these first-class; no backlog ID exists. Claude ships `/copy` with OSC 52 fallback so copy works over SSH; Aider has `/copy`. Keyboard copy is the anti-mouse-selection answer. | Claude Code (proprietary), Aider (Apache-2.0) | `OWN` | 1pt | AppCore commands + per-pane copy targets (P12) |
| 9 | **Commit-message drafting — never committing** | Aider's weak model writes conventional-commit messages from the diff. keywork's version: a `/commit-msg` command drafts from staged changes and copies/prints it — the user commits (the standing convention, kept structural). Reuses the small-model slot the J `titler` already needs. | Aider (Apache-2.0) | `LIFT:aider` (behavior) | 1pt | D0 command + I9 git data layer + titler's weak-model slot |
| 10 | **Large-paste placeholder collapse** | Pastes over a threshold collapse to `[pasted #N, M lines]` in the input, expand on demand, full content sent on submit. Claude (800 chars, paste-cache recall) and Gemini (Ctrl+O expands placeholders) converge. WP-5 landed paste *routing*; the placeholder rendering is untasked. | Claude Code (proprietary), Gemini CLI (Apache-2.0) | `OWN` | 1pt | C7 InputBuffer + `Pane.handlePaste` seam + TranscriptEntry kind |
| 11 | **Away summary** | After returning from a few minutes idle, one quiet line recaps what happened — the complement of needs-you-only silence (completions don't notify, so the return moment must be self-explaining). ux-principles P13 names the idea; nothing tasks it. | Claude Code (proprietary, `awaySummaryEnabled`) | `OWN` | 1pt | focus/idle events on the bus + status line or transcript marker |
| 12 | **`/btw` side-questions** | Ask a quick question without polluting the session's context — Claude answers out-of-history. keywork already owns the right primitive: a throwaway fork the tree never keeps. Context-per-turn frugality (P6) as a keystroke. | Claude Code (proprietary) | `OWN` | 1pt | D0 command + B4 fork (discard-on-answer) |
| 13 | **Distill-session-to-command** | Goose's `/recipe` generates a reusable recipe *from the current conversation*. keywork's form: distill this session into a D5 markdown command or skill draft — the self-extending harness closing its own loop, feeding J10's skill lifecycle. | Goose (Apache-2.0, Rust — behavior only in practice) | `OWN` | 1pt | D0 command + D5 markdown commands + J10 skills |
| 14 | **Watch-files: `AI!` comments in any editor** | `--watch-files` scans the repo for `AI`/`AI!`/`AI?` comments — instructions accumulate, `AI!` triggers, `AI?` asks — the ultimate keyboard-first entry point (never leave `$EDITOR`). Surveyed in `mit-feature-candidates.md` §2.2 but never given a backlog ID. `AI?` is a legitimate needs-you trigger. | Aider (Apache-2.0) | `LIFT:aider` (design) | 2pt | engine file-watcher extension + bus + G6 |
| 15 | **MCP prompts as palette citizens** | Goose and Gemini surface MCP server *prompts* as first-class slash commands. D8–D10 task tools and lazy schemas; prompts-as-commands is the missing corner, nearly free once the D0 registry exists. | Goose (Apache-2.0), Gemini CLI (Apache-2.0) | `OWN` | 1pt | D0 registry + D8 MCP client |

---

## 2. Fits — but already covered or planned

| Nuance (who does it) | Backlog home |
|---|---|
| Steer vs queue delivery, `Enter`/`Alt+Enter` (Pi, Amp Enter-Enter, Codex Tab-queue, Zed) | A8, C12 (landed) |
| Git-snapshot undo/redo of file state (OpenCode; Gemini shadow-git `/restore`) | E3/E4 — done (I3, shadow `GIT_DIR`) |
| Tree sessions, fork/clone/labels, branch summaries (Pi) | B1–B8 — done; C13 pane mostly done |
| Promptable compaction + reserve-token auto-trigger (Pi; Goose 80% threshold) | B7 (I2) — done |
| Token/cost accounting, honest estimates (Aider $ per message, Goose opt-in cost, Amp live cost) | A15 (done) + C18 grammar |
| `@file` mention + image paste in the input (OpenCode, Codex, Amp, Claude) | C21 |
| `file:line` deep links to `$EDITOR` via OSC 8 (Amp IDE bridge is the maximal form) | C22 |
| Needs-you-only notifications with transport auto-select (Amp's SSH bell fallback `AMP_FORCE_BEL` validates the transport ladder) | G6 / P2.4 + design-language formula |
| Resume picker scoped to cwd, `--continue`/`--resume` (Codex `resume`, Goose `session -r`) | B2 — done (palette "recent sessions") |
| Auto session titles (Claude `sessionTitle` hook; keywork `suggestTitle`) | B2 polish — done |
| Slash autocomplete in the prompt; queued slash completion (Codex) | C25, D0 |
| Palette showing bindings, quick menu (OpenCode `ctrl+p`; Amp replaced slash commands with a palette — convergent validation) | C5 → C26 |
| Keybinding overlay generated from the keymap | C6 |
| allow/ask/deny + glob-scoped bash rules, per-agent (OpenCode; Codex `/permissions`) | E1 (landed: `permissionPolicy`), E2 presets |
| Plan/Build one-key switch (OpenCode Tab; Gemini Shift+Tab cycle; Goose `/plan`; Codex read-only sandbox) | E5 |
| Per-path persisted workspace trust (Pi `ProjectTrustStore`) | E6 — landed (I5) |
| Markdown commands with `$ARGUMENTS` / `` !`cmd` `` / `@file` (OpenCode; Gemini's TOML variant; namespaced subdirs) | D5 (I10) |
| Agents/subagents as markdown + frontmatter (OpenCode, Gemini, Claude) | D6 |
| Skills discovery, cross-agent skill dirs (Claude, Goose `/skills`) | D7 |
| Deferred/lazy MCP schemas (keywork's own D1 mitigation; Claude's ToolSearch is convergent evidence) | D10 |
| Ignore file (`.keyworkignore`; Gemini's git-aware `@` filtering) | D11 |
| MCP server status at a glance (Gemini `/mcp` list) | D14 dock |
| Ranked repo map with token budget & dynamic sizing (Aider) | F2/F3 |
| LSP diagnostics fed to the agent, off-by-default honesty (OpenCode) | F4/F5 |
| CLI lint/typecheck as first-class recipes (Aider built-in linters) | F1 (the *loop* is shortlist #7) |
| Headless print/JSON + JSONL event stream (Pi RPC, Codex `exec`, Gemini `--output-format stream-json`) | A13 (done), D7 bus vocabulary (I8) |
| Collapsed tool blocks, expand-on-demand (all eight, universally) | C12 (partial: collapsed blocks named in scope) |
| Head+tail output truncation with spill-to-file (Aider infinite-output stitching is the provider-side cousin) | A18 |
| Theme tokens, terminal-derived `system` theme via OSC 10/11 (OpenCode) | C16/C17 (I13) |
| Model picker with cost hints; model+effort in one picker (Codex) is a C20 scope note | C20 (I14) |
| Thinking-block parts and per-model thinking levels (Pi `set_thinking_level`; Amp Alt+T toggle) | A1 (thinking/redacted parts done); display = C12; level control = C20 scope note |
| External editor for the prompt, kill-ring, per-project history (Pi/Aider `Ctrl+G`/`/editor`) | C7 (I4) — done |
| Bracketed-paste safety: paste never submits, CRLF-normalized (all) | WP-5 — landed; C34 fixture |
| Voice input — external injectors, never a microphone in the harness (Aider `/voice` and Amp dictation are the *internal* road not taken) | P2.6 + C34 posture (decided) |
| Session sharing as local HTML export (Pi `/export`; Gemini `/chat share`) | P2.5 |
| Shared live workspaces by cwd | P2.3 |
| Subagents as navigable child sessions → panes (OpenCode child-session keybinds; Amp agents panel) | ux-principles §3.2 + C11 pane registry (design of record; no subagent primitive is planned in core, per D2/P6) |
| Cross-session context recall (`@T-xxx` thread mentions in Amp) | Workstream J (J5 recall + J13 citations) |
| Read-only review findings (Codex `/review`, Amp `.agents/checks/`) | C14 diff pane, findings variant named in ux-principles §3.1 |
| Structured debug/diagnostics log (Gemini F12 console, `session diagnostics`) | A17 — done |
| Fast-render discipline at 5000-message scale (Amp neo, pi-tui caching) | C2 + WP-6 — landed |
| Onboarding that teaches five keys (Claude `/terminal-setup` is adjacent art) | C19 + D13 |
| Conventions/instructions files, hierarchical (`AGENTS.md`, `GEMINI.md` `/memory`) | A7 + J (memory workstream) |
| Emergency interrupt during retry/backoff; Ctrl+C context-sensitivity (Goose) | 93 WP-2 (eng-10) — landed |

---

## 3. Doesn't fit — and why

| Nuance (who) | Violated principle (one line) |
|---|---|
| Click-to-expand tool output, copy-on-select, fullscreen mouse capture (Claude) | P1/94 refusals — mouse is garnish; expansion and copy get keys, not clicks |
| Cloud thread sync, share links with visibility levels, multiplayer billing (Amp) | Simplicity budget: "no share-link cloud service"; P2.5 local HTML export is the answer |
| IDE companion extensions / `/ide` context handoff (Codex, Gemini, Amp) | D10 terminal-only v1; C22 `$EDITOR` deep links are the bridge out |
| Auto-commit every AI edit into the user's git (Aider) | P11 trust-through-visible-state: keywork's E3 shadow checkpoints give undo without ever writing the user's history; the user commits (standing convention) |
| Silent auto-compaction with manual context management removed (Amp neo, 90%) | Provenance-visible / honest state: context events must be visible and steerable (B7 promptable compaction + shortlist #1 gauge), never invisible |
| LLM-classified "smart approval" of ambiguous tools (Goose `smart_approve`, Amp plugin classify) | Trust is GRANTED, not guessed: E1's rule language is deterministic and inspectable; a model deciding permissions makes the trust state unreproducible |
| Ask-dialog auto-continue timeouts (Claude `askUserQuestionTimeout`) | The needs-you formula: a notification means a keystroke is *wanted*; an ask that expires on its own was never a real ask |
| Whimsical verb spinners with shimmer gradients (Claude) | Design language: "never a spinner" — progress is the deterministic tile-fill |
| In-harness voice capture (Aider `/voice`, Amp hold-to-dictate) | 80-p2 posture (decided): voice stays external permanently; keywork is a great citizen to injectors, never a microphone host |
| Subscription-OAuth "use your existing plan" flows (multiple tools) | Hard guardrail #1 — API-key / Agent-SDK only, ever |
| Connector/app stores, `/apps`, plugin marketplaces (Codex, Goose extension catalog) | Simplicity budget: distribution is npm/git; the agent writes local extensions instead |
| Validated settings-editor dialog (Gemini `/settings`) | D9 one typed config surface: the schema and file are the editor; a settings GUI multiplies config surface |
| Capability presets that route models opaquely (Amp low/med/high/ultra) | Omarchy honesty: visible model + honest cost (C18/C20) over abstraction that hides what runs |
| Opt-in telemetry lotteries (Aider's 10% ask; PostHog) | Calm, single-user software: no analytics prompts in a keyboard-first harness |
| Emoji shortcode completion (Claude) | Simplicity budget: no daily use in a coding harness; every feature justifies itself |
| Mermaid rendering with code-linked nodes (Amp) | Terminal-only scope + render discipline; markdown/code blocks yes (C12), embedded diagram runtimes no |

---

## 4. Per-agent appendix

### Claude Code (Anthropic) — **proprietary; behavior observation only, all reimplementation is `OWN`**
Deepest corner-polish in the field. Standouts: double-`Esc` rewind menu with three restore
modes (conversation / code / both) and 100-checkpoint tracking; paste collapse to
`[Pasted text #N]` with a paste-cache; away summary after idle; `/btw` out-of-history
questions; `/focus` quiet view (one-line diffstats); custom status line as a shell script
fed session JSON on stdin (and keyboard hints auto-suppress when one is set); ~30 hook
events with regex matchers and blocking semantics; permission language
`Tool(pattern)` across a five-layer settings hierarchy; `[` key flushes the transcript to
scrollback so native terminal search works; OSC 52 clipboard over SSH; vim mode with
INSERT-mode remaps; notification channels per terminal capability. Weaknesses for
keywork's purposes: mouse-first expansion gestures, spinner whimsy, no visible context
meter outside `/context`.

### OpenCode (sst/opencode) — **MIT; adaptable with `NOTICE` attribution** *(dossier: `docs/influencers/opencode.md`)*
Already keywork's structural donor: leader-key + palette, allow/ask/deny with glob bash
rules, git-snapshot undo, `system` theme, markdown commands/agents, child-session
subagent navigation, OpenAPI/SSE server shape. Nothing new surfaced this pass that the
I1–I14 intake doesn't already carry.

### Pi (earendil-works/pi) — **MIT; adaptable with `NOTICE` attribution** *(dossier: `docs/influencers/pi.md`)*
The taste anchor: four tools, tree sessions, steer/followUp/nextTurn, `!`/`!!` user bash
(interceptable via the `user_bash` event — the shortlist #5 lift), `/reload`
self-extension, IME-correct cursor, extension-owned UI over RPC. Its `set_thinking_level`
and favorite-model cycling remain the reference for C20 scope.

### Aider (Aider-AI/aider) — **Apache-2.0; adaptable with attribution + license text carried**
The operational-loop specialist. Standouts: dirty-commits (user's own edits committed
separately before the agent touches a file); weak-model commit messages
(conventional-commit style, `--commit-prompt` customizable); auto-lint default-on with a
hardcoded reflection cap of 3 covering edit-failure and test-fix loops alike; watch-files
`AI`/`AI!`/`AI?` comments; edit-format tolerance (search/replace, udiff, per-model
auto-select) with malformed-edit reflection; infinite output via assistant prefill
stitching; `/copy-context` web-chat bridge kept deliberately manual for ToS reasons —
an instructive precedent for keywork's own guardrail posture.

### OpenAI Codex CLI (openai/codex) — **Apache-2.0 (Rust); design adaptable, code mostly not stack-compatible**
Standouts: Esc-backtrack (step through prior user messages, edit, fork); Tab-queue with
live slash completion; `/diff` including untracked files; approval policies
(`untrusted`/`on-request`/`on-failure`/`never`) orthogonal to sandbox modes
(`read-only`/`workspace-write`/`danger-full-access`, Seatbelt/Landlock, network off by
default in workspace-write); two-layer notifications (terminal events array + external
`notify` command); `codex fork`; `/review` read-only findings; model+effort in one picker;
managed-hooks-only enterprise pinning.

### Gemini CLI (google-gemini/gemini-cli) — **Apache-2.0 (TypeScript); directly adaptable with attribution**
The closest license-and-stack match after OpenCode/Pi. Standouts: dynamic window title
with state icons (◇/✋/✦) and optional thought-streaming into the title; footer
"% context left"; "modify with external editor" on edit confirmations; shadow-git
checkpointing restoring files *and* conversation together; `!` shell mode setting
`GEMINI_CLI=1`; git-aware `@`-mention filtering; TOML custom commands with namespaced
subdirectories and confirmed `!{...}` injection; Ctrl+O placeholder expansion; Alt+M
markdown toggle; `truncateToolOutputThreshold`; screen-reader plain-text mode.

### Goose (block/goose) — **Apache-2.0 (Rust); design adaptable, code not stack-compatible**
Standouts: four permission modes incl. `smart_approve` (LLM-classified — rejected above,
but the `readOnlyHint` MCP-annotation fast-path within it is sound and worth remembering
for E1); auto-compaction at 80% with a printed reduction report; `/recipe` generating a
recipe from the live conversation; recipes as typed-parameter YAML with a scheduler;
`goose session --edit` opening the conversation as YAML; MCP prompts as first-class
(`/prompts`); `@goose` shell aliases that carry recent shell history as context (the
inverse of `!` — invoking the agent *from* the shell).

### Amp (Sourcegraph) — **proprietary; behavior observation only, all reimplementation is `OWN`**
The steering-and-scale reference. Standouts: queue-by-default with Enter-Enter steer and
Esc-Esc force-send; render-only ANSI progress (frames never reach the model); `@T-xxx`
thread mentions with context extraction; Tab-navigate to any message then edit/fork;
commit trailers (`Amp-Thread:` URL + co-author) independently disableable; oracle
(second-opinion model) as a named subagent; `/handoff` (goal-directed fresh thread) — then
its removal in "neo" for silent auto-compaction, a philosophy whiplash that validates
keeping context management *visible*; 5000-message render performance as the bar.

---

*Compiled 2026-08-10 from web research (per-tool official docs and changelogs) plus the
in-repo dossiers. See `docs/influencers/` for the Pi/OpenCode deep dives and
`docs/mit-feature-candidates.md` for the prior ecosystem pass this survey extends.*
