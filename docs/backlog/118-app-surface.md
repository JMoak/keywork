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
