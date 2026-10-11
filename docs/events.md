# keywork event vocabulary (v1)

The engine emits typed events on an in-process bus (`packages/engine/src/bus.ts`,
`EngineEvents`). The TUI subscribes in process; `keywork serve` streams the same events over
SSE (`packages/server/src/events.ts`, `sse.ts`). Names are API: a new event gets a section
here in the same change that adds it to `EngineEvents`, and `packages/engine/src/bus.test.ts`
fails when the two drift. Vision D7 is the decision behind the shape.

## Envelope

In process, a listener receives the bare payload for the type it subscribed to. The server
stamps each payload into an envelope before it leaves the process:

```json
{ "id": 42, "ts": "2026-09-06T12:00:00.000Z", "sessionId": "…", "type": "turn.delta", "payload": { } }
```

| Field | Meaning |
|---|---|
| `id` | Monotonic per server process, starting at 1. The SSE `id:` line carries the same number. |
| `ts` | ISO 8601 time the envelope was stamped. |
| `sessionId` | The session whose bus produced the event. |
| `type` | One of the event names below. |
| `payload` | The event's fields, exactly as emitted, with one translation (see `engine.error`). |

Every payload may also carry `replay: true`. Replayed events are re-emissions of stored
history when a session is opened or resumed (`packages/engine/src/session/replay.ts`,
`journal.ts`); a consumer that paints the transcript treats them as the past, and a consumer
that reacts to live activity ignores them.

## Turn lifecycle

A prompt produces this sequence on the bus:

```
turn.started
  turn.delta*                       streamed text, thinking and tool calls
  (tool.started tool.output* tool.finished)*   one group per tool call, in order
  turn.delta*                       the next assistant message, when tools ran
turn.completed | turn.interrupted
queue.changed                       whenever the pending prompt list changes
```

`engine.error` can appear anywhere and does not end the sequence by itself; a failed turn
emits `engine.error` and then nothing else for that turn.

### turn.started

Fires when a prompt begins its turn, after the user message joins the context.

| Field | Type | Meaning |
|---|---|---|
| `userText` | `string` | The prompt text. |
| `entryId` | `string`, optional | The session entry id, present on replay of a stored user message. |
| `origin` | `PromptOrigin`, optional | `{ kind: "external", client }` when the prompt came through `POST /sessions/{id}/inject` on `keywork serve`; absent for a typed prompt. |

On replay, a compaction or branch summary also fires `turn.started` with the summary as
`userText`, so the transcript shows where history was folded.

### turn.delta

Fires once per streamed provider delta.

| Field | Type | Meaning |
|---|---|---|
| `delta` | `TurnDelta` | One of the shapes below. |

`TurnDelta` is a tagged union on `type`:

| `type` | Fields | Meaning |
|---|---|---|
| `text` | `text` | A run of assistant text. |
| `visible-thinking` | `text` | A run of thinking the model chose to show. |
| `redacted-thinking` | `part` | An opaque thinking block the provider kept sealed. |
| `tool-call` | `call` | A complete tool call (`ToolCallPart`: `callId`, `name`, `arguments`). |
| `done` | `usage` | The provider closed the stream; `usage` is the turn's token counts. |

Replay re-emits the `text`, `visible-thinking` and `tool-call` parts of each stored
assistant message and never a `done`.

### turn.completed

Fires when an assistant message ends with no tool calls to run.

| Field | Type | Meaning |
|---|---|---|
| `message` | `Message` | The final assistant message (`role`, `parts`). |
| `usage` | `Usage` | `inputTokens`, `outputTokens`, optional `cacheCreationInputTokens`, `cacheReadInputTokens`, `costUsd`. |

### turn.interrupted

Fires when a turn is aborted (the user interrupts, or the abort route is called). The partial
assistant message is kept in history and any tool calls it made without results are settled
as errors.

| Field | Type | Meaning |
|---|---|---|
| `message` | `Message` | The partial assistant message. |

### queue.changed

Fires whenever the list of prompts waiting behind the active turn changes.

| Field | Type | Meaning |
|---|---|---|
| `queued` | `QueuedPrompt[]` | Each `{ id, text, behavior, origin? }`; `behavior` is `steer` or `queue`, and `origin` is the same as on `turn.started`. |

## Tool lifecycle

`tool.started` fires before the gate decides, so a refused call still announces itself: the
sequence for a refusal is `tool.started`, then `gate.permission` with `verdict: "denied"`, then
`tool.finished` with `isError: true` carrying the refusal text. When the policy would ask and
a guard can answer, `gate.ask` fires between `tool.started` and the decision. The call is
also visible earlier on `turn.delta` as a `tool-call` delta.

### tool.started

Fires just before a tool executes.

