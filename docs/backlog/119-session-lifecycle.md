# 119: Session lifecycle: remove, restore, trash

> **Kind:** scoping overlay + work plan (2026-10-11). It owns session removal and restore across
> every surface: the engine primitive, `keywork sessions remove`, `restore`, `trash` and `purge`, the
> TUI's remove key and trash view, and the `keywork serve` family (`DELETE /sessions/{id}`,
> `/trash`). Where it speaks it wins over [`20`](20-sessions.md) and over the session rows of
> [`118`](118-app-surface.md). Jordan called the absence of removal "an essential oversight";
> this overlay closes it.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only. Pi and OpenCode are
> MIT and adapted only with attribution in `NOTICE`; nothing here lifts from either. Crush is
> never a source. The user commits; agents never `git commit` or `git push`. Every task below
> is `OWN`.

## What and why

A session is two things on disk: `<sessionDir>/<stamp>.jsonl` (the entry log) and, when a tool
spilled, `<sessionDir>/<stamp>.spills/` beside it (`engine/src/session/spill.ts`,
`spillDirFor`). Until this overlay the only thing that ever deleted either was the empty-file
cleanup `keywork sessions list` offers (`cli/src/sessions/command.ts`,
`offerEmptySessionCleanup` → `removeSessionFiles`). Nothing removed a used session: no engine
primitive, no subcommand, no key in the sessions overview, no route. A workspace accumulated
every false start forever, and `GET /sessions` listed them all to the app.

Removal has to be safe to get wrong. A session is the record of work, memory notes cite it by
`origin_session`, forks point at it, arcs and bots count it. So removal is a move, never an
unlink: the pair goes to `<sessionDir>/.trash/` with its names intact, every reader of the
session directory stops seeing it at once (they read `*.jsonl` at one level and never descend),
and `restore` is the same move back. Only `purge` deletes, and it asks.

## Where the tree stands (2026-10-11)

Facts from source that shape the design (cited per decision):

- **Readers of the session directory** all go through `sessionFileNames` in
  `cli/src/sessions/store.ts:144` (`readdir` filtered to `*.jsonl`); `scanSessions`,
  `listSessions`, `findSession` and `latestSessionFile` build on it. A subdirectory is invisible
  to them by construction, so `.trash/` needs no filtering anywhere.
- **The store holds no file handle.** `SessionStore` appends with `appendFile` per entry
  (`engine/src/session/store.ts:314`) and keeps only the path. Moving the file under an open
  store does not fail; it makes the next append recreate the file at the old path. That is why
  an open session must be released before its files move (119-3).
- **`parentSession` is a path, not an id** (`store.clone`, `store.ts:271` writes the parent's
  file path into the fork's header). Nothing in `packages/*` reads it back; the only readers are
  two tests. A missing parent therefore breaks nothing today; the surfaces in 119-4 add the one
  honest reader.
- **Arc bound counts and bot usage are scans**: `boundSessionCounts` (`cli/src/sessions/
  ports.ts:251`) and `botUsage` (`cli/src/bots.ts:146`) rescan the directory on every read.
  A trashed session leaves both at once with no bookkeeping.
- **Checkpoints are process-level.** `Checkpoints` (`engine/src/checkpoints.ts`) is one shadow
  repo per workspace with a bounded undo stack; the only per-session fact is the tree hash
  stamped on each user `MessageEntry.checkpoint`, which lives in the JSONL and moves with it.
  There is no per-session ref to drop.
- **Live sessions in `serve`** are `LiveSessions.live` (`cli/src/serve.ts`), each a
  `LiveSession` that owns an agent, a shell and a journal tap; `close()` interrupts, waits for
  the turn to settle, flushes the journal and closes the shell. In the TUI a pane owns the
  attachment; `paneSessionIndex.closed(paneId)` releases it through `SessionPort.release`, which
  `compose-panes.ts` maps to dropping the store, the agent, the arc binding and the extension
  host's session.
- **The TUI confirms in-pane with a pending state and one key**: `workspaces-pane-model.ts`
  holds `pendingSwitch`, renders a line, and `handleConfirmKey` acts on Enter and cancels on any
  other key. The sessions overview (`sessions-overview-model.ts`) is shared by the session tree
  pane, the arcs pane (drilled) and the arc pane, so a key added there reaches all three.

## Decisions of record

**119-1 · Removal is a move to `.trash/`, never an unlink.** `<sessionDir>/.trash/` holds the
JSONL and its `.spills/` directory under their original names. `restore` moves them back;
`trash` lists what is there (summarized exactly as `list` summarizes a live session, because
the trash is a session directory like any other); `purge` deletes the trash, with a confirm. The
empty-session cleanup `list` offers routes through the same move. No `--older-than`: moving
preserves mtime, which is the session's last activity, and inventing a trashed-at stamp (a
sidecar, a renamed entry) is more machinery than the flag is worth; the trash listing shows
each session's age instead, and `purge` is one confirm.

