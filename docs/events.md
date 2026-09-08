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
| `queued` | `QueuedPrompt[]` | Each `{ id, text, behavior }`; `behavior` is `steer` or `queue`. |

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
| `ask` | `PermissionAsk` | `{ tool, callId, arguments, rule }`. |

`rule` says why the gate is asking: `policy` (a configured rule says ask) or `default` (the
tool mutates and no rule covers it).

### gate.permission

Fires when the trust gate decides on a tool call.

| Field | Type | Meaning |
|---|---|---|
| `decision` | `PermissionDecision` | `{ tool, callId, verdict, gate }`. |

`verdict` is `granted` or `denied`. `gate` says who decided: `policy` (a preset rule),
`default` (the preset's fallback), `user` (an interactive answer) or `headless` (no one to
ask; the answer is no and `keywork run` flags it).

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

### engine.error

Fires when a listener throws, when a turn fails, or when post-turn settling fails. A listener
that throws while handling `engine.error` is dropped silently, so the bus cannot loop.

| Field | Type | Meaning |
|---|---|---|
| `error` | `Error` | The failure. |

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

## The one translation: `engine.error`

Fourteen of the fifteen types cross the wire as `JSON.stringify(envelope)` with no per-type
code. `engine.error` carries an `Error` instance, which `JSON.stringify` would flatten to
`{}`. The server serializes every `Error` value anywhere in an envelope as

```json
{ "name": "Error", "message": "…" }
```

through one value-level replacer (`errorsAsPlainObjects` in `sse.ts`). No stack, no cause.
This is the only place the wire form differs from the in-process payload.
