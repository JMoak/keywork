# Crush (charmbracelet/crush)

> Research dossier for **keywork**. Crush is Charm's agentic coding tool for the terminal — "Your new coding bestie, now available in your favourite terminal." Written in Go on the Bubble Tea stack.

> **LICENSING — READ FIRST**
> Crush is **FSL-1.1-MIT** (Functional Source License with an MIT conversion after a delay). It is *source-available, not open source* for our purposes. **keywork must NEVER copy, port, translate, or closely paraphrase Crush source code.** This document covers **IDEAS ONLY**: any feature we adopt must be reimplemented independently from first principles. (Contrast: Pi and OpenCode are MIT — code from those may be lifted with attribution.)
>
> Also note the project-wide guardrail: **never integrate Anthropic subscription OAuth**. Anthropic access in keywork is API-key / Agent-SDK only.

---

## 1. Philosophy — "glamorous" CLI craft

Charm's slogan is "We make the command line glamorous," and Crush is the flagship application of that culture: an AI coding agent where the terminal UI itself is a first-class product, not an afterthought. Reviewers consistently lead with the polish — "the slick visuals applied to an AI assistant delight users" — before they get to the agent capabilities.

Cultural traits worth internalizing:

- **The TUI is the product.** Crush is built on Bubble Tea and the broader Charm ecosystem ("industrial-grade" components serving 25k+ applications, per the README). Rendering quality, color, spacing, and motion get real design attention.
- **Terminal-native everywhere.** First-class support "in every terminal on macOS, Linux, Windows (PowerShell and WSL), Android, FreeBSD, OpenBSD, and NetBSD." Native Windows without WSL is a deliberate point of pride.
- **The LLM is a swappable component.** As one architecture writeup puts it, Crush treats the model as replaceable while *sessions and context management* are the architectural foundation. Provider churn is assumed; your work context is the durable thing.
- **Developer empathy in small details.** Ignore-file awareness, desktop-notification modes, clickable references into `$EDITOR`, permission prompts before shell execution — user-operation heuristics all the way down.

## 2. Architecture & implementation (conceptual level)

*Sources: GitHub README, DeepWiki architecture overview. Concept-level only — we have not read and must not read-to-copy the source.*

### Bubble Tea TUI stack

- The interactive interface is built with **Bubble Tea v2** — the Elm-architecture Go TUI framework: the UI is a pure function of application state; every keystroke becomes a message flowing through an update function.
- An `app.App` orchestrator owns all services/subsystems; the TUI subscribes to a backend **event bus** (an events channel) that broadcasts changes from backend services, driving reactive UI updates. Clean separation: agent engine emits events, TUI renders them.

### Agent & tool loop

- An agent **coordinator** manages multiple per-session agents running the LLM loop. Tools (shell, file view/edit/write, grep/ls, LSP queries, MCP resources) execute and their results feed back into model context until a final response is produced.
- A **permission system** gates tool execution: prompts by default, granular allow/deny configuration (`permissions allow/deny`), and a `--yolo` flag to skip all prompts.

### LSP integration for agent context

- The headline idea: "Crush uses LSPs for additional context, just like you do." Users register language servers explicitly, e.g. `lsp add go --command "gopls"` or `lsp add typescript --command "typescript-language-server" --args --stdio`.
- Internally an **LSP manager** owns the lifecycle of multiple concurrent language servers; LSP queries are exposed to the agent as tools, giving it real symbol tables, diagnostics, and documentation — IDE-grade structural context instead of grep-only understanding.

### MCP transports

- MCP servers extend the agent via three transports: **stdio**, **http**, and **sse**. Config supports OAuth authorization-code flows and pre-registered clients (e.g. GitHub, Slack MCP servers).

### Sessions & workspaces

- **Session-based** design: multiple concurrent work sessions/contexts per project, with persistent state stored in **SQLite** (CGO-free `modernc.org/sqlite`) behind service abstractions.
- **Workspace sharing:** clients launched with the same working directory (`--cwd`) implicitly join the same workspace, with live mirroring of in-progress sessions across connected clients — a multi-client, multi-pane story built into the core.

### Ignore-file awareness

- Respects `.gitignore` by default and adds **`.crushignore`** (same syntax) for paths that are tracked in git but should be excluded from AI context (large fixtures, generated files). Both are honored by default.