*Amended 2026-10-12 by [`120`](120-subagents.md) 120-13:* a session's files are now three, the
log, its spill dir and its child dir (`<stem>.children/`), named by `sessionFileSet`, which
replaces `sessionFilePair`; every move, discard and purge carries the children with their
parent.

**119-2 · The engine owns the primitive.** `engine/src/session/trash.ts` exports
`SessionTrash` (`put(file)`, `restore(file)`, `files()`, `purge()`, `dir`) beside `spill.ts`,
with the file-pairing rule (`sessionFilePair`: the JSONL and its spill dir) in one place. A move
refuses to overwrite: a name already present at the target throws. `removeSessionFiles` stays
as the one unlink and is what `purge` runs per pair.

**119-3 · Running refuses, open releases.** A session with a running turn refuses removal
(CLI: the reason on stderr and exit 1; HTTP: 409 `{ error: "a turn is running" }`; TUI: one
notice). An idle session that is open is released first, then moved: the TUI closes its pane the
way pane close does (`AppCore.discardPane(id)`, reachable to panes as `PaneIntents.closePane`),
which releases the attachment through the same seam `/undo` and pane close use; `serve` runs
`LiveSession.close()` and drops the live entry.

**119-4 · Forks keep `parentSession`; readers tolerate a missing parent.** The header is not
rewritten. The one reader this overlay adds, `forkOrigin(store)` in
`cli/src/sessions/lifecycle.ts`, resolves the path to `{ sessionId?, removed }`: the parent in
the session directory (`removed: false`), in the trash (`removed: true` with its id), or gone
(`removed: true`, no id). `GET /sessions/{id}` carries it as `forkedFrom`; the session tree
pane's entries title says `fork of <id8>` or `fork of a removed session`.

**119-5 · Arcs, bots, memory, checkpoints are untouched by design.** Arc bound counts and bot
usage are scans, so they drop on their own (tested). Memory notes the session wrote stay,
because they carry `origin_session` and `keywork memory forget --session <id>` is the reviewed
way to drop them; the CLI confirm line and the TUI notice say so in a few words. Checkpoints
have no per-session ref (see the facts above), so nothing is dropped and nothing needs to be.

**119-6 · Surfaces.** `keywork sessions remove <idPrefix>` (confirm unless `--yes`),
`restore <idPrefix>`, `trash` (`--json` honoured), `purge` (confirm unless `--yes`). The sessions
overview gets `x` with an in-pane confirm (Enter removes, any other key cancels) wherever the
overview model is hosted (session tree pane, arcs pane drilled into an arc, arc pane); the
session tree pane gets `t` to show the trash, where Enter restores and Escape returns. `keywork
serve` gets the family `routes/lifecycle.ts`: `DELETE /sessions/{id}` (200 the removed
summary, 404, 409 busy), `GET /trash`, `POST /trash/{id}/restore` (201 the restored summary),
`DELETE /trash/{id}`, `DELETE /trash` (purge, 200 `{ purged }`), behind an optional
`SessionHost.lifecycle` port in the K3 / K4 pattern (503 when a host lacks it). `HttpMethod`
grows `DELETE`. Events `session.removed` and `session.restored` carry `{ sessionId }` at process
level (empty `sessionId` envelope, the way `memory.inbox` does). The client gains one method per
route. keywork-app needs nothing new: `GET /sessions` stops listing the removed id.

## Tasks

### L1 (1pt): the engine primitive

`engine/src/session/trash.ts`, exported through `engine/src/index.ts`. **Accept:** `put` moves
a JSONL with and without a spill dir, `restore` brings both back, `files()` lists only JSONLs in
the trash, `purge` empties it, a collision at either end throws and moves nothing.

### L2 (1pt): the CLI

`cli/src/sessions/lifecycle.ts` (`removeSession`, `restoreSession`, `listTrash`, `purgeTrash`,
`forkOrigin`) and the four subcommands in `command.ts`; `main.ts` gains `--yes`. **Accept:** each
subcommand's happy path and refusal on a real directory; `list` no longer shows a removed
session and `trash` does; the empty cleanup trashes; a fork of a removed parent still lists,
opens and reports its origin; `boundSessionCounts` and bot usage drop after a remove.

