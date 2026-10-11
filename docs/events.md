# keywork event vocabulary (v1)

The engine emits typed events on an in-process bus (`packages/engine/src/bus.ts`,
`EngineEvents`). The TUI subscribes in process; `keywork serve` streams the same events over
SSE (`packages/server/src/events.ts`, `sse.ts`). Names are API: a new event gets a section
here in the same change that adds it to `EngineEvents`, and `packages/engine/src/bus.test.ts`
fails when the two drift. Vision D7 is the decision behind the shape. The server adds a
second, process-level vocabulary of its own (`ServerEvents`, the "Server events" section at
the end); `packages/server/src/server.test.ts` holds that section to the same rule.

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
| `sessionId` | The session the event concerns. Empty (`""`) for a process-level event, which belongs to the process rather than to one session: `surface.changed`, `memory.inbox`, and `gate.preset` from `POST /preset`. |
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
| `decision` | `PermissionDecision` | `{ tool, callId, verdict, gate }`. |

`verdict` is `granted` or `denied`. `gate` says who decided: `policy` (a preset rule),
`default` (the preset's fallback), `user` (an interactive answer) or `headless` (no one to
ask; the answer is no and `keywork run` flags it).

`gate` can also be `trusted`: the fixed read-only posture a trusted workspace gets decided it.
The decision carries an optional `scope` when a person's grant decided it: `once`,
`session` or `workspace` on the answer to an ask (`POST /asks/{callId}`), and `session` or
`workspace` with `gate: "user"` on a later call an earlier grant covered without asking. A
denial carries no `scope`.

### gate.preset

Fires when the active permission preset changes. Over `keywork serve` the switch is
`POST /preset`, and the envelope is process-level: its `sessionId` is empty.

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

## Tree and files

These two events carry what the TUI's in-process feeds carry: the session tree pane's
`SessionChangeFeed` and the diff pane's `FileChangeFeed`. `keywork serve` records them on the
session's log where those feeds fire; a remote tree or diff pane refetches on them instead of
polling. Neither is replayed.

### session.tree

Fires when the session's entry tree changes other than by streaming a turn: after a fork,
a label, a leaf move, or once a finished turn's messages are written to the JSONL.

| Field | Type | Meaning |
|---|---|---|
| `sessionId` | `string` | The session whose tree changed (the source session, for a fork). |
| `leafId` | `string \| null` | The session's active leaf after the change; `null` is the empty root. |
| `reason` | `"fork" \| "label" \| "leaf" \| "entry"` | What changed. |
| `entryId` | `string`, optional | The entry forked at, labelled, or moved to. |
| `forkedTo` | `string`, optional | The new session's id, on `fork`. |

A client answers it by refetching `GET /sessions/{id}/entries`.

### changes.updated

Fires after a `write`, `edit` or `bash` tool call finishes, once the checkpoint store has
re-read the worktree.

| Field | Type | Meaning |
|---|---|---|
| `sessionId` | `string` | The session whose turn ran the tool. |
| `paths` | `string[]` | Every path changed since the session's baseline, after the refresh; a client replaces its list rather than merging. |

The counts and provenance behind each path come from `GET /sessions/{id}/changes`.

### engine.error

Fires when a listener throws, when a turn fails, or when post-turn settling fails. A listener
that throws while handling `engine.error` is dropped silently, so the bus cannot loop.

| Field | Type | Meaning |
|---|---|---|
| `error` | `Error` | The failure. |

## Server events

`keywork serve` adds a second vocabulary beside the engine's (`serverEventTypes` in
`packages/server/src/events.ts`; the envelope's `type` is the union of both lists, and `/doc`
publishes the union). These events never appear on the in-process bus and never replay. The
engine vocabulary above is unchanged by them. `surface.changed` and `memory.inbox` belong to
the process: their envelope carries an empty `sessionId` (`""`), and a client filtering
`/events` by session keeps them unless it adds `only=session`. `session.state` carries its
session's id.

