# Cross-Tool Comparison: Pi vs OpenCode vs Crush

> Synthesis document for **keywork** (Bun + TypeScript + Vitest + OpenTUI). It compares the
> three primary influences head-to-head, extracts the shared table-stakes baseline, rates each
> tool's unique features for adoption, and frames the disagreements keywork must resolve during
> vision-shaping.
>
> **Licensing ground rules (apply to every recommendation below):**
> - **Pi** ([earendil-works/pi](https://github.com/earendil-works/pi)) — **MIT**: code may be lifted with attribution.
> - **OpenCode** ([sst/opencode](https://github.com/sst/opencode)) — **MIT**: code may be lifted with attribution.
> - **Crush** ([charmbracelet/crush](https://github.com/charmbracelet/crush)) — **FSL-1.1-MIT**: **ideas only, never copy its source.** Where Crush and an MIT tool share a mechanic, study/lift the MIT implementation instead.
> - **Anthropic access is API-key / Agent-SDK only.** Never integrate Anthropic subscription-OAuth, and never port OpenCode's or any other tool's Pro/Max login code paths.
>
> Companion deep-dives: [`influencers/pi.md`](influencers/pi.md),
> [`influencers/opencode.md`](influencers/opencode.md),
> [`influencers/crush.md`](influencers/crush.md),
> [`influencers/omarchy-ux.md`](influencers/omarchy-ux.md),
> [`mit-feature-candidates.md`](mit-feature-candidates.md).

---

## 1. Philosophy — three answers to "what is a coding-agent harness?"

| | **Pi** | **OpenCode** | **Crush** |
|---|---|---|---|
| **One-line answer** | A minimal, self-extending substrate: four tools, the shortest prompt, and an extension API — the agent builds the rest | A headless server with an open API; every UI (TUI, desktop, web, IDE) is a thin client | A glamorous terminal product: the TUI *is* the product, backed by IDE-grade context |
| **Core bet** | Minimalism is a measured performance strategy (~3x less context/turn); "the agent maintains its own harness" | Provider-neutral, everything-is-a-client architecture scales to every surface | Design polish + real language-server context close the gap with IDE agents |
| **What's in core** | `read`/`write`/`edit`/`bash` — nothing else | Batteries: agents/modes, permissions, LSP, themes, share links, plugins, subagents | Batteries: LSP manager, MCP (3 transports), skills, permissions, notifications |
| **Extensibility story** | TypeScript extensions with ~30 lifecycle hooks; `/reload` hot reload; agent writes its own extensions | Plugins (JS/TS hooks + Zod tools), markdown agents/commands, OpenAPI SDKs | MCP servers, `SKILL.md` skills (cross-agent discovery), Bash-based `crushrc` config |
| **MCP stance** | Rejected, with published token-math arguments; CLI scripts + Bash instead | Supported (endpoints in the server API) | First-class: stdio / http / sse, OAuth for remote servers |
| **Safety stance** | No built-in permissions; delegate to containers or a `tool_call`-gate extension | Per-tool `allow`/`ask`/`deny` with glob-scoped bash rules, per-agent enforceable | Prompt-by-default → allowlist → `--yolo` graduated trust |
| **Persistence** | JSONL **tree** sessions (`id`/`parentId`, active leaf, fork/clone/labels) | Effect + Drizzle + **SQLite**; parent/child session trees; git-snapshot undo/redo | **SQLite**; multiple sessions per project; live shared workspaces by `--cwd` |
| **Stack** | TypeScript; zero-dependency pi-tui | Bun + TypeScript + **OpenTUI** (they created it), Turbo monorepo | Go + Bubble Tea v2 (Charm ecosystem) |
| **License** | MIT — liftable | MIT — liftable | FSL-1.1-MIT — **ideas only** |

**Prose.** The three tools disagree at the root. **Pi** says a harness is a set of primitives:
ship almost nothing, keep the model's context lean, and let users (and the agent itself) write
TypeScript extensions for everything else — plan mode, permissions, and sub-agents are proudly
listed as "notable absences." **OpenCode** says a harness is an *architecture*: a headless Bun
server publishing an OpenAPI 3.1 spec and SSE event streams, with the TUI merely the first of
many clients — the feature set is broad because every client benefits from server-side
batteries. **Crush** says a harness is an *experience*: Charm's "make the command line
glamorous" culture applied to an agent, where rendering quality, notification modes, clickable
references, and LSP-grade context are the product, and the LLM is a swappable component while
sessions/context are the durable foundation.

keywork's values (taste, simplicity, fiery-clean keyboard interaction, multi-pane workflows,
Omarchy-grade detail) do not map onto any one of the three. The natural synthesis: **Pi's core
and extension model, OpenCode's architecture and stack, Crush's product sensibility** —
reimplemented, never copied, where it comes from Crush.

---

## 2. Shared features — keywork's table-stakes baseline

Features all or most of the three ship. These define the minimum bar; keywork must have an
answer for every row.

| Feature | Pi | OpenCode | Crush | Notes for keywork |
|---|---|---|---|---|
| Multi-provider LLM support | ✅ 15+ via `pi-ai` | ✅ 75+ via Vercel AI SDK + Models.dev | ✅ broad built-in matrix + OpenAI/Anthropic-compatible customs | Lift from MIT sources (Pi's `pi-ai` or OpenCode's `packages/llm`); a few providers done excellently beats twenty done adequately. **Excise all Anthropic-OAuth paths.** |
| Mid-session model switching | ✅ `/model`, `Ctrl+L`, favorite cycling | ✅ models picker (`<leader>m`) | ✅ `Ctrl+L` picker, context preserved | Table stakes; requires a provider-agnostic internal message format from day one. |
| Persistent sessions, resume, multiple per project | ✅ JSONL trees | ✅ SQLite, `/sessions` | ✅ SQLite | All three treat sessions as durable. Only the *shape* differs (see §4). |
| Session/context compaction | ✅ auto + `/compact [prompt]` | ✅ `/compact` | ✅ (context management is the "architectural foundation") | Adopt Pi's promptable compaction + branch summaries. |
| Slash commands | ✅ | ✅ (markdown-defined, overridable) | ✅ (palette-driven) | OpenCode's markdown commands (`$ARGUMENTS`, `` !`cmd` ``, `@file`) are the best format — MIT, lift it. |
| Command palette / discoverability surface | ⚠️ partial (autocomplete, overlays) | ✅ `ctrl+p` palette showing bindings | ✅ `Ctrl+P` palette incl. skills | Palette that doubles as live keybinding documentation (OpenCode) + Omarchy's runnable `Super+K` overlay is keywork's target. |
| Fully rebindable keyboard config | ✅ `keybindings.json`, namespaced actions, hot reload | ✅ `tui.json`, string/array/object, `"none"`, platform defaults | ⚠️ keyboard-first but less documented rebinding | Lift OpenCode's binding-resolution model + Pi's hot reload. |
| Permission/safety gating for tools | ⚠️ via extension only (by design) | ✅ allow/ask/deny + globs | ✅ prompt → allowlist → `--yolo` | Shared *concern*, divergent designs — see §4 Q3. |
| Custom system prompt / project instructions file | ✅ `AGENTS.md`, `SYSTEM.md` | ✅ agents as markdown + frontmatter | ✅ `option global-context-path`, `initialize-as` | Support `AGENTS.md` (also this machine's repo convention). |
| Skills / prompt-template layer | ✅ skills, templates, Pi Packages | ✅ commands + agents as markdown | ✅ open `SKILL.md` standard, cross-agent discovery | Adopt `SKILL.md` interop (idea from Crush; implement independently). |
| Extensibility via user code | ✅ extension API (~30 hooks) | ✅ plugin hooks + custom tools | ✅ MCP + skills | Pi's is the deepest and MIT — lift the event taxonomy. |
| Headless / scriptable mode | ✅ print/JSON, RPC JSONL, SDK | ✅ `opencode run`, `serve`, generated SDKs | ⚠️ logging/debug; TUI-centric | Non-negotiable for keywork (testability with Vitest, CI, pane orchestration). |
| Themes | ✅ themes + packages | ✅ 10 built-ins + JSON format + `system` theme | ✅ Charm design system | One token palette drives every pane (Omarchy rule); lift OpenCode's theme schema. |
| Token/cost visibility | ✅ `/session` stats | ✅ (server/API surface) | ⚠️ logging | Show honestly, exactly when useful (Omarchy corner-polish rule). |
| Cross-platform incl. Windows | ✅ Windows + Termux | ✅ macOS/Windows/Linux | ✅ incl. Android + BSDs, no WSL required | keywork is developed on Windows — parity from day one. |
| Image/attachment input | ✅ `Ctrl+V` paste, terminal image rendering | ✅ `--file`, `@file` context | ⚠️ n/a verified | Nice-to-have at v1. |
| External editor escape hatch | ✅ `Ctrl+G` | ✅ `/editor` → `$EDITOR` | ✅ Ctrl-clickable refs → `$EDITOR` | Bridge to the user's real editor; never pretend to be one. |

**Legend:** ✅ verified present · ⚠️ partial/qualified.

---

## 3. Unique features per tool — adopt or not

Verdicts: **Yes** (v1/foundational) · **Later** (post-core) · **No** (skip). License note per row.

### 3.1 Pi (MIT — lift code with attribution)

| Feature | Verdict | Why | License note |
|---|---|---|---|
| Tree-structured JSONL sessions (`id`/`parentId`, `/tree`, `/fork`, `/clone`, labels, branch summaries) | **Yes** | Crown jewel; maps directly onto multi-pane workflows — panes as leaves of one tree | **Lift** the documented session format |
| Four-tool core + shortest system prompt | **Yes** | Measured performance win (~3x less context/turn); keywork's simplicity value made concrete | **Lift** tool impls + prompt structure from `packages/coding-agent` |
| ExtensionAPI (~30 hooks, registerTool/Command/Shortcut, `tool_call` gating, `context` injection, replayable entries) | **Yes** | Cleanest plugin architecture in any agent; replaces MCP, permission popups, and plan mode with user-space code | **Lift** the event taxonomy wholesale |
| Steer vs. follow-up delivery (`Enter` / `Alt+Enter`, mirrored in RPC as `streamingBehavior`) | **Yes** | Interruption as a predictable keyboard-level primitive — exactly "fiery-clean" | **Lift** |
| `/reload` hot reload of extensions/skills/themes/keybindings | **Yes** | Makes self-extension and live theming real | **Lift** |
| RPC JSONL mode + extension-UI bridge (`extension_ui_request`) | **Yes** | Headless embedding and pane orchestration for free; mind the strict-LF framing lesson | **Lift** `protocol` vocabulary |
| Self-extension as primary workflow (agent writes its own extensions) | **Later** | Signature move, but needs the extension API + hot reload landed first | Pattern, enabled by lifts above |
| pi-tui internals (width-constrained `render()`, output caching, `CURSOR_MARKER` IME cursor, first-class overlays) | **Later** | keywork uses OpenTUI — steal the *contracts* behind "no flicker," not the framework | **Ideas** (framework mismatch, not license) |
| Deliberate MCP absence | **Yes** (as default posture) | See §4 Q1 — adopt the posture, keep a bridge path open | Posture, not code |
| No built-in permission system at all | **No** | Too raw for keywork's taste; ship a thin default gate extension instead | — |
| `/share` via GitHub gist, `/export` HTML | **Later** | Useful, not core | **Lift** when wanted |
| Supply-chain hygiene (exact pins, `--ignore-scripts`, release-age gating, offline binaries) | **Yes** | Cheap to adopt from day one | Practices |
| `/login` subscription-provider flows | **No — never** | Hard ToS guardrail: Anthropic is API-key/Agent-SDK only | **Prohibited** |

### 3.2 OpenCode (MIT — lift code with attribution)

| Feature | Verdict | Why | License note |
|---|---|---|---|
| Leader-key (`ctrl+x` + timeout) + `ctrl+p` palette keyboard model | **Yes** | Sidesteps terminal keybinding conflicts; palette doubles as live docs; matches Omarchy's one-leader grammar | **Lift** binding-resolution config model |
| OpenTUI usage patterns in `packages/tui` | **Yes** | Production-proven components/overlays/scroll on keywork's exact renderer — read before writing a line | **Lift** with attribution |
| Headless server + OpenAPI 3.1 (`/doc`) + SSE events | **Yes** (shape) | Makes multi-window/multi-client cheap later; v1 can run in-process but adopt the shape | **Lift** `packages/server` patterns |
| Git-snapshot `/undo` / `/redo` of file changes | **Yes** | Highest-leverage trust feature per line of code | **Lift** the mechanism |
| Plan/Build primary agents, Tab switch, allow/ask/deny permissions | **Yes** | Whole safety UX in a small config surface; one-key mode switch is a reflex | **Lift**; markdown-frontmatter agent format copyable verbatim |
| Markdown custom commands (`$ARGUMENTS`, `` !`cmd` ``, `@file`) | **Yes** | Cheap, composable, user-loved | **Lift** |
| `system` theme (terminal-background-derived ramp + ANSI reuse) | **Yes** | Omarchy-grade default: native-looking everywhere with zero config | **Lift** + JSON theme schema |
| Vercel AI SDK + Models.dev provider layer | **Yes** | Don't hand-roll provider abstraction | **Lift, excising all Anthropic subscription-OAuth** |
| Subagents as navigable child sessions with dedicated keybinds | **Later** | Fits pane-per-child-session ambitions once core sessions land | **Lift** |
| LSP diagnostics fed to the agent (30+ servers, off by default) | **Later** | See §4 Q5; their honest "CLI linters are often lighter" note is instructive | **Lift** if adopted |
| Share links (`opncd.ai`) + cloud service | **No** | Out of scope for a keyboard-first harness; requires running a service | — |
| Electron desktop app, web UI, Slack/enterprise packages | **No** | Not keywork's surface; the server shape keeps the door open | — |
| Anthropic Pro/Max subscription-OAuth login | **No — never** | Their own docs acknowledge Anthropic prohibits it | **Prohibited** |

### 3.3 Crush (FSL-1.1-MIT — **ideas only, never copy source**)

| Feature | Verdict | Why | License note |
|---|---|---|---|
| LSP-powered agent context (real language servers as agent tools) | **Later** | Highest-leverage Crush idea for a TypeScript-first harness (`typescript-language-server`/`vtsls`); heavy lifecycle cost — after core | **Reimplement** from scratch; or lift OpenCode's MIT LSP layer instead |
| Live shared workspaces (same `--cwd` ⇒ implicit join, live session mirroring) | **Yes** (as target) | Direct hit on keywork's multi-window/pane value; keywork's server/event architecture should be designed so this falls out | **Reimplement** — own protocol (local socket/Bun IPC + storage) |
| Event-bus core, TUI as subscriber | **Yes** | Headless engine emitting typed events with any number of pane subscribers; convergent with OpenCode's SSE design | **Reimplement** (natural OpenTUI territory) |
| `.crushignore`-style AI-context ignore file | **Yes** | Small idea, outsized signal-to-noise; ship `.keyworkignore` with `.gitignore` syntax | **Reimplement** (trivial) |
| Graduated trust ladder (prompt → allowlist → yolo) with visible trust state | **Yes** | Trust escalation as a designed UX flow, not a config footnote | **Reimplement**; combine with Codex CLI's visible-sandbox idea (Apache-2.0) |
| Cross-agent `SKILL.md` discovery (reads `.claude/skills`, `.cursor/skills`, …) | **Yes** | Existing team skill investments work day one; `SKILL.md` is an open standard | **Reimplement** discovery walk; the standard itself is open |
| Desktop notification modes (native / OSC / bell / off) | **Yes** | Users tab away from agent panes; "come back, I need a decision" is a designed moment | **Reimplement** (small) |
| Ctrl-clickable code references → `$EDITOR` | **Yes** | Deep-link out instead of embedding an editor | **Reimplement** (OSC 8 hyperlinks + editor launch) |
| MCP over stdio/http/sse with OAuth | **No** (in core) | Conflicts with the chosen Pi posture (§4 Q1); an extension can bridge later | — |
| Bash-based `crushrc` config | **No** | Clever, but typed TS/JSON config with schema validation fits keywork's simplicity value better | — |
| Very broad provider matrix; Android/BSD targets | **No** (for now) | Scope discipline: few providers/platforms done excellently first | — |

---

## 4. Divergences & tensions — open questions for vision-shaping

Where the three tools genuinely disagree. Each is framed as a decision keywork must make
explicitly, with the evidence on each side.

### Q1 — MCP: support it, reject it, or bridge it?
Pi rejects MCP outright with measured arguments (13k–18k tokens of schemas at startup,
non-composable, breaks hot-reload/branching; a CLI-script alternative needs ~225 tokens).
Crush makes MCP first-class across three transports; OpenCode supports it server-side.
**Decision:** default posture for integrations — CLI scripts + Bash + extensions (Pi), MCP in
core (Crush/OpenCode), or Pi's posture with an optional extension-provided MCP bridge?
The research leans strongly toward Pi's posture + bridge, but this shapes the extension API
and must be settled before it is designed.

### Q2 — Minimal core vs. batteries included?
Pi ships four tools and calls everything else a "notable absence"; OpenCode and Crush ship
agents/modes, permissions, LSP, subagents, notifications in core. Minimalism has measured
context-cost benefits and matches keywork's simplicity value — but Omarchy's omakase lesson
cuts the other way: *zero-config first run must be the best experience*, which argues for a
curated set of shipped-on extensions.
**Decision:** what exactly is in keywork's core, and what ships as default-on extensions?
Candidate line: Pi's four-tool core + extension API in core; permissions gate, Plan/Build
modes, and theming shipped as blessed default-on extensions. Every core addition needs the
justification Pi would demand.

### Q3 — Permissions: none, matrix, or ladder?
Three distinct answers: Pi has *no* built-in permissions (containers or a `tool_call`-gate
extension); OpenCode has a declarative per-tool/per-agent allow/ask/deny matrix with glob
rules; Crush has an experiential prompt→allowlist→`--yolo` ladder. Cline's Plan/Act toggle
(Apache-2.0, see `mit-feature-candidates.md`) is a fourth, simpler model.
**Decision:** keywork's default safety story — and whether it lives in core or in a shipped-on
gate extension (Q2). The Omarchy heuristic suggests: one visible trust indicator, one key to
change it, implemented as an extension so power users can replace it.

### Q4 — Session model: tree, git-snapshot, or shared workspace?
All three persist sessions, but the durable *shape* differs: Pi's JSONL trees version the
*conversation* (fork/branch/labels/summaries); OpenCode's git snapshots version the *files*
(`/undo`/`/redo`) with parent/child trees for subagents; Crush's shared workspaces make the
session a *live multi-client space*. These are complementary, not exclusive — but each adds
storage and protocol complexity.
**Decision:** does keywork adopt all three layers (Pi tree format + git-snapshot undo +
workspace mirroring), and in what order? Research suggests Pi's tree format is the P0
foundation, git-undo is the cheapest trust win, and cwd-shared workspaces are the multi-pane
differentiator — but committing to all three up front constrains the storage design (JSONL vs
SQLite, see Q8).

### Q5 — Code intelligence: LSP in the loop, or CLI tools + repo map?
Crush's headline is LSP-as-agent-tools; OpenCode ships 30+ LSP configs but *disables them by
default* and candidly recommends plain CLI linters/typecheckers; Pi has no LSP at all — bash
plus small scripts. Aider's repo-map (Apache-2.0) is a third path: ranked structural context
without live servers.
**Decision:** for a TypeScript-first harness, is running `vtsls`/`typescript-language-server`
worth the lifecycle complexity at v1, or do CLI tools + a repo map cover 90% at a fraction of
the cost? OpenCode's off-by-default choice is real-world evidence to weigh.

### Q6 — Multi-context work: panes, sessions, or both?
None of the three has persistent split panes: Pi points at tmux, OpenCode models multi-context
as multiple sessions plus overlays in a single chat column, Crush gets closest with live
workspace mirroring across separately launched clients. Multi-pane is keywork's stated
differentiator — and its biggest unproven design area.
**Decision:** what *is* a pane in keywork? (A view onto a session-tree leaf? A child session?
An independent client of one server?) And does keywork own tiling (Omarchy-style
split/rotate/zoom/close verbs) or compose with tmux/zellij? This decision drives the
server/event architecture (Q7) more than any other.

### Q7 — Client/server: in-process, RPC pipe, or HTTP server?
Pi is in-process with an optional RPC-JSONL stdio mode; OpenCode is client/server over HTTP
with OpenAPI + SSE always; Crush is in-process with an internal event bus and implicit
workspace sharing. All three separate engine from UI — the transport is the disagreement.
**Decision:** keywork v1 topology. The convergent shape from all three: headless engine
emitting typed events; then choose whether panes attach in-process (fast, simple), over
stdio-RPC (Pi — scriptable), or HTTP/SSE (OpenCode — multi-client, remote-ready). Q6's answer
largely forces this one.

### Q8 — Persistence: JSONL files or SQLite?
Pi: JSONL trees per session, human-readable, documented format (with a sqlite backend package
in-repo). OpenCode: Effect + Drizzle + SQLite. Crush: SQLite. JSONL is greppable, diffable,
and trivially replayable (Pi's extension state-reconstruction contract depends on it); SQLite
wins for concurrent multi-client access — which Q4/Q6 may demand.
**Decision:** storage engine, chosen *after* Q4/Q6. A Pi-format JSONL log with an optional
index is one candidate synthesis; adopting Pi's format wholesale keeps its tooling liftable.

### Q9 — Config: how many knobs?
Pi: settings + keybindings JSON, extensions for behavior. OpenCode: rich `opencode.json` +
`tui.json` + markdown agents/commands. Crush: executable Bash `crushrc`. Omarchy's rule:
every new config option is a design failure to justify.
**Decision:** keywork's config surface — likely a single typed, schema-validated TS/JSON
config plus markdown for prompts/commands (OpenCode's best format) — and a written policy for
when a new option is allowed to exist.

### Q10 — Distribution & scope: how many surfaces?
OpenCode ships TUI + desktop + web + IDE + GitHub Actions + Slack; Pi and Crush ship a
terminal binary. Omarchy's lesson: superb for the target user beats mediocre for everyone.
**Decision:** commit to terminal-only for v1 (with the server shape from Q7 keeping doors
open), and define what "done excellently" means for that single surface before any other is
considered.

---

## 5. Sources

All claims trace to the companion deep-dives, which cite primary sources inline. Key primaries:

- Pi: <https://github.com/earendil-works/pi> · <https://pi.dev/> · in-repo docs (`extensions.md`, `sessions.md`, `rpc.md`, `tui.md`, `session-format.md`) · Armin Ronacher, *Pi* (Jan 2026): <https://lucumr.pocoo.org/2026/1/31/pi/> · Mario Zechner, *What if you don't need MCP?*: <https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/>
- OpenCode: <https://github.com/sst/opencode> · <https://opencode.ai/docs/> (tui, keybinds, agents, lsp, themes, share, server, cli, providers, commands, plugins) · OpenTUI origin: <https://www.stork.ai/blog/the-tui-library-thats-killing-ink>
- Crush: <https://github.com/charmbracelet/crush> · <https://deepwiki.com/charmbracelet/crush> · reviews cited in `influencers/crush.md`
- Omarchy heuristics: <https://omarchy.org/> · <https://learn.omacom.io/2/the-omarchy-manual> (full citations in `influencers/omarchy-ux.md`)
- Broader ecosystem (Aider, Codex CLI, Gemini CLI, Cline, Zed, et al.): `mit-feature-candidates.md`

*Written 2026-08-09.*