### L3 (1pt): the server family and `serve`

`server/src/routes/lifecycle.ts`, `SessionHost.lifecycle`, `client.ts`, `events.ts`,
`docs/events.md`, the memory host in `testing.ts`, `LiveSessions` in `serve.ts`. **Accept:**
every route's 2xx, 404, 409 and 503 under `server.test.ts`; under `serve.test.ts` a live idle
session is closed and moved, a busy one answers 409, a stored one moves, `GET /sessions/{fork}`
reports `forkedFrom.removed`, both events fire.

### L4 (1pt): the TUI

`sessions-overview-model.ts` (`x`, pending confirm), the three hosting panes (confirm line and
the `remove` effect), the session tree pane's trash level, `PaneIntents.closePane` and
`AppCore.discardPane`, `SessionTreePort.remove | trash | restore` in `cli/src/sessions/ports.ts`.
**Accept:** model tests for the key and the confirm; pane tests for busy refusal, pane release
before the move, the trash level and restore; e2e stays green.

## Assumptions Jordan may reverse

- **The trash lives inside the session directory** (`.trash/`), so it travels with the
  workspace and needs no new path rule. A per-user trash would be one constant.
- **`purge` is all or nothing** (plus `DELETE /trash/{id}` for one). `--older-than` is declined
  for the reason in 119-1; a stamp sidecar would bring it back in a few lines.
- **`x` is the remove key** in the overview, next to the picker idiom; the confirm is Enter and
  any other key cancels, the workspaces pane's idiom.
- **The trash view lives in the session tree pane only**, under `t`. The arcs and arc panes get
  the remove key but not the view, because restore is rare and the tree pane is the sessions
  surface.
- **`DELETE /sessions/{id}` answers 200 with the removed summary** rather than 204, so a client
  can name what it removed in its own notice.
- **Memory notes are left alone, every time.** Removal never stages a forget proposal; the
  confirm points at `keywork memory forget`.
- **A removed session's checkpoint trees stay** in the shadow repo, bounded by its own limit.

## Questions for Jordan

- **Q-SL1.** Should the TUI's remove also stage a `memory forget` proposal for the session when
  memory is trusted, so the inbox offers the cleanup, or stay silent as built?
- **Q-SL2.** Should `keywork sessions trash` offer `purge` inline the way `list` offers the
  empty cleanup, or stay a plain listing as built?
- **Q-SL3.** When a fork's parent is removed, is the title suffix enough, or should the entries
  view also show the parent's first entries greyed?

## Non-goals

- No bulk remove by filter, no remove from the conversation pane itself, no remove while a
  turn is running under any surface.
- No rewrite of `parentSession` on remove or restore; no reparenting of forks.
- No change to the session file format, to the spill format, or to the directory layout beyond
  the one subdirectory.

## Ledger

### L1 to L4 · landed 2026-10-11

**Engine (L1).** `engine/src/session/trash.ts`: `SessionTrash(sessionDir)` with `dir`
(`<sessionDir>/.trash`), `put(file)`, `restore(file)`, `files()`, `discard(file)`, `purge()`;
`sessionFilePair(file)` is the one pairing rule and `SessionFileCollisionError` the one refusal.
Exported from `engine/src/index.ts` with `trashDirName`. `removeSessionFiles` in `spill.ts` is
unchanged and is what `discard` runs. Tests: `trash.test.ts` (5).

**CLI (L2).** `cli/src/sessions/lifecycle.ts`: `removeSession`, `trashStore`, `restoreSession`
(returns the reopened store), `listTrash`, `findTrashed`, `discardTrashed`, `purgeTrash`,
`forkOrigin(dir, parentPath)` and `memoryStaysNote`. `command.ts` gains `remove`, `restore`,
`trash`, `purge` (`sessionsSubcommands` names them for the usage line), `agreedTo` (`--yes`, a
terminal confirm, or a usage exit when neither is there) and routes the empty cleanup through
`SessionTrash.put`. `main.ts` parses `--yes`; `dispatch.ts` usage names the four. Tests:
`command.test.ts` (6 new, 21 total: confirm text, `--yes`, decline, no terminal, restore and
resume, purge and `--json`, a fork of a removed and then purged parent, the arc bound count
dropping and returning).