### surface.changed

Fires when one of the process-level surfaces changed and a client should fetch it whole
again. It fires where the terminal's own panes refresh today: on every `McpRegistry` status
change (`kind: "mcp"`), on every arc registry change and session binding (`kind: "arcs"`),
after a bot is defined or a session switches bot (`kind: "bots"`), after a workspace is
declared, chosen, focused or unfocused (`kind: "workspaces"`), and after trust is recorded for
the served root (`kind: "workspace"`).

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"mcp" \| "arcs" \| "bots" \| "workspaces" \| "workspace"` | Which surface changed: `GET /mcp`, `GET /arcs`, `GET /bots`, `GET /workspaces` or `GET /workspace`. |

One event with a `kind` rather than four names, because every surface is cheap to re-fetch
whole and read by exactly one pane (118-3; Q-AS6 may split it).

### memory.inbox

Fires whenever the memory review inbox changes under the server: a staged write landing at
the end of a turn, an approval or discard through `POST /memory/inbox/{id}/...`, a revert
that re-stages or un-stages an item, and every arc airlock verb (a close review staged by
`finish`, a triage, a delivery). Fired only when the count or the kind tally actually
differs from the last one announced, so a verb that leaves the inbox as it was is silent.

| Field | Type | Meaning |
|---|---|---|
| `count` | `number` | How many items wait in the inbox, the workspace vault's and every bot layer's together. |
| `kinds` | `Record<string, number>` | The count per staged kind, keyed by the engine's own `StagedItem.kind` (`note`, `daily`, `moc`, `borderline-promotion`, `contradiction`, `arc-question`, ...), so a kind the engine adds later appears here without a server change. |

The needs-you threshold stays on the client: the TUI notifies on the rising edge of
`count >= 3` (`defaultInboxThreshold`, `packages/tui/src/notifications.ts`), and a remote
client applies the same rule to this payload. The server carries the count, never the
decision.

### session.state

Fires after every session verb that changes the session's standing state: `POST
/sessions/{id}/model`, `/thinking`, `/effort`, `/compact`, `/undo`, `/redo`, `/rename` and
`/leaf`. The payload is the whole current state, not a delta, so a client replaces what it
holds.

| Field | Type | Meaning |
|---|---|---|
| `model` | `string`, optional | The model in force as `provider/model`; absent when the provider reports no model id. |
| `thinking` | `boolean` | Whether the model is asked to show its reasoning. |
| `effort` | `EffortLevel`, optional | `low`, `medium`, `high`, `xhigh` or `max`; absent when the provider decides. |
| `title` | `string` | The session title. |
| `leafId` | `string \| null` | The session entry the next prompt will follow; `null` at the root. |
| `undoable` | `boolean` | Whether `POST /sessions/{id}/undo` has something to take back. |
| `redoable` | `boolean` | Whether `POST /sessions/{id}/redo` has something to bring back. |

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

## Filtering with `?session=`

`GET /events?session=<id>` keeps the envelopes whose `sessionId` equals the id **and** every
envelope with an empty `sessionId`, so a pane bound to one session still learns about
process-level state such as a preset switch. `&only=session` drops the process-level
envelopes too. The filter applies to the `Last-Event-ID` replay as well as to live delivery,
and ids are never renumbered: a filtered stream still carries the server's ids, so resuming
with the last id seen works the same way.

## The one translation: `engine.error`

Every type but one crosses the wire as `JSON.stringify(envelope)` with no per-type
code. `engine.error` carries an `Error` instance, which `JSON.stringify` would flatten to
`{}`. The server serializes every `Error` value anywhere in an envelope as

```json
{ "name": "Error", "message": "…" }
```

through one value-level replacer (`errorsAsPlainObjects` in `sse.ts`). No stack, no cause.
This is the only place the wire form differs from the in-process payload.
