# Workstream D: Extensions, Commands & MCP

> `packages/extensions` + engine host. Pi's extension API lifted wholesale (the cleanest
> plugin design in the field), OpenCode's markdown command format verbatim, MCP in core but
> **lazy** (D1 decision; deferred schemas answer Pi's token critique).

---

### D1 (3pt): Extension host
Load TS/JS extensions from `~/.keywork/extensions/` + project `.keywork/extensions/`;
lifecycle (activate/deactivate), error containment (a throwing extension is disabled with a
visible toast, never crashes keywork), per-extension logger.
**Accept:** broken fixture extension is quarantined with readable error; healthy ones
unaffected; load order deterministic.
**Strategy:** `LIFT:pi` host architecture.

**Landed 2026-10-07 (`engine/src/extensions/host.ts`, `discover.ts`).** `ExtensionHost`
activates `ExtensionDefinition`s (a name, a source, an optional file and a default-export
factory that receives the `ExtensionApi` and may return a teardown). Discovery walks
`.keywork/extensions/` under the project root and then the user root, alphabetically within a
layer; a file (`.ts`, `.js`, `.mts`, `.mjs`) or a directory with an `index.*` is one extension
named after its stem, and a project extension shadows a user one with the same name. **Trust
decision:** the project layer follows the MCP-server posture in `shared/src/config/load.ts`:
it is refused outright until the workspace is trusted (`projectTrusted: true`), and the
discovery report lists the refused directory with `untrustedProjectReason` so the UI can say
why. Containment is per phase: a throw or rejection in activation, in any hook handler, in a
command or in teardown quarantines that one extension (its tools, commands, shortcuts, flags
and handlers are withdrawn, later `api` calls go inert), the bus carries an
`extension.notice` at level `error` with a one-line readable reason, and every other extension
keeps running. A handler that outlives `hookTimeoutMs` (default 10s) is quarantined the same
way. A module that fails to import (syntax error, no default function) is listed as
quarantined in phase `load`. Each extension gets `api.log.info|warn|error`, which rides the
same `extension.notice` event. `packages/extensions` is the authoring surface
(`defineExtension`, the API types); the host lives in the engine because the `Agent` seam and
the session store do. Not wired yet: the CLI does not call `loadExtensions` or
`host.startSession` (a follow-up in `packages/cli`), and `/reload` is D4.

### D2 (3pt): Hook taxonomy & registration API
The ExtensionAPI surface: Pi's ~30 lifecycle events (session lifecycle, turn/message events,
`tool_call` gating with modify/deny, context injection, input interception, UI hooks) plus
`registerTool` / `registerCommand` / `registerShortcut` / `registerFlag`. Typed end-to-end, so
extension authors get full inference.
**Accept:** fixture extensions exercise every hook category in tests; a `tool_call` gate
denies and modifies calls; registered tool reaches the model's tool list.
**Strategy:** `LIFT:pi` event taxonomy wholesale (attribute in NOTICE).

**Landed 2026-10-07 (`engine/src/extensions/hooks.ts`, `engine/src/agent-hooks.ts`).** Thirty
hooks are typed end to end in `Hooks` (payload and result per name; `api.on` infers both).
Nine are **wired** and dispatched by the host: `session_start` / `session_end`
(`host.startSession` / `endSession`), `turn_start`, `turn_end` (from `turn.started`,
`turn.completed`, `turn.interrupted`, replays skipped), `message_appended` (every message that
enters the agent's history, through the seam), `tool_call` (gate before the trust gate:
`allow`, `deny` with a reason, or `modify` the arguments; extensions run in load order, the
first deny wins and names the extension in the refused tool result, modifications chain),
`tool_result` (observation, with the call paired by id), `context` (a system-prompt fragment
appended on every provider request) and `custom_entry` (D3). Twenty-one are **typed only**
and never fire yet: `session_before_fork`, `session_before_compact`, `session_compact`,
`session_tree`, `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`,
`message_start`, `message_update`, `message_end`, `input`, `tool_execution_start`,
`tool_execution_update`, `tool_execution_end`, `before_provider_request`,
`after_provider_response`, `model_select`, `user_bash`, `project_trust`,
`resources_discover`; `wiredHooks` / `typedOnlyHooks` are the lists, and a type-level check
keeps every hook in exactly one. Registration: `registerTool` (reaches the model's tool list
through `AgentOptions.hooks`; a name clash with another extension or a reserved core name
quarantines the registrant), `registerCommand` (`host.commands()` / `host.runCommand`),
`registerShortcut` and `registerFlag` (collected and exposed, consumed by nothing yet). The
engine seam is `AgentHooks` (`tools`, `systemPrompt`, `toolCall`, `messageAppended`); the
host serializes every dispatch through one queue so delivery order matches bus order, and
`host.settle()` drains it.

