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

### K2 · tree and diff · landed 2026-10-07

`packages/server/src/routes/tree.ts` (`GET /sessions/{id}/entries`, `POST …/fork`, `POST
…/label`, `POST …/leaf`) and `routes/changes.ts` (`GET …/changes`, `GET …/changes/file?path=`),
registered last in `routeFamilies`; `host.ts` grows `entries`, `fork`, `label`, `moveLeaf`,
`changes`, `changedFile`; `tree.ts` (`entriesOf`, `moveLeafOf`, `treeChange`) and `changes.ts`
(`changedFilesOf`, `changedFileOf` with the 1 MiB per-side cap, `announceChanges`) are the
helpers both hosts share. `followMutations` moved from `tui/src/diff-model.ts` to
`engine/src/mutations.ts` so the TUI feed and the server announce from one pairing. Two bus
events, `session.tree { sessionId, leafId, reason, entryId?, forkedTo? }` and
`changes.updated { sessionId, paths }`, in `EngineEvents`, `engineEventTypes`, `docs/events.md`
("Tree and files"). `fileSessionHost` composes checkpoints as the TUI does (`checkpointsGitDir`
on `HostOptions`, the guard's `beforeMutation` captures, `persistNewMessages` takes the turn
tag), which is K0's first half and a one-line overlap with K1 at the former `checkpoints: "off"`
site; `/leaf` rebuilds the agent over the shorter path and refuses 409 while busy; untrusted
answers `{ trusted: false, files: [] }`. The memory host keeps a `SessionStore` per session in a
temp dir and takes a `ChangeSource | "untrusted"` seam. `client.ts` gains one method per route.
Tests: `server.test.ts` 28 → 38, `serve.test.ts` 8 → 12, `/doc` fixture regenerated with the
six rows. Not done: `session.state` after a leaf move (K1 owns it), `/changes` 409 under the file
host (only reachable when the shadow repo cannot open; covered through the memory host).

### K3 · landed 2026-10-07

`packages/server/src/routes/workspace.ts` (`GET /workspace`, `GET /tree?path=`,
`GET /files?path=&from=&to=`, `POST /workspace/trust`, `GET /flavors`) and
`routes/status.ts` (`GET /mcp`, `POST /mcp/{name}/restart`, `POST /mcp/{name}/enabled
{ enabled }`, `GET /mcp/{name}/tools`, `GET /arcs`, `POST /arcs { slug? }`,
`POST /arcs/{slug}/close { direction? }`, `POST /arcs/{slug}/abandon`,
`POST /sessions/{id}/arc { slug | null }`, `GET /bots`, `POST /bots`,
`POST /sessions/{id}/bot { slug | null }`, `GET /workspaces`, `POST /workspaces { slug }`,
`POST /workspaces/use { slug | null }`, `POST /workspaces/{slug}/focus|unfocus { dir }`),
registered last in `routeFamilies`; `/doc` fixture regenerated (28 paths). Two families
rather than four because the status surfaces share one host seam and one event.
`SessionHost` grows `WorkspaceHost` and `SurfaceHost`; refusals travel as `HostRefusal
(status, message)` thrown by the host and answered by one `.catch` in `server.ts`, so a
handler is one line. The file host lives in `cli/src/serve-workspace.ts` (tool jail via
`confinedPath(workspaceToolScope(...))` resolved against the anchor root, `.gitignore` rules
read along the path exactly as the browser accumulates them, byte ranges through
`sliceBounds`) and `cli/src/serve-surfaces.ts` (the TUI ports over HTTP: `arcService`,
`botService`, `workspacesPort`, `McpRegistry`); `serve.ts` composes `arcService` into
`composeAgents`, attaches each adopted store, and rebuilds a session's agent over the same
bus for a bot switch. The memory host mirrors every verb in `server/src/testing-surfaces.ts`.
`surface.changed { kind }` is the first entry of `serverEventTypes`; `BusEnvelope.type` is the
union, `EventLog.surfaceChanged(kind)` records it with an empty `sessionId`, and
`keywork attach` drops non-engine envelopes before relaying to its local bus. `docs/events.md`
gains the "Server events" section. Tests: 66 → 102 across server, serve and attach (51 in
`server.test.ts`, 21 in `serve.test.ts`, the MCP fixture through toggle and restart, real arcs
through the airlock, a junction out of the root refused).

