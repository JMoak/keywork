# 118: The app surface

> **Kind:** scoping overlay + work plan (2026-10-07). It owns keywork's side of keywork-app:
> which routes `keywork serve` grows for the native app, what shape each one has, and how a
> route family registers in the server package. The route-family split (`packages/server/src/
> routes/`) landed with this doc; every task below is unbuilt. Where it speaks it wins over
> [`80`](80-p2-reach.md)'s S0 · S1 section (which keeps only what landed there) and over the
> server lane in the app's own `docs/plan.md`, whose S2 to S9 are re-cut here as K0 to K4.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only; the app never
> touches a model credential. Pi and OpenCode are MIT and adapted only with attribution in
> `NOTICE`; nothing here lifts from either. Crush is never a source. The user commits; agents
> never `git commit` or `git push`. Every task below is `OWN`.

## What keywork-app is, and what it is not

keywork-app (`C:\src\keywork-app`, Electron + Solid) exists. It is the **third mounting
surface** that [`80`](80-p2-reach.md)'s native-shell revisit gate (D10 restated) allowed once
the M2 demo and P2.1 had both landed: panes rendered natively from `keywork serve`'s HTTP and
SSE surface. It is a client. It holds no session, runs no tool, decides no permission and
keeps no memory; the engine in this repo stays the only engine, and the app's own guardrails
say so (`scripts/check-guardrails.ts` there fails on any import of `@keywork/engine`).

**D10 "terminal-only v1" is unchanged for keywork itself.** The terminal is still the surface
keywork is judged on. What changes is only that the server grows routes under keywork's own
rules, and the rules are the ones S0 · S1 established: a route is a row in a family's table, a
handler, tests in `server.test.ts` and `serve.test.ts`, `docs/events.md` updated in the same
change when an event is added, loopback and bearer posture never touched. Every route lands
for every Tier-2 client, not for the app alone. Nothing the app needs may be re-implemented
in the app: when the server lacks it, the server grows (a task here) and the app waits.

The app's own plan says it in one line that this doc adopts: *the lane must never add a route
that lets a client hold state the server does not know about.* Two surfaces, one bus.

## Where the tree stands (2026-10-07)

**Landed with this doc: the route-family split.** `packages/server/src/server.ts` is
composition only; `openapi.ts` composes `routes` from `routeFamilies`; each family lives in
`packages/server/src/routes/<family>.ts` exporting its route rows and its handlers;
`routes/family.ts` holds the shared contract (`RouteSpec`, `RouteFamily`, `RouteContext`,
`HandlersOf`, `handlersOf`, `json`, `unauthorized`, `missingSession`, `bodyOf`, `fieldsOf`,
`nonBlank`). `openapi.test.ts` proves the composed `/doc` equals, key for key and in order, the
document the single table produced (`openapi-document.fixture.json`, captured before the
split) and that operation ids are unique. `OperationId` is still a precise union, derived from the
families' rows.

Facts from source that shape every route below (read 2026-10-07; cited per task):

- **The bus has no event for any session verb.** `engine/src/bus.ts:19-36` lists sixteen
  types; model, thinking, effort, compaction, undo, title, cost and context changes are
  session entries only (`engine/src/session/entries.ts:68-82`, `store.ts:144-186`). Fork and
  label travel over a CLI-side `SessionChangeFeed` (`cli/src/sessions/ports.ts:114`); file
  changes over a TUI-side `FileChangeFeed` that pairs `tool.started` with `tool.finished`
  for `write`, `edit` and `bash` (`tui/src/diff-model.ts:118,307`). `gate.preset` and
  `session.mode` exist in the vocabulary and nothing in production emits them.
- **`keywork serve` composes with `checkpoints: "off"`** (`cli/src/serve.ts:298`) and builds
  every session on **one process-level provider** (`serve.ts:271-277`), ignoring the
  session's `model_change`, `thinking_level_change` and `effort_change` entries. The TUI
  switches a model by rebuilding the agent over the same history
  (`tui/src/session-panes.ts:320-335`).
- **Presets are process-level**, one `userPresetSwitch` per process (`cli/src/presets.ts:44`,
  `main.ts:198`), persisted to the user config; loosening requires confirmation
  (`shared/src/trust/presets.ts:24`).
- **Modes do not exist.** `docs/modes.md` is the E7 spec; no mode code is in `packages/*`.
- **Trust is read once at compose time** (`cli/src/main.ts:154` → `cli/src/compose.ts:
  111-165`): memory, tool scope, arcs, project bots, repo map, LSP and project instructions
  all take the flag at build. The TUI's `/init` grants trust and then **reopens the app**
  (`cli/src/workspace-setup.ts:18-26`, `requestReopen`).
- **Memory is inert when untrusted** by construction: `MemoryStore.gate()` throws
  `MemoryInertError` on every write and every read returns empty (`engine/src/memory/
  store.ts:379`). The inbox count is polled on session change (`cli/src/compose-panes.ts:
  466-491`); P2.4's needs-you trigger fires on the rising edge of `inbox >= 3`
  (`tui/src/notifications.ts:17,99`).
- `engine/src/memory/{notes,staging,store}.ts` carry **uncommitted edits from another lane**
  (`revisedBy`, `drift`, `drift-review`, `forget-proposal`) as this doc is written; K4 is
  specified against the committed shapes and names the drift where it matters.

## Decisions of record

**118-1 · One file per family, one line to register.** A route family is a module under
`packages/server/src/routes/` that exports a `const <name>Routes = [...] as const satisfies
readonly RouteSpec[]` and a `<name>Family` object `{ routes, handlers }` checked with
`satisfies RouteFamily<typeof <name>Routes>`. It registers by one entry in `routeFamilies`
in `openapi.ts`. Composition order is `/doc` order, so a new family goes **last** unless it
must shadow a path (it never should). Handlers receive one `RouteContext` (`host`, `log`,
`streams`, `describe`); a family that needs more from the host adds a method to `SessionHost`
(`host.ts`) and implements it in `fileSessionHost` and the testing memory host, never by
reaching around the port. Verbatim pattern, for the next agent:

```ts
import { bodyOf, fieldsOf, json, type RouteFamily, type RouteSpec } from "./family.ts";

export const flavorRoutes = [
  { method: "GET", path: "/flavors", operationId: "listFlavors", summary: "…",
    authenticated: true, responses: { "200": "The flavors." } },
] as const satisfies readonly RouteSpec[];

export const flavorFamily = {
  routes: flavorRoutes,
  handlers: ({ host }) => ({
    listFlavors: async () => json(200, { flavors: await host.flavors() }),
  }),
} satisfies RouteFamily<typeof flavorRoutes>;
// openapi.ts: routeFamilies = [documentFamily, eventFamily, sessionFamily, askFamily, flavorFamily]
```

**118-2 · The engine's shape dictates the route.** A route returns the engine's record with
its field names, not a presentation of it. Where the TUI's pane model adds presentation
(glyphs, curing words, ages, hue), the route returns the inputs the model computes from and
the app re-derives the presentation. Where a TUI port already exists (`SessionTreePort`,
`DiffPort`, `McpPanePort`, `ArcsPort`, `BotsPort`, `WorkspacesPort`, `MemoryPanePort`,
`ArcAirlockPort`), the route is that port's method over HTTP, byte for byte in intent.

**118-3 · Three new event kinds, as few names as possible.** A remote pane never polls.
Events that today travel over in-process feeds get wire names:

| Event | Payload | Fired where the feed fires today |
|---|---|---|
| `session.state` | `{ model?, thinking, effort?, title, leafId, undoable, redoable }`, the whole current state | after every K1 verb and every K2 leaf move; replaces nothing, adds one |
| `session.tree` | `{ reason: "fork" \| "label" \| "leaf", entryId, forkedTo? }` | where `SessionChangeFeed.emit` fires (`ports.ts:114`, `rewindBefore`, `moveLeaf`) |
| `changes.updated` | `{ paths: string[], turn?: number }` | where `FileChangeFeed.emit` fires (`diff-model.ts:118`, after undo / redo / restore) |
| `surface.changed` | `{ kind: "mcp" \| "arcs" \| "bots" \| "workspaces" }` | where `McpRegistry.subscribe` and `ArcsPort.subscribe` listeners fire; after every K3 verb |
| `memory.inbox` | `{ count, staged, airlock, proposals, contradictions }` | where `reviewInboxFeed` recounts (`compose-panes.ts:466`), plus after approve / discard / propose |

Process-level events (`surface.changed`, `memory.inbox`) are recorded through
`EventLog.record("", type, payload)` with an empty `sessionId`; the envelope schema makes
`sessionId` nullable-by-emptiness and `docs/events.md` gains a "Server events" section
beside the engine vocabulary (`engineEventTypes` stays the engine mirror; `serverEventTypes`
is the new list and `envelopeSchema.type.enum` is their union). `surface.changed` is one
event rather than four because every family is process-level, cheap to re-fetch whole, and
consumed by exactly one pane; a `kind` enum keeps the vocabulary small and the SSE filter
simple. If Jordan prefers four names, each is a one-line rename (Q-AS6).