**Server and `serve` (L3).** `server/src/routes/lifecycle.ts` (five routes, registered last in
`routeFamilies`; `HttpMethod` gains `DELETE` and `server.ts` matched on method already).
`host.ts`: `SessionLifecyclePort` (`remove`, `trash`, `restore`, `discard`, `purge`),
`SessionHost.lifecycle?`, `ForkOrigin`, `SessionDetail.forkedFrom?`. `events.ts`:
`session.removed`, `session.restored`; `docs/events.md` documents both under "Server events".
`client.ts`: `removeSession`, `trash`, `restoreSession`, `discardTrashedSession`, `purgeTrash`.
`testing.ts`: the memory host keeps a `trashed` map (`memoryTrash`). `cli/src/serve-lifecycle.ts`:
`servedLifecycle({ sessionDir, bound, release, summaryOf })`; `serve.ts` adds the `lifecycle`
entry, `LiveSessions.release(id)` (close the live session, drop it, end the extension host's
session) and `withForkOrigin` on `read`. `openapi-document.fixture.json` regenerated. Tests:
`server.test.ts` "session lifecycle (119) over the memory host" (4: 503 without the port, move
and restore with both events on the stream, 404 / 409 refusals, the typed client through discard
and purge); `serve.test.ts` "session lifecycle (119) under serve" (5: a stored session's log and
spills move and come back, an idle live session is closed first, a stalling turn answers 409, a
fork of a removed parent reports `forkedFrom.removed` and survives a purge, discard and the
`session.removed` envelope).

**TUI (L4).** `sessions-overview-model.ts`: `x` begins a `PendingRemoval` when the host passes a
`remove` effect, Enter confirms, any other key cancels; `removal()` and `removalPrompt()`.
`session-tree-pane.ts`: `SessionTreePort.remove | trash | restore` (`SessionRemoval`), the
`trash` level (`t`, Enter restores, Escape returns, its own tray), `removeSessionThrough` (busy
refusal, `closePane` before the move, the notice, a refresh) shared by the arcs and arc panes,
`removalConfirmLine`, `overviewTray` gains `remove` and `trash`. `arcs-pane.ts` /
`arcs-pane-model.ts` / `arc-pane.ts`: the `remove` effect, the confirm line, the confirm routed
before fold and escape keys, `x` in `arcSessionsTray` and `memberTray`. `session-tree-model.ts`:
`SessionTreeView.forkedFrom` and `forkOriginFact()` for the entries title. `pane.ts`:
`PaneIntents.closePane?`; `app-core.ts`: `discardPane(id)` (never the last visible pane) wired
as that intent. `cli/src/sessions/ports.ts`: the three port methods and `forkedFrom` on `load`;
`cli/src/remote-ports.ts`: the same three over the client. Tests: overview model (3), tree pane
(5), arc pane (1), arcs pane (1), `workflows-layout` discard (1), `ports.test.ts` (1),
`remote-ports.test.ts` (1).

**Decisions taken (reversible).** The trash lives in the session directory; `purge` is all or
nothing beside a per-id discard; no `--older-than`; `x` / Enter / any-key-cancels; the trash
view lives in the session tree pane only; `DELETE /sessions/{id}` answers 200 with the summary;
memory and checkpoints untouched; `forkedFrom` rides `GET /sessions/{id}` beside the raw
`parentSession` path K2 added, and the entries title names the origin.

**Gaps found, not built.** The attached TUI (`keywork attach`) gets remove, trash and restore
through the client, but its pane close releases nothing on the server side, so the server's own
release runs instead (the route closes the live session). `keywork sessions trash` does not
offer `purge` inline (Q-SL2). A session removed under `serve` while a TUI in another process
has it open is not detected: the two processes do not share presence (P2.3 territory). The
`serve.test.ts` "routes an ask" case can fail with `EBUSY` on scratch-dir cleanup when the
sibling lanes' gates run at the same time; it passed alone and in the file run.

**Gate.** `bun run check` clean; the touched files, `packages/server`, `serve.test.ts` and
`packages/tui` green in isolation (tui 131 files / 2052 tests); the full run and e2e are in the
report.

**Proposed commit message.**

```
feat: session removal and restore across every surface (119)

- engine: SessionTrash moves a session's log and spills to <sessionDir>/.trash and back
- cli: keywork sessions remove, restore, trash, purge with --yes; the empty cleanup trashes
- serve: DELETE /sessions/{id}, GET /trash, POST /trash/{id}/restore, DELETE /trash/{id},
  DELETE /trash; session.removed and session.restored; forkedFrom on GET /sessions/{id}
- tui: x with an in-pane confirm in the session tree, arcs and arc panes; t shows the
  trash and enter restores; an open session's pane is closed before the move; the
  entries title names a removed fork parent
```
