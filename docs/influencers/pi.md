# Pi (earendil-works/pi): Deep Dive

> **Influence research for keywork.** Pi is a minimal, self-extending terminal coding-agent
> harness by Mario Zechner (badlogic, of libGDX fame), published under Earendil Inc. at
> [pi.dev](https://pi.dev/) and [github.com/earendil-works/pi](https://github.com/earendil-works/pi).
>
> **License: MIT.** Code may be lifted into keywork with attribution. (Contrast: OpenCode
> `sst/opencode` is also MIT and liftable with attribution; Crush `charmbracelet/crush` is
> FSL-1.1-MIT, ideas only, never copy its source.) Keywork must never integrate Anthropic
> subscription-OAuth; Anthropic access is API-key / Agent-SDK only.

> **Status 2026-10-02.** Pi has moved a long way since this dossier was written (2026-08-09).
> Earendil acquired it in April 2026; the canonical repo is `earendil-works/pi`, still MIT.
> The headline change is that Pi reversed on MCP: v0.99.0 (2026-09-29) ships MCP as a built-in
> extension with lazy `tool_search` and per-tool exposure, plus Codemode (model-written
> JavaScript in QuickJS calling tools), and v1.0.0 (2026-10-01) hardens both. The anti-MCP
> passages in §1, §5 and §6 stay as history with dated notes. Pi also shipped
> `ContextEditEntry`, mid-run compaction, cache-preserving prompt deltas, cache warming, `/bug`
> and Pi Durable; §7 has the release list. §6 now marks each item landed, open or superseded in
> keywork. What keywork takes from the new releases is decided in
> [`docs/backlog/117-influence-sweep.md`](../backlog/117-influence-sweep.md).

---

## 1. Philosophy

Pi's tagline is *"Adapt Pi to your workflows, not the other way around."* Its design bets are
unusually crisp and each one is directly relevant to keywork:

- **Minimal core, primitives not features.** Pi ships exactly **four built-in LLM tools**:
  `read`, `write`, `edit`, `bash`. Everything else (plan mode, permission gates, sub-agents,
  to-dos, background bash) is deliberately *absent* from core and provided (or buildable) as
  extensions. The pi.dev homepage lists these omissions proudly as "notable absences."
- **Shortest system prompt of any agent.** Armin Ronacher highlights that Pi has "the shortest
  system prompt of any agent" paired with just the four tools. Databricks-style benchmarking
  cited in third-party writeups found Pi sending roughly 3x less context per turn than Claude
  Code, finishing tasks in fewer runs at lower cost.
- **Self-extending agent.** The central idea Ronacher champions: "LLMs are really good at
  writing and running code, so embrace this." Instead of downloading pre-built plugins, you ask
  Pi to *extend itself*: it writes a TypeScript extension into `.pi/extensions/`, you `/reload`,
  and the new capability is live. The agent maintains its own harness.
- **Rejection of MCP.** Pi has no MCP support, on purpose. Zechner's argument (see his "What if
  you don't need MCP?" post): MCP servers dump 13k–18k tokens of tool schemas into context at
  startup, are not composable (all output must round-trip through model context), and are hard
  to extend. Loading tools into system context at startup would also break Pi's hot-reload and
  session-branching model. His alternative: small CLI scripts + Bash, because "Bash and code are
  composable"; a browser-automation script set he wrote needs a "225 token" README vs. an
  18k-token MCP server.
  - *Note 2026-10-02:* Pi 1.0 reversed this. v0.99.0 ships MCP as a built-in extension (stdio
    and streamable HTTP with OAuth, `mcp.json`, `/mcp`, `pi mcp add|login`), with `tool_search`
    and per-tool `exposure` so idle servers stay out of context. Earendil's stated reason:
    "what Pi needs is quite similar to what MCP needs: a sandbox." See §7.
- **No built-in permission system.** Pi explicitly "does not include a built-in permission
  system for restricting filesystem, process, network, or credential access." Security is
  delegated to containerization (documented patterns: Gondolin extension, plain Docker,
  OpenShell), or to a permission-gate *extension* using the `tool_call` event.

## 2. Architecture & implementation

### Monorepo packages

`packages/` in the repo contains: `agent`, `ai`, `client`, `coding-agent`, `evals`, `protocol`,
`server`, `session-backends/sqlite-node`, `telemetry`, `tui`. The published surface:

| Package | Role |
|---|---|
| `@earendil-works/pi-coding-agent` | The interactive CLI / harness itself |
| `@earendil-works/pi-agent-core` | Agent runtime: tool calling, state management |
| `@earendil-works/pi-ai` | Unified multi-provider LLM API (OpenAI, Anthropic, Google, Azure, Bedrock, Mistral, Groq, … 15+ providers) |
| `@earendil-works/pi-tui` | Zero-dependency terminal UI framework with differential rendering |
| (telemetry) | Vendor-neutral telemetry contracts + reference adapter |

Supply-chain posture is notable: exact-pinned deps, `.npmrc` with `save-exact=true` and
`min-release-age=2`, shrinkwrap, CI auditing, `npm install --ignore-scripts`, offline binary
builds (`./scripts/build-binaries.sh --offline-model-data`).

### The four core tools

`read`, `write`, `edit`, `bash`. That is the entire built-in tool surface the model sees.

### Extension system

Extensions are TypeScript modules auto-discovered from `~/.pi/agent/extensions/` (global) and
`.pi/extensions/` (project-local), or loaded ad hoc with `-e ./path.ts`. Each exports a default
(possibly async) factory receiving an `ExtensionAPI` (`pi`):

- **Registration:** `pi.registerTool()` (with `promptSnippet`, `promptGuidelines`, TypeBox
  `parameters`, `execute`, optional `renderCall`/`renderResult` renderers),
  `pi.registerCommand()` (slash commands), `pi.registerShortcut("ctrl+shift+p", …)`,
  `pi.registerFlag()` (CLI flags), `pi.registerProvider()`,
  `pi.registerMessageRenderer()` / `pi.registerEntryRenderer()` /
  `pi.registerMarkdownTransformer()`.
- **Events (~30 hooks)** spanning the whole lifecycle: `session_start`, `session_before_fork`,
  `session_before_compact`, `session_tree`, `before_agent_start`, `agent_start/end/settled`,
  `message_start/update/end`, `input` (intercept/transform user input), `context` (mutate
  messages before every LLM call), `tool_call` (block or mutate args; this is how permission
  gates are built), `tool_result`, `tool_execution_start/update/end`,
  `before_provider_headers/request`, `after_provider_response`, `model_select`, `user_bash`,
  `project_trust`, `resources_discover`.
- **UI from extensions:** `ctx.ui.select/confirm/input/editor/notify`, plus
  `ctx.ui.custom((tui) => Component)` for arbitrary pi-tui components, and persistent
  `ctx.ui.setStatus()` / `ctx.ui.setWidget()` chrome. Dialogs work in both TUI and RPC modes
  (RPC clients answer `extension_ui_request` events, with timeouts and defaults).
- **Messaging:** `pi.sendMessage()` / `pi.sendUserMessage()` with delivery modes `"steer"`
  (after current tool batch), `"followUp"` (after agent finishes), `"nextTurn"`.
- **Persistent state:** `pi.appendEntry(type, data)` writes custom entries into the session
  JSONL (invisible to the LLM); on `session_start` an extension replays its entries to
  reconstruct state. Tool results carry a `details` field so state can be rebuilt correctly
  after branching; "state reconstruction" is a documented first-class pattern.
- **Hot reload:** `/reload` reloads extensions, skills, prompt templates, and keybindings
  without restarting, the loop that makes "agent, extend thyself" practical.
- **Inter-extension messaging:** `pi.events.on()` / `pi.events.emit()`.

Beyond extensions, Pi has three lighter customization layers: **Skills** (capability packages),
**Prompt templates**, and **Themes**, all bundleable into **Pi Packages** shareable via npm or
git.

### Session trees

Sessions persist automatically as JSONL in `~/.pi/agent/sessions/`, organized by working
directory. Every entry has `id` + `parentId`; the current position is the active leaf. The
session *is* a tree, not a log:

- `/tree`: visualize and navigate the tree; selecting a user message drops its text into the
  editor for resubmission (creating a new branch); selecting an assistant/tool entry moves the
  leaf there. `Shift+L` labels entries in tree view. Switching branches offers branch
  summarization: none, default, or custom-focus instructions.
- `/fork <path|id>`: new session file from a previous user message; `/clone`: duplicate the
  active branch into a new session. (`/tree` = within one file; fork/clone = new files.)
- `/resume`, `/new`, `/name`, `/session` (metadata: ID, message count, tokens, cost),
  `/compact [prompt]`, `/export [file]` (HTML), `/share` (private GitHub gist with shareable
  HTML link).

### Four operating modes

1. **Interactive TUI**: the default.
2. **Print / JSON**: `pi -p "query"` one-shot, with a JSON event-stream variant for scripting.
3. **RPC**: headless JSONL over stdin/stdout. Strict LF-delimited framing (docs warn that
   Node `readline` is protocol-incompatible because it splits on U+2028/U+2029). Commands:
   `prompt` (with `streamingBehavior`), `steer`, `follow_up`, `abort`, `set_model`,
   `cycle_model`, `set_thinking_level`, `get_state`, `get_messages`, `get_entries` (cursor
   support), `get_tree`, `fork`, `clone`, `compact`, `set_auto_compaction`, direct `bash` /
   `abort_bash`, `set_auto_retry`, etc. Events stream `agent_start/end/settled`,
   `turn_start/end`, `message_update` (with `text_delta` / `thinking_delta` /
   `toolcall_delta`), `tool_execution_*`, `compaction_*`, `auto_retry_*`. Extension dialogs
   surface as `extension_ui_request` / `extension_ui_response`.
4. **SDK**: embed the agent in a Node/TypeScript program.

The same extension code runs in all modes; `ctx.mode` reports `"tui" | "rpc" | "json" |
"print"` and `ctx.hasUI` gates UI use.

### pi-tui

A zero-dependency, ANSI-native TUI framework (no blessed/ink underneath):

- **Component contract:** `render(width): string[]` (each line must fit `width`),
  optional `handleInput(data)`, `invalidate()`. Differential rendering via per-component
  output caching keyed on width; re-render only on width change, `invalidate()`, or
  `tui.requestRender()`.
- **Components:** `Text`, `Box`, `Container`, `Spacer`, `Markdown` (syntax-highlighted),
  `Image` (Kitty/iTerm2/Ghostty/WezTerm/Warp), `SelectList`, `SettingsList`,
  `Input`/`Editor`, `BorderedLoader`, `DynamicBorder`, `CustomEditor`.
- **IME-first:** a `Focusable` interface emits a zero-width `CURSOR_MARKER` APC sequence; the
  TUI scans output and positions the *hardware* cursor there so CJK IME candidate windows
  appear at the right spot. Almost no TUI framework gets this right.
- **First-class overlays:** nine anchor positions, percent/absolute sizing, focus handles,
  responsive show/hide, rendered on top without clearing the screen.
- **Utilities:** `matchesKey(data, Key.*)`, `wrapTextWithAnsi()`, `truncateToWidth()`,
  `visibleWidth()`.
- Ronacher specifically praises the result: minimal resource consumption, "no flickering or
  random breakdowns."

## 3. Full feature inventory

| Area | Features |
|---|---|
| Models | 15+ providers via `pi-ai`; switch mid-session with `/model` or `Ctrl+L`; cycle favorites `Ctrl+P` / `Shift+Ctrl+P`; per-model thinking levels ("off" → "max"); local models via llama.cpp router (`/llama`); custom models and custom provider APIs (incl. OAuth flows for providers that offer them) |
| Context | `AGENTS.md` project instructions; `SYSTEM.md` custom system prompt; auto-compaction + `/compact [prompt]`; branch summarization; skills; dynamic context injection via the `context` event |
| Sessions | JSONL tree sessions; `/tree`, `/fork`, `/clone`, `/resume`, `/new`, `/name`, `/session`; entry labels; `/export` HTML; `/share` gist; documented session format; pluggable session backends (sqlite package exists in-repo) |
| Interaction | Steering vs. follow-up message delivery (`Enter` interrupts current tools to steer; `Alt+Enter` queues follow-up); `!`/`!!` user bash passthrough (interceptable by extensions); prompt templates; image paste `Ctrl+V`; external editor `Ctrl+G` |
| Extensibility | TypeScript extensions (tools, commands, shortcuts, flags, providers, renderers, UI); skills; prompt templates; themes; Pi Packages via npm/git; `/reload` hot reload |
| Modes | Interactive TUI, print/JSON (`pi -p`), RPC JSONL, Node SDK |
| Ops | Auto-retry on transient provider errors; token/cost stats; environment-variable config; settings files; Windows + Termux support; tmux workflow docs (Pi's answer to sub-agents/background work) |
| Security | No built-in sandbox by design; containerization docs (Gondolin, Docker, OpenShell); permission gates as extensions; hardened supply chain |
| Distribution | `curl -fsSL https://pi.dev/install.sh \| sh`, PowerShell installer, npm/pnpm/yarn/bun, standalone offline-buildable binaries |

## 4. Keyboard & UX model

Everything is remappable via `~/.pi/agent/keybindings.json` (namespaced action IDs like
`tui.editor.historyPrevious`; single key or array per action; Emacs/Vim preset examples in
docs; `/reload` applies changes live).

Defaults worth knowing:

| Key | Action |
|---|---|
| `Enter` | Submit; delivered as a *steering* message that interrupts current tool batch |
| `Alt+Enter` | Queue as follow-up (waits for the agent to finish) |
| `Shift+Enter` / `Ctrl+J` | Newline |
| `Tab` | Autocomplete |
| `Ctrl+A` / `Ctrl+E`, `Ctrl+W` / `Alt+D` | Emacs-style line/word editing |
| `Ctrl+C` | Clear editor, then exit; `Ctrl+D` exits when empty |
| `Ctrl+G` | Open external editor |
| `Ctrl+V` | Paste image/text |
| `Ctrl+L` | Model selector; `Ctrl+P` / `Shift+Ctrl+P` cycle favorite models |
| `PageUp/PageDown`, `Home/End` | Transcript scroll (fullscreen) |
| `Shift+L` | Label entry in `/tree` view |

UX character: differential rendering (no flicker), overlay dialogs instead of full-screen
mode switches, persistent status line + widgets that extensions can own, image rendering in
capable terminals, IME-correct cursor placement, terminal-setup and shell-alias docs showing
Omarchy-grade attention to the surrounding environment.

## 5. Unique features no other agent has

1. **Tree-structured sessions as the native storage model**: branch/navigate/label a live
   conversation tree with optional branch summaries on switch. Others have "resume"; Pi has
   version control for conversations.
2. **Self-extension as the primary workflow**: the agent writes its own extensions, hot-reloads
   them, and tests them in-session (`/reload` + `-e file.ts`). No marketplace mentality.
3. **Deliberate MCP absence with an articulated alternative** (CLI scripts + Bash +
   extensions), backed by measured token-cost arguments. *Note 2026-10-02:* no longer true.
   Pi 1.0 ships MCP built in, behind lazy `tool_search` and per-tool exposure (§7).
4. **Four-tool core with the shortest system prompt in the field**: minimalism as a measured
   performance strategy (less context/turn, fewer runs), not just aesthetics.
5. **Extension-owned UI across modes**: the same extension can pop a `select` dialog in the
   TUI *or* over RPC (`extension_ui_request` with timeout defaults), so headless embedders get
   interactive extensions for free.
6. **State reconstruction contract**: tool-result `details` + replayable custom session
   entries mean extension state survives forking and tree navigation coherently.
7. **IME-first hardware-cursor handling and first-class overlays in a zero-dependency TUI.**
8. **Steer vs. follow-up as a keyboard-level distinction** (`Enter` vs `Alt+Enter`), exposed
   identically in the RPC protocol (`streamingBehavior: "steer" | "followUp"`).

## 6. What keywork should take (prioritized)

Pi is MIT: **code below is liftable with attribution**, not just inspiration. Priorities:

Status as of 2026-10-02 is marked on every item. Task IDs refer to `docs/backlog/`; "91" and
"92" are the archived ledgers in `docs/backlog/archive/`.

### P0: foundational, adopt the model
1. **Four-tool core + minimal system prompt.** Start keywork with `read`/`write`/`edit`/`bash`
   and nothing else; measure context-per-turn as a first-class metric. Lift Pi's tool
   implementations and prompt structure from `packages/coding-agent` as a starting point.
   **Landed:** A7 and A9 to A12 (91), in `packages/engine/src/tools/` and
   `packages/engine/src/prompt.ts`. keywork has since added tools past the four (`skill`,
   memory tools, `mcp_tool_search`).
2. **Tree sessions (JSONL, `id`/`parentId`, active leaf).** Adopt Pi's session format
   (documented in `session-format.md`) so keywork gets `/tree`, fork, clone, labels, and
   branch summaries. This is Pi's crown jewel and maps perfectly to keywork's
   multi-window/pane values: panes can be leaves of one tree.
   **Landed:** B1 and B4 to B8 (91, recorded in `NOTICE`), `packages/engine/src/session/`;
   B7 compaction adapted from Pi's design; `/tree` through C13
   (`packages/tui/src/session-tree-pane.ts`). Open follow-ups from Pi's newer releases: SW1
   newline repair and the `ContextEditEntry` scope-first item (117).
3. **Extension API shape.** The `ExtensionAPI` factory + event-hook design (`tool_call` gates,
   `context` injection, `input` interception, registerTool/Command/Shortcut) is the cleanest
   plugin architecture in any agent. Lift the event taxonomy wholesale; it also cleanly
   replaces MCP, permission popups, and plan mode with user-space code.
   **Open:** D1 to D4 (`40-extensions.md`); `packages/extensions/src` holds only a version
   stub and no `registerTool` host exists. The markdown layer beside it landed (D5 to D7, 92).
   The "replaces MCP" clause is superseded by vision D1.

### P1: high leverage
4. **Steer vs. follow-up delivery semantics** (`Enter` / `Alt+Enter`, and
   `steer`/`followUp`/`nextTurn` in the API). Exactly the "fiery-clean keyboard interaction"
   keywork wants: interruption as a first-class, predictable primitive.
   **Landed:** A8 (91), `send(..., { behavior: "steer" | "queue" })` in
   `packages/engine/src/agent.ts`. keywork flips Pi's keys: `Enter` queues and `Alt+Enter`
   steers. No `nextTurn` mode exists.
5. **RPC JSONL mode with the extension-UI bridge.** Lifting Pi's `protocol` package (or its
   command/event vocabulary) gives keywork headless embedding, IDE integration, and
   pane-orchestration for free. Mind the strict-LF framing lesson.
   **Superseded** by the P2.1 HTTP + SSE server (landed 2026-09-06, `80-p2-reach.md`) and A13
   `keywork run --json`; gate prompts cross the wire through the S1 ask queue (landed
   2026-09-07). An extension-UI bridge waits on D2 (open).
6. **Namespaced, hot-reloadable keybindings** (`keybindings.json`, action IDs, `/reload`).
   Keywork should be at least this remappable from day one.
   **Landed:** C4 (`30-tui.md` ledger, 2026-09-07). Action-named overrides in `keywork.json`
   apply live through a file watch, so no `/reload` is needed.
7. **Hot reload of extensions/skills/themes.** The `/reload` loop is what makes
   self-extension real.
   **Open:** D4 (`40-extensions.md`), blocked on the D1 host.

### P2: take the ideas, adapt the implementation
8. **pi-tui patterns, not pi-tui itself.** Keywork uses OpenTUI, but steal the contracts:
   width-constrained `render()`, per-component output caching for differential updates,
   `invalidate()` on theme change, `CURSOR_MARKER`-style IME cursor placement, overlay-native
   dialogs, `Focusable`. These are the details behind "no flicker."
   **Partly landed:** overlay dialogs (`packages/tui/src/overlays/`) and A18 bounded entries
   with delta coalescing (95). **Open:** IME hardware-cursor placement and the `Ctrl+G`
   external editor, both in C7 (`30-tui.md`); neither appears in `packages/tui/src`.
9. **No-MCP-by-default posture.** Follow Pi: keep MCP out of the core loop (an extension can
   always bridge it); prefer CLI scripts + Bash for integrations, citing the token math.
   **Superseded** by vision D1 (MCP in core, lazily; D8/D10 landed, 92,
   `packages/engine/src/mcp/`) and by Pi's own reversal in v0.99.0. SW12 (open, 117) brings
   the client to the 2026 MCP revision.
10. **Permission gates as extensions, not core**, though keywork may want a thin default gate
    extension shipped-on (Pi's bare-metal default is a taste call keywork can soften).
    **Superseded** by E1 and E2 as built: the gate resolves inside the agent loop
    (`packages/shared/src/trust/permissions.ts`) with the `careful · standard · open` presets,
    since there is no extension host to put it in. SW15 (open, decision 117-2) reorders the
    rules after OpenCode v2.
11. **Skills / prompt templates / themes / packages layering**: four escalating customization
    tiers, npm/git distributable.
    **Landed** for three tiers: skills (D7), prompt templates as markdown commands (D5), and
    themes as flavors (`packages/shared/src/config/flavor.ts`, C17 ledger in `30-tui.md`).
    **Unverified** for packages: no backlog task found, and 117 declines marketplaces and
    registries.
12. **Supply-chain hygiene:** exact pins, `--ignore-scripts`, release-age gating, offline
    binary builds.
    **Landed** for exact pins (M0, `scripts/check-pins.ts`), `ignore-scripts=true` (`.npmrc`)
    and release binaries (`bun run build:binary`, 108). **Unverified** for release-age gating
    and offline model-data builds: neither appears in the tree and no backlog task names them.

### Explicitly do NOT take
- Pi's `/login` subscription-provider flows: **keywork must never implement Anthropic
  subscription-OAuth**. Anthropic access in keywork is API-key / Agent-SDK only.
  **Landed** as a guardrail: `AGENTS.md` rule 1, enforced by `scripts/check-guardrails.ts`.
  Pi 1.0's Anthropic "copy code" login falls under the same rule and is declined in 117.
- The complete absence of any safety rail by default is worth softening (see item 10).
  **Landed:** E1 and E2 (92) plus the E6 workspace trust store
  (`packages/shared/src/trust/store.ts`, adapted from Pi's trust-manager per `NOTICE`).

## 7. Since 2026-08-09

Dated facts from Pi's releases and Earendil's posts. keywork's verdict on each lives in
[`117-influence-sweep.md`](../backlog/117-influence-sweep.md).

- **April 2026:** Earendil acquires Pi
  ([post](https://mariozechner.at/posts/2026-04-08-ive-sold-out/)). The canonical repo is
  `earendil-works/pi`, MIT. mariozechner.at has no posts after 2026-05-30.
- **v0.84.2 (2026-08-14):** fullscreen transcript search (`Ctrl+Shift+F`), a `defaultTools`
  setting, experimental strict JSON-schema constrained sampling for core tools.
- **v0.84.3 (2026-08-24):** optional native `powershell` tool on Windows; `/thinking` with
  session-scoped model and thinking picks (`Ctrl+S` saves); a `session_compact_failed` event;
  `branch_summary.fromId` now records the source leaf; compaction and summary requests no
  longer expose tools.
- **v0.84.4 (2026-08-28):** compaction can run between a tool batch and the next assistant
  response in the same run (#6879); JSONL repair for session files missing a trailing newline
  (#8345, keywork's SW1); `ui_prompt_start/end` events, RPC `clear_queue`, terminal-capability
  overrides.
- **v0.85.0 (2026-09-04):** per-turn Anthropic thinking effort persists;
  `SessionManager.inMemory()` restores externally stored entries.
- **v0.86.0 (2026-09-19):** cache warming (`cacheWarming: off|streaming|idle`, fires only when
  the model declares a cache lifetime and the avoided cost is at least $0.05); `/bug` with
  redacted diagnostics; transcript-aware prompt and tool deltas (the first system message
  records the prompt and tool set and later changes are appended, so the cache prefix
  survives); per-model compaction budgets; `user_bash` fails closed.
- **v0.87.0 (2026-09-21):** `ContextEditEntry` (`type: "context_edit"`, `targetId`,
  `replacement: null | content`), an append-only, branch-relative edit of model context that
  leaves raw history untouched; `context_with_system`; `finishTurn` replaces
  `shouldStopAfterTurn`.
- **v0.99.0 (2026-09-29), the direction shift:** MCP as a built-in extension (stdio and
  streamable HTTP with OAuth, `mcp.json`, `/mcp`, `pi mcp add|login`); Codemode, where
  model-written JavaScript runs in QuickJS (`quickjs-wasi`, MIT) and calls tools through
  `tools.x()`; `tool_search`; per-tool `exposure` of `direct | model-only | codemode | deferred
  | hidden`; `ctx.executeTool()` for nested calls; virtual models and a classifier model type;
  `system` theme by default; "Sign in with ChatGPT".
- **v0.99.2 (2026-09-30):** MCP servers no longer block the first prompt; Anthropic workload
  identity federation read from SDK env vars.
- **v1.0.0 (2026-10-01):** fullscreen by default; Codemode prompts about 40% smaller (5.3k to
  3.3k tokens); an Anthropic "copy code" login, which keywork never adopts under the API-key
  guardrail; MCP OAuth hardened to RFC 9207. Earendil's reason for MCP, per The Register:
  "what Pi needs is quite similar to what MCP needs: a sandbox."
- **Pi Durable (2026-10-01),** npm `@earendil-works/pi-durable` 1.0.0, MIT: a separate harness
  layer where every model call and tool call is a checkpointed task. Tools declare
  `replay: "safe"`, `submit()` is idempotent via `requestId`, clients join on a committed-state
  view followed by deltas, any client can steer, and typed documents commit atomically with
  the transcript.

Docs at v1.0.0 worth reading: `mcp.md` (§Control tool exposure), `codemode.md`,
`compaction.md` (§When It Triggers), `session-format.md` (`ContextEditEntry`),
`extensions.md`, all under `packages/coding-agent/docs/`.

What keywork takes, per 117: SW1 newline repair and SW3 stable prefix as tasks; as scope-first
items, `ContextEditEntry`, Codemode as the Q-DSH5 answer, Pi Durable as input to P2.3, a gate
`terminate` outcome, `/bug`, cache warming and mid-run compaction. Declined: every Anthropic
login path, virtual models, fullscreen by default, and Radius share. Pi's new "Sign in with
ChatGPT" flow is a watch item: keywork already carries a ChatGPT sign-in adapted from Pi's
older Codex module (`NOTICE`, `cli/src/codex-login.ts`), and Pi renaming that provider to
"legacy" means the adapted code may drift from upstream.

---

## Sources

- Repo & README: <https://github.com/earendil-works/pi> (MIT)
- Homepage/docs: <https://pi.dev/>; docs live at
  `packages/coding-agent/docs/` in the repo (`extensions.md`, `sessions.md`, `keybindings.md`,
  `rpc.md`, `tui.md`, `session-format.md`, `containerization.md`, …):
  <https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs>
- Armin Ronacher, *Pi* (Jan 31, 2026): <https://lucumr.pocoo.org/2026/1/31/pi/>
- Mario Zechner, *What if you don't need MCP?*:
  <https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/>
- npm: <https://www.npmjs.com/package/@mariozechner/pi-coding-agent> (legacy scope; current
  scope `@earendil-works/pi-coding-agent`)
- Third-party writeups consulted:
  <https://andrew.ooo/posts/pi-coding-agent-minimal-terminal-harness-review/>,
  <https://www.explainx.ai/blog/pi-minimal-agent-harness-mario-zechner-guide-2026>
- Added 2026-10-02 (§7):
  - Mario Zechner, *I've sold out* (2026-04-08):
    <https://mariozechner.at/posts/2026-04-08-ive-sold-out/>
  - Releases: <https://github.com/earendil-works/pi/releases/tag/v0.84.2>,
    <https://github.com/earendil-works/pi/releases/tag/v0.84.3>,
    <https://github.com/earendil-works/pi/releases/tag/v0.84.4>,
    <https://github.com/earendil-works/pi/releases/tag/v0.86.0>,
    <https://github.com/earendil-works/pi/releases/tag/v0.87.0>,
    <https://github.com/earendil-works/pi/releases/tag/v0.99.0>,
    <https://github.com/earendil-works/pi/releases/tag/v1.0.0>
  - Earendil, *Pi 1.0*: <https://earendil.com/posts/pi-1-0/>
  - Earendil, *Pi Durable*: <https://earendil.com/posts/pi-durable/>
  - The Register (2026-10-02):
    <https://www.theregister.com/ai-and-ml/2026/10/02/pi-coding-agent-pulls-a-180-and-adds-mcp-support/5300678>
  - v1.0.0 docs (`mcp.md`, `codemode.md`, `compaction.md`, `session-format.md`,
    `extensions.md`): <https://github.com/earendil-works/pi/tree/v1.0.0/packages/coding-agent/docs>