### D3 (2pt): Replayable extension state
Extensions append typed custom entries to the session (B1 format); on resume, B3 replay
redelivers them so extension state reconstructs without side effects (the Pi contract).
**Accept:** counter-extension fixture survives exit/resume with exact state; replay flag
prevents double side effects.
**Strategy:** `LIFT:pi`.

**Landed 2026-10-07 (`engine/src/extensions/extension-entries.ts`).** `api.appendEntry(type,
data)` writes one `custom` session entry with `customType: "extension"` and
`{ extension, type, data }`, then delivers `custom_entry` with `replay: false` to the owning
extension; `host.startSession({ reason: "resume", store })` walks the active path and
redelivers each of that extension's entries with `replay: true` before `session_start`
fires, so state rebuilds through the same handler and side effects key off the flag. Entries
on other branches and entries owned by other extensions are never delivered. With no session
open the entry is dropped with a `warn` notice. The counter fixture
(`engine/src/testing/extension-fixtures/counter.ts`) and the host tests cover exact state
across exit and resume.

**Product wiring, not landed (2026-10-07 wrap-up).** A lane was opened to make the host a
product feature and was stopped during its read phase at the user's request; no code
changed. What the read established, so the next pass starts from it:

- **Composition shape.** `composeWorkspace` (`cli/src/compose.ts`) owns one `ExtensionHost`
  per workspace beside the existing `extensions: WorkspaceExtensions` (markdown commands,
  bots, skills; that name is already taken, so the host joins as `host` plus a
  `hostReport: ExtensionLoadReport`). Roots: `userRoot ?? homedir()` and `cwd` with
  `projectTrusted` passed through, which is the trust posture `loadExtensions` already
  encodes. `reservedToolNames` comes from `coreTools(scope).map((tool) => tool.name)`.
  `buildAgent` passes `hooks: composition.host.agentHooks()` into `new Agent(...)`; the
  bot `restrictTools` wrap only covers the base list, so extension tools would reach a bot
  unrestricted unless that wrap moves into the hooks seam too.
- **Host API gap found.** `ExtensionHost` observes `turn.*` and `tool.*` on the one bus it
  is constructed with, but every agent carries its own bus (`Agent` makes one when
  `spec.bus` is absent; the pane composition hands each session pane its own through
  `seams.bus`). A workspace-wide host therefore never hears a turn. The additive fix is a
  public `host.observe(bus): () => void` (the current private `observeBus` refactored to
  take a bus, idempotent per bus via a `WeakSet`, unsubscribed on `dispose`), called from
  `buildAgent` on `agent.bus` after construction. Notices keep riding the constructor bus,
  which the TUI subscribes to for toasts.
- **Session lifecycle.** The host keeps a single `store` for `appendEntry` and replay, a
  one-session-per-process assumption lifted from Pi. The pane composition attaches many
  sessions at once (`sessionPort` `onAttach(store)` / `onRelease(sessionId)`), so the
  planned wiring was: `startSession({ reason: store.messages().length > 0 ? "resume" :
  "start", store })` on attach, `endSession("switch")` on release only when the released
  store is the one the host holds, `endSession("exit")` plus `dispose()` from a closer.
  `chat` and `run` call `startSession` once after `openOrResumeSession` / `openSessionStore`
  and `endSession("exit")` in `close()` / `tearDown`; `serve` per `LiveSession`. Whether
  entries should land in "the most recently attached session" or the host should become
  per-session is a decision for Jordan before this wiring lands.
- **Notices.** `core.postNotice(text)` is the status-bar transient (cleared on the next
  key); `sessions.postNotice(text)` is a quiet line in the focused pane's feed. Planned
  split per PD25 and `docs/events.md`: `error` and `warn` to the status bar, `info` to the
  focused pane's feed and dropped with no pane. Headless `run` prints `warn` and above to
  stderr as `keywork run: <extension>: <message>`. Load-time quarantines already arrive as
  `error` notices, so a startup subscription before `loadExtensions` surfaces them.
- **Commands.** `host.commands()` registers into `core.registry` next to
  `registerExtensions` in `app.ts` (collisions reported through `shadowedExtensionNotice`),
  and into `chat.ts`'s slash table after the markdown commands. `/extensions` lists name,
  standing, phase and reason when quarantined, and tool and command counts (the
  `ExtensionStatus` carries no counts; the listing computes them from `host.tools()` and
  `host.commands()` grouped by owner, which needs the tool owner exposed or a
  `host.registrations(name)` accessor). `keywork extensions` is the CLI twin, registered in
  `dispatch.ts` `commandNames` and `main.ts`, with `withoutTerminal: runs`.
- **e2e.** The harness composes through `composePanes` with `projectTrusted: true` and
  writes `scenario.files` into the workspace, so a `.keywork/extensions/hello.ts` fixture
  loads through the project layer; its mock `agentFactory` bypasses `agents.build`, so an
  e2e scenario can show `/extensions` but not a hook firing.

