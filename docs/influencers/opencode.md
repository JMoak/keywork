# OpenCode (sst/opencode): Deep Dive

> Research dossier for **keywork**. OpenCode is the single most structurally relevant influence:
> it shares keywork's exact stack (Bun + TypeScript + OpenTUI) and is **MIT-licensed, so code may
> be lifted with attribution**. (For contrast within this series: Pi, `earendil-works/pi`, is
> also MIT and liftable with attribution; Crush, `charmbracelet/crush`, is FSL-1.1-MIT:
> **ideas only, never copy its source**.)
>
> **Hard guardrail:** OpenCode's Anthropic subscription-OAuth login code paths must **NOT** be
> ported into keywork. Anthropic access in keywork is API-key / Agent-SDK only (ToS). See §7.

> **Status 2026-10-02.** The repo moved to `anomalyco/opencode` (still MIT; `sst/opencode`
> redirects) and OpenTUI moved to `anomalyco/opentui`. OpenCode v2 is a rewrite branched
> 2026-06-26 and tagged v2.0.0 on 2026-09-11 (v2.0.22 on 2026-10-02) with no release notes; it
> replaces the plugin API, the server/client contracts and the TUI config file. v1 is in
> maintenance. v2 runs on Bun 1.4.2 and OpenTUI 0.5.14, while keywork pins `@opentui/core`
> 0.5.1. Sections 1 to 5 describe v1 as surveyed on 2026-08-09; §8 has what changed since, and
> [`117-influence-sweep.md`](../backlog/117-influence-sweep.md) decides what keywork takes.

- Repo: <https://github.com/anomalyco/opencode> (formerly `sst/opencode`; MIT, ~195k stars, created April 2025 by the SST/Anomaly team)
- Docs: <https://opencode.ai/docs/> (v1) · <https://opencode.ai/v2/docs/> (v2)

---

## 1. Philosophy and positioning

OpenCode brands itself simply as **"the open source AI coding agent."** Its positioning pillars,
as verified in the README and docs:

- **Open source and provider-neutral.** Works with "any LLM provider by configuring their API
  keys" (75+ providers) rather than being tied to one vendor. A curated model list
  ("OpenCode Zen") lowers the choice burden.
- **Terminal-first, but not terminal-only.** The TUI is the flagship surface, with a beta
  desktop app (macOS/Windows/Linux), a web interface, and IDE extensions all speaking to the
  same server.
- **Plan before you build.** The default UX pushes a two-mode workflow: **Plan** (read-only
  analysis, suggestions) vs **Build** (full tool access), toggled with a single keypress (Tab).
  Docs frame the agent as "a junior developer" you should brief with detailed, contextual prompts.
- **Everything is a client.** The architectural thesis is that the agent is a headless server
  with an open HTTP API; the TUI is merely the first client. Third parties can build
  alternative frontends without touching the core.