| Field | Type | Meaning |
|---|---|---|
| `call` | `ToolCallPart` | `callId`, `name`, `arguments`. |

### tool.output

Fires for each chunk a running tool streams while it works (the shell tool, for one).

| Field | Type | Meaning |
|---|---|---|
| `chunk` | `string` | Raw output text. |
| `callId` | `string`, optional | The running call, when one is known. |

Never replayed: chunks are not stored.

### tool.finished

Fires when a tool returns or throws.

| Field | Type | Meaning |
|---|---|---|
| `callId` | `string` | Matches the `tool.started` call. |
| `output` | `string` | The result text, bounded to the tool output budget. |
| `isError` | `boolean` | True when the tool threw or was refused. |
| `spill` | `SpillReference`, optional | Present when the output was clipped: `{ id, bytes, elidedFrom, elidedTo }` names the spill file beside the session. |

## Gate and session state

### gate.ask

Fires when the active policy would ask about a tool call and a guard exists to answer. The
turn waits on the answer; over `keywork serve` a client answers with `POST /asks/{callId}`
and an unanswered ask times out as a headless denial. Never fired when no guard can answer,
and never replayed.

| Field | Type | Meaning |
|---|---|---|
| `ask` | `PermissionAsk` | `{ tool, callId, arguments, rule, rules }`. |

`rule` says why the gate is asking: `policy` (a configured rule says ask) or `default` (the
tool mutates and no rule covers it).

`rule` can also be `trusted`: the trusted read posture allows a command but asks for its
write-capable form (`find … -delete`, `rg --pre`, `git log --output=…`). `rules` is the list
of `{ action, resource, effect: "allow" }` rules a `session` or `workspace` answer would
record, so a client can show them before the person picks: for `bash`, one rule per part of
the command built from its leading literal words (`git push *` from `git push origin main`),
none for a part with redirection or substitution; for an MCP tool, its full name with
resource `*`; for `write`, `edit` and every other tool, empty, since those are approved once
at a time.

### gate.permission

Fires when the trust gate decides on a tool call.

| Field | Type | Meaning |
|---|---|---|
| `decision` | `PermissionDecision` | `{ tool, callId, verdict, gate, scope? }`. |

`verdict` is `granted` or `denied`. `gate` says who decided: `policy` (a preset rule),
`default` (the preset's fallback), `user` (an interactive answer) or `headless` (no one to
ask; the answer is no and `keywork run` flags it).

`gate` can also be `trusted`: the fixed read-only posture a trusted workspace gets decided it.
The decision carries an optional `scope` when a person's grant decided it: `once`,
`session` or `workspace` on the answer to an ask (`POST /asks/{callId}`), and `session` or
`workspace` with `gate: "user"` on a later call an earlier grant covered without asking. A
denial carries no `scope`.

### gate.preset

Fires when the active permission preset changes.

| Field | Type | Meaning |
|---|---|---|
| `from` | `string` | The preset being left. |
| `to` | `string` | The preset now active. |

### session.mode

Fires when the session's mode changes.

| Field | Type | Meaning |
|---|---|---|
| `mode` | `string` | The mode name. |

### context.injected

Fires when something other than the conversation is added to the model's context.

| Field | Type | Meaning |
|---|---|---|
| `injection` | `ContextInjection` | `{ source, id?, scope? }`. |

`source` is one of `memory-bootstrap`, `memory-recall`, `memory-action`, `skill`,
`project-instructions`, `repo-map`, `subagent`. `id` names the thing injected (a skill name,
a note id) and `scope` the memory scope, where those apply.

### diagnostics.published

Fires after a file save when the language port publishes diagnostics for it.

| Field | Type | Meaning |
|---|---|---|
| `path` | `string` | The saved file. |
| `count` | `number` | How many diagnostics it now carries. |

### shell.reset

Fires when the session's shell state was reset. The payload has no fields beyond the
optional `replay`.

### extension.notice

Fires when the extension host has something to say about one extension: a quarantine (level
`error`, the message names the extension, the phase and the thrown reason), or a line the
extension wrote through its own logger. A consumer that toasts shows `error` and `warn`;
`info` belongs in a log. Not journaled; a resumed session does not replay notices.

| Field | Type | Meaning |
|---|---|---|
| `extension` | `string` | The extension's name (its file stem). |
| `level` | `"info" \| "warn" \| "error"` | How loud the notice is. |
| `message` | `string` | One readable line. |
| `detail` | `unknown` | Optional structured context the extension attached. |

### engine.error

Fires when a listener throws, when a turn fails, or when post-turn settling fails. A listener
that throws while handling `engine.error` is dropped silently, so the bus cannot loop.

| Field | Type | Meaning |
|---|---|---|
| `error` | `Error` | The failure. |