**118-4 · `/events?session=<id>`** keeps envelopes whose `sessionId` equals the filter **and**
every envelope with an empty `sessionId`, so a session pane still learns about process-level
state. `diagnostics.published` is per session already (it rides the session's bus) and passes
when its session matches. Q-AS5 asks whether a `&only=session` strictness flag is wanted.

**118-5 · Nothing here loosens the gate.** No route accepts a permission rule, a preset other
than by its name (and only after K1's confirmation contract, Q-AS2), a path outside the tool
scope, or a trust decision for any root but the one being served. The ask queue stays the one
door for tool approval.

## Tasks

Sizes follow the README scale. Each task is one family file (or one addition to
`routes/sessions.ts`), one `SessionHost` extension, tests in `server.test.ts` and
`serve.test.ts`, `docs/events.md` in the same change, `client.ts` extended so `keywork
attach` and the app read the same typed client, and `/doc` summaries written for a reader who
has never seen the TUI.

### K0 (1pt): checkpoints and per-session inference under `keywork serve`

The prerequisite both K1 and K2 trip over. `serve` opens `Checkpoints` for the workspace
(`engine/src/checkpoints.ts:55`, the shadow git repo the TUI already uses:
`tui/src/session-panes.ts:232` wires `guard.beforeMutation` to `capture()`) and stores the
turn tag on each user message exactly as `cli/src/chat.ts:114-124` does. `LiveSession`
builds its agent from the session's own `store.modelSelection()`, `thinkingLevel()` and
`effort()` (`engine/src/session/store.ts:158-186`) through the inference registry the
TUI uses (`InferenceRegistry.bind`, `engine/src/inference/registry.ts:46`), falling back to
the process provider when the session has no selection.
**Accept:** a prompt under `serve` leaves a `MessageEntry.checkpoint`; `Checkpoints.canUndo()`
is true after a turn that wrote a file; a session whose JSONL carries a `model_change`
answers `GET /sessions/{id}` with that model's id; `serve.test.ts` runs the shadow repo in a
temp dir; `--no-checkpoints` keeps today's behavior for a worktree with no git.

### K1 (3pt): session verbs

The app's S3 + S8 + the undo half of S4. All under `routes/sessions.ts` (or a sibling
`routes/session-verbs.ts` if the file passes ~250 lines), all `authenticated: true`, all
404 `missingSession()` on an unknown id, all 409 `{ error: "a turn is running" }` where the
TUI refuses while busy (`agent.hold`, `agent.ts:229`).

| Route | Body | Answer | Engine |
|---|---|---|---|
| `POST /sessions/{id}/prompt` | `{ text, behavior?: "steer" \| "queue" }` | 202 `{ sessionId, accepted, queued, behavior }` | `SendOptions.behavior` (`agent.ts:77-81`); default `queue`, which is what Enter does in the composer (`tui/src/prompt-editor.ts:151`; Meta+Enter steers). `steer` aborts the running turn and runs next (`agent.ts:217-223, 275-278`). `serve.ts:333-340` must pass it through. |
| `GET /events?session=<id>` | | the filtered stream (118-4) | `EventLog.subscribe`, filter in `sse.ts` |
| `POST /sessions/{id}/model` | `{ reference }` (`provider/model` or bare `model`) | 200 `{ model: { provider, model }, notice }`; 400 with the `ResolutionFailure` code (`engine/src/inference/types.ts:78-92`) | `InferenceRegistry.bind`, rebuild the agent over its history (`session-panes.ts:320-335`), `store.appendModelChange` (`store.ts:158`) |
| `POST /sessions/{id}/thinking` | `{ on: boolean }` | 200 `{ thinking: boolean }` | `agent.setThinking` (`agent.ts:151-157`), `appendThinkingLevelChange("on" \| "off")` (`store.ts:168`); `/thinking` is binary, not levelled (`conversation-model.ts:985`) |
| `POST /sessions/{id}/effort` | `{ level: "low" \| "medium" \| "high" \| "xhigh" \| "max" \| null }` | 200 `{ effort: EffortLevel \| null }`; 400 on an unknown word | `effortLevels` (`engine/src/provider.ts:25`), `agent.setEffort`, `appendEffortChange`; `null` returns to the provider default (SW4 had no reset; this adds it, Q-AS3) |
| `POST /sessions/{id}/compact` | `{ focus?: string }` | 200 `{ compacted: CompactionEntry \| null, notices: string[] }` | `compactNow` (`engine/src/session/settle.ts:46`, `focus` is its `instructions`), then the rebuild `session-attachment.ts:249-260` does; 409 while busy |
| `POST /sessions/{id}/undo` | | 200 `{ prompt: { entryId, text }, filesNote, undoable, redoable }`; 409 busy; 404 `{ error: "nothing to undo" }` | SW14: `rewindBefore` (`ports.ts:202`), `Checkpoints.restoreTo(prompt.checkpoint)` after a `snapshot()` (`tui/src/prompt-undo.ts`); **the prompt text comes back to the client** and the server keeps the one-level `StagedUndo` so `/redo` can cancel it; a file-only `checkpoints.undo()` is the fallback when no prompt is on the path |
| `POST /sessions/{id}/redo` | | 200 `{ restored: true, undoable, redoable }`; 404 nothing staged | `StagedUndo.cancel()` or `checkpoints.redo()` |
| `GET /sessions/{id}/context` | | 200 `ContextReading & { fullness, flushDue, compactionDue, basis: "estimated" }` | `readContext(estimateConversationTokens(history), contextBudgetFor(declaredContextWindow(provider)))` (`engine/src/session/context-budget.ts:23-61`, `compaction.ts:36`); exactly what `contextReadout` prints (`tui/src/context-gauge.ts:38-47`) |
| `GET /sessions/{id}/cost` | | 200 `{ rollup: CostRollup, usage: Usage, basis, cacheMiss?, models: [{ reference, turns, usage, rollup }] }` | `agent.cost()` / `usage()` / `cacheMiss()` (`agent.ts:175-181`), `basis` is the honesty line `costReport` prints (`tui/src/session-ledger.ts:158-162`); `models` requires `SessionLedger`'s retired map to move from `tui/` to the engine or the host, else it is `[current]` (Q-AS4) |
| `POST /sessions/{id}/export` | `{ scope?: "path" \| "tree", out?: string }` | 200 `text/html` body when `out` is absent, 201 `{ file }` when it was written | `sessionHtml` / `exportSession` (`cli/src/sessions/export-html.ts:29`, `export.ts:13`); `out` is confined to the tool scope |
| `POST /sessions/{id}/rename` | `{ title }` | 200 `{ title }` | `store.setName` (`store.ts:144`); there is no `/rename` in the TUI today, titles come from `suggestTitle`; a client-set title must stop the auto-titler from replacing it (Q-AS3) |
| `POST /preset` | `{ name: "careful" \| "standard" \| "open", confirmed?: true }` | 200 `{ from, to }`; 409 `{ error: "loosening needs confirmed: true" }` | process-level `PresetPort.apply` (`cli/src/presets.ts:15`), `requiresConfirmation` (`shared/src/trust/presets.ts:24`); the switch starts emitting `gate.preset`, which the journal already folds |
| `GET /sessions` | | `SessionSummary` gains `model?: string` (`provider/model`) and `thinking?`, `effort?` | `store.modelSelection()` for stored, `modelReferenceOf(agent.provider)` for live |

**Excluded:** a mode route. Plan / Recall / Agent are spec only (`docs/modes.md`); nothing in
`packages/*` implements a mode and nothing emits `session.mode`. When E7 lands the route is
`POST /sessions/{id}/mode { mode }` and it is one row. **Presets** are process-level, so there
is no `POST /sessions/{id}/preset`; the app sets the process preset with `POST /preset` and
every session sees `gate.preset`, which is what the TUI does with one `userPresetSwitch`.

**Accept:** every row in the table with its 2xx, 4xx and 409 cases under `server.test.ts`
with the memory host and under `serve.test.ts` with a real JSONL store; `session.state`
fires after each verb and the memory host proves the payload; `behavior: "steer"` interrupts a
running `MockProvider` turn and the steer runs before a queued prompt; `/undo` returns the
prompt text and a following `/redo` restores the transcript and the files; `/doc` names the
default behavior; `client.ts` gains one method per route; `docs/events.md` gains
`session.state` and the `/events?session=` paragraph.

### K2 (3pt): tree and diff

The app's S2 + the rest of S4. New family `routes/tree.ts` and `routes/changes.ts`.

| Route | Body / query | Answer | Engine |
|---|---|---|---|
| `GET /sessions/{id}/entries` | | 200 `{ sessionId, name?, leafId, entries: SessionEntry[], labels: Record<entryId, label>, activePath: string[] }` | the flat JSONL as `parseFileEntries` yields it (`engine/src/session/entries.ts:136`), `store.leafId()`, `labels()`, `activePath()` ids (`store.ts:217-249`); the client runs the tree fold (`buildTree`, `entries.ts:238`, is 40 lines and mirrored into the protocol package by the app); `message` entries carry their `Message` whole |
| `POST /sessions/{id}/fork` | `{ entryId }` | 201 `{ sessionId }` (the new session) | `store.clone(file, entryId)` (`store.ts:261`) as `sessionTreePort.fork` does (`ports.ts:101-107`); 404 on an unknown entry |
| `POST /sessions/{id}/label` | `{ entryId, label: string \| null }` | 200 `{ entryId, label }` | `store.setLabel(entryId, label ?? undefined)` (`store.ts:128`) |
| `POST /sessions/{id}/leaf` | `{ entryId: string \| null }` | 200 `{ leafId }`; 409 busy | `moveLeaf` (`ports.ts:217`) then the rebuild over the shorter path, the same move `/undo` makes without the file restore; the one tree verb the TUI pane lacks and the app's transcript needs |
| `GET /sessions/{id}/changes` | | 200 `{ baseline: "session start", files: ChangedPath[] }` | `Checkpoints.changedSince(await baseline())` (`engine/src/checkpoints.ts:12,108`); `turn` is the 1-based turn ordinal the checkpoint store assigns, which is the TUI's provenance too (`diff-model.ts:12`); 409 `{ error: "no baseline" }` when K0's checkpoints are off, mirroring `noBaselineNotice` |
| `GET /sessions/{id}/changes/file?path=` | | 200 `{ path, before: string \| null, after: string \| null, note?: "binary" \| "new" \| "deleted" \| "unreadable", truncated: boolean }` | `contentAt(baseline, path)` and the working file; each side capped at 1 MiB with `truncated: true`, NUL content answers `note: "binary"` with no text (`diff-model.ts:310` rules). A path param cannot carry `/` under the matcher (`[^/]+`), so the path is a query |

**Events:** `session.tree` and `changes.updated` as in 118-3. `changes.updated` is computed
by the same `followMutations` pairing (`diff-model.ts:118`), moved from `tui/` into the host
so the TUI and the server share it; its `paths` are the post-refresh `changedSince` paths so
a client replaces its list rather than merging.

**Accept:** `entries` round-trips a fixture JSONL with a fork, a label, a compaction and a
binding entry; `fork` yields a session `GET /sessions/{new}` can read, with
`parentSession` set; a `write` tool call under `MockProvider` fires `changes.updated` with
the path and `GET …/changes` shows `added` for it with `turn: 1`; `changes/file` answers
`before: null` for a new file and `note: "binary"` for NUL content; `session.tree` fires on
fork, label and leaf; the per-file cap is tested at the boundary; `docs/events.md` gains both
events.

### K3 (3pt): workspace, files, trust and status

The app's S5 + S7 + S9 plus trust. Families `routes/workspace.ts`, `routes/files.ts`,
`routes/surfaces.ts` (mcp, arcs, bots, workspaces), `routes/flavors.ts`.

| Route | Body / query | Answer | Engine |
|---|---|---|---|
| `GET /workspace` | | 200 `{ anchor: { root, source }, identity, slug?, name?, declared, declarationFile?, contextDirs, missingContextDirs, focusDirs, vault?, trust: TrustDecision, readiness: "ready" \| "undeclared" \| "undecided" \| "refused" }` | `resolveAnchor` (`shared/src/config/workspace.ts:37`), `Workspace` (`declaration.ts:38-47`), `workspaceIdentity` (`cli/src/paths.ts:14`), `TrustStore.resolve` (`shared/src/trust/store.ts:52`), `workspaceReadiness` (`cli/src/workspace-setup.ts:30-47`) |
| `GET /tree?path=&hidden=` | one directory level | 200 `{ path, entries: [{ name, kind: "file" \| "dir", ignored, hidden }] }` | `BrowserDisk.readDirectory` + `IgnoreRules` (`tui/src/browser-model.ts:21-25`, `gitignore.ts:9`); ignored entries are **returned and flagged**, never dropped, as the browser does; `path` is relative to the anchor and passes `confinedPath(workspaceToolScope)` (`engine/src/tools/confine.ts:14`): the browser is unconfined in the TUI because it runs as the user, a remote client gets the tool jail; 403 `{ error: "escapes the workspace scope" }` |
| `GET /files?path=&from=&to=` | byte range, `[from, to)` | 200 `{ path, bytes, from, to, text, truncated, encoding: "utf-8" }`; 415 `{ error: "binary file" }` on NUL | the whole-file cap stays `maxFileBytes` 20 MiB (`tui/src/file-model.ts:99`); the per-request cap is 1 MiB; `from`/`to` are the `SpillReference.elidedFrom/To` numbers (`engine/src/messages.ts:55-60`), so a spill opens at its range; confined as `/tree` |
| `POST /workspace/trust` | `{}` (no path: the served root only) | 200 `{ trusted: true, root, reopens: true }`; 400 `BlanketTrustError`; 409 when already decided `untrusted` (`grantTrust` throws there, `cli/src/workspace-setup.ts:55-67`) | `TrustStore.trust(root)` (`store.ts:61`) exactly as `/init` and `keywork trust` do. **Safety argument:** the server is loopback with a per-launch bearer whose ticket file is private to the user, so the caller is the same local user who could run `keywork trust` in that directory; the route takes no path, so it cannot trust anything but the workspace the server was launched for; it cannot untrust, forget or trust-for-session; and because trust is read at compose time, the server does **not** recompose itself: it answers `reopens: true` and the app, which owns the sidecar, restarts `keywork serve` the way the TUI reopens itself after `/init`. That keeps the route a pure write of the same decision with the same confirmation sentence shown by the client (`workspace-setup.ts:31-41`). If Jordan rejects a trust route (Q-AS1), the alternative is `GET /workspace` returning `readiness: "undecided"` and the app shelling `keywork trust` through its PTY. |
| `GET /mcp` | | 200 `{ servers: McpServerStatus[] }` | `McpRegistry.status()` (`engine/src/mcp/reconciler.ts:4-14`, `registry.ts:120`) |
| `POST /mcp/{name}/restart`, `POST /mcp/{name}/enabled { on }`, `GET /mcp/{name}/tools` | | 200 the new status / `{ tools: string[] }`; 404 `McpServerNotFoundError` | `registry.restart / enable / disable / listTools` (`registry.ts:129-145`) |
| `GET /arcs` | | 200 `{ arcs: ArcSummary[], ordinals: Record<slug, number> }` | `ArcsPort.list` (`tui/src/arcs.ts:62`, `cli/src/arcs.ts:244`); `ordinals` is `arcOrdinalsOf` so the app derives the same hue; 403 `arcsUnavailable` when untrusted |
| `POST /arcs { slug }`, `POST /arcs/{slug}/close { direction? }`, `POST /arcs/{slug}/abandon` | | 201 `ArcSummary` / 200 `ArcCloseOutcome` / 200 | `create`, `close`, `abandon` on the port |
| `POST /sessions/{id}/arc { slug: string \| null }`, `POST /sessions/{id}/bot { name: string \| null }` | | 200 the binding; 409 mid-turn for a bot | `store.appendArcBinding / appendBotBinding` (`store.ts:188-192`) as `bind` / `switchBot` do (`session-panes.ts:165-175, 305-318`); `null` releases |
| `GET /bots` | | 200 `{ bots: BotSummary[] }` | `BotsPort.list` (`tui/src/bots.ts:5-33`, `cli/src/bots.ts:41`) |
| `POST /bots { slug, scope, purpose? }` | | 201 `BotEntry` | `BotsPort.create` |
| `GET /workspaces` | | 200 `{ workspaces: WorkspaceChoice[] }` | `WorkspacesPort.list` (`tui/src/workspace-picker.ts:6-23`, `cli/src/workspaces.ts:104`) |
| `POST /workspaces { slug }`, `POST /workspaces/{slug}/focus { dir }`, `DELETE`-equivalent `POST /workspaces/{slug}/unfocus { dir }` | | 201 / 200 `{ dir }` | `create`, `linkFocusDir`, `unlinkFocusDir` (focus dirs only; a context-dir link needs trust and a confirmation and stays a `keywork link` affair, Q-AS7) |
| `POST /workspaces/use { slug: string \| null }` | | 200 `{ slug, reopens: true }` | `recall.remember` only; a workspace switch is a new identity and therefore a new server, so the app restarts the sidecar with that slug, as the TUI shuts down and reopens (`tui/src/workspace-commands.ts:72-79`) |
| `GET /flavors` | | 200 `{ flavors: Flavor[], active: string }` | the parsed `flavorSchema` records (`shared/src/config/flavor.ts:107-143`): `keywork-night` and the config closet; `system` is derived from terminal colors and is omitted under `serve` (the app derives its own from the OS, Q-AS8) |

**Events:** `surface.changed { kind }` as in 118-3, from `McpRegistry.subscribe`,
`ArcsPort.subscribe`, after every verb in this family, and after a workspace declaration
write.

**Accept:** `GET /workspace` matches `/doc`'s `info.workspace.identity`; `/tree` on `..`
answers 403 and on an ignored directory flags `ignored: true`; `/files` honours `from`/`to`,
caps at 1 MiB with `truncated: true`, and refuses NUL content with 415; `/workspace/trust` on
an undecided temp root writes `~/.keywork/trust.json` under a temp `userRoot` and answers
`reopens: true`, on a home directory answers 400, and never accepts a body path; every verb
fires `surface.changed` with its kind; `serve.test.ts` runs the MCP fixture server
(`engine/src/testing/mcp-fixture-server.ts`) through restart and toggle; `docs/events.md`
gains the "Server events" section with `surface.changed`.

### K4 (2pt): memory

The app's S6, expanded to the memory pane's whole model. Family `routes/memory.ts`. Every
route answers 403 `{ error: "memory is inert: this workspace is untrusted" }` on a write and
`{ trusted: false, … empty lists }` on a read when the store is untrusted, so the wire says
exactly what `MemoryInertError` and the empty reads say (`engine/src/memory/store.ts:
97-102, 379`).

| Route | Body / query | Answer | Engine |
|---|---|---|---|
| `GET /memory` | | 200 `{ trusted, layers: MemoryLayerView[], inbox: StagedItem[], ledger: LedgerEntry[], audit: AuditEntry[], gardener?, airlocks: ArcCloseDigest[] }` | `loadInputs` (`cli/src/memory.ts:317-343`) with the **engine** rows (`StagedItem`, `LedgerEntry`) rather than the pane's `InboxItemView` / `LedgerEventView`; the layer list keeps its ids `workspace`, `arc:<slug>`, `bot:<slug>` (`memory.ts:291-299`) and the workspace layer's `prompt: { budget: 4096, used }` from `store.bootstrap(memoryBootstrapBudget)` |
| `GET /memory/inbox` | | 200 `{ trusted, items: StagedItem[], count }` | `store.listStaged()` + `bots.staged()` (`compose-panes.ts:487-491`); `count` is what `memory.inbox` carries |
| `POST /memory/inbox/{id}/approve`, `POST /memory/inbox/{id}/discard` | | 200 `WriteResult` / 200 `{}`; 404 `StagedItemNotFoundError` | `store.approve / discard` or the owning bot store (`memory.ts:259-289`) |
| `GET /memory/notes?layer=` | | 200 `{ trusted, notes: Note[] & { curing, injected, recalls? } }` | `store.listNotes()`, `curingStage` (`memory.ts:301-309`), `injected` from the bootstrap selection |
| `GET /memory/notes/{name}` | | 200 `Note & { relations: NoteRelationView[] }`; 404 | `store.readNote(name)` (`store.ts:169`), graph edges as `noteViews` adds them |
| `GET /memory/daily`, `GET /memory/daily/{date}` | | 200 `{ dates: string[] }` / `{ date, entries: DailyEntry[] }` | `listDailyDates`, `readDaily(date)` (`store.ts:187-193`) |
| `GET /memory/ledger` | | 200 `{ entries: LedgerEntry[] }` (this process only, cap 128) | `store.ledger()` (`store.ts:232`) |
| `POST /memory/ledger/{id}/revert` | | 200 `{ outcome: RevertOutcome }`; 404 `LedgerEntryNotFoundError` | `store.revert(ledgerId)` (`store.ts:363`), the C72 one-key revert; `needs-rebase` is a 200 with that outcome, not an error |
| `GET /arcs/{slug}/airlock` | | 200 `ArcCloseDigest & { decisions: CloseDecisions }` or 404 when no review is staged | `ArcAirlockPort.digest` (`cli/src/arcs.ts:202-210`), the in-memory `ArcCloseDraft` folded in |
| `POST /arcs/{slug}/airlock/candidates/{note} { choice: "deliver" \| "leave" }`, `POST /arcs/{slug}/airlock/questions { title, choice: "resolve" \| "carry" \| "drop" }`, `POST /arcs/{slug}/airlock/deliver`, `POST /arcs/{slug}/airlock/finish { force?: boolean }` | | 200 the digest / `{ delivered }` / `AirlockFinishOutcome` | `triageCandidate`, `triageQuestion` (carry picks `successorFor`, `arcs.ts:165-174`, 409 `MissingSuccessorError`), `deliverEligible`, `finish` (`arcs.ts:234-242`); `force` is the `f` key |
| `POST /memory/ask { query, arc? }` | | 200 `MemoryQueryOutcome` | `askMemory` through `MemoryPanePort.query` |

**Events:** `memory.inbox` as in 118-3, recorded where `reviewInboxFeed` recounts and after
each write above. The threshold stays in the client (`defaultInboxThreshold` 3, rising edge).

**Accept:** every route answers the inert shape against an untrusted memory host and the live
shape against a trusted temp vault; approve of a staged note writes the note and fires
`memory.inbox` with the decremented count; `revert` returns `needs-rebase` after an outside
edit; the airlock walk (digest → triage → finish, then `force`) mirrors
`cli/src/arcs.test.ts`'s cases over HTTP; the two staged kinds still uncommitted in
`staging.ts` (`drift-review`, `forget-proposal`) pass through as `StagedItem` without a
server-side switch, so this family never needs a change when a kind is added.

## Assumptions Jordan may reverse

- **A trust route exists at all** (K3, Q-AS1). The argument above says it is the same decision
  the same user already makes; the alternative is written in the row.
- **`reopens: true` is a contract**, not a hack: trust and workspace switches both answer it,
  and a client that cannot restart the sidecar (a plain `keywork attach`) just reports it.
- **The prompt default is `queue`**, matching Enter in the composer; `steer` is opt-in per
  request. The app's plan expected the same.
- **`/events?session=` passes process-level envelopes through** (118-4) rather than dropping
  everything that is not the session.
- **One `surface.changed` event** instead of four names (118-3).
- **`SessionSummary.model` is the reference string** `provider/model`, not an object, because
  that is what `/model` accepts and what `modelReferenceOf` returns.
- **The per-file diff and the file read cap at 1 MiB per side / per request**; the TUI reads
  whole files up to 20 MiB because it is local.
- **Presets stay process-level** and the route lives at `/preset`, not under a session. If
  E7's per-pane permission mode lands first, the route moves and this doc gains a ledger line.
- **`/leaf` is a new verb** the TUI pane does not have; it exists because the app's transcript
  needs to walk a branch without forking.
- **K4 is specified against committed shapes.** The uncommitted memory lane may rename
  fields before K4 is built; the family passes `StagedItem` and `Note` through untouched so
  a rename there is a rename on the wire and nothing more.
- **No route carries `provenance` on a prompt** (the app's S8 mentioned one): `inject` already
  stamps `origin`, and a typed prompt from the app is a typed prompt, provenance `user`.

## Questions for Jordan

- **Q-AS1.** Is `POST /workspace/trust` acceptable under the safety argument in K3, or should
  trust stay a terminal-only decision (`GET /workspace` says `undecided`, the app runs
  `keywork trust` in its PTY)?
- **Q-AS2.** `POST /preset` loosening with `confirmed: true` in the body: is a body flag enough
  confirmation over loopback + bearer, or should loosening be refused over HTTP altogether
  (the app then shows the TUI's confirmation and sets it through the user config)?
- **Q-AS3.** Two small additions the TUI lacks, both one row: `effort: null` to return to the
  provider default, and `/rename` pinning a title so `suggestTitle` stops replacing it. Yes to
  both, or keep parity with the terminal?
- **Q-AS4.** `GET /sessions/{id}/cost` lineage per model needs `SessionLedger`'s retired map
  out of `tui/`. Move it to the engine (the honest home) in K1, or ship the rollup only and
  add `models` when the TUI is refactored?
- **Q-AS5.** Should `/events?session=<id>` offer `&only=session` to drop process-level
  envelopes as well, or is the pass-through enough?
- **Q-AS6.** One `surface.changed { kind }` or four events (`mcp.changed`, `arcs.changed`,
  `bots.changed`, `workspaces.changed`)?
- **Q-AS7.** Context-dir linking (widens the tool jail, needs trust and a confirmation) stays
  off the wire in K3. Agreed, or should it ride the same `confirmed: true` contract as
  Q-AS2?
- **Q-AS8.** `GET /flavors` omits `system` under `serve` because it is derived from the
  terminal's colors. Should the server instead return a `system` placeholder the app fills
  from the OS, so the two surfaces list the same names?

## Non-goals

- No mode route until E7 exists in code. No OAuth of any kind, no credential route: `/connect`
  stays a terminal flow and the app launches it in its PTY.
- No route that lets a client hold session state the server does not have: no client-side
  queue, no client-side undo stack, no client-side trust cache.
- No change to loopback binding, the bearer scheme, the ticket file or the ask timeout.
- The server never grows a view model: it returns engine records and the app renders them.

## Ledger

### Route-family split · landed 2026-10-07

`packages/server/src/routes/{family,document,events,sessions,asks}.ts` (new),
`openapi.ts` (composes `routeFamilies`; keeps the OpenAPI renderer), `server.ts`
(composition only), `index.ts` (exports `routeFamilies` and the family types),
`openapi.test.ts` + `openapi-document.fixture.json` (the composed `/doc` equals the
pre-split document key for key and in order, with the envelope's `type` enum taken from the
live `engineEventTypes` because the vocabulary is the engine's; unique operation ids). Pure
refactor: 66 server, serve and attach tests unchanged and green.

### K4 · memory and the arc airlock over HTTP · landed 2026-10-10

Families `packages/server/src/routes/memory.ts` (eleven routes) and `routes/airlock.ts` (five),
registered last in `routeFamilies`. `SessionHost` gains an optional `memory?: MemoryPort`
(`host.ts`: `MemoryPort`, `ArcAirlockPort`, `MemoryOverview`, `MemoryNoteRecord`,
`ArcCloseDigestRecord`, `AirlockFinishOutcome`); a host without it answers 503 on every memory
route. The port is implemented twice: `vaultMemoryPort` in `server/src/testing.ts` (a real
`MemoryStore` on a temp vault, trusted or untrusted, with a pluggable airlock seam) and
`servedMemory` in `cli/src/serve-memory.ts` (workspace + active arc layers, bot-owned staged
items, the arc service's airlock, `arcs.port.subscribe` as the recount feed). `client.ts` gains one
method per route; `serverEventTypes` gains `memory.inbox` and `docs/events.md` its "Server
events" section; `openapi-document.fixture.json` regenerated for the new routes.

**Wiring `serve.ts` still needs (owned by another lane):** in `fileSessionHost`, add
`memory: servedMemory({ memory, arcs })` to the returned object, where `memory` is the
composition's `MemoryAccess` (so the route's ledger is the same instance the sessions flush
through) and `arcs` an `arcService` built as `compose-panes.ts` builds it. Until then `serve`
answers 503 and `serve.test.ts` proves the port by spreading it over `fileSessionHost`.

**Where the committed memory shapes differ from the K4 text:** `GET /memory` returns
`StagedItem[]` and `LedgerEntry[]` as written, and the notes carry `originSession`,
`revisedBy` and `drift` because `Note` does; `drift-review` and `forget-proposal` pass through
`GET /memory/inbox` with no server-side switch (tested). `curing` is computed in the family from
the note's provenance, pin, usefulness and confidence (the same rule as `cli/src/memory.ts`), the
one presentation field the K4 table asked for. `GET /arcs/{slug}/airlock` returns the arc
service's digest (`AirlockDigestView` fields) plus `decisions`, derived from the per-row `choice`,
`successor` and `direction`, because `ArcCloseDraft` is private to the service.

**Deviations:** every read carries `trusted` beside its records (the single-note read spreads it
over the note); `approve` answers `{}` for an item a bot store owns, since `BotMemory.approve`
returns nothing; an undeclared workspace (no vault) also answers the inert shape, because a
`MemoryStore` cannot exist without a vault root; `memory.inbox` is recorded after every write
unconditionally and on port change notifications only when the count moved, which is the
terminal feed's dedupe. `GET /memory/notes/{name}` and the candidate route URL-decode their
parameter so entity notes and titles with spaces fit the `[^/]+` matcher.

### K3 · workspace, files, trust and status over HTTP · landed 2026-10-10

Four families, registered last in `routeFamilies` in this order: `routes/workspace.ts`
(`GET /workspace`, `POST /workspace/trust`), `routes/files.ts` (`GET /tree`, `GET /files`),
`routes/surfaces.ts` (`GET /mcp`, `POST /mcp/{name}/restart`, `POST /mcp/{name}/enabled`,
`GET /mcp/{name}/tools`, `GET /arcs`, `POST /arcs`, `POST /arcs/{slug}/close`,
`POST /arcs/{slug}/abandon`, `POST /sessions/{id}/arc`, `POST /sessions/{id}/bot`, `GET /bots`,
`POST /bots`, `GET /workspaces`, `POST /workspaces`, `POST /workspaces/use`,
`POST /workspaces/{slug}/focus`, `POST /workspaces/{slug}/unfocus`) and `routes/flavors.ts`
(`GET /flavors`). `routes/answers.ts` holds what the four share: `servedBy` (503 when the host
lacks the port, the K4 precedent), `answering` (one class-to-status table: 400 blanket trust and
slug grammar, 403 scope escape and surface unavailable, 404 missing path, MCP server or arc, 409
busy, untrusted, arc exists or not active, 413 over the file cap, 415 binary, 503 registry
stopping; a port's plain `Error` is a 409 refusal, anything more specific is rethrown) and
`surfaceChanged`. `files.ts` is the filesystem half (`workspaceFiles(root, scope)`: one level of
tree with `.gitignore` layers from the root down through the shared ignore rules, byte slices
capped at 1 MiB with a 20 MiB whole-file cap, NUL refused), shared by both hosts.

`SessionHost` gains six optional ports, following K4's `memory?`: `workspace` (report, trust,
tree, file), `mcp`, `arcs` (with `bindSession`), `bots` (with `bindSession`), `workspaces` and
`flavors`. They are implemented twice: `memorySurfacePorts` in `server/src/testing.ts` (a real
directory for tree and files, in-memory trust, arcs, bots and workspaces, a pluggable `McpPort`)
and `surfacePorts` in `cli/src/serve-surfaces.ts` (the anchor, declaration, `TrustStore` and
`workspaceReadiness` for the report; `workspaceSetupPort(...).setUp()` for trust, the same path
`/init` takes; the composition's `scope` and `mcp`; `arcService` and `botService` built as
`compose-panes.ts` builds them; `workspacesPort` with a no-op switch; `startupFlavors` dressed
in the config theme). `client.ts` gains one method per route; `serverEventTypes` gains
`surface.changed` and `docs/events.md` its section.

**Decisions taken (reversible):** Q-AS1 built as constrained: no body path, served root only,
never untrusts, 400 on a home directory, 409 on an untrusted root; `reopens` is
`!projectTrusted` (the server composed before the decision) rather than a constant, and the
route also declares the workspace because that is what `/init` does and `serve` has no deferred
materialization. Q-AS6 one `surface.changed { kind }`. Q-AS7 context-dir linking stays off the
wire. Q-AS8 `system` is omitted from `/flavors`; `active` still names it when configured and the
summary says the client derives it. Events for `mcp` and `arcs` ride the registry's and the arc
service's own subscriptions (so a verb that changed nothing fires nothing, and an MCP server
dropping on its own still announces); `bots` and `workspaces` are recorded after each verb.

**Wiring `serve.ts` still needs (owned by another lane):** in `fileSessionHost`, spread
`...surfacePorts({ ...options, composition: () => sessions.composed(), session: (id) =>
sessions.bound(id) })` into the returned object, with `LiveSessions.composed()` made public
(returning the composition) and a `bound(id)` that answers `{ store, busy }` for a live or stored
session; `HostOptions` may gain `flavor` and `theme` so the config closet reaches `/flavors`.
Until then `serve` answers 503 on every K3 route and `serve.test.ts` proves the ports by spreading
them over `fileSessionHost`, which is also how the MCP fixture server is run through restart and
toggle there.

**Deviations:** `/tree` and `/files` resolve `path` against the anchor root and check it against
the composed tool scope (so a linked context dir is reachable by absolute path) rather than
calling `confinedPath` on the launch cwd; the TUI's `IgnoreRules` are not shared with the server,
so the ignore flag uses `@keywork/shared`'s `ignoresPath` over the same `.gitignore` files; the
`WorkspaceChoice`, `ArcSummary`, `BotEntry` and `BotSummary` wire shapes are restated in
`host.ts` because the server cannot import `@keywork/tui`; binding a session to a bot under
`serve` records the binding but does not rebuild the agent as a bot, because `serve` builds every
agent without a bot today (the same gap K0 names for model selection); an unknown bot name is a
409 so a client cannot bind what no roster defines.

### K0 · checkpoints and per-session inference under `keywork serve` · landed 2026-10-10

`cli/src/serve.ts` composes with `checkpoints: "on"` by default (`--no-checkpoints` keeps the
old behavior; `HostOptions.checkpoints` and `checkpointsGitDir` carry it, the latter so tests
run the shadow repo in a temp dir). Every live session's guard is the ask-queue guard plus
`beforeMutation → Checkpoints.capture()` and `beforeTurn → beginTurn()`, and
`persistNewMessages` receives the store so the turn tag lands on `MessageEntry.checkpoint`
exactly as `chat.ts` does. `LiveSession` builds its agent from the session's own
`modelSelection()` through a `SessionInference` seam (`host.ts`: `bind(reference)` +
`provider(binding)`, wired in `main.ts` from the runtime's registry), falling back to the
process provider with a notice when the stored reference does not resolve; `thinkingLevel()`
and `effort()` are applied to the agent on open. `SessionSummary` gains `model?`
(`provider/model`), `thinking?` and `effort?` for stored and live sessions alike.

### K1 · session verbs · landed 2026-10-10

Family `packages/server/src/routes/session-verbs.ts` (eleven routes), registered last in
`routeFamilies`; `POST /sessions/{id}/prompt` in `routes/sessions.ts` gains `behavior`
(default `queue`) and answers `{ sessionId, accepted, queued, behavior }`. `SessionHost` gains
one method per verb (`setModel`, `setThinking`, `setEffort`, `compact`, `undo`, `redo`,
`context`, `cost`, `exportHtml`, `rename`, `applyPreset`) with the string refusals `"missing"`
/ `"busy"` (`"nothing"` for undo/redo) mapped to 404 / 409 in the family; `client.ts` gains the
same methods and `events({ session })`. Implemented twice: the memory host in
`server/src/testing.ts` (a `models` map stands in for the registry, `presets` for the switch)
and `LiveSession` in `cli/src/serve.ts` (agent rebuild over the same history for model, effort
reset, compaction and undo, with a `SpendLedger` that retires each agent's usage and rollup
under its reference so `GET …/cost` answers `models` per model, not `[current]`). `/undo`
stages one `cancel` closure (files restored to the snapshot taken before the rewind, leaf moved
back) that `/redo` runs; with no prompt on the path it falls through to `Checkpoints.undo()`.
`/preset` is process-level: `main.ts` passes a `userPresetSwitch` seeded from `--preset` or
the config, and every live session's bus emits `gate.preset` so the journal folds it.

`serverEventTypes` gains `session.state`, recorded after every verb and after each turn's
persist; `/events?session=<id>` filters in `sse.ts` per 118-4 (replay and live). The title pin:
`SessionInfoEntry.pinned`, `SessionStore.setName(name, pinned)` + `titlePinned()`, and
`attachmentOf.rename` in `cli/src/sessions/ports.ts` is a no-op when pinned, which is where
`persistingTitler` writes. `rewindBefore` and `moveLeaf` are exported from `ports.ts` for the
host. `docs/events.md` gains `session.state` and the `?session=` section.

**Decisions taken (all reversible):** Q-AS2 `confirmed: true` in the body is the confirmation
over loopback + bearer; Q-AS3 yes to both (`effort: null` writes `effort_change "default"`,
which the readers treat as no level; `/rename` pins); Q-AS4 the retired map lives in the host
(`SpendLedger`), so `models` is real lineage, and the TUI's `SessionLedger` is untouched.
`gate.preset` is emitted on each live session's bus rather than as a process-level envelope,
so it journals; a stored session not yet open hears nothing and needs nothing. `/thinking` and a
levelled `/effort` never answer 409 (the TUI toggles them mid-turn too); only `effort: null`,
`/model`, `/compact`, `/undo` and `/redo` need an idle session. `/preset` on a server started
without a switch answers 501. Exports confine `out` with `scopeContains` over the composition's
tool scope. Tests: `server.test.ts` "session verbs (118 K1) over the memory host" (eleven
cases including the typed client and the `?session=` filter), `serve.test.ts` "K0 and K1 under
serve" (eight cases over a real JSONL store and a temp shadow repo). Gate: see the report.

### K2 · tree and diff over HTTP · landed 2026-10-11

Families `packages/server/src/routes/tree.ts` (`GET /sessions/{id}/entries`, `POST
/sessions/{id}/fork`, `/label`, `/leaf`) and `packages/server/src/routes/changes.ts` (`GET
/sessions/{id}/changes`, `GET /sessions/{id}/changes/file?path=`), registered last in
`routeFamilies` in that order. `SessionHost` gains two required sub-ports, `tree:
SessionTreePort` (`entries`, `fork`, `label`, `moveLeaf`, with the string refusals `"missing"`
/ `"unknown-entry"` mapped to 404 and `"busy"` to 409 in the family) and `changes: ChangesPort`
(`list`, `file`, with `"no-baseline"` mapped to 409 `{ error: "no baseline" }`). `/entries`
answers `store.entries()` verbatim beside `leafId`, `labels` (the map as an object) and
`activePath` (ids), so the client runs `buildTree`; `SessionDetail` gains `parentSession`, the
header field as the engine writes it. The per-file rules live in the family (`fileChangeOf`):
NUL on either side answers `note: "binary"` with no text, a missing side answers `new` /
`deleted` / `unreadable`, and each side is capped at `fileChangeCapBytes` (1 MiB of UTF-8, cut
back to a character boundary) with `truncated: true`.

`followMutations` moved into the engine (`packages/engine/src/mutations.ts`, with
`mutatingToolNames`); the TUI's `followMutations(bus, feed)` is now a one-line delegate and its
tests are untouched. The server's `packages/server/src/changes.ts` builds on it:
`ChangesSource` (`label`, `changes`, `before`, `after`) is what a host supplies, `changesPortOver`
turns it into the `ChangesPort`, and `ChangesFeed` follows each agent's bus and records
`changes.updated` with the post-refresh `changedSince` paths (queued, so two rapid mutations
cannot land out of order). `cli/src/serve-changes.ts` supplies the source from the composition's
`Checkpoints` and tool scope (`after` confines the path with `scopeContains` and throws
`WorkspaceScopeError` for 403); `cli/src/serve-tree.ts` supplies the tree port over
`LiveSessions.bound(id)` (fork clones through `store.clone`, label appends through
`store.setLabel`), and `LiveSession.moveLeaf` is the one verb that needs a live session: it
moves the leaf with `moveLeaf` from `sessions/ports.ts`, rebuilds the agent over
`store.messages()`, clears any staged undo, and announces `session.state`. Undo, redo and the
staged restore announce `changes.updated` after their `restoreTo`. The memory host in
`server/src/testing.ts` derives entries from the agent's history (`m<n>` ids, the same
convention its `leafId` already used), forks by slicing it, and takes a `changes` source through
its options. `client.ts` gains `entries`, `fork`, `labelEntry`, `moveLeaf`, `changes` and
`changedFile`.

**Decisions taken (all reversible):** `session.tree` is recorded by the route family after the
verb returns (the only caller over HTTP), while `changes.updated` is recorded by the host
because only the host sees the bus; on `/leaf` the host's `session.state` therefore arrives
before the family's `session.tree`. `session.tree.entryId` is `string | null` so a leaf move to
the root is the same event. `changes.updated.turn` is the highest attributed turn among the
listed paths (the open turn attributes as the last ordinal), absent when no path is attributed.
`parentSession` on the wire is the engine's header value, the parent's file, because
`store.test.ts` pins that contract and the session-removal lane's `forkedFrom` resolves it to a
session; the app reads `forkedFrom` for the link and `parentSession` only as provenance. Both
ports are required on `SessionHost` (as the K1 verbs are) rather than optional with 503,
because every host has an entry log and the no-checkpoints case is the 409. The two tree verbs
that only need the store (`fork`, `label`) run over `bound(id)` without making the session
live. `/changes` on a stored session composes the workspace lazily, as `onLive` does.

**Gaps found, not built:** a label written over HTTP to a live session moves that session's
leaf to the label entry (the store's `persistAsLeaf` contract, same as the TUI), so the next
message parents under the label; harmless but worth a `SessionStore.setLabel` that does not
move the leaf. `/changes/file` reads the working file whole before capping (the TUI does the
same); a 20 MiB cap like `/files` would need a stat first. `changes.updated` fires per mutating
call, so a turn with five writes announces five times; coalescing on a frame tick would need a
host-level scheduler. `Checkpoints.changedSince` snapshots the worktree on every call (`git
add -A`), which is the cost of `/changes` on a large tree.

Tests: `engine/src/mutations.test.ts` (two cases), `server.test.ts` "tree and diff (118 K2)
over the memory host" (five cases: entries, labels, fork with `parentSession`, leaf moves and
their 409, no baseline, `changes.updated` after a write tool, the four notes and the 1 MiB
boundary on ASCII and on a three-byte character, the typed client), `serve.test.ts` "K2 under
serve" (seven cases: a fixture JSONL with a fork, a label, a compaction and a binding round-trips
through `/entries`; fork into a readable session with `parentSession`; label into the file;
leaf move over a live session branching the next prompt; 409 mid-turn; `changes.updated` with
`turn: 1` after a real write through the shadow repo, both sides, binary, 403 and undo / redo;
409 under `--no-checkpoints`; the ports through `servedHost`). The OpenAPI fixture was
regenerated.

Proposed commit message:

```
feat(server): tree and diff route families for keywork serve (118 K2)

GET /sessions/{id}/entries, POST fork, label and leaf, GET changes and changes/file,
with session.tree and changes.updated on /events. followMutations moves from the TUI
into the engine so the server and the pane share one pairing; the TUI delegates.
```

### Serve parity · landed 2026-10-11

The four gaps 115's pickup item 3 named, each closed by giving `serve` the pane's own code
rather than a copy of it.

**Files.** New: `cli/src/session-settle.ts` (`settleSessionTurn`, `compactSessionNow`,
`budgetOf`, `sweepFlushFor`: the settle call both paths make, with the budget and flush lookup
in one place), `cli/src/arc-seams.ts` (`closingSeamFor`, `latestArcActivity`: the arc service
seams both paths pass), `cli/src/serve-workspace.ts` (`composeServedWorkspace`: the served
composition with the arc service, bot memory layers, citation trail and agents wired as
`compose-panes.ts` wires them, plus `attached`, `released`, `close`), `cli/src/mcp-reconnect.ts`
(`reconnectOnRunningServer`, `describeReconnect`). Changed: `cli/src/serve.ts` (`LiveSession`
settles through the agent's own `settleTurnsWith` and `settleToolBatchesWith`, forges agents
with the store's bot, `adoptBinding`, `SessionRuntime.flushes` and `botNamed`,
`HostOptions.closingProvider`; `LiveSessions.compose` and `close` delegate to the served
workspace; `release` goes through `workspace.released`), `cli/src/serve-surfaces.ts`
(`ServedSession.adoptBinding?`, called after an arc or bot binding is written),
`cli/src/compose-panes.ts` (uses the shared settle and seam modules; its private copies are
gone), `cli/src/mcp.ts` (`McpCommandOptions.runningServer`, login reports the reconnect),
`cli/src/main.ts` (`runMcp` resolves the workspace ticket into a client), `server/src/host.ts`
(`SessionState.arc` and `.bot`, `SessionSettlement`), `server/src/events.ts`
(`session.settled`), `server/src/routes/surfaces.ts` (bot binding summary) and the fixture,
`docs/events.md`.

**Shapes.** `session.settled { phase: "after-turn" | "between-tool-batches" | "requested",
flushed, compacted, notices }` on the session's id, recorded only when the settle did
something; `session.state` carries `arc?` and `bot?` and fires after both binding verbs and
when an arc close releases the session. The bot verb rebuilds a live session's agent through
the same `swap` seam K1's undo uses, seeds the bot's `model` as a `model_change` when the
registry resolves it (a later `/model` wins, unbinding keeps the model in force, an
unresolvable seed keeps the session's model with a notice), and answers 409 while a turn runs.
`POST /arcs/{slug}/close` now sweeps each bound live session's memory (`flushNow` over its
store) into the arc layer and runs the closing judgment before the airlock, with the pane's
`direction` steering; `surface.changed` rides the arc service's own subscription as before.
`keywork mcp login <server>` ends by looking for the workspace's serve ticket
(`runningServerAmong(ticketFilesFor(cwd, slug))`) and calling `POST /mcp/{name}/restart` on
it, printing the server's status after; with no server it prints the old restart hint.

**Decisions (reversible).** No new reconnect verb: `restart` already drops the connection and
opens a fresh one, which reads the new token, so a second verb would be the same thing under
another name. The settle under `serve` runs inside the agent's turn (the agent is busy until
it settles, so a prompt that arrives mid-settle queues), which is how the pane does it and
what keeps the once-per-turn rule from 117's mid-run compaction. The between-batches check
uses the conversation estimate (`estimateConversationTokens`, the same reading `GET
/sessions/{id}/context` answers) because `serve` has no ledger of provider-reported usage.
The closing provider under `serve` is `HostOptions.closingProvider` when the host passes one
(`main.ts` does not yet; the `roles.closing` config needs the registry), else the first bound
live session's provider, else the server's own provider, so the judgment always runs when a
session is bound. No auto-polling of the vault anywhere. The bot memory layers (`botMemory`)
and the citation trail now compose under `serve` too, so a bot's bootstrap, skills and flush
target and an arc candidate's cited eligibility match the pane.

**Gaps not built.** The exit sweep the pane runs in its closers (`sweepOnClose`,
`botLayers.sweep`) still does not run when `serve` stops. `keywork chat` keeps its own
settle call in `chat.ts` (it could take `settleSessionTurn` too). `main.ts` does not pass
`closingProvider` from `roles.closing` yet. A session's first turn that uses a tool journals
its `permission_decision` entry before the prompt is persisted, so the compaction planner
(which never cuts at index 0) finds nothing to summarize on that turn; the pane has the same
ordering, so it is an engine planner item rather than a serve one.

**Tests.** `cli/src/serve-parity.test.ts` (5: after-turn flush and compaction with
`session.settled` once per turn, mid-run compaction between tool batches with no second
compaction, bot bind rebuilding the agent with its seeded model and unbinding, 409 while
busy, arc close flushing into the arc layer and distilling through the judgment with the
direction), `cli/src/mcp-reconnect.test.ts` (2), `cli/src/arc-seams.test.ts` (2);
`compose-panes.test.ts`, `mcp.test.ts`, `serve.test.ts` and `packages/server` unchanged in
intent and green. The 118 K2 lane's in-progress tests in `serve.test.ts` were failing in the
shared tree while this landed; the ask-routing test there passed with this lane's changes
applied alone to a clean checkout.

Proposed commit message: `feat(serve): pane parity for settle, bot binding, arc close and
mcp login reconnect`.

### K6 · the themes · landed 2026-10-11

Jordan asked for an Omarchy-grade gallery where one theme dresses every surface. Mid-lane
he renamed the unit: "flavor" is now **theme** everywhere a person sees it and in code.

**Renames (the app lanes mirror these).** Shared: `flavorSchema` → `themeSchema`, `Flavor`
→ `Theme`, `FlavorTokens` → `ThemeTokens`, `FlavorTokenOverrides` → `ThemeTokenOverrides`,
`flavorTokensSchema` → `themeTokensSchema`, `flavorTokenOverridesSchema` →
`themeTokenOverridesSchema`, `parseFlavor` → `parseTheme`; files `config/flavor.ts` →
`config/theme.ts`. Route: `GET /flavors` (`listFlavors`, `{ flavors, active }`) → `GET
/themes` (`listThemes`, `{ themes, active, placeholders }`); `/flavors` is gone; the optional
host port `flavors?: FlavorsPort` → `themes?: ThemesPort` (`FlavorsReport` →
`ThemesReport`), the client's `flavors()` → `themes()`, and `HostOptions.flavor` plus the
token-override `theme` → one `theme` name. Config: the startup key is
`theme` and the overrides key is `palette`; for one release `flavor` still reads as `theme`
and an object under `theme` still reads as `palette` (normalized per layer at load, so
project layers still merge token by token). TUI: its bare-token `Theme` type is now
`Palette` (`ThemeOverrides` → `PaletteOverrides`, `ThemeColorToken` → `PaletteColorToken`,
`resolveTheme` → `resolvePalette`, `themeOf` → `paletteOf`, `theme.ts` → `palette.ts`);
`FlavorSwitch` → `ThemeSwitch` (its `.theme` getter → `.palette`), `startupFlavors` →
`startupThemes`, `registerFlavorCommands` → `registerThemeCommands`, `keyworkNightFlavor`
→ `keyworkNightTheme`, `systemFlavor`/`systemFlavorName` → `systemTheme`/`systemThemeName`,
`AppOptions.flavor`/`flavors`/`themeOverrides` → `theme`/`themes`/`paletteOverrides`;
palette commands are `theme-<name>` and notices say "theme now …".

**Schema.** Optional sections on `themeSchema`, so older files still load: `terminal` (the
ANSI 16 by name), `syntax` (fifteen roles), `diff` (`insertedLine`, `deletedLine`,
`insertedText`, `deletedText`), `selection` (`background`, optional `text`), `cursor`, and
`pair`. Floors in `contrastFailures`: syntax ≥ 30 on panel (comment 15); the six terminal
hues and their bright twins ≥ 30 on background; selection text ≥ 45; text ≥ 60 on both diff
line grounds; cursor ≥ 40. `pair` symmetry and opposite appearance are proved in
`gallery.test.ts`.

**Derivation.** `completeTheme` fills a missing section from the thirteen base tokens and
keeps hand-set ones; the rule is in `docs/themes.md` and the describe strings. Every floored
derived ink steps toward `text` and every derived ground steps back toward its panel, so the
rule always ends on a passing theme. Palette overrides drop the worn theme's hand-set
sections so they re-derive from the new palette.

**Gallery.** Nineteen themes, every section by hand: keywork-night (tokens unchanged) and
keywork-day; catppuccin-mocha/-latte; nord/nord-light; gruvbox-dark/-light;
everforest-dark/-light; kanagawa-wave/-lotus; rose-pine/rose-pine-dawn;
flexoki-dark/-light; matte-black, osaka-jade, ristretto unpaired. Taste: Nord and Gruvbox
`regular`, matte-black and osaka-jade `borderless`, the rest `seams`; gap 1 on Catppuccin,
Everforest, Rosé Pine, Flexoki, and matte-black; `cockpit` on matte-black and ristretto;
density `medium` on accentSoft for Catppuccin and Kanagawa, `full` on error for Everforest,
Rosé Pine, Flexoki, and ristretto. Twenty-six canonical shades were stepped to clear a floor
(Nord's red and the light Nord greens, cyans and yellow; gruvbox-dark's error and dark
terminal red/blue/magenta; everforest-dark's green diff line; Kanagawa's dark terminal red
and invalid; Rosé Pine's border and pine; flexoki-dark's error), each tabled in
`gallery.test.ts` with its canonical value. Sources are recorded in `NOTICE` under "Themes".

**`GET /themes`.** `{ themes: CompleteTheme[], active: string, placeholders: ["system"] }`:
the gallery plus any closet theme (a closet theme replaces a gallery theme of the same
name, via `wardrobe`), each run through `completeTheme` so the wire always carries every
section; `pair` rides on each theme, so no separate `pairs` field. The TUI wardrobe lists
the same gallery, so `theme-<name>` exists for all nineteen. The TUI paints from base tokens
only (its design language keeps syntax inside the tokens), so the sections are for the app.

**Evidence.** Full gate under bun 1.3.9: `check:types`, `lint`, `check:prose`,
`check:pins`, `check:guardrails` and `bun run test` exit 0; the suite is 327 files, 4595
passed, 1 skipped. e2e goldens for chrome-states, tray-tour, and discovery were refreshed
(theme commands now fill the slash completions).

### K7 · trusted reads and ask scopes · landed 2026-10-11

Jordan asked whether trusting a workspace could pre-load read permissions so the app stops
asking for `ls` and `git status` in every session. His three decisions are recorded verbatim
in `50-trust.md` E1: the bundle applies on trust with no second confirmation, it is fixed in
keywork with user rules above it, and grants beyond `once` cover `bash` and MCP tools only.

**Posture.** A trusted workspace gets `trustedReadRules` (listed in `50-trust.md` E1): allow
rules for read-only shell commands plus a few asks for their write-capable forms. An
untrusted workspace and every headless run get nothing new. Decisions under it report
`gate: "trusted"`; an ask it raises reports `rule: "trusted"`.

**`POST /asks/{callId}`.** Body `{ verdict: "granted" | "denied", scope?: "once" | "session"
| "workspace" }`, `scope` defaulting to `once`; a denial ignores it. `session` records the
ask's `rules` for that session; `workspace` records them for every session of the workspace in
`~/.keywork/workspaces/<identity>/permissions.json`. A write or edit answered beyond `once` is
`400 { error: "write and edit are approved once at a time" }`; a call with no rule to derive
(a command whose every part redirects or substitutes, or a tool that is neither bash nor
MCP) is `400 { error: "this call has nothing a grant could remember; approve it once" }`. In
both cases the ask stays pending for a `once` answer. `200`, `404` and `409` are unchanged.

**`gate.ask`** gains `rules: PermissionRule[]`, the candidates a `session` or `workspace`
answer would record (also on each `GET /asks` entry): bash yields one rule per command part,
`{ action: "bash", resource: "<program> <second word> *", effect: "allow" }` when the second
word is a plain word or flag (`git push *`, `rm -rf *`, `npm run *`), else `<program> *`;
parts with redirection or substitution and wildcard program words yield none. An MCP tool yields
`{ action: "<server>__<tool>", resource: "*", effect: "allow" }`. **`gate.permission`** gains
`gate: "trusted"` and an optional `scope`: `once | session | workspace` on an answered ask,
`session | workspace` with `gate: "user"` on a later call an earlier grant covered.

**`GET /permissions`** (`listPermissions`) answers `{ trusted: boolean, bundle:
PermissionRule[], workspace: PermissionRule[], session: Record<sessionId, PermissionRule[]> }`;
`bundle` is empty when untrusted. **`POST /permissions/workspace/revoke`**
(`revokeWorkspaceGrant`) takes `{ rule: { action, resource, effect: "allow" } }` and answers
`200 { revoked: rule }`, `400` on a malformed rule, `404` when no grant matches. The family is
`permissionFamily`, last in `routeFamilies`.

**Layering.** The configured rules (the preset switch) decide first; where they say nothing,
one ordered list decides, last match winning: bundle, then workspace grants, then session
grants. The engine's `PermissionResolver` may now return a `PermissionRuling`
(`{ permission, gate: "policy" | "trusted" }` or `{ permission: "allow", gate: "user",
scope }`); a bare string still means `policy`. `PermissionLedger` in the engine composes the
layers for `serve`, the panes TUI and the line REPL alike. The TUI's and the REPL's `always`
record the derived session rules (and the ask hides `[a]` when there is nothing to remember).

**Evidence.** Full gate under bun 1.3.9: `check:types`, `lint`, `check:prose`,
`check:pins`, `check:guardrails` and `bun run test` exit 0; 329 files, 4685 passed, 1
skipped. New: `shared` `trusted-reads.test.ts` (the bundle's allow, ask and still-asking
tables, a user rule over the bundle, `activePreset` unaffected) and `grants.test.ts`
(derivation, refusals, `SessionGrants`, the strict private store); `server.test.ts` (bundle
with `gate: "trusted"`, empty untrusted bundle, session scope stops the second ask,
workspace grant listed and revoked, write refused beyond once); `serve.test.ts` (a real
`echo` under the bundle runs without an ask while a compound still asks, the session grant,
a workspace grant surviving a reopen until revoke restores the ask); `mutation-ask.test.ts`
and `chat.test.ts` for rule-derived `always`.

### Merge with main · 2026-10-11

`main` (d308505) landed K0 through K4, serve parity and session removal in its own shape
while `app-surface/next` (8f86c05) carried the same lanes in a different one plus K6 and K7.
The merge keeps main's architecture wherever main covers the ground and lands K6 and K7 whole
on top of it. Every conflicted file was rebuilt from main's version with only the K6 and K7
hunks re-applied by hand.

**Dropped from the branch in favour of main.** The branch's route modules `routes/status.ts`
and `routes/presets.ts` (main's `session-verbs.ts` holds `applyPreset`, `undoSession`,
`redoSession`; main's `surfaces.ts` holds the MCP, arc, bot and workspace routes `status.ts`
served); its own `routes/{tree,changes,memory,workspace,session-verbs,sessions,events}.ts`
(main's are kept with main's ids: `readTree`, `labelSessionEntry`, `moveSessionLeaf`,
`readSessionChanges`, `listMemoryInbox`, `readAirlock`, `deliverAirlock`, `finishAirlock`,
`bindSessionBot`); the helper modules `server/src/{tree,memory,reports,spills,testing-surfaces}.ts`
(main's `changes.ts`, `files.ts`, `routes/memory.ts` and `testing.ts` cover them); the spill
route `readSpill` (main serves spills through `GET /files` with `elidedFrom`/`elidedTo`);
`engine/src/usage-ledger.ts` with `costBasis` in `pricing.ts` and the TUI `SessionLedger`
rewrite (main keeps `SpendLedger` in serve and `costBasisOf` in the verbs family);
`engine/src/memory/curing.ts` (main computes `curingStage` in `cli/src/memory.ts` and the
memory family); `session.tree` and `changes.updated` on the engine bus (main records them as
server events); the branch's `cli/src/serve-workspace.ts` workspace host, `serve-surfaces.ts`
and `sessions/store.ts` summary fields (main's `serve-workspace.ts`, `surfacePorts` and
`storedSummary` cover them); `setupRoot` exported from `workspace-setup.ts`;
`refusalResponse` and the query helpers in `routes/family.ts`; `Agent.setEffort(undefined)`;
the TUI's `browser-model` and `IgnoreRules` exports; `followMutations(bus, emit)` in the diff
model tests; and the K1 and spill cases in `client.test.ts`. Tests that exercised those
shapes went with them.

**K6 and K7 in main's shape.** `routes/flavors.ts` became `routes/themes.ts` (`themeFamily`,
`listThemes`, 503 without the port, every theme through `completeTheme`); `serve-surfaces.ts`
answers the gallery from `wardrobe()` with `active` from `HostOptions.theme` and
`placeholders: ["system"]`; the memory host lists `MemorySurfaceOptions.themes`.
`routeFamilies` is document, events, sessions, asks, memory, airlock, sessionVerbs,
workspace, files, surfaces, themes, tree, changes, lifecycle, permissions: fifteen families,
66 paths, 72 operations in `/doc`. `SessionHost` gains `answerAsk(callId, verdict, scope?)`,
`permissions()` and `revokeWorkspaceGrant(rule)` as required methods beside `asks()`;
`fileSessionHost` and `servedHost` build one `ServedGate` (the `AskQueue` with the
`PermissionLedger` from `workspacePermissions` as its grant sink) and every session's agent
takes `ledger.resolverFor(id)` through `AgentBuildSpec.permissions`; the memory host takes
`trusted?` and a `memoryGrants()` ledger the same way. The client's `answerAsk` passes
`scope` and maps the two 400 refusals to `write-once` and `nothing-to-remember`.
`docs/events.md` is main's text with K7's paragraphs under `gate.ask` and `gate.permission`.

**Evidence.** Under bun 1.3.9: `check:types`, `lint`, `check:prose`, `check:pins`,
`check:guardrails` and `bun run test` exit 0; 346 files, 4797 passed, 1 skipped. The OpenAPI
fixture was regenerated from the composed document. e2e: the discovery golden was rewritten
for main's `/extensions` beside the theme commands. Six scenarios (first-conversation,
lsp-loop, chrome-states, chrome-states-ascii, arc-fold, diff-pane) waited for the
`[y] allow  [a] always  [n] deny` row on a write ask, which K7 shortens to `[y] allow  [n]
deny` (they failed the same way on 8f86c05 alone).
The e2e goldens were updated for the K7 ask row: the five `*-needs-you-*` captures under
`chrome-states` and `chrome-states-ascii` changed in that row only, and all 49 scenarios pass.
