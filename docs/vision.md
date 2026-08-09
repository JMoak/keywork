# keywork — Vision Decisions

> Decision record from vision-shaping (2026-08-09). Resolves the ten open questions in
> [`comparison.md`](comparison.md) §4. Each decision is binding until explicitly revisited.
>
> **Standing guardrails (restated everywhere on purpose):** Pi and OpenCode are MIT — lift with
> attribution. Crush is FSL-1.1-MIT — ideas only, never copy source. Anthropic access is
> **API-key / Agent-SDK only**; no subscription-OAuth, ever, and no Anthropic provider wiring at
> all until the dedicated API-key milestone.

## The one-liner

**keywork** is a keyboard-first coding-agent harness with native multi-pane tiling: Pi's
minimal core and extension model, OpenCode's architecture and stack, Crush's product
sensibility (reimplemented), and Omarchy's attention to operational detail — Bun + TypeScript +
Vitest + OpenTUI.

## Decisions

### D1 — MCP: in core, lazily
MCP is a first-class integration path in core (user call, overriding the research lean).
Mitigation for Pi's token-cost critique is mandatory: **deferred tool schemas** — MCP server
tools register as names only; full schemas load on demand (ToolSearch-style), so idle servers
cost ~0 context. CLI-scripts-plus-Bash remains an equally blessed path.

### D2 — Core vs. batteries: minimal core, blessed extensions
Core = four tools (`read`/`write`/`edit`/`bash`), shortest-viable system prompt, session
engine, event bus, extension API, MCP host, keyboard/TUI shell. Everything else — permissions
gate, Plan/Build modes, theming, notifications, code-intel — ships as **default-on blessed
extensions** the user can disable or replace. Zero-config first run must be the best
experience (Omarchy omakase); every core addition requires a written justification.

### D3 — Permissions: gate extension with a visible trust ladder
Shipped-on gate extension implementing OpenCode's allow/ask/deny config model (MIT lift,
glob-scoped bash rules, per-agent) presented through Crush's *idea* of a graduated trust
ladder: one always-visible trust indicator in the status line, one key to change level.
Replaceable by power users because it's just an extension (D2).

### D4 — Sessions: all three layers, in order
1. **P0** — Pi's JSONL tree format (`id`/`parentId`, active leaf, fork/clone/labels, branch
   summaries, promptable compaction). Lifted format = Pi tooling stays compatible.
2. **P1** — git-snapshot `/undo` `/redo` of file changes (OpenCode mechanism, MIT lift).
3. **P2** — live shared workspaces: same `--cwd` ⇒ implicit join (Crush idea, own protocol).

### D5 — Code intelligence: all three rungs, phased ("MIT mode online")
Committed to the full stack, landed in cost order so nothing blocks the core loop:
1. **v1** — CLI tools via bash (tsc, linters) — free, ships with the four-tool core.
2. **v1.x** — Aider-style ranked repo map (Apache-2.0, adaptable) as a blessed extension.
3. **capstone** — LSP-as-agent-tools (`vtsls`/`typescript-language-server` first): diagnostics
   and symbols exposed to the model. Crush's idea; implementation is our own or adapted from
   OpenCode's MIT LSP layer — never Crush source.

### D6 — Panes: keywork owns tiling; panes are bus clients
The differentiator. Every pane (conversation, diff/files, terminal, session tree, …) is a
subscriber view onto the typed event bus. **v1:** keywork's OpenTUI app is the tiler —
Omarchy-style verbs (split/rotate/zoom/close/focus), self-contained, no multiplexer required,
Windows-first parity. **P2:** the same pane components mount from external processes over the
workspace server (`keywork attach --pane diff`), making tmux/zellij composition a bonus
surface, not a dependency. One pane abstraction, two mounting surfaces.

### D7 — Topology: in-process bus, server-shaped
Headless engine as a library emitting **typed events on an internal bus** (Crush's shape,
reimplemented; convergent with OpenCode's SSE design). TUI subscribes in-process for v1. The
event vocabulary is designed OpenAPI/SSE-shaped from day one so the P2 server wrap
(HTTP + SSE, spec at `/doc`) is mechanical, not a rewrite. Print/JSON headless mode rides the
same bus (testability, CI, scripting).

### D8 — Persistence: Pi's JSONL tree format
Human-readable, greppable, diffable, replayable (extension state-reconstruction depends on
replay). Documented format lifted from Pi. An index (or Pi's in-repo sqlite backend package)
may be added when P2 multi-client concurrency demands it — not before.

### D9 — Config: one typed surface + markdown
Single schema-validated JSON config (settings + keybindings), TypeScript types published;
markdown with frontmatter for prompts/agents/commands (OpenCode's `$ARGUMENTS` / `` !`cmd` `` /
`@file` format, MIT lift). Written policy: **every new config option is a design failure until
justified** (Omarchy rule) — the justification lives in the option's schema description.

### D10 — Scope: terminal-only v1
One surface, done excellently, including first-class Windows. The D7 server shape keeps
desktop/web/IDE doors open; none are considered until the terminal experience is the best in
the field.

## Identity anchors (from the UX research)

- Fiery-clean keyboard: leader key + palette-as-live-docs; steer (`Enter`) vs. queue
  (`Alt+Enter`) interruption primitive; single-keystroke reach for the vital few.
- Omarchy detail: zero-config beauty, `system` theme by default, visible trust state, honest
  token/cost display, discoverability overlay.
- Simplicity budget: the refusals list in [`ux-principles.md`](ux-principles.md) §4 is policy.

*Next: [`tasks.md`](tasks.md) — the parallelized implementation breakdown.*