## Server events

`keywork serve` adds a few event kinds of its own beside the engine vocabulary
(`serverEventTypes` in `packages/server/src/events.ts`; the envelope's `type` enum in `/doc` is
the union of both lists). They describe process-level state rather than one session's turn, so
their `sessionId` is the empty string, and `/events?session=<id>` passes them through to every
session filter. They are never replayed from a journal; a client that reconnects re-fetches the
state they announce.

### memory.inbox

Fires when the review inbox is recounted: after every memory write over HTTP (approve, discard,
revert, every airlock verb) and whenever the served memory port reports a change (the same
places the terminal's inbox feed recounts). The counts are the whole inbox, not a delta, so a
client replaces its number rather than adding. The "needs you" threshold stays in the client
(`defaultInboxThreshold` 3, rising edge).

| Field | Type | Meaning |
|---|---|---|
| `count` | `number` | Every staged item waiting, the number `GET /memory/inbox` answers. |
| `staged` | `number` | Untrusted writes held in `.staging/` (`note`, `daily`, `moc`). |
| `airlock` | `number` | Arc close reviews (`arc-distillation`, `arc-question`). |
| `proposals` | `number` | Every other gardener proposal (merge, supersession, link, promotion, preference, skill, drift, forget). |
| `contradictions` | `number` | `contradiction` reviews. |

An untrusted workspace never fires it: memory is inert there and the count is always zero.

### surface.changed

Fires when one of the process-level surfaces a status pane shows has changed, so a client
re-fetches that family whole rather than merging a delta. One event with a `kind` serves all
four surfaces because each is cheap to re-read and consumed by exactly one pane (118-3).

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"mcp" \| "arcs" \| "bots" \| "workspaces"` | Which family changed: re-fetch `GET /mcp`, `GET /arcs`, `GET /bots` or `GET /workspaces` (and `GET /workspace`, whose trust and declaration ride under `workspaces`). |

Where it fires: `mcp` wherever the MCP registry notifies its subscribers (a server connecting,
dropping, changing its catalog, and after `restart` and `enabled`); `arcs` wherever the arc
service notifies (create, close, abandon, a session binding or release, airlock triage); `bots`
after a bot is created or a session is bound to one; `workspaces` after the workspace is trusted
and declared, a named workspace is created or chosen, and a focus dir is linked or unlinked. A
verb that changed nothing fires nothing. The payload carries no detail on purpose: the family's
`GET` is the source of truth.

### session.removed

Fires after `DELETE /sessions/{id}` moves a session to the trash (`<sessionDir>/.trash/`). The
session no longer appears in `GET /sessions`; a client drops its row and closes any view of it.
Memory notes it wrote stay, forks keep pointing at it, and `POST /trash/{id}/restore` undoes the
move. A session with a running turn is never removed (the route answers 409).

| Field | Type | Meaning |
|---|---|---|
| `sessionId` | `string` | The removed session. |

### session.restored

Fires after `POST /trash/{id}/restore` moves a session back from the trash. It appears in
`GET /sessions` again with everything it had.

| Field | Type | Meaning |
|---|---|---|
| `sessionId` | `string` | The restored session. |

### session.state

The one server event that belongs to a session: its `sessionId` is the session's id, not the
empty string. Fires after every session verb (`prompt`, `model`, `thinking`, `effort`,
`compact`, `undo`, `redo`, `rename`) and again once a turn's messages are persisted, carrying
the whole current state rather than what changed, so a client replaces its copy. It replaces
nothing in the engine vocabulary: `turn.started` still opens a turn and `queue.changed` still
announces the queue.

| Field | Type | Meaning |
|---|---|---|
| `model` | `string`, optional | The model in force as `provider/model`; absent when the provider declares no model id and the session recorded no choice. |
| `thinking` | `boolean` | Whether extended thinking is requested for the next prompt. |
| `effort` | `EffortLevel`, optional | The reasoning effort in force; absent means the provider default. |
| `title` | `string` | The session's title, pinned or not. |
| `leafId` | `string \| null` | The session entry the next message will follow; `null` for an empty session. |
| `arc` | `string`, optional | The arc the session is bound to; absent when unbound. |
| `bot` | `string`, optional | The bot the session runs as; absent when it runs as no bot. |
| `undoable` | `boolean` | Whether `POST /sessions/{id}/undo` has a prompt or a file checkpoint to take back. |
| `redoable` | `boolean` | Whether `POST /sessions/{id}/redo` has a staged undo or a file checkpoint to restore. |

It also fires after `POST /sessions/{id}/arc` and `POST /sessions/{id}/bot` change a live
session's binding, and when an arc close releases the session.

### session.settled

Fires when the after-turn settler did something to a session: a memory flush ran, the session
was compacted, or settling produced a notice. The same settler the terminal pane runs (memory
flush when the context passes the flush line, compaction when it passes the compaction line,
once per turn, and between tool batches when a running turn passes the compaction line) runs
under `keywork serve`, so a client sees the same flushes and compactions the pane would. A quiet
settle fires nothing. Carries the session's id.

| Field | Type | Meaning |
|---|---|---|
| `phase` | `"after-turn" \| "between-tool-batches" \| "requested"` | When it ran: after the turn, between two tool batches of a running turn, or on `POST /sessions/{id}/compact`. |
| `flushed` | `number` | How many messages the memory flush exchanged with the model (0 when no flush ran). |
| `compacted` | `CompactionEntry \| null` | The compaction entry written, or `null` when nothing was compacted. |
| `notices` | `string[]` | What the pane would have shown: the compaction line, or why a flush or compaction failed. |

### session.tree

Fires after a verb changes the shape of a session's entry tree, so a client re-fetches
`GET /sessions/{id}/entries` rather than patching its copy. Carries the session's id, like
`session.state`. `POST /sessions/{id}/leaf` also records a `session.state` envelope (the host
writes it as part of the move, so it arrives first) because the leaf is part of the state.

| Field | Type | Meaning |
|---|---|---|
| `reason` | `"fork" \| "label" \| "leaf"` | Which verb changed the tree: `POST /sessions/{id}/fork`, `/label` or `/leaf`. |
| `entryId` | `string \| null` | The entry the verb named; `null` only for a leaf move to the empty root. |
| `forkedTo` | `string`, optional | On `fork`, the new session's id. The event rides the session that was forked, not the new one. |

### changes.updated

Fires when the files the workspace diff shows may have changed: after every finished `write`,
`edit` or `bash` tool call (the same pairing of `tool.started` and `tool.finished` the terminal
diff pane follows, `followMutations` in the engine), and after `POST /sessions/{id}/undo` or
`/redo` put files back. Carries the id of the session whose turn or verb did it. `paths` is the
whole list `GET /sessions/{id}/changes` would answer at that moment, not a delta, so a client
replaces its list; the per-file sides still come from `GET /sessions/{id}/changes/file`. Never
fires on a server started with `--no-checkpoints`, where there is no baseline to diff against.

| Field | Type | Meaning |
|---|---|---|
| `paths` | `string[]` | Every path that differs from the session-start baseline, relative to the workspace root, as `changedSince` lists it. |
| `turn` | `number`, optional | The highest 1-based turn ordinal attributed to those paths, which is the turn that just touched them; absent when nothing differs or nothing is attributed. |

## SSE framing

`GET /events` answers `text/event-stream; charset=utf-8` with `cache-control: no-store`. The
first bytes are a comment line, `: connected`, so the client learns the stream is live
before any event exists. Each envelope is one frame:

```
id: 42
event: turn.delta
data: {"id":42,"ts":"…","sessionId":"…","type":"turn.delta","payload":{…}}

```

`event:` repeats the envelope's `type` so `EventSource` listeners can subscribe per name;
`data:` is the whole envelope as one line of JSON. The stream closes when the server shuts
down or the client disconnects.

## Resuming with `Last-Event-ID`

The server keeps the last 1000 envelopes in a ring. A client that reconnects sends the last
`id` it saw as `Last-Event-ID: <n>` (decimal digits only; anything else is ignored and the
stream starts live). The server replays every retained envelope with `id > n`, then continues
live. `Last-Event-ID: 0` replays everything retained. When `n + 1` is older than the ring's
oldest envelope, the replay is preceded by a comment naming the loss:

```
: resumed with a gap, events 12 to 41 are gone
```

## Filtering with `?session=<id>`

`GET /events?session=<id>` keeps the envelopes whose `sessionId` equals the id **and** every
envelope with an empty `sessionId`, so a session pane still learns about process-level state
(`memory.inbox`, `surface.changed`) without a second stream. The filter applies to the
`Last-Event-ID` replay and to the live tail alike; ids are not renumbered, so a filtered
client resumes with the same `Last-Event-ID` it would send unfiltered. `diagnostics.published`
rides the session's bus and passes when its session matches. An empty `session=` is the same
as no filter.

## The one translation: `engine.error`

Fourteen of the fifteen types cross the wire as `JSON.stringify(envelope)` with no per-type
code. `engine.error` carries an `Error` instance, which `JSON.stringify` would flatten to
`{}`. The server serializes every `Error` value anywhere in an envelope as

```json
{ "name": "Error", "message": "…" }
```

through one value-level replacer (`errorsAsPlainObjects` in `sse.ts`). No stack, no cause.
This is the only place the wire form differs from the in-process payload.
