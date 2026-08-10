# Workstream D — Extensions, Commands & MCP

> `packages/extensions` + engine host. Pi's extension API lifted wholesale (the cleanest
> plugin design in the field), OpenCode's markdown command format verbatim, MCP in core but
> **lazy** (D1 decision — deferred schemas answer Pi's token critique).

---

### D1 (3pt) — Extension host
Load TS/JS extensions from `~/.keywork/extensions/` + project `.keywork/extensions/`;
lifecycle (activate/deactivate), error containment (a throwing extension is disabled with a
visible toast, never crashes keywork), per-extension logger.
**Accept:** broken fixture extension is quarantined with readable error; healthy ones
unaffected; load order deterministic.
**Strategy:** `LIFT:pi` host architecture.

### D2 (3pt) — Hook taxonomy & registration API
The ExtensionAPI surface: Pi's ~30 lifecycle events (session lifecycle, turn/message events,
`tool_call` gating with modify/deny, context injection, input interception, UI hooks) plus
`registerTool` / `registerCommand` / `registerShortcut` / `registerFlag`. Typed end-to-end —
extension authors get full inference.
**Accept:** fixture extensions exercise every hook category in tests; a `tool_call` gate
denies and modifies calls; registered tool reaches the model's tool list.
**Strategy:** `LIFT:pi` event taxonomy wholesale (attribute in NOTICE).

### D3 (2pt) — Replayable extension state
Extensions append typed custom entries to the session (B1 format); on resume, B3 replay
redelivers them so extension state reconstructs without side effects (the Pi contract).
**Accept:** counter-extension fixture survives exit/resume with exact state; replay flag
prevents double side effects.
**Strategy:** `LIFT:pi`.

### D4 (2pt) — `/reload` hot reload
Reload extensions/skills/themes/keybindings in-place: teardown, re-import (cache-busted),
re-register, replay state (D3); sub-second; toast confirms. This is what makes
agent-writes-its-own-extension a live loop instead of a restart cycle.
**Accept:** E2E — edit fixture extension, `/reload`, new behavior active with state intact,
under 1s.
**Strategy:** `LIFT:pi`.

### D5 (2pt) — Markdown commands
`.keywork/commands/*.md` (+ user-level): frontmatter (description, agent, model) + body as
prompt template with `$ARGUMENTS`, `` !`cmd` `` shell interpolation, `@file` embedding;
commands appear in palette and `/name` completion.
**Accept:** all three interpolations tested (shell one sandboxed through the gate later);
palette lists with descriptions.
**Strategy:** `LIFT:opencode` format verbatim.

### D6 (1pt) — Agents as markdown
`.keywork/agents/*.md`: frontmatter (model, tools allowlist, permission overrides) + system
prompt body; selectable per session/pane.
**Accept:** fixture agent restricts tool list and swaps prompt in a mock conversation.
**Strategy:** `LIFT:opencode` format verbatim.

### D7 (2pt) — `SKILL.md` support & discovery
Load skills from `.keywork/skills/` **and** discover existing `.claude/skills/`,
`.cursor/skills/` etc. (cross-agent walk) so team skill investments work day one; skills
surface in palette and are model-invokable.
**Accept:** fixture repo with a `.claude/skills/` skill: discovered, listed, invokable.
**Strategy:** `OWN` (the `SKILL.md` format and cross-agent directory names are public
convention).

### D8 (2pt) — MCP client: stdio transport
Spawn/manage stdio MCP servers from config; handshake, tool listing, invocation, restart on
crash (with backoff + toast).
**Accept:** round-trip against a reference MCP server fixture in tests.
**Strategy:** `LIFT:opencode` MCP integration patterns; official TS SDK.

### D9 (2pt) — MCP client: http/sse transports
Remote servers over streamable HTTP/SSE incl. auth headers from config.
**Accept:** fixture HTTP server round-trip; reconnect on drop.
**Strategy:** `LIFT:opencode`; official TS SDK.

### D10 (2pt) — Lazy MCP schemas
The D1-decision mitigation: connected servers contribute **names + one-liners only** to the
model's context; a built-in `tool_search`-style tool fetches full schemas on demand, after
which the tool is directly callable. Idle servers ≈ 0 tokens.
**Accept:** token-count test — 3 connected fixture servers add < 200 tokens to the system
context until a schema is requested; post-fetch invocation works.
**Strategy:** `OWN` design (this harness's own deferred-tool pattern as prior art).

### D11 (1pt) — `.keyworkignore`
Gitignore-syntax exclusion file respected by read/edit tools' discovery surfaces, repo map
(F2), and diff pane; combines with `.gitignore`.
**Accept:** ignored fixture paths invisible to tool globbing and repo map.
**Strategy:** `OWN` (trivial); standard ignore-parser dep.

### D14 (2pt) — MCP status dock pane
(2026-08-10, Jordan.) When any MCP server is configured, startup docks a node on the right
(C27/C28 dock) showing a tight per-server status line: name, connection state, tool count.
Focusing it opens a simple interaction menu per server — enable/disable, restart, list
tools — in the spirit of OpenCode's MCP menu, re-presented as a dock-native pane. Connection
progress gets keywork's own loading indicator: tight like OpenCode's, but an original,
more imaginative design (spec it before building; no spinner-by-default).
**Accept:** fixture config with two servers (one healthy, one failing) docks the pane on
start with correct states; menu restart recovers the failing server; zero MCP config ⇒ no
pane, zero cost.
**Strategy:** `LIFT:opencode` MCP plumbing/status semantics (D8–D10); `OWN` dock
presentation and loading indicator.