Deviations from the table, all recorded in `/doc` summaries: `/tree` has no `hidden=`
query (entries carry `hidden`, the client filters, per 118-2); `/files` adds `eof` beside
`truncated` and checks the requested slice for NUL rather than the whole file; `/flavors`
answers `placeholders: ["system"]` rather than omitting it (Q-AS8 taken as yes, reversible
in one line); `/workspace/trust` answers `reopens: false` when trust was already recorded,
and does not materialize a declaration (that is `/init`'s second half, not `keywork trust`);
`/mcp/{name}/enabled` takes `{ enabled }`, not `{ on }`; a bot's pinned model is ignored under
`serve` until K0 gives sessions their own provider. Context-dir linking stays off the wire
(Q-AS7).

### K4 memory · landed 2026-10-07

`packages/server/src/routes/memory.ts` (new, registered last in `routeFamilies`): `GET
/memory`, `GET /memory/inbox`, `POST /memory/inbox/{id}/approve|discard`, `GET
/memory/notes[?layer=]`, `GET /memory/notes/{name}[?layer=]`, `GET /memory/daily[/{date}]`,
`GET /memory/ledger`, `POST /memory/ledger/{id}/revert` (`needs-rebase` is a 200 outcome),
`POST /memory/ask { query, arc? }` (the pane's `?`: lexical or hybrid search, no model call,
20 hits, 2000-character query cap), and the airlock verbs `GET /arcs/{slug}/airlock`, `POST
.../candidates/{note} { choice }`, `POST .../questions { title, choice }`, `POST
.../deliver`, `POST .../finish { force? }`. `finish` stages the close review itself when none
is staged (the TUI reaches that through `/arc close`, which K3 owns), so a client can walk
finish → digest → triage → finish without a close route. `StagedItem` and `Note` cross the
wire as the engine's own rows (a bot layer's items gain only `bot`), so the in-flux staging
kinds are wire renames only; the family holds no `kind` switch.

The host grew one port: `SessionHost.memory: MemoryHost` (`host.ts`), built by
`memoryHost(seams)` in `packages/server/src/memory.ts` over an async `MemoryWorkspace`
(`vault`, `arcs`, `airlock`, `botInbox`). `fileSessionHost` composes `arcService`, `botMemory`
and the citation trail into `keywork serve` (`cli/src/serve.ts`) and recounts the inbox after
every settled turn; `memorySessionHost` takes a `memory` seam. Inert workspace: reads answer
`{ trusted: false, ... }` empties, writes 403 with `MemoryInertError`'s exact message.

`memory.inbox { count, kinds }` is the first **server event**: `serverEventTypes` beside
`engineEventTypes` in `events.ts`, `EventLog.announce` records it with an empty `sessionId`,
the envelope schema's `type` enum is their union, `docs/events.md` gained the "Server events"
section (the threshold of 3 stays client-side, P2.4 rising edge), `engine/src/bus.test.ts`
holds only the engine section to its rule and `server.test.ts` the server one. The payload
is `kinds` (a tally per engine kind) rather than 118-3's five named counts, so a new kind
needs no server change. `remote-ports.ts` relays engine events only.

Engine touched additively: `memory/curing.ts` (new; `curingStage` moved from `cli/src/
memory.ts`, which re-exports it) and one index line. Tests: `server.test.ts` 32 → 42 (every
route's inert and live shape against a temp vault through `MemoryStore`, approve/discard with
the event and the audit lines, every staged kind passing through verbatim, notes by layer,
daily, revert incl. `needs-rebase` after an outside edit, ask layered with an arc, the
airlock mapping with its 400/404/409s), `serve.test.ts` 8 → 11 (inert file host, approve
through the composed vault, the real airlock walk: bound session, `finish` → `undecided`,
carry → successor, `finish` → `closed`, binding released on disk), `openapi-document.fixture.
json` regenerated for the sixteen new rows.