### D4 (2pt): `/reload` hot reload
Reload extensions/skills/themes/keybindings in-place: teardown, re-import (cache-busted),
re-register, replay state (D3); sub-second; toast confirms. This is what makes
agent-writes-its-own-extension a live loop instead of a restart cycle.
**Accept:** E2E: edit fixture extension, `/reload`, new behavior active with state intact,
under 1s.
**Strategy:** `LIFT:pi`.

### D5 (2pt): Markdown commands
`.keywork/commands/*.md` (+ user-level): frontmatter (description, agent, model) + body as
prompt template with `$ARGUMENTS`, `` !`cmd` `` shell interpolation, `@file` embedding;
commands appear in palette and `/name` completion.
**Accept:** all three interpolations tested (shell one sandboxed through the gate later);
palette lists with descriptions.
**Strategy:** `LIFT:opencode` format verbatim.

### D6 (1pt): Agents as markdown
`.keywork/agents/*.md`: frontmatter (model, tools allowlist, permission overrides) + system
prompt body; selectable per session/pane.
**Accept:** fixture agent restricts tool list and swaps prompt in a mock conversation.
**Strategy:** `LIFT:opencode` format verbatim.

### D7 (2pt): `SKILL.md` support & discovery
Load skills from `.keywork/skills/` **and** discover existing `.claude/skills/`,
`.cursor/skills/` etc. (cross-agent walk) so team skill investments work day one; skills
surface in palette and are model-invokable.
**Accept:** fixture repo with a `.claude/skills/` skill: discovered, listed, invokable.
**Strategy:** `OWN` (the `SKILL.md` format and cross-agent directory names are public
convention).

### D8 (2pt): MCP client: stdio transport
Spawn/manage stdio MCP servers from config; handshake, tool listing, invocation, restart on
crash (with backoff + toast).
**Accept:** round-trip against a reference MCP server fixture in tests.
**Strategy:** `LIFT:opencode` MCP integration patterns; official TS SDK.

### D9 (2pt): MCP client: http/sse transports
Remote servers over streamable HTTP/SSE incl. auth headers from config.
**Accept:** fixture HTTP server round-trip; reconnect on drop.
**Strategy:** `LIFT:opencode`; official TS SDK.

**Landed 2026-10-02 (117 SW12, dual-era client):** both transports now probe the
2026-07-28 revision first (`server/discover` with per-request `_meta`) and fall back to an
`initialize` handshake at `2025-11-25` when the server answers like a legacy one;
`mcp/era.ts` owns the probe and request shaping, and the registry remembers each server's
era for the process (a failed connect forgets it). Modern servers get `Mcp-Method` /
`Mcp-Name` / `x-mcp-header` headers on HTTP, `subscriptions/listen` in place of the GET
stream, and `ttlMs` re-lists on the next tool call after expiry. An `input_required`
result fails the call with a clear message until elicitation routing lands. Roots, Sampling,
Logging and HTTP+SSE stay out (deprecated). The stdio fixture takes `--era=legacy|modern|dual`.
The stdio probe waits at most 2s (`discoverProbeTimeoutMs`) before falling back, paid once per server per process thanks to the remembered era.

### D10 (2pt): Lazy MCP schemas
The D1-decision mitigation: connected servers contribute **names + one-liners only** to the
model's context; a built-in `tool_search`-style tool fetches full schemas on demand, after
which the tool is directly callable. Idle servers ≈ 0 tokens.
**Accept:** token-count test: 3 connected fixture servers add < 200 tokens to the system
context until a schema is requested; post-fetch invocation works.
**Strategy:** `OWN` design (this harness's own deferred-tool pattern as prior art).

### D11 (1pt): `.keyworkignore`
Gitignore-syntax exclusion file respected by read/edit tools' discovery surfaces, repo map
(F2), and diff pane; combines with `.gitignore`.
**Accept:** ignored fixture paths invisible to tool globbing and repo map.
**Strategy:** `OWN` (trivial); standard ignore-parser dep.

### D14 (2pt): MCP status dock pane
(2026-08-10, Jordan.) When any MCP server is configured, startup docks a node on the right
(C27/C28 dock) showing a tight per-server status line: name, connection state, tool count.
Focusing it opens a simple interaction menu per server (enable/disable, restart, list
tools) in the spirit of OpenCode's MCP menu, re-presented as a dock-native pane. Connection
progress uses the **tile-fill mark** (Jordan, 2026-08-10: the dwindle layout in
miniature; spec in [`../design-language.md`](../design-language.md)); server states use
the density ramp (`█` connected · `▒` connecting · `░` down). Never a spinner.
**Accept:** fixture config with two servers (one healthy, one failing) docks the pane on
start with correct states; menu restart recovers the failing server; zero MCP config ⇒ no
pane, zero cost.
**Strategy:** `LIFT:opencode` MCP plumbing/status semantics (D8–D10); `OWN` dock
presentation and loading indicator.
