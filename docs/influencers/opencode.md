# OpenCode (sst/opencode) — Deep Dive

> Research dossier for **keywork**. OpenCode is the single most structurally relevant influence:
> it shares keywork's exact stack (Bun + TypeScript + OpenTUI) and is **MIT-licensed — code may
> be lifted with attribution**. (For contrast within this series: Pi, `earendil-works/pi`, is
> also MIT and liftable with attribution; Crush, `charmbracelet/crush`, is FSL-1.1-MIT —
> **ideas only, never copy its source**.)
>
> **Hard guardrail:** OpenCode's Anthropic subscription-OAuth login code paths must **NOT** be
> ported into keywork. Anthropic access in keywork is API-key / Agent-SDK only (ToS). See §7.

- Repo: <https://github.com/sst/opencode> (MIT, ~195k stars, created April 2025 by the SST/Anomaly team)
- Docs: <https://opencode.ai/docs/>

---

## 1. Philosophy and positioning

OpenCode brands itself simply as **"the open source AI coding agent."** Its positioning pillars,
as verified in the README and docs:

- **Open source and provider-neutral.** Works with "any LLM provider by configuring their API
  keys" — 75+ providers — rather than being tied to one vendor. A curated model list
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
**OpenTUI** — a Zig-core terminal rendering library with TypeScript bindings for React/SolidJS,
run on Bun — specifically because Go TUI libraries (and Ink) hit performance walls at the scale
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
  OpenCode "previously included workarounds." See §7 — keywork must not carry any of that code.

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
  chord window. This deliberately sidesteps terminal keybinding conflicts — a vim/tmux idiom
  applied to an agent harness.
- **Command palette** on `ctrl+p` lists every command with its binding — discoverability layer
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

1. **OpenTUI itself** — they funded/co-created the Zig-accelerated TS terminal renderer rather
   than accept Ink or stay on Bubble Tea. The library keywork builds on exists because of this
   project.
2. **OpenAPI-first headless server** — a self-documenting HTTP API (`/doc`) + SSE events makes
   every surface (TUI, Electron, web, IDE, GitHub Actions, Slack) a thin client; SDKs are
   generated from the spec.
3. **Git-backed undo/redo of agent work** — `/undo`/`/redo` restore file state, not just chat
   state.
4. **`system` theme** — computes a grayscale ramp from the terminal's background color and
   leans on ANSI colors, so the app inherits the user's terminal aesthetic by default.
5. **Session trees** — subagent invocations are navigable child sessions with dedicated
   keybinds (`session_child_first`, `session_child_cycle`, `session_parent`).
6. **LSP diagnostics as agent feedback** — with the honest engineering note that it's off by
   default and plain CLI tools are often better.
7. **Markdown-as-config everywhere** — agents and commands are markdown files with frontmatter;
   prompt templates support arg substitution, shell injection, and file inclusion.
8. **Share links with a kill switch** — team-wide disablement via a committed config file.
9. **Models.dev-driven provider metadata** — model capabilities/context limits come from a
   community dataset instead of hand-maintained tables.

## 6. What keywork should take

Ordered by priority. Reminder: **OpenCode is MIT — code is liftable with attribution**, and
because keywork shares the exact Bun + TypeScript + OpenTUI stack, structural reuse (not just
inspiration) is on the table. Study their OpenTUI usage in `packages/tui` before writing a line
of keywork's renderer.