### Integration of K2, K3 and K4 · 2026-10-07

The three lanes were folded onto one branch (`app-surface/all`) in lane order. Where they
met: `serverEventTypes` is one list, `["surface.changed", "memory.inbox"]`, with
`eventTypes` the engine ∪ server union and one `isEngineEventType` guard; `EventLog.announce`
is the single process-level recorder (K3's `surfaceChanged(kind)` became
`announce("surface.changed", { kind })`); `routeFamilies` runs document, events, sessions,
asks, tree, changes, workspace, status, memory, and the `/doc` fixture was regenerated from
that composition; `fileSessionHost` composes `arcService` once (with K4's `flushFor` and
`citedNotes`) and carries K2's checkpoints, K3's surfaces and K4's `botMemory`, citation
trail and inbox recount side by side; the memory host keeps K2's per-session stores and
takes K3's `surfaces` and K4's `memory` seams; `docs/events.md` has one "Server events"
section holding both events. K1 folds in by the same procedure (`C:\src\keywork-lanes\INTEGRATION.md`).

### K0 + K1 · landed 2026-10-07

**What landed.** `keywork serve` now composes checkpoints exactly as the TUI does (`compose`
default, the shadow repo under `snapshotGitDir`, no trust gate; `--no-checkpoints` keeps the
old behavior), wires `guard.beforeMutation` to `capture()` and tags each user message
through `persistNewMessages(…, checkpoints)` as `chat.ts` does. Inference is per session:
`HostOptions.inference: SessionInference` (`bind(selection) → { provider, reference } |
failure`, built in `main.ts` from the runtime's `resolve({ override, selection, default })`)
and `LiveSessions.providerFor(store)` reads `store.modelSelection()`; the session's
`thinking_level_change` and `effort_change` entries are applied on adopt. `SessionHost`
gained `checkpointsOf(id)` (`CheckpointReads | "missing" | "off"`, the capability K2's
`/changes` reads through) and one method per verb. New family
`routes/session-verbs.ts` (`/model`, `/thinking`, `/effort`, `/compact`, `/undo`, `/redo`,
`/context`, `/cost`, `/export`, `/rename`) and `routes/presets.ts` (`POST /preset`),
registered last in that order; `/prompt` gained `behavior` (default `queue`) and answers
`{ sessionId, accepted, queued, behavior }`; `/events?session=` filters per 118-4 and
`&only=session` was one boolean, so it shipped (Q-AS5 answered by code). `SessionSummary`
gained `model`, `thinking`, `effort` (stored and live). `session.state` is the first server
event: `serverEventTypes` beside `engineEventTypes`, `eventTypes` their union in the `/doc`
envelope enum; `docs/events.md` gained a "Server events" section and the `?session=`
paragraph, and `bus.test.ts` scans only the engine sections. The retired-model map moved
from `tui/session-ledger.ts` into the engine as `UsageLedger` (with `costBasis` in
`pricing.ts`), so `/cost` answers the honesty line and a `models` row per reference, and a
model switch no longer zeroes the session's spend; the TUI ledger delegates to it. `client.ts`
has one method per route; `remote-ports` relays only engine events to an attached pane.

**Evidence.** `server.test.ts` 21 → 34 cases (memory host: every verb's 2xx/400/404/409,
steer ahead of the queue, the filter in replay and live with `Last-Event-ID`, `session.state`
payloads, `/preset` with `gate.preset` at `sessionId: ""`); `serve.test.ts` 8 → 17 (the
checkpoint tag on the user message and `canUndo()` after a `write`, `checkpoints: "off"`
leaving no tag, a stored `model_change` + thinking + effort reaching the provider request
and `GET /sessions/{id}`, undo putting `note.txt` back to the previous turn and redo restoring
turn and file, compaction over a real store with a focus, export inline / to a workspace
directory / refused outside it, rename persisted to the JSONL, the preset port and its
absence); `client.test.ts` 11 → 12; `openapi-document.fixture.json` regenerated with the
eleven new rows. Full suite: 4250 passing, the only misses two 5 s timeouts under load in
`cli/src/arcs.test.ts` and `cli/src/compose.test.ts` (untouched here, green in isolation);
`bun run check` green under bun 1.3.9.

**Findings.** `turn.completed` fires before the turn's messages are persisted, so the
rewriting verbs (`/model`, `/compact`, `/undo`, `/redo`) answer 409 while busy and otherwise
wait for the pending persist before touching the store. Compaction's `budget` comes from the
provider's declared `contextWindow`, so `/compact` on an undeclared model assumes 200k like
the TUI. `exportSession` writes into an existing directory or to a file path; it never creates
the directory (TUI parity).

**Assumptions Jordan may reverse.** `/rename` pins by construction: the TUI's `adoptTitle`
sets `titleRequested`, so a stored name is never re-titled, and `serve` runs no titler at all
(Q-AS3, no extra flag). `effort: null` records an `effort_change` entry of `"default"`, which
`effortOf` reads back as "provider decides" (Q-AS3). `/cost` `models` rows are the
in-process ledger, not the JSONL (Q-AS4: the map moved to the engine, so lineage is real for
this process and starts empty on adopt, like the TUI's). `POST /preset` persists to the user
config through `userPresetSwitch`, with `--preset` seeding the switch's initial rules; a body
`confirmed: true` is the whole confirmation (Q-AS2). `/undo` with no prompt on the path falls
back to a files-only `checkpoints.undo()` and answers `prompt: null`. The memory host's
`/compact` answers `compacted: null` with a notice saying it keeps no store, and its `/export`
refuses `out`.

### Integration onto main + K1 + spills · landed 2026-10-10

Branch `app-surface/next`, based on `bc33378` (main after PR #6, agentbox). Main already held
the wave-0 route split byte for byte, so those hunks did not apply and nothing about them
needed resolving. The K2+K3+K4 integration (`app-surface/all`) was taken as one delta against
its reconstructed base (25e9f67 plus `wave0-server.patch` plus the wave-0 files, with main's
own copy of this document as that file's base) and applied with `git apply --3way`; K1 was
folded the same way on top. Agentbox touched none of `serve.ts`, `host.ts` or `testing.ts`;
the only server-contract change it made is the engine event `extension.notice`.

| File | Sides | Resolution |
|---|---|---|
| `packages/engine/src/bus.ts` | main, K2 | Both: `extension.notice` beside `session.tree` and `changes.updated` in `EngineEvents`. |
| `packages/engine/src/bus.test.ts` | main, K2, K1 | Both list entries; K4's `serverEventsHeading` split kept over K1's literal. |
| `packages/server/src/events.ts` | main, K2, K3+K4, K1 | One `ServerEvents` with `surface.changed`, `memory.inbox`, `session.state` (K1's `SessionState` import); one `serverEventTypes`; `eventTypes` the `as const` union; `vocabularyIsComplete` over the whole `EventType`; one `isEngineEventType`; `processLevelSessionId` kept. |
| `packages/server/src/server.test.ts` | main, all, K1 | Rebuilt from the pre-K1 merge plus K1's edits (D7 loop over `engineEventTypes`, `/prompt` answer with `queued` and `behavior`) and K1's four describe blocks appended; git had interleaved K1's blocks into K2's. `samplePayloads` carries all three engine additions. |
| `docs/events.md` | main, K2, K3+K4, K1 | `extension.notice` section, then "Tree and files"; one "Server events" section whose intro now says which server events are process-level (`surface.changed`, `memory.inbox`) and that `session.state` carries its session's id; sections in order `surface.changed`, `memory.inbox`, `session.state`. Envelope `sessionId` row merged. |
| `docs/backlog/118-app-surface.md` | K2..K4, K1 | Both ledgers, K1's after the K2..K4 integration entry. |
| `packages/server/src/host.ts` | all, K1 | Imports unioned; K2's tree and change types and K1's `SessionState`; K1's `PromptOutcome` (`started \| queued \| missing`); all's outcome types and `HostRefusal` then K1's; `SessionHost extends WorkspaceHost, SurfaceHost` carrying both verb sets. |
| `packages/server/src/index.ts` | all, K1 | One events export block and one host export block holding every name. |
| `packages/server/src/openapi.ts` | all, K1 | `routeFamilies`: document, events, sessions, asks, tree, changes, workspace, status, memory, sessionVerbs, presets (K1 added two families; appended after memory). Envelope `sessionId` description: "empty for a process-level server event". |
| `packages/server/src/client.ts` | all, K1 | Both method sets and imports (deduplicated). |
| `packages/server/src/testing.ts` | all, K1 | One store-backed `MemorySession`: K1's agent swap, ledger, `session.state` and verbs over K2's per-session `SessionStore`, persist and tree events, inside all's `MemorySessions` (K3 bindings, K4 memory seam). Undo and redo move the store's leaf instead of slicing agent history, so the store and the agent never disagree; the undone prompt's `entryId` is now the real entry id (K1's test expected `m0`), and `/compact` says "this host never compacts". `gate.preset` records at `processLevelSessionId`. |
| `packages/cli/src/serve.ts` | all, K1 | Hand-merged: K1's `HostOptions` (`inference`, `presets`, `checkpoints`) beside K3's; K1's per-session provider, settings adoption and verbs on `LiveSession`; all's `Composed` with `arcService`, `botMemory` and citations composed once; one `AgentBuild` seam (history, provider, bus, bot) so model switches, compaction, undo and leaf moves keep a bot; `switchBot` and `moveLeaf` became `LiveSession` verbs that swap in place (queue adopted, ledger kept) instead of K2's release-and-readopt; K4's `afterTurn` recount after persist; K1's "can't undo files" notice. |
| `packages/cli/src/serve.test.ts` | all, K1 | Rebuilt like `server.test.ts`; K1's undo test now waits for `session.state` by type, since K2's `session.tree` and `changes.updated` arrive first. |
| `packages/cli/src/remote-ports.ts` | all, K1 | All's shared `isEngineEventType`; K1's private copy dropped. |
| `packages/cli/src/sessions/ports.ts` | main, K1 | Main's `contextEditTarget` kept; `rewindBefore` exported for K1. |
| `packages/server/src/sse.ts` | K1 | Clean apply; the `?session=` filter compares against `processLevelSessionId`. |

Two parity fixes rode along. Serve's tool guard now calls `checkpoints.beginTurn()` before
each turn, as agentbox made `chat.ts` do, and serve passes the session's `SpillStore` to
`agents.build`, so a served session spills oversized tool output exactly as the TUI does
(before this, serve kept whole outputs in the transcript). A leaf move now announces
`session.state` on both hosts, the gap K2's ledger left for K1.

**Spill route.** `GET /sessions/{id}/spills/{spillId}?from=&to=`, a row in the sessions
family (operation `readSpill`). The engine already keys spills: `SpillReference.id` is a
UUID minted by `SpillStore.keep`, the file is `<session>.spills/<id>.txt` beside the JSONL,
and the reference carries `bytes`, `elidedFrom` and `elidedTo`. The answer is `/files`'s
slice with `spillId` for `path`: `{ spillId, bytes, from, to, text, truncated, eof,
encoding: "utf-8" }`, `[from, to)` defaulting to the whole spill, cut to 1 MiB with
`truncated: true`. 400 when `from` or `to` is not a whole number; 404 for an unknown session
(`no session has that id`) or an unknown or malformed spill id (`no spill <id> in this
session`; ids outside `[A-Za-z0-9-]{1,64}` never reach the filesystem); 415 when the slice
holds a NUL. A stored session answers without being made live. `spillSliceOf` in
`server/src/spills.ts` serves both hosts; `SessionHost.spill`, `SpillSlice`, `SpillOutcome`
and `client.spill(id, spillId, range?)` are the new surface.

**Vocabulary and `/doc`.** `engineEventTypes` (19): turn.started, turn.delta,
turn.completed, turn.interrupted, queue.changed, tool.started, tool.output, tool.finished,
gate.ask, gate.permission, gate.preset, session.mode, context.injected,
diagnostics.published, shell.reset, extension.notice, session.tree, changes.updated,
engine.error. `serverEventTypes` (3): surface.changed, memory.inbox, session.state. `/doc`:
62 paths across eleven families; the fixture was regenerated from the composed document.

**Evidence.** `server.test.ts` 98, `serve.test.ts` 38, `client.test.ts` 13, `attach` 17,
`remote-ports` 7, `bus.test.ts` 7, `openapi.test.ts` 2. Full gate under bun 1.3.9:
`check:types`, `lint`, `check:prose`, `check:pins`, `check:guardrails` and `bun run test`
all exit 0; the suite is 325 files, 4533 passed, 1 skipped (the pre-existing skip).

### Findings from the app's side · 2026-10-10

keywork-app's wave 5 consumed every route above (K1 through the spill route) and drove the
wave-2 panes against a real `keywork serve`. What it found, each a candidate row for the open
ledger:

- **`keywork serve` refuses a second workspace.** Serve writes the user-level
  `~/.keywork/server.json` for every workspace and `runningServerAmong` treats any live ticket
  there as this workspace's server, so with workspace B serving, `keywork serve` in workspace A
  exits 2 with "a keywork server for this workspace is already listening at …". `keywork attach`
  shares the mix-up. Fix: check `/doc`'s `info.workspace.identity` before trusting a ticket, or
  stop writing the user-level ticket now that the per-workspace one exists.
- **The identity rule is not on the wire before connecting.** A client that wants the
  per-workspace ticket must re-derive `workspaceIdentity` (the app does, pinned by fixtures
  computed from keywork itself). Documenting the rule, or `keywork identity`, removes the drift.
- **`/doc` is unauthenticated, so a client cannot check a token without a side effect.** The
  app probes `/asks`. A cheap authenticated ping would be honest.
- **No `GET /preset` and no `GET /models`.** The app learns the active preset only from the
  first `gate.preset` and builds its model list from session summaries and the `known` /
  `available` / `candidates` lists in a 400 refusal.
- **Refusals told apart only by text.** `/preset` answers 409 both for "loosening needs
  `confirmed: true`" and "this process has no preset switch"; `/undo` answers 404 both for a
  missing session and "nothing to undo", and 409 both for busy and already-staged. A `code`
  field beside `error` would make clients robust.
- **`costBasis` says "metered by the provider" when nothing was priced** (`meteredTurns ===
  pricedTurns` is true at 0 and 0).
- **`GET /flavors` serves only `keywork-night`** plus the `system` placeholder, not
  `keywork-day` or user flavor files.
- **`/memory/ledger` discard entries carry only the staging path**, so a client can show
  `discard .staging/<uuid>.md` but not the note's name.
- **An untrusted workspace still lets the agent write in the root** (`write proof.txt`
  succeeded with `projectTrusted: false`): not a bug, but client copy must not claim read-only.
- **`/prompt` and `/inject` are text-only** although agentbox added `promptMessage(text, images)`.
- **File-host undo sends `session.state` but not `session.tree`**; `docs/events.md` still lists
  `engine.error` under "Tree and files".

### K6 · the themes · landed 2026-10-11

Jordan asked for an Omarchy-grade gallery where one theme dresses every surface. Mid-lane
he renamed the unit: "flavor" is now **theme** everywhere a person sees it and in code.

**Renames (the app lanes mirror these).** Shared: `flavorSchema` → `themeSchema`, `Flavor`
→ `Theme`, `FlavorTokens` → `ThemeTokens`, `FlavorTokenOverrides` → `ThemeTokenOverrides`,
`flavorTokensSchema` → `themeTokensSchema`, `flavorTokenOverridesSchema` →
`themeTokenOverridesSchema`, `parseFlavor` → `parseTheme`; files `config/flavor.ts` →
`config/theme.ts`. Route: `GET /flavors` (`listFlavors`, `{ flavors, active, placeholders }`)
→ `GET /themes` (`listThemes`, `{ themes, active, placeholders }`); `/flavors` is gone; host
port `flavors()` → `themes()`, `FlavorsView` → `ThemesView`. Config: the startup key is
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