### Agent Skills standard

- Implements the open **Agent Skills** standard (`SKILL.md` packages). Discovery walks a documented path list: `$CRUSH_SKILLS_DIR`, `$XDG_CONFIG_HOME/agents/skills`, `~/.config/crush/skills/`, `~/.agents/skills/`, and project dirs `.agents/skills`, `.crush/skills`, `.claude/skills`, `.cursor/skills` — i.e. it deliberately reads *other agents'* skill directories for portability.
- Skills marked `user-invocable: true` surface in the command palette with `user:`/`project:` prefixes. Built-in skills ship embedded in the binary. Skills can be hidden via `option disable-skill`.

### Configuration

- Configured via **`crushrc`**, a Bash-based config format executed by a native Bash interpreter bundled for cross-platform consistency (older JSON config is deprecated). Commands include `provider add` / `model add`, `lsp add`, `mcp add`, `permissions allow/deny`, and `option …` settings.
- Environment variables override config (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CRUSH_DISABLE_METRICS`, `DO_NOT_TRACK`, …).

## 3. Full feature inventory

| Area | Feature | Notes |
|---|---|---|
| Models | Multi-provider support | Built-in: Anthropic, OpenAI, Gemini, OpenRouter, Groq, Cerebras, Hugging Face, VertexAI, Bedrock, Vercel AI Gateway, Z.ai, MiniMax, Moonshot, Alibaba, and more |
| Models | Custom providers | Any OpenAI- or Anthropic-compatible API; Deepseek, llama.cpp, Ollama, LM Studio, LiteLLM |
| Models | Mid-session model switching | Switch LLMs mid-session **preserving context** (`Ctrl+L` picker) |
| Sessions | Multiple sessions per project | Persistent (SQLite); create/rename/switch work contexts |
| Sessions | Shared workspaces | Same `--cwd` ⇒ implicit join; live mirroring across clients |
| Context | LSP integration | User-registered language servers feed diagnostics/symbols/docs to the agent |
| Context | `.gitignore` + `.crushignore` | Both respected by default |
| Context | `option global-context-path` / `initialize-as` | Custom system-prompt files and project context filename |
| Extensibility | MCP (stdio / http / sse) | Incl. OAuth flows for remote servers |
| Extensibility | Agent Skills (`SKILL.md`) | Open standard, multi-path discovery incl. `.claude/skills`, palette-invocable |
| Safety | Permission prompts | Allow/deny config, per-tool allowlisting, `--yolo` escape hatch |
| Ops | Logging | `./.crush/logs/crush.log`; `crush logs --follow`; `crush --debug` |
| Ops | Desktop notifications | `option notifications`: auto / native / osc / bell / disabled |
| Ops | Attribution trailers | Configurable commit-attribution style |
| Ops | Telemetry opt-out | `CRUSH_DISABLE_METRICS`, honors `DO_NOT_TRACK` |
| Platform | Cross-platform | macOS, Linux, Windows (PowerShell + WSL, no WSL required), Android, *BSDs |

## 4. Keyboard & UX model

- **Command palette** (`Ctrl+P`): central launcher for commands and user-invocable skills — the "one keybinding to reach everything" pattern.
- **Model picker** (`Ctrl+L`): mid-session provider/model switching with full context continuity; also drivable as a slash-style command (`/model …` per third-party writeups).
- **Keyboard-first throughout**: reviewers emphasize it "keeps your hands on the keyboard"; mouse is optional garnish.
- **Clickable line references**: code references in agent explanations are Ctrl-clickable to open the location in `$EDITOR` — the TUI bridges into your real editor rather than pretending to be one.
- **Trust-building permission UX**: asks before running shell commands by default; users graduate to allowlists, and only then to `--yolo`. Escalation of trust is a UX flow, not a config footnote.
- **Notification modes** (native / OSC escape / bell) acknowledge that people run agents in background panes and tab away — the harness pings you when it needs you.
- **Polish as default**: Charm's design system (colors, spinners, layout) makes long agent runs pleasant to watch; a `dev.to` piece literally asks "does developer delight matter in a CLI?" using Crush as the case study.

## 5. Unique features

1. **LSP-powered agent context (the headline).** Almost every terminal agent greps; Crush additionally runs real language servers and hands the agent diagnostics, symbols, and docs. This closes much of the gap with IDE-embedded agents while staying terminal-native.
2. **Live shared workspaces.** Multiple clients on the same `--cwd` implicitly join one workspace and mirror in-progress sessions — multi-window/multi-pane agent operation as a core primitive, not a hack.
3. **Cross-agent skill discovery.** Reading `.claude/skills` and `.cursor/skills` alongside its own directories means a team's existing skill investment works on day one.
4. **`.crushignore` as an AI-context ignore layer.** A dedicated, git-syntax file for "in the repo, but not for the model" — a small idea with outsized signal-to-noise payoff.
5. **Bash-based config (`crushrc`)** with a bundled interpreter for cross-platform determinism — config as an executable, composable script rather than inert JSON.
6. **Terminal reach.** Android and the BSDs are supported targets; "every terminal" is treated literally.

## 6. What keywork should reinterpret — IDEAS ONLY

> **Reminder: FSL-1.1-MIT. No code may be copied from Crush — not a function, not a prompt, not a config schema verbatim. Everything below is a concept to be designed and implemented independently in TypeScript/Bun.** Where similar mechanics exist in MIT projects (OpenCode, Pi), prefer studying/lifting from those instead.

1. **LSP as an agent tool.** Run `typescript-language-server`/`vtsls` (and per-project servers) alongside the agent; expose diagnostics, hover, references, and rename as tools. For a TypeScript-first harness this is the single highest-leverage idea. Design our own manager/lifecycle model.
2. **Event-bus core, TUI as subscriber.** Elm-style state → view is native territory for OpenTUI. Keep the agent engine headless, emit typed events, let any number of panes/windows subscribe — which also unlocks:
3. **Shared workspaces by cwd.** Two keywork panes opened in the same project should see the same live session. This fits our multi-window/pane value directly; design our own protocol (e.g. a local socket + SQLite, or Bun IPC).
4. **Command palette + model picker as the two anchor keybindings.** One chord to all commands/skills, one chord to model switching with preserved context. Mid-session switching implies a provider-agnostic internal message format from day one.
5. **`.keyworkignore`.** Honor `.gitignore` plus a dedicated AI-context ignore file with identical syntax.
6. **Graduated trust for tool execution.** Prompt → per-tool allowlist → yolo, designed as a smooth UX ladder with a visible current-trust indicator.
7. **Agent Skills interop.** Adopt the open `SKILL.md` standard and discover skills from `.agents/skills` *and* `.claude/skills` etc., so existing ecosystems work immediately. Mark palette-invocable skills.
8. **Notification modes.** Native / OSC 9 / bell / off — assume the user is in another pane; make "come back, I need a decision" a designed moment.
9. **Ctrl-clickable code references → `$EDITOR`.** Deep-link out of the TUI instead of embedding an editor.
10. **What to skip:** the Bash-config idea is clever but a poor fit for a TypeScript harness (a typed TS/JSON config with schema validation serves keywork's simplicity value better); and Crush's very broad provider matrix is scope we don't need at first — a few providers done excellently beats twenty done adequately. Also, per project guardrails: no Anthropic subscription-OAuth of any kind — API key / Agent SDK only.

---

## Sources

- Crush README — https://github.com/charmbracelet/crush (features, LSP/MCP/skills/config/keybindings, license)
- DeepWiki architecture overview — https://deepwiki.com/charmbracelet/crush (app orchestrator, event bus, agent coordinator, SQLite persistence, LSP manager)
- Bright Coding review — https://www.blog.brightcoding.dev/2025/08/06/crush-the-glamorous-ai-coding-agent-that-lives-in-your-terminal (UX details, clickable references, logging, `.crushignore` rationale)
- Starlog article (listed, not fetched) — https://starlog.is/articles/ai-agents/charmbracelet-crush/ (session/context-graph framing via search summary)
- Codexpedite review — https://codexpedite.com/crush-by-charmbracelet-an-honest-deep-dive-into-the-multi-model-ai-coding-agent/ (pros/cons; note: some claims there, e.g. "Node.js package," contradict the primary sources and were excluded)
- Developer-delight discussion — https://dev.to/fernandezbaptiste/does-developer-delight-matter-in-a-cli-the-case-of-charms-crush-248g

*Researched 2026-08-09. Feature claims reflect the README and docs as of that date.*