| # | Take | Why / how |
|---|---|---|
| 1 | **Leader-key + palette keyboard model** | The `ctrl+x` leader with `leader_timeout`, frequency-tiered bindings, and a `ctrl+p` palette that doubles as keybind documentation is exactly keywork's "fiery-clean keyboard interaction" value. Lift the binding-resolution config model (string/array/object, `"none"`, platform overrides) directly. |
| 2 | **OpenTUI patterns from `packages/tui`** | Production-proven component structure, overlay/dialog handling, scroll performance, and input handling on the same renderer keywork uses. Read the source; lift with attribution. |
| 3 | **Headless server + OpenAPI + SSE architecture** | Client/server with a generated-SDK API is what makes multi-window/pane and multi-client workflows cheap later. Adopt the shape (session/message/event/tool endpoints, `/doc` spec, SSE stream) even if keywork's v1 runs in-process. Their `packages/server` + `httpapi-codegen` are reference implementations. |
| 4 | **Git-snapshot undo/redo** | Highest-leverage trust feature per line of code. Lift the mechanism. |
| 5 | **Plan/Build primary agents with Tab switch + allow/ask/deny permissions** | Small config surface (`mode`, `permission` with glob-scoped bash rules) delivering the whole safety UX. Markdown-with-frontmatter agent definitions are worth copying verbatim as a format. |
| 6 | **Markdown custom commands** | `$ARGUMENTS`/`$1`, `` !`cmd` `` shell injection, `@file` inclusion, frontmatter routing to an agent/model. Cheap, composable, user-loved. |
| 7 | **`system` theme + JSON theme format** | Terminal-background-derived grayscale + ANSI reuse + `"none"` inheritance is Omarchy-grade default behavior: it looks native everywhere with zero user effort. Theme `defs`/dark-light variants are a good schema to lift. |
| 8 | **Vercel AI SDK + Models.dev provider layer** | Don't hand-roll provider abstraction; their `packages/llm` wiring over `@ai-sdk/*` with Models.dev metadata is directly reusable — **excluding all subscription-OAuth auth flows** (see §7). |
| 9 | **Plugin hook taxonomy** | The event list (`tool.execute.before/after`, `session.*`, `permission.asked`, …) is a well-shaped extension surface; adopt the taxonomy even if keywork's plugin runtime differs. |
| 10 | **Session trees for subagents** | Modeling subagent runs as navigable child sessions (instead of buried logs) fits keywork's multi-pane ambitions — a pane per child session is a natural keywork extension OpenCode itself doesn't have. |
| — | **Skip:** Electron desktop app, share-link cloud service, enterprise/Slack packages — out of scope for a keyboard-first harness; revisit only if the server split (item 3) lands first. |

## 7. Licensing & compliance notes (must-read)

- **OpenCode (sst/opencode): MIT.** Code may be lifted into keywork **with attribution**
  (preserve copyright/license notice; note provenance in the file or a NOTICE).
- **Pi (earendil-works/pi): MIT** — same rule, liftable with attribution.
- **Crush (charmbracelet/crush): FSL-1.1-MIT** — **ideas only; never copy its source.**
- **Anthropic guardrail:** OpenCode has historically contained login flows using Anthropic
  **Claude Pro/Max subscription OAuth**; its own docs now acknowledge Anthropic prohibits
  subscription use in third-party dev tools. **Do not port, adapt, or reference those code
  paths in keywork.** keywork integrates with Anthropic via **API keys or the Agent SDK only.**
  When lifting from `packages/llm` / auth code, excise anything touching Anthropic OAuth,
  `auth.json` OAuth token storage for Anthropic, or Pro/Max login.

## Sources

- <https://github.com/sst/opencode> — README, license, packages layout, root `package.json`
- <https://opencode.ai/docs/> — intro
- <https://opencode.ai/docs/tui/> · <https://opencode.ai/docs/keybinds/> · <https://opencode.ai/docs/agents/> · <https://opencode.ai/docs/lsp/> · <https://opencode.ai/docs/themes/> · <https://opencode.ai/docs/share/> · <https://opencode.ai/docs/server/> · <https://opencode.ai/docs/cli/> · <https://opencode.ai/docs/providers/> · <https://opencode.ai/docs/commands/> · <https://opencode.ai/docs/plugins/>
- <https://www.stork.ai/blog/the-tui-library-thats-killing-ink> — OpenTUI origin story
- <https://grokipedia.com/page/OpenTUI> — Go/Bubble Tea → OpenTUI migration
- <https://codexpedite.com/opencode-review-the-open-source-ai-agent-that-challenges-claude-code-and-cursor/> — third-party architecture review
- <https://aiwiki.ai/wiki/opencode> — project history/stats