Sources: [README](https://github.com/sst/opencode), [docs intro](https://opencode.ai/docs/),
[aiwiki profile](https://aiwiki.ai/wiki/opencode).

## 2. Architecture & implementation

### Monorepo (Bun + TypeScript + Turbo)

- Root `package.json` pins `"packageManager": "bun@1.3.14"`; **Turbo 2.x** orchestrates the
  workspace; tooling includes oxlint, prettier, husky. Workspaces span `packages/*` plus nested
  groups (`packages/console/*`, `packages/stats/*`, `packages/sdk/js`).
- Notable packages (from `packages/` on the `dev` branch): `core`, `server`, `tui`, `app`,
  `desktop`, `web`, `cli`, `client`, `sdk` / `sdk-next`, `plugin`, `protocol`, `schema`,
  `session-ui`, `ui`, `storybook`, `llm`, `codemode`, `enterprise`, `slack`, `identity`,
  `httpapi-codegen`, `http-recorder`, `effect-drizzle-sqlite`, `effect-sqlite-node`, `docs`.
  The Effect + Drizzle + SQLite packages indicate typed persistence built on the Effect ecosystem.

### Client/server split

- Running `opencode` launches **both a TUI client and an HTTP server**; the TUI talks to the
  server over HTTP. `opencode serve` runs the server headless (default `127.0.0.1:4096`,
  configurable port/hostname/CORS, optional basic auth via `OPENCODE_SERVER_PASSWORD`).
- The server publishes an **OpenAPI 3.1 spec at `/doc`**, from which SDKs are generated.
  Endpoint categories: projects, sessions, messages, commands, files, tools, LSP/formatters/MCP,
  agents, auth, events.
- **SSE event streams** (`/event`, `/global/event`) push real-time updates to clients.
- Dedicated **TUI remote-control endpoints** (`/tui/append-prompt`, `/tui/submit-prompt`,
  `/tui/control/response`) let IDE plugins drive the terminal UI.
- `opencode run --attach` reuses a running server to skip cold boot; `opencode attach [url]`
  attaches a TUI to a remote server.

Sources: [server docs](https://opencode.ai/docs/server/), [CLI docs](https://opencode.ai/docs/cli/).

### The TUI: from Go/Bubble Tea to OpenTUI

OpenCode's TUI was originally written in **Go with Bubble Tea**; older third-party reviews
still describe that split (Go TUI + Bun/Hono server). The team then drove the creation of
**OpenTUI** (a Zig-core terminal rendering library with TypeScript bindings for React/SolidJS,
run on Bun) specifically because Go TUI libraries (and Ink) hit performance walls at the scale
of an AI coding interface. **OpenTUI now powers OpenCode's TUI in production.** This is the
strongest possible validation of keywork's stack choice: the highest-starred coding agent
converged on Bun + TypeScript + OpenTUI after trying the alternatives.

Sources: [OpenTUI writeup (stork.ai)](https://www.stork.ai/blog/the-tui-library-thats-killing-ink),
[Grokipedia: OpenTUI](https://grokipedia.com/page/OpenTUI),
[codexpedite architecture review](https://codexpedite.com/opencode-review-the-open-source-ai-agent-that-challenges-claude-code-and-cursor/).

### Desktop app

`packages/desktop` is an **Electron** app (electron-vite + electron-builder, built with Bun),
in beta for macOS/Windows/Linux. It is another client of the same HTTP server.

### Provider abstraction

- Built on the **Vercel AI SDK** (`@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, etc.).
- **Models.dev** supplies model metadata (context limits, capabilities) automatically.
- Credentials via `/connect` (stored in `~/.local/share/opencode/auth.json`); config in
  `opencode.json`. Custom OpenAI-compatible providers need only an ID, base URL, and model list.
- Auth methods vary by provider: API keys (most), OAuth (GitHub Copilot, GitLab Duo, Snowflake
  Cortex), env credential chains (Bedrock, Vertex). **Note:** the docs themselves now state
  that Anthropic prohibits using Claude Pro/Max subscriptions with third-party developer tools;
  OpenCode "previously included workarounds." See §7; keywork must not carry any of that code.

Source: [providers docs](https://opencode.ai/docs/providers/).

## 3. Full feature inventory

| Area | What OpenCode ships |
|---|---|
| **Sessions** | Multiple concurrent sessions; `/sessions` switcher; parent/child session trees (subagent runs become child sessions with dedicated navigation keybinds); list/delete/export/import via CLI; **/undo and /redo restore file changes via Git integration**; `/compact` for context compaction. |
| **Agents / modes** | Primary agents **Build** (all tools) and **Plan** (restricted; edits/bash default to ask), cycled with **Tab**. Built-in subagents: **General** (multi-step tasks), **Explore** (read-only analysis), **Scout** (dependency research). Subagents invoked automatically or by `@mention`. Custom agents via `opencode agent create` or markdown files with frontmatter (`mode`, `model`, `prompt`, `permission`, `temperature`, `top_p`, `steps`) in `~/.config/opencode/agents/` or `.opencode/agents/`. |
| **Permissions** | Per-tool-category `allow` / `ask` / `deny` (`read`, `edit`, `bash`, `webfetch`, `skill`, …); glob-pattern fine-grained bash permissions; enforceable per-agent. |
| **LSP** | 30+ pre-configured language servers, used to feed **diagnostics back to the agent**. **Disabled by default**; enabled via `"lsp": true` or per-server objects (`command`, `extensions`, `env`, `initialization`); auto-download opt-out via `OPENCODE_DISABLE_LSP_DOWNLOAD`. Docs candidly recommend plain CLI linters/typecheckers as a lighter alternative. |
| **Share links** | `/share` publishes a conversation to a public URL (`opncd.ai/s/<id>`); `/unshare` deletes the data. Modes: manual (default), `"share": "auto"`, `"share": "disabled"` (team-enforceable via committed `opencode.json`); enterprise self-hosting/SSO options. |
| **Themes** | Built-ins (opencode, tokyonight, everforest, ayu, catppuccin, gruvbox, kanagawa, nord, matrix, one-dark). JSON custom themes: hex or ANSI-256 values, reusable `defs`, per-color `{dark, light}` variants, `"none"` to inherit terminal colors. A **`system` theme derives a grayscale ramp from the terminal background** and reuses ANSI colors so the UI blends with any terminal scheme. Load order: built-ins → user config dir → project `.opencode/themes/` → cwd. |
| **Keybind config** | Every action rebindable in `tui.json`; values as string (comma = alternatives), array, or object (`key`, `event`, `preventDefault`, `fallthrough`); `"none"`/`false` disables. Platform-aware defaults (e.g. Windows `input_undo`, forced-off `terminal_suspend`). |
| **Custom commands** | Markdown files in `~/.config/opencode/commands/` or `.opencode/commands/`; filename = `/command` name; frontmatter (`description`, `agent`, `model`, `subtask`); templates support `$ARGUMENTS`/`$1`/`$2`, shell injection via `` !`cmd` ``, file inclusion via `@path`; can override built-in commands. |
| **Plugins** | JS/TS modules (local dirs or npm packages listed in `opencode.json`) exporting a function `(context) => hooks`. Hooks: `tool.execute.before/after`, `file.edited`, `session.created/compacted/idle/error`, `message.updated`, `permission.asked`, `shell.env`, `lsp.client.diagnostics`, `command.executed`, etc. Plugins can register custom tools with Zod schemas; Bun auto-installs plugin deps. |
| **CLI** | `run` (non-interactive, `--model/--agent/--file/--format/--attach`), `serve`, `attach`, `web`, `agent`, `auth`, `models`, `github` (GitHub Actions integration: `install`/`run`), `upgrade`. |
| **Prompt input** | `@file` fuzzy-search context injection (incl. `@alias/` reference dirs); `!cmd` shell execution whose output becomes a tool result; `/editor` opens `$EDITOR`; `/export` dumps the transcript. |

Sources: [TUI](https://opencode.ai/docs/tui/), [agents](https://opencode.ai/docs/agents/),
[LSP](https://opencode.ai/docs/lsp/), [themes](https://opencode.ai/docs/themes/),
[share](https://opencode.ai/docs/share/), [keybinds](https://opencode.ai/docs/keybinds/),
[commands](https://opencode.ai/docs/commands/), [plugins](https://opencode.ai/docs/plugins/),
[CLI](https://opencode.ai/docs/cli/).

## 4. Keyboard & UX model

- **Leader-key pattern (the headline idea).** Default leader is `ctrl+x`; most non-trivial
  actions are `<leader>` + key (new session `<leader>n`, models `<leader>m`, agents
  `<leader>a`, quit `<leader>q`). A configurable `leader_timeout` (2000 ms default) bounds the
  chord window. This deliberately sidesteps terminal keybinding conflicts, a vim/tmux idiom
  applied to an agent harness.
- **Command palette** on `ctrl+p` lists every command with its binding, a discoverability layer
  over the chords; palette customizations persist across sessions.
- **One-key mode switch:** Tab cycles primary agents (Build ⇄ Plan). Mode switching is a
  reflex, not a menu dive.
- **Frequency-tiered bindings:** hot-path actions (submit `return`, newline
  `shift+return`, paging, session parent/child navigation via arrows) intentionally skip the
  leader; rarer actions live behind it.
- **Everything rebindable, nothing hardcoded:** string/array/object binding formats,
  multi-binding per action, `"none"` to disable, platform-specific defaults.
- **Layout:** the TUI is a single chat-centric column with overlays (palette, pickers, dialogs)
  rather than persistent split panes; multi-context work is modeled as multiple *sessions*
  (and parent/child session trees) rather than visible splits. Multi-pane workflows are
  keywork's opening, not something to copy from OpenCode.

Sources: [keybinds docs](https://opencode.ai/docs/keybinds/), [TUI docs](https://opencode.ai/docs/tui/).

## 5. Unique features

1. **OpenTUI itself**: they funded/co-created the Zig-accelerated TS terminal renderer rather
   than accept Ink or stay on Bubble Tea. The library keywork builds on exists because of this
   project.
2. **OpenAPI-first headless server**: a self-documenting HTTP API (`/doc`) + SSE events makes
   every surface (TUI, Electron, web, IDE, GitHub Actions, Slack) a thin client; SDKs are
   generated from the spec.
3. **Git-backed undo/redo of agent work**: `/undo`/`/redo` restore file state, not just chat
   state.
4. **`system` theme**: computes a grayscale ramp from the terminal's background color and
   leans on ANSI colors, so the app inherits the user's terminal aesthetic by default.
5. **Session trees**: subagent invocations are navigable child sessions with dedicated
   keybinds (`session_child_first`, `session_child_cycle`, `session_parent`).
6. **LSP diagnostics as agent feedback**, with the honest engineering note that it's off by
   default and plain CLI tools are often better.
7. **Markdown-as-config everywhere**: agents and commands are markdown files with frontmatter;
   prompt templates support arg substitution, shell injection, and file inclusion.
8. **Share links with a kill switch**: team-wide disablement via a committed config file.
9. **Models.dev-driven provider metadata**: model capabilities/context limits come from a
   community dataset instead of hand-maintained tables.

## 6. What keywork should take

Ordered by priority. Reminder: **OpenCode is MIT, so code is liftable with attribution**, and
because keywork shares the exact Bun + TypeScript + OpenTUI stack, structural reuse (not just
inspiration) is on the table. Study their OpenTUI usage in `packages/tui` before writing a line
of keywork's renderer.

| # | Take | Why / how | Status 2026-10-02 |
|---|---|---|---|
| 1 | **Leader-key + palette keyboard model** | The `ctrl+x` leader with `leader_timeout`, frequency-tiered bindings, and a `ctrl+p` palette that doubles as keybind documentation is exactly keywork's "fiery-clean keyboard interaction" value. Lift the binding-resolution config model (string/array/object, `"none"`, platform overrides) directly. | **Landed:** C3 keymap with a timed leader (`ctrl+k`, `tui/src/keymap.ts`), C6 overlay from the live keymap, C26 palette (partial at the 92 ledger; files section via C33), C4 hot reload (2026-09-07). The config schema came from Pi (92 I11), not OpenCode. |
| 2 | **OpenTUI patterns from `packages/tui`** | Production-proven component structure, overlay/dialog handling, scroll performance, and input handling on the same renderer keywork uses. Read the source; lift with attribution. | **Landed** as keywork's own TUI on OpenTUI (C1, C2 + WP-6); no OpenCode TUI code was adapted (`NOTICE` has none). **Open:** SW9 bumps `@opentui/core` 0.5.1 to 0.5.14. |
| 3 | **Headless server + OpenAPI + SSE architecture** | Client/server with a generated-SDK API is what makes multi-window/pane and multi-client workflows cheap later. Adopt the shape (session/message/event/tool endpoints, `/doc` spec, SSE stream) even if keywork's v1 runs in-process. Their `packages/server` + `httpapi-codegen` are reference implementations. | **Landed:** P2.1 server with OpenAPI 3.1 at `/doc` and SSE `/events` (2026-09-06), P2.2 `keywork attach`, S0 discovery and S1 ask queue (2026-09-07). The engine stays in-process (D7). **Open:** P2.3 shared workspaces. |
| 4 | **Git-snapshot undo/redo** | Highest-leverage trust feature per line of code. Lift the mechanism. | **Landed:** E3/E4 (2026-08-10, shadow `GIT_DIR`, recorded in `NOTICE`). **Open:** SW14 undo that returns the prompt, SW13 per-command diff. |
| 5 | **Plan/Build primary agents with Tab switch + allow/ask/deny permissions** | Small config surface (`mode`, `permission` with glob-scoped bash rules) delivering the whole safety UX. Markdown-with-frontmatter agent definitions are worth copying verbatim as a format. | **Landed:** E1 `permissionPolicy` (I6, in `NOTICE`), E2 presets, D6 markdown agents (since absorbed by D16 bots). **Superseded:** Plan/Build + Tab (E5) by the E7 / PD12 modes spec (Plan · Recall · Agent), unbuilt; the rule model by SW15 (decision 117-2, v2's ordered list), open. |
| 6 | **Markdown custom commands** | `$ARGUMENTS`/`$1`, `` !`cmd` `` shell injection, `@file` inclusion, frontmatter routing to an agent/model. Cheap, composable, user-loved. | **Landed:** D5 (2026-08-10, `engine/src/extensions/markdown-commands.ts`, in `NOTICE`). |
| 7 | **`system` theme + JSON theme format** | Terminal-background-derived grayscale + ANSI reuse + `"none"` inheritance is Omarchy-grade default behavior: it looks native everywhere with zero user effort. Theme `defs`/dark-light variants are a good schema to lift. | **Landed:** C16 theme tokens; C17 `system` as a flavor (2026-09-07). JSON theme files were not lifted; PD15 flavors are the unit. **Open:** SW21 live theme follow. |
| 8 | **Vercel AI SDK + Models.dev provider layer** | Don't hand-roll provider abstraction; their `packages/llm` wiring over `@ai-sdk/*` with Models.dev metadata is directly reusable, **excluding all subscription-OAuth auth flows** (see §7). | **Superseded** by keywork's own raw-fetch providers (92 anti-regression note; G1, IR contract in 105). Models.dev metadata (92 I14) is not built: `engine/src/pricing.ts` is a hand table that SW2 refreshes, and per-model output limits are open (70, note 5). |
| 9 | **Plugin hook taxonomy** | The event list (`tool.execute.before/after`, `session.*`, `permission.asked`, …) is a well-shaped extension surface; adopt the taxonomy even if keywork's plugin runtime differs. | **Superseded** by D2's Pi taxonomy (`LIFT:pi`). D1 to D3 are open (`packages/extensions` is a stub). The bus vocabulary landed as `docs/events.md` (A5, Pi names per I8). |
| 10 | **Session trees for subagents** | Modeling subagent runs as navigable child sessions (instead of buried logs) fits keywork's multi-pane ambitions; a pane per child session is a natural keywork extension OpenCode itself doesn't have. | **Open, parked:** FR6.17 waits until spawning exists (115); no subagent primitive is planned in core (D2/P6). |
| · | **Skip:** Electron desktop app, share-link cloud service, enterprise/Slack packages are out of scope for a keyboard-first harness; revisit only if the server split (item 3) lands first. | | Still skipped. The server landed; the share answer is P2.5 local HTML export (open). |

## 7. Licensing & compliance notes (must-read)

- **OpenCode (sst/opencode): MIT.** Code may be lifted into keywork **with attribution**
  (preserve copyright/license notice; note provenance in the file or a NOTICE).
- **Pi (earendil-works/pi): MIT**; same rule, liftable with attribution.
- **Crush (charmbracelet/crush): FSL-1.1-MIT**: **ideas only; never copy its source.**
- **Anthropic guardrail:** OpenCode has historically contained login flows using Anthropic
  **Claude Pro/Max subscription OAuth**; its own docs now acknowledge Anthropic prohibits
  subscription use in third-party dev tools. **Do not port, adapt, or reference those code
  paths in keywork.** keywork integrates with Anthropic via **API keys or the Agent SDK only.**
  When lifting from `packages/llm` / auth code, excise anything touching Anthropic OAuth,
  `auth.json` OAuth token storage for Anthropic, or Pro/Max login.

## 8. Since 2026-08-09

What keywork takes from this is decided in
[`117-influence-sweep.md`](../backlog/117-influence-sweep.md); the tag after each item cites it.

**v1 maintenance.** v1.18.16 to v1.18.34 (2026-08-10 to 2026-09-30) are provider fixes plus a
few behaviors: 5-minute default header and stream-chunk timeouts (v1.18.27), a resumable
`task_id` on failed subagents (v1.18.20), ACP session-option fixes (v1.18.31).
[changelog](https://opencode.ai/changelog)

**v2 rewrite.** Branched 2026-06-26, v2.0.0 tagged 2026-09-11, v2.0.22 on 2026-10-02. No
release notes exist ([issue #52184](https://github.com/anomalyco/opencode/issues/52184)).
Three breaking changes per the [migration guide](https://opencode.ai/v2/docs/migrate-v1/): a
new plugin API, new server/client contracts, and one global `cli.json` in place of `tui.json`.

- **Permissions** ([docs](https://opencode.ai/v2/docs/permissions/)): one ordered array of
  `{action, resource, effect}`, last match wins, no match asks. `bash` became `shell`, `task`
  became `subagent`, `write`/`patch` fold into `edit`. Every tool has its own resource (path,
  pattern, URL, skill ID); a compound shell command scans into several resources and any deny
  denies. Taken: SW15 (decision 117-2).
- **Policies** ([docs](https://opencode.ai/v2/docs/policies/)): `experimental.policies` are
  hard-deny statements that override "Allow always" and can be pushed by the Console. Not
  triaged in 117.
- **Background service by default** ([CLI docs](https://opencode.ai/v2/docs/cli/)): one shared
  per-user server owns sessions, permissions and tools; `--standalone`, `--server` and
  `opencode mini` opt out. Declined as a default; keywork keeps D7 in-process.
- **Snapshots** ([docs](https://opencode.ai/v2/docs/snapshots/)): undo and redo cover the
  conversation and files together; rollback is staged and the removed prompt returns to the
  composer; each model step is attributed to the paths it changed; untracked files are capped
  at 2 MiB. Taken: SW14.
- **Session warming** ([docs](https://opencode.ai/v2/docs/warming/)): prompt-cache keep-alive,
  off by default. Scope first.
- **References** ([docs](https://opencode.ai/v2/docs/references/)): named outside directories or
  repos, refreshed every 24h. Scope first, adjacent to V2.7.
- **Code Mode** ([tools docs](https://opencode.ai/v2/docs/tools/)): an `execute` tool on by
  default for MCP. Declined as a default; Pi codemode is the scope-first input to Q-DSH5.
- **MCP client** reworked for the 2026-07-28 protocol revision with split startup, catalog and
  execution timeouts ([PR #48937](https://github.com/anomalyco/opencode/pull/48937),
  2026-09-14). keywork's answer: SW12.
- **TUI commits:** `/btw` side questions (#49646, 2026-09-18; converges with V2.17, open),
  `/goal` (#45379; declined), transcript verbosity levels (#50941, 2026-09-23) and adjacent
  reads grouped into one row (#52207), both taken as SW25; transcript mounting budgeted by
  rendered entries (#50936; not triaged, the A18 pane half's virtualized rows are the nearest
  landed piece); undo of queued
  prompts back into the input (#51124; not triaged, V2.6 queue editing is the nearest landed
  piece); automatic tabs mode (#50456; not triaged).
- **Runtime:** v2's root `package.json` at v2.0.22 pins Bun 1.4.2 and OpenTUI 0.5.14. keywork's
  Bun move waits on decision 117-3 (SW10).

**OpenTUI** ([releases](https://github.com/anomalyco/opentui/releases), MIT). keywork pins
`@opentui/core` 0.5.1; latest is 0.5.14 (2026-09-30). Taken: SW9 (bump), SW11 (terminal pane).

- 0.5.0 (2026-08-03): native image rendering (Kitty, Sixel, blocks); Windows output through
  `WriteConsoleW`.
- 0.5.2 (2026-08-12): statically linked libghostty and an embedded terminal runtime, exposed in
  0.5.14 as `EmbeddedTerminalRenderable` driven by `Bun.spawn({ terminal })`; cross-platform
  clipboard (host and OSC 52); bounded streaming code highlights.
- 0.5.4 to 0.5.8: forced-Sixel fixes, stale mouse input cleared, double and triple-click
  selection (#1407, must stay inert under 94's mouse refusals), independent mouse-button
  tracking, Ghostty-matched wide graphemes.
- 0.5.9 to 0.5.11: backpressure fixes, byte-accurate wrapped layout, bounded large-diff
  rendering, split-diff realign on resize, Bun 1.4 support, CJK wrapping.
- 0.5.12 to 0.5.14: OSC 22 pointer styles, `textAlign`, a Windows Zig extraction fix, a Kitty
  z-order fix, tmux capability replies, repaint after net-zero resize bursts.
- `@opentui/keymap` (MIT, since April 2026): leader, timed leader, sequences, a command catalog,
  and dead or shadowed binding diagnostics. Not triaged in 117; keywork's own C3 keymap already
  has a timed leader.

## Sources

- <https://github.com/sst/opencode>: README, license, packages layout, root `package.json`
- <https://github.com/anomalyco/opencode>: the repo since the move; v2 root `package.json` at v2.0.22; issue #52184, PR #48937
- <https://opencode.ai/changelog>: v1.18.16 to v1.18.34
- <https://opencode.ai/v2/docs/> · <https://opencode.ai/v2/docs/migrate-v1/> · <https://opencode.ai/v2/docs/permissions/> · <https://opencode.ai/v2/docs/policies/> · <https://opencode.ai/v2/docs/cli/> · <https://opencode.ai/v2/docs/snapshots/> · <https://opencode.ai/v2/docs/warming/> · <https://opencode.ai/v2/docs/references/> · <https://opencode.ai/v2/docs/tools/>
- <https://github.com/anomalyco/opentui/releases>: OpenTUI 0.5.0 to 0.5.14
- <https://opencode.ai/docs/>: intro
- <https://opencode.ai/docs/tui/> · <https://opencode.ai/docs/keybinds/> · <https://opencode.ai/docs/agents/> · <https://opencode.ai/docs/lsp/> · <https://opencode.ai/docs/themes/> · <https://opencode.ai/docs/share/> · <https://opencode.ai/docs/server/> · <https://opencode.ai/docs/cli/> · <https://opencode.ai/docs/providers/> · <https://opencode.ai/docs/commands/> · <https://opencode.ai/docs/plugins/>
- <https://www.stork.ai/blog/the-tui-library-thats-killing-ink>: OpenTUI origin story
- <https://grokipedia.com/page/OpenTUI>: Go/Bubble Tea → OpenTUI migration
- <https://codexpedite.com/opencode-review-the-open-source-ai-agent-that-challenges-claude-code-and-cursor/>: third-party architecture review
- <https://aiwiki.ai/wiki/opencode>: project history/stats
