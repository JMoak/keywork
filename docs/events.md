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

## What the contract promises

The HTTP routes in `GET /doc` and the envelopes on `GET /events` are one contract, and it has
a version of its own, separate from the keywork release. `info.version` in `/doc` is the
release (`packages/cli/package.json`, or the build-time version in a release binary).
`info.x-keywork-contract` is the contract version, `major.minor`, and the same string rides
`/doc` as the `x-keywork-contract` response header so a client can read it before parsing
anything. The current value lives in `packages/server/src/contract.ts`.

Since contract 1.31, authenticated `POST /models/refresh` reloads saved model connections
and configuration and returns the `GET /models` inventory. It accepts no request body.
Refresh does not grant workspace trust, restart the service, or change an already-bound
conversation. Clients use the returned inherited model to finish setup; an inventory
reading does not establish that a model has answered. A host without refresh support
returns 503; older contracts may return 404.

Host-wide model inventory may also report `conversation`: `{ provider, model, mode }`,
where `mode` is `chat` or `tools`, or a refusal with `refused` and `detail`. A smaller model
can serve a basic creature conversation in `chat` mode: the engine removes tools from
requests and refuses returned tool calls. The existing `strong` and `loop` classes still
gate project and autonomous work. License checks and explicit provider choice apply in
both modes. Older hosts omit this field; clients keep their existing strong-model path.
When a selected loopback model has enough measured context but unverified tool support,
`conversation.projectCheck` supplies its exact `{ endpoint, model }`. A client may offer
an explicit short `POST /models/probe` with `behaviour: true, refresh: true`, then refresh
inventory to establish project eligibility. Discovery never runs this check on its own.

Within a major, changes are additive. A route, an operation id, a response field or an event
name that exists in `1.x` keeps existing and keeps its meaning through every later `1.y`.
A payload field documented here keeps its name and type. New routes, new optional fields and
new event names can arrive in a minor and a client treats unknown ones as noise. The fields
that make up the envelope (`id`, `ts`, `sessionId`, `type`, `payload`) and the SSE framing
below never change within a major.

A route whose handler fails in a way the server does not answer as a refusal answers `500` with
`{ error }`, `internal fault: ` followed by the error's message (never a stack), and the server
writes the route and the error to its own log (`keywork serve:` lines on its standard error). A
failure after the answer has begun, such as a stream that breaks off, still ends the connection, and
is logged the same way. Every operation in `/doc` lists the `500`. Since contract 1.39; an older
server ended the connection without an answer, which some HTTP stacks deliver as an empty `200`.

A route or an event that is going away is marked first and removed later. In `/doc` the
operation carries `deprecated: true` and an `x-deprecated` note saying what replaces it and
which major removes it; the note is set on the route's row (`deprecated` in `RouteSpec`).
An event on its way out keeps firing with its section here marked the same way. The removal
itself lands in the next major, and the major bump is the only time a client has to change
anything to keep attaching.

A client checks the major at attach time, with `info.x-keywork-contract` or the header, and
refuses to proceed on a major it was not built for. keywork-app does exactly this.

Two fixtures hold the contract still: `packages/server/src/openapi-document.fixture.json`
is the whole `/doc` with a fixed version and workspace, and
`packages/server/src/event-shapes.fixture.json` is the wire shape of every event payload
(keys and types, with the `type` tag kept literal), one entry per event name.
`openapi.test.ts` and `event-contract.test.ts` fail on any difference, with a message naming
the way back: `bun run contract:fixtures` regenerates both. The diff of a regenerated fixture
is the review surface for a contract change: a removed key or a renamed operation in that
diff means a major bump, an added one means a minor bump, and either goes in
`packages/server/src/contract.ts` in the same change. Any change to either fixture needs
one of the two, with a single exception: a reworded `summary` or `description` string in
the OpenAPI document is documentation, so it needs no bump. Every key in the event shapes
is contract, a payload field named `summary` included. `bun run check:contract` holds the
rule. It compares both fixtures and `contractVersion` with `HEAD` (CI passes the commit
before the change), and fails when a fixture moved but the version didn't move forward.
Which of the two bumps a diff needs stays the reviewer's call.

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

When a provider call fails before it streams anything and the failure is transient, the
retrying provider sleeps and tries again; each sleep shows on the bus as `turn.waiting` and
each next attempt as `turn.resumed`, both before the turn's first `turn.delta` of that call.

`engine.error` can appear anywhere and does not end the sequence by itself; a failed turn
emits `engine.error` and then nothing else for that turn.

### turn.started

Fires when a prompt begins its turn, after the user message joins the context.

| Field | Type | Meaning |
|---|---|---|
| `userText` | `string` | The prompt text. |
| `entryId` | `string`, optional | The id of the prompt's session entry: present on replay of a stored user message, and live under `keywork serve`, which writes the entry before the event fires (since contract 1.7). A host that keeps no session log leaves it out. |
| `origin` | `PromptOrigin`, optional | `{ kind: "external", client }` when the prompt came through `POST /sessions/{id}/inject` on `keywork serve`; `{ kind: "creature", creature, thread }` when it is the one-line summary a creature's finished thread sent to the creature's conversation (`thread` is that session's id; since contract 1.8); absent for a typed prompt. |

On replay, a compaction or branch summary also fires `turn.started` with the summary as
`userText`, so the transcript shows where history was folded. A memory flush never fires it:
the flush is not a prompt (see [Memory flush entries](#memory-flush-entries)).

Under `keywork serve` the prompt's `message` entry is written to the session log as the turn
starts, before `turn.started` fires and stamped with that moment, so the event carries its id
and the entry comes before the asks, decisions and injections the turn journals; the turn's other messages follow when it settles, and a `turn_facts` entry closes it
(see [Turn facts and journal-only entries](#turn-facts-and-journal-only-entries)). Since
contract 1.6; a log written earlier carries the prompt at settle time, after its turn's
journal entries.

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
| `progress` | `text` | A line of provider progress that is not part of the message (a provider's thinking summary while it works). Not stored and not replayed. |
| `done` | `usage` | The provider closed the stream; `usage` is the turn's token counts, with an optional `responseId` and `cacheMiss` (`{ cause, missedTokens? }`) from the provider. |

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

### turn.waiting

Fires when the provider refused or failed a call before streaming anything, the failure is
transient (408, 429, 5xx, a dropped connection), and the turn sleeps before the next attempt.
The turn is still running: it is waiting on the provider, not thinking. Since contract 1.13.

| Field | Type | Meaning |
|---|---|---|
| `reason` | `"rate-limited" \| "overloaded" \| "unreachable"` | `rate-limited` for a 429, `overloaded` for a 408 or 5xx, `unreachable` when the connection failed. |
| `until` | `string` | ISO 8601 time the next attempt starts: the provider's `Retry-After` when it sent one, else the backoff. |
| `attempt` | `number` | The attempt that starts at `until`; the first call is attempt 1. |

An interrupt during the sleep ends the turn with `turn.interrupted` and no `turn.resumed`.

### turn.resumed

Fires when the sleep a `turn.waiting` announced ends and the next attempt starts. Since
contract 1.13.

| Field | Type | Meaning |
|---|---|---|
| `attempt` | `number` | The attempt now starting, the same number `turn.waiting` carried. |

### queue.changed

Fires whenever the list of prompts waiting behind the active turn changes.

| Field | Type | Meaning |
|---|---|---|
| `queued` | `QueuedPrompt[]` | Each `{ id, text, behavior, origin? }`; `behavior` is `steer` or `queue`, and `origin` is the same as on `turn.started`. |

Steered prompts always come before queued ones. A thread's summary (a `creature` origin) runs
exactly like an injected prompt: it starts a turn when the conversation is idle and joins the
back of the queue when a turn is running, so thread updates never interleave with a running
answer, and any memory note such a turn proposes is staged with provenance `untrusted`, as for
`external`. Besides a prompt joining or leaving for its
turn, the list changes on `POST /sessions/{id}/queue/{itemId}/move` (a new order),
`DELETE /sessions/{id}/queue/{itemId}` (one prompt dropped) and a prompt sent with
`behavior: "now"` (every waiting prompt set aside, the terminal's ctrl+enter). The `id` here is
the `itemId` those routes take.

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
| `spill` | `SpillReference`, optional | Present when the output was clipped: `{ id, bytes, elidedFrom, elidedTo }` names the spill file beside the session. Over `keywork serve`, `GET /sessions/{id}/spills/{spill.id}` reads it, by default exactly the clipped `[elidedFrom, elidedTo)`. |
| `exitCode` | `number`, optional | The exit code of the command a `bash` call ran, `0` included, so a client marks a failed command without reading `(exit code N)` out of `output`. Absent for every other tool, and for a command that never exited on its own (a timeout, an abort, a shell that died). The tool result in the session keeps it, so a replay carries it too. Since contract 1.32. |

## Child sessions

The `delegate` tool hands a piece of work to a child session and waits for its answer
([`backlog/120-subagents.md`](backlog/120-subagents.md)). Both events ride the parent's bus,
inside the `delegate` call's `tool.started` / `tool.finished` pair, so their envelope carries
the parent's `sessionId`. While the child works, the same call streams one `tool.output` line
per child tool call (`read src/a.ts`, `needs you · bash git push`). The child's own turns stay
on its own bus and in its own session file under `<parent>.children/`. Never replayed: a
resumed transcript rebuilds its child rows from the `delegate` results, whose first line names
the child.

### child.started

Fires once the child session exists and before its first turn.

| Field | Type | Meaning |
|---|---|---|
| `callId` | `string` | The `delegate` call that spawned it. |
| `sessionId` | `string`, optional | The child's session id; absent when the parent session is not saved, so neither is the child. |
| `title` | `string` | The few words the model named the work with. |
| `bot` | `string`, optional | The bot the child runs as; absent when it runs as no bot. |

### child.finished

Fires when the child's turn has ended and its messages are saved, before the `delegate` result
reaches the parent.

| Field | Type | Meaning |
|---|---|---|
| `callId` | `string` | Matches `child.started`. |
| `sessionId` | `string`, optional | As on `child.started`. |
| `outcome` | `"completed" \| "interrupted" \| "failed" \| "denied"` | `denied` means the child stopped at a call no one could approve, which only happens where a refusal ends the run (`keywork run`). |
| `usage` | `Usage` | The child's token counts across its turn. |
| `costNanos` | `number`, optional | What the child cost in nano-dollars, present only when every one of its model calls was priced. |
| `refused` | `{ tool, callId }[]`, optional | The child's calls a headless gate refused, present only when there were any. |

Under `keywork serve`, from `child.started` to `child.finished` the child's own engine events
(`turn.started`, `turn.delta`, `tool.*`, `gate.*`, `turn.completed` and the rest) stream on
`/events` under the child's session id, so a console watching that id sees it work; the parent
keeps its `child.*` events and activity lines. While it runs, `GET /sessions/{id}` for the child
reads its running conversation (`live: true`, `messages` up to the prompt it is answering, the
reply arriving on the stream), and the verbs that would open it to drive it (prompt, model,
context, cost and the rest) answer as for a session not open here until `child.finished`;
after that it reads and opens from its saved log like any other session. Since contract 1.32.

## Gate and session state

### gate.ask

Fires when the active policy would ask about a tool call and a guard exists to answer. The
turn waits on the answer; over `keywork serve` a client answers with `POST /asks/{callId}`
and an unanswered ask times out as a headless denial (after seven days by default). Never fired when no guard can answer,
and never replayed. The session journal keeps each ask as a `permission_ask` entry holding
`{ tool, callId, rule, rules, change? }`, where `change` is `{ creates, linesBefore,
linesAfter }` from the preview; the arguments already ride the assistant message, and the
preview's text is never journaled ([`backlog/122`](backlog/122-tool-decision-evidence.md)).

| Field | Type | Meaning |
|---|---|---|
| `ask` | `PermissionAsk` | `{ tool, callId, arguments, rule, rules, preview? }`. |

`rule` says why the gate is asking: `policy` (a configured rule says ask) or `default` (the
tool mutates and no rule covers it). `always` (since contract 1.38) is a call that acts on the
keeper's machine and so asks every time: a `show` of the `terminal` or `screen` pane. No rule,
preset, posture, quiet session, standing grant or promoted rule class decides it, its `rules` are
empty so a `session` or `workspace` answer remembers nothing, and with no one to ask it is refused.
A local agent's `show` of one over a creature's MCP server raises the same ask on the creature's
conversation, with `gate.ask` and `gate.permission` recorded there. A session left quiet (`POST /sessions/{id}/quiet`) raises
no ask for a call its quiet posture grants; see `gate.permission`.

`rule` can also be `trusted`: the trusted read posture allows a command but asks for its
write-capable form (`find … -delete`, `rg --pre`, `git log --output=…`). The posture allows a
command only while every operand stays inside the workspace and its read roots, by the same
rule the `read` tool confines paths (links resolved, `/c/…` drive paths read as Windows ones);
a command that names a path elsewhere (`..`, an absolute path, `~`, a glob or brace expansion
that can climb out, a path in an option value, a PowerShell provider path such as `env:`) is
not covered by it and asks with `rule: "default"`, never a silent refusal. A `session` or
`workspace` grant still covers such a command. Since contract 1.32. `rules` is the list
of `{ action, resource, effect: "allow" }` rules a `session` or `workspace` answer would
record, so a client can show them before the person picks: for `bash`, one rule per part of
the command built from its leading literal words (`git push *` from `git push origin main`,
`git -C dir status *` past git's global options), none for a part with redirection or
substitution; a destructive part never gets a wildcard: deletes (`rm`, `rmdir`, `rd`, `del`,
`erase`, `Remove-Item`) and `git branch -D` are remembered only as the exact command, and
`git push` with a force flag or `+` refspec, `git reset --hard`, `git clean` and a discarding
`git checkout` (`--` or `.`) remember nothing, so their card offers once or deny; and a
remembered `session` or `workspace` rule covers a destructive part only when it is that exact
command, so `git push *` never covers `git push --force`; for an MCP tool, its full name with
resource `*`; for `write`, `edit` and every other tool, empty, since those are approved once
at a time.

`preview` shows a `write` or `edit` call's consequence before anyone answers:
`{ path, before, after }`, the file as it is and as the call would leave it. The tool computes
it with its own dry logic (the edit's exact replacement over the file's current content,
line endings and `replaceAll` included; the write's whole new content), never by running the
call. `path` is relative to the session's working directory with `/` separators, or absolute
outside it; `before` is `null` when the file does not exist yet. There is no preview when the
call would fail (an edit whose `oldText` does not match once), for a memory note the call would
only propose, for binary content, or when either side is over 256 KiB of UTF-8: a cut diff
would misstate the consequence, so a client falls back to the arguments. `GET /asks` carries
the same `preview` on the pending ask.

### gate.permission

Fires when the trust gate decides on a tool call.

| Field | Type | Meaning |
|---|---|---|
| `decision` | `PermissionDecision` | `{ tool, callId, verdict, gate, scope?, asked?, reason?, note? }`. |

`verdict` is `granted` or `denied`. `gate` says who decided: `policy` (a preset rule),
`default` (the preset's fallback), `user` (an interactive answer) or `headless` (no one to
ask; the answer is no and `keywork run` flags it).

`gate` can also be `trusted`: the fixed read-only posture a trusted workspace gets decided it.

`gate` is `quiet` when a quiet session's posture granted the call instead of a person
(`POST /sessions/{id}/quiet { on: true }`, since contract 1.5), always with `scope: "session"`
and `asked: false`, and no `gate.ask` before it. Quiet grants a call only when a `session`
answer to its ask would record rules (`gate.ask`'s `rules`), none of them blanket (a bare
`<program> *`), no part of the command destructive in the sense above (deletes, `git branch -D`,
force pushes, `git reset --hard`, `git clean`, a discarding `git checkout`), the rules together
covering every part of the command, and the ask not coming from the trusted posture's
write-capable forms (`rule: "trusted"`). Those rules join the session's grants as a `session`
answer's would. `write`, `edit` and anything else still fire `gate.ask`. It is a new origin on
purpose: a client that tallies a person's answers, and `keywork sessions decisions`, never count
a quiet grant as one. Turning quiet off revokes nothing it granted, and `keywork run` and every
other headless gate never go quiet.
The decision carries an optional `scope` when a person's grant decided it: `once`,
`session` or `workspace` on the answer to an ask (`POST /asks/{callId}`), and `session` or
`workspace` with `gate: "user"` on a later call an earlier grant covered without asking, whether
an answer recorded it or it was granted ahead of an ask (`POST /permissions/workspace/grant` and
`POST /permissions/session/{sessionId}/grant`, which also take every tool of one MCP server as
the one rule `{ action: "mcp", resource: "<server>__*" }`). A denial carries no `scope`.

`asked` says whether this verdict answered an ask: `true` when a guard was asked (a person,
or the headless guard saying no), `false` when a rule, the trusted posture, the preset's
fallback or a standing grant decided without asking. It is what tells a person's fresh
`session` answer apart from the later calls that answer covers, which otherwise carry the same
`gate: "user"` and `scope`. keywork sets it on every decision since contract 1.3; a decision
journaled before then has none.

`reason` says why a person denied: `unsafe` (the call should not run), `not-now` (the moment,
not the call: stop, not that, later) or `other`. The TUI asks for it with one more key after
`n` (`[u] unsafe  [n] not now  [o] other`; escape and enter answer `other`), and a client sends
it as `reason` on `POST /asks/{callId}`. A grant never carries one, nor does a denial by a rule
or the headless guard; a pane closing or an agent swap answers its pending asks `not-now`. A
denial without `reason` was answered by a client that does not send one. Since contract 1.4.
The distinction exists for evidence: a decider scored against the person's answers must not
count a `not-now` as a judgment of the call.

`note` is the person's own words on a denial, the free text an `other` answer asks for (sent as
`note` on `POST /asks/{callId}`, trimmed, at most 1000 characters). Since contract 1.6. The
model reads both: the refused call's `tool.finished` output opens with `declined by user` and
the reason (`· they judged this call unsafe`, `· not now, though the call itself may be fine
later`), quotes the note on its own line (`The user said: "…"`), and closes with a line telling
the model the call did not run, not to retry it or a variant unless the person asks, and never
to report it as done. A headless refusal opens with `not approved: this run has no one to ask`
and closes the same way. An ask that timed out under `keywork serve` is still a `headless`
decision, but the model reads `not approved: nobody answered the ask in time, so the person
probably stepped away and the call was refused` instead, since someone could have answered
(since contract 1.7). Asks a closing or recomposing server refuses keep the headless line.

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
`project-instructions`, `repo-map`, `subagent`, `creature`. `id` names the thing injected (a
skill name, a note id, a creature's slug) and `scope` the memory scope, where those apply.

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

Two producers that are not extension files use this envelope. The `review` extension emits one
notice per hunk verdict (see `keywork.review.verdict` below). The `keeper` extension emits one
notice when a promoted rule class decided an ask for the keeper (contract 1.23): `message` reads
`decided for you: <tool> (<rule class>) ...`, and `detail` is `{ recordId, ruleClass, callId, tool,
creature? }`, where `recordId` is the ledger row `POST /creatures/{slug}/overturn` takes to label
the call wrong and demote the class. The ask itself never reaches `GET /asks`: the queue settles it
with a non-user gate, so `gate.permission` follows with `asked: true` and no keeper answered.

### engine.error

Fires when a listener throws, when a turn fails, or when post-turn settling fails. A listener
that throws while handling `engine.error` is dropped silently, so the bus cannot loop.

| Field | Type | Meaning |
|---|---|---|
| `error` | `Error` | The failure. |

## Memory decisions

Memory's small judgment calls go through one port, the memory decider
(`packages/engine/src/memory/decider.ts`; the design is
[`backlog/121-jev-memory.md`](backlog/121-jev-memory.md)): which recalled notes to add before
an edit or a command, whether a daily-log entry goes to the distiller, how two similar notes
relate, whether a note still holds after a diff, whether an unlinked mention should become a
link card. Every decision is a record, the builtin's as much as any other, so a session can say
why a note arrived. `memory.decider` in the user config picks the decider. `builtin`, the
default, is keywork's own rules and, where a judgment needs one, the chat model, exactly as
before the port existed. `jev` asks TypeSafe's Jev, on the person's own key, the questions an
eval has proven for the pinned model (none yet; `KEYWORK_DECIDER_TRIAL=1` in the environment
lets Jev take every question on that one machine), and the builtin answers everything else, and
every question Jev could not or would not settle, with the reason named in `fallback`.

### memory.decided

Fires once per decision taken inside a turn. Today that is point-of-action recall: one event
per mutating tool call (`write`, `edit`, `bash`) whose memory search found at least one
candidate note, emitted before the `context.injected` events for the notes it kept. Journaled
as a `memory_decision` custom entry and re-emitted with `replay: true` when the session is
opened, so a recorded session holds why memory injected what it did beside the injection
itself. Decisions taken outside a turn (Gardener sweeps at session close and arc close, bot
sweeps, `keywork memory drift`) go through the same decider and produce the same record, but
ride no session bus yet; 121-5 gives them a machine-local log and a process-level server event.

| Field | Type | Meaning |
|---|---|---|
| `decision` | `MemoryDecision` | The decision, below. |

`MemoryDecision`:

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Unique per decision. |
| `question` | `string` | The catalog id with its version: `action-relevance@1`, `entry-durability@1`, `pair-relation@1`, `drift-verdict@1`, `mention-is-link@1`; `entry-kind@1`, `search-relevance@1` and `skill-applies@1` are reserved. Rewording a question bumps its version. |
| `about` | object | What was decided: `{ kind: "call", callId }`, `{ kind: "pair", older, newer }`, `{ kind: "entry", entryId }`, `{ kind: "note", note }`, `{ kind: "mention", note, target }` or `{ kind: "query", query }`. Which note of a pair is older is computed from the notes' `created` stamps. |
| `candidates` | `string[]` | The note names or entry ids offered, in the order offered; never bodies. |
| `choice` | `{ kept, dropped }` or `string` | The outcome that took effect. For `action-relevance@1`, the candidate names kept (in injection order) and dropped. Otherwise one option: `entry-durability@1` answers `new-durable`, `changes-a-note`, `reinforces-a-note`, `episodic` or `unsure`; `pair-relation@1` answers `duplicate`, `newer-supersedes-older`, `older-still-holds`, `contradiction`, `distinct` or `unsure`; `drift-verdict@1` answers `hold`, `stale` or `unsure`; `mention-is-link@1` answers `link` or `no-link`. |
| `scores` | `Record<string, number>`, optional | Probability per candidate (a recall or mention question) or per option (a choice); absent for a rule with no score. On an `undecided` fallback these are the odds Jev gave before the builtin took over. |
| `confidence` | `number`, optional | The decider's confidence in its choice. For the builtin it is the chat model's self-reported confidence on a pair, the number the Gardener's thresholds read. For Jev it is TypeSafe's `confidence` on a choice, and on a recall the smallest `\|2p - 1\|` among the kept notes Jev scored. |
| `decider` | `"builtin" \| "jev"` | Who decided what took effect. A recall is `jev` when Jev settled at least one candidate. |
| `model` | `string`, optional | The decision model version that answered, present whenever an answer came back (on an `unproven-model` fallback, the version that answered instead of the pinned one). |
| `rule` | `string`, optional | The builtin's rule in words, for a builtin decision and for the candidates the rule settled inside a Jev recall: `[[Auth Tokens]] shares "auth" with the path; [[Old Auth]] is superseded`, `jaccard 0.41 · judged by closing:anthropic`, `asked drift:anthropic · the diff renames mintToken`. |
| `fallback` | `{ reason, undecided? }`, optional | Why the builtin decided when `jev` was selected: `no-key`, `refused` (TypeSafe answered 401 or 403; no further call until the key changes), `late`, `rate-limited` (429), `overloaded` (529), `malformed` (a 400, 413, 415 or 422, or an answer that does not fit the questions asked), `unreachable` (no connection, or a server error other than 529), `degraded` (three failures in a row opened a 60-second breaker), `undecided` or `unproven-model`; `undecided` names the candidates left to the rule. Never present while `memory.decider` is `builtin`, and absent under `jev` for a question no eval has proven yet, because the builtin answering it is the design rather than a failure. |
| `latencyMs` | `number` | How long the decision took, in whole milliseconds. |
| `waitedMs` | `number`, optional | Hot path only: what the decision added after the tool finished. |
| `inputTokens` | `number`, optional | The decision model's reported input tokens, for cost. |
| `stateHash` | `string`, optional | SHA-256 of the state sent, so a replay can prove it rebuilt the same question. |

The builtin's action rule speaks once per candidate, in candidate order. A kept note `shares`
up to three words with the path or the command, or `is near the path in meaning` when only the
semantic leg found it. A dropped note `is superseded`, `was already surfaced` this session,
`is only a graph neighbor`, `is past the 3-note cap` or `would pass the 1024-token budget`
(the numbers are the session's own caps).

Jev's recall asks about at most five candidates that policy has not already screened out
(superseded, already surfaced). A note at odds of 0.10 or less is dropped; at 0.90 or more it
is kept and injected first; anything between is the builtin rule's call and is named in
`fallback.undecided`. The note cap and the token budget still apply to whatever Jev ranked
first. The questions, their wording and their bands live in
`packages/engine/src/memory/jev-questions.ts`.

## Model policy

A creature's model policy names a candidate per task class (`strong`, `loop`, `decide`,
`vision`), each `inherit` or `{ provider, model }`, resolved creature first, then workspace,
then user (`packages/engine/src/models/policy/`). The nearest candidate leads a turn and the
outer levels are its fallbacks; `fallbackProvider` switches between them on a live stream.

### model.fallback

Fires when a turn's provider switched from one candidate of the creature's policy to the next:
the first failed before it streamed anything (a context-length refusal, a 429, a 503, a server
down, a moderation refusal). A switch never happens after text or a tool call reached the
transcript, because a second model's reply would be spliced onto the first's. Rides the session
whose turn switched. Never replayed. Since contract 1.8.

| Field | Type | Meaning |
|---|---|---|
| `class` | `"strong" \| "loop" \| "decide" \| "vision"` | The task class the policy was resolved for. |
| `from` | `string` | The candidate that failed, as `provider/model`. |
| `to` | `string` | The candidate now streaming, as `provider/model`. |
| `trigger` | `"context-length" \| "rate-limited" \| "saturated" \| "down" \| "moderation"` | What the failure was classified as. |
| `cloud` | `boolean` | True when the switch left a local server for a cloud provider, which only happens for a creature whose `creature.json` sets `cloudFallback: true`. |

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
five surfaces because each is cheap to re-read and consumed by exactly one pane (118-3).

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"mcp" \| "arcs" \| "bots" \| "workspaces" \| "permissions"` | Which family changed: re-fetch `GET /mcp`, `GET /arcs`, `GET /bots`, `GET /workspaces` (and `GET /workspace`, whose trust and declaration ride under `workspaces`) or `GET /permissions`. |

Where it fires: `mcp` wherever the MCP registry notifies its subscribers (a server connecting,
dropping, changing its catalog, and after `restart` and `enabled`); `arcs` wherever the arc
service notifies (create, close, abandon, a session binding or release, airlock triage, and a
theme worn or taken off through `POST /arcs/{slug}/theme`, whose `theme` then rides on the arc in
`GET /arcs` so every client dresses the arc alike); `bots` after a bot is created or a session is bound to one; `workspaces` after the workspace is trusted
and declared, a named workspace is created or chosen, and a focus dir is linked or unlinked;
`permissions` after a grant ahead of an ask (`POST /permissions/workspace/grant`,
`POST /permissions/session/{sessionId}/grant`), after either revoke, after an ask is
answered `granted` with a `session` or `workspace` scope, when a session's quiet posture is
turned on or off, when a quiet grant adds a rule the session did not hold, and after
`POST /workspace/trust` recomposed the server with the workspace trusted (its answer says
`recomposed: true`; since contract 1.6). A verb that
changed nothing fires nothing. The payload carries no detail on purpose: the family's
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
`compact`, `undo`, `redo`, `restore`, `rename`, `quiet`, `flush`, `forget`) and again once a turn's messages are persisted, carrying
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
| `quiet` | `boolean` | Whether the session is quiet: its gate grants on its own what a `session` answer would cover (`POST /sessions/{id}/quiet`; see `gate.permission`). Since contract 1.5. |
| `undoable` | `boolean` | Whether `POST /sessions/{id}/undo` has a prompt or a file checkpoint to take back. |
| `redoable` | `boolean` | Whether `POST /sessions/{id}/redo` has a staged undo or restore, or a file checkpoint, to take back. |

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
| `phase` | `"after-turn" \| "between-tool-batches" \| "requested"` | When it ran: after the turn, between two tool batches of a running turn, or on `POST /sessions/{id}/compact` or `POST /sessions/{id}/flush`. |
| `flushed` | `number` | How many messages the memory flush exchanged with the model (0 when no flush ran). The flush itself lands in the session log as a `memory_flush` entry; see [Memory flush entries](#memory-flush-entries). |
| `compacted` | `CompactionEntry \| null` | The compaction entry written, or `null` when nothing was compacted. |
| `notices` | `string[]` | What the pane would have shown: the compaction line, or why a flush or compaction failed. |

The compaction line's `context now N of W` is the same reading `GET /sessions/{id}/context`
answers right after it: everything the next request carries, measured fresh from the shorter
history (`basis: "estimated"` until the provider reports again). Since contract 1.6; before,
it counted the conversation alone.

### session.tree

Fires after a verb changes the shape of a session's entry tree, so a client re-fetches
`GET /sessions/{id}/entries` rather than patching its copy. Carries the session's id, like
`session.state`. `POST /sessions/{id}/leaf` also records a `session.state` envelope (the host
writes it as part of the move, so it arrives first) because the leaf is part of the state.
`POST /sessions/{id}/restore` moves the leaf too, so it records `leaf` the same way, naming the
`restore` entry it wrote, which is the new leaf. `POST /sessions/{id}/forget` does the same with
the `context_edit` entry it wrote.

| Field | Type | Meaning |
|---|---|---|
| `reason` | `"fork" \| "label" \| "leaf"` | Which verb changed the tree: `POST /sessions/{id}/fork`, `/label`, or `/leaf`, `/restore` and `/forget`. |
| `entryId` | `string \| null` | The entry the verb named (on a restore, the entry it recorded); `null` only for a leaf move to the empty root. |
| `forkedTo` | `string`, optional | On `fork`, the new session's id. The event rides the session that was forked, not the new one. |

### changes.updated

Fires when the files a session's diff shows may have changed: once per burst of finished
`write`, `edit` or `bash` tool calls (the same pairing of `tool.started` and `tool.finished` the
terminal diff pane follows, `followMutations` in the engine; calls that land within the same
16 ms quiet window, or while a listing is in flight, fold into one trailing event), and after `POST /sessions/{id}/undo`,
`/redo` or `/restore` put files back. Carries the id of the session whose turn or verb did it. `paths` is the
whole list `GET /sessions/{id}/changes` would answer at that moment, not a delta, so a client
replaces its list; the per-file sides still come from `GET /sessions/{id}/changes/file`. Never
fires on a server started with `--no-checkpoints`, where there is no baseline to diff against.

| Field | Type | Meaning |
|---|---|---|
| `paths` | `string[]` | Every path this session's turns touched that differs from the session-start baseline, relative to the workspace root. Since contract 1.6 the list is the session's own; before, it was every changed file in the workspace. |
| `turn` | `number`, optional | The highest 1-based turn ordinal of this session attributed to those paths, which is the turn that just touched them; absent when nothing differs or nothing is attributed. |

`GET /sessions` sums the last listing announced for each session as its row's `changes`
(`{ files, added, deleted }`), so a desk can show a session's changes before it opens any
stream. A session with no announcement in this server process shows the totals its latest
`turn_facts` froze (`session`), so a restart keeps the figure; a session that never settled a
turn has no `changes` on its row.

### creature.changed

Fires when a creature's own facts changed in a way no session event carries, so a client
re-fetches `GET /creatures` or `GET /creatures/{slug}` whole rather than merging a delta. Thread
state (working, waiting, back) keeps riding the session events; this event only says that the set
of creatures, or the set of a creature's sessions, is different now. Fires wherever the creatures
port notifies its subscribers. Since contract 1.8.

| Field | Type | Meaning |
|---|---|---|
| `slug` | `string` | The creature. |
| `change` | `"created" \| "updated" \| "paused" \| "resumed" \| "removed" \| "conversation" \| "threads"` | Why: `created` after `POST /creatures`; `updated` after `PATCH /creatures/{slug}` (a rename, a body or a policy change, since contract 1.14); `paused` and `resumed` after `POST /creatures/{slug}/pause` and `/resume` (since contract 1.14); `removed` after a confirmed `DELETE /creatures/{slug}`; `conversation` when the first `GET /creatures/{slug}` opened the conversation (a read with one idempotent side effect, kept for milestone one); `threads` when a thread was opened or finished (its summary entry reached the conversation). |

### creature.handoff

Fires when the tally of how often one creature handed work to another changed, so a console that
draws which creatures work together updates one pair without re-fetching
`GET /creature-handoffs`, which serves the whole tally for a cold start. A hand-off is a creature
message (the `message` tool, or `POST /mesh/messages`) from one creature in the workspace to
another on this machine that was delivered into the receiver's conversation. Nothing else
counts: not a message refused (its shape, the receiver's inbound policy, a missing receiver or
conversation, a repeat, the hourly limits), not one to or from a creature on another machine,
not a creature's message to itself, not an agent's `ask` over MCP, and not a thread reporting
back to its own creature. The two directions of a pair are separate rows. The server counts each hand-off as it is delivered and
keeps the tally for the workspace under the node's state, saved on every change, so it outlives
a restart; it is never rebuilt from history and began empty with contract 1.36. Removing a
creature (a confirmed `DELETE /creatures/{slug}`) drops every pair that names it, with one
`dropped` event each, so a creature made again under the same slug starts from none. The tally
is a count for display: it grants, widens and implies nothing about what any creature may do.
Since contract 1.36; an older server sends none and serves no `GET /creature-handoffs`.

| Field | Type | Meaning |
|---|---|---|
| `change` | `"counted" \| "dropped"` | `counted` when a hand-off was delivered; `dropped` when the pair left the tally with a removed creature. |
| `handoff.from` | `string` | The slug of the creature that handed the work over. |
| `handoff.to` | `string` | The slug of the creature it was handed to. |
| `handoff.count` | `number` | Hand-offs from `from` to `to` so far, at least 1; on `dropped`, the count the pair had when it went. |
| `handoff.lastAt` | `string` | When the latest of them was delivered (ISO 8601). |

### creature.ledger

Fires when an entry in a creature's ledger opened, changed or left the kept list, so the keeper's
console updates one row of its per-creature panel without re-fetching
`GET /creatures/{slug}/ledger`, which serves the whole ledger for a cold start. The ledger is the
creature's questions for the keeper and its tasks, kept as history after their sessions are
cleared. Not the keeper ledger behind `GET /creatures/{slug}/report`, nor the memory ledger.

A question is `waiting`, then `answered`. It is a permission ask on one of the creature's sessions
(its conversation, a chore run, a thread, or a sub-agent of one), waiting from when it joins
`GET /asks` until it leaves it, or a chore held on a write or act grant set the keeper has not
accepted, waiting while `GET /routines/needs-you` lists its `grants` item. A task is `running`,
then `finished` until the keeper looks (`POST /creatures/{slug}/ledger/{id}/seen`), then `done`;
or `blocked` when it failed, timed out, ran over budget or could not deliver. A task is a chore run,
from its thread's opening to its `routine.finished`, or a thread of kind `thread`, until its first
report reaches the conversation. The conversation's own turns are not tasks, and a sub-agent's work
belongs to the session that delegated it.

The server writes every change as it happens and keeps the ledger for the workspace under the
node's state (`creatures/ledger.json` beside the hand-off tally), so it outlives a restart and
the sessions it names. It is never rebuilt from history and began empty with contract 1.37; the
one thing read back is which chores are held on grants, from the chore journal at every start. No
ask or turn outlives the server, so a question about an ask a stopped server left waiting is
answered `lapsed`, and a task it left running is `blocked`, when the next server starts; those
settle without an event. Each creature keeps its 50 most recent closed entries; an older one
leaves the list with `change: "folded"` and adds to `folded`. Open entries are always kept.
Removing a creature (a confirmed `DELETE /creatures/{slug}`) drops its ledger with no event of
its own beside `creature.changed`, so a creature made again under the same slug starts from none.
The ledger is a record for display: it grants, widens and implies nothing about what any creature
may do, and a question is answered only where it was asked. Since contract 1.37; an older server
sends none and serves no `GET /creatures/{slug}/ledger`.

Work in a bound project is on the creature's ledger too (since contract 1.40). A project's threads
run in that project's own runtime, which keeps their questions and their tasks for the home's
creature by the same rules (a permission ask on the thread or a sub-agent of it is a question; the
thread is a task, running until its first turn settles, titled with the opening words of what was
asked until the thread has a title of its own). This server reads them from that runtime with
`GET /creatures/{slug}/ledger?visitor=<its workspace identity>` at the moments it reads that
project's worksites: at start, as soon as that runtime says something changed there
(`POST /creature-projects/{project}/changed`, sent when a turn of one of its threads begins or one of
its questions or tasks changes, whether the turn was started from here or from the project's own
console), and then once a second while a thread there has a turn running. It carries each as its own
entry with `project` set to the project's id: opened, changed and folded as any entry, and marked
seen here. Such a question is answered on the project's server, with
`POST /asks/{callId}` there, where it waits in that server's `GET /asks`; its entry here follows
within about a second. A restart of this server does not settle a project's entries, since their
work did not stop with it; a project's runtime that stops answers its own open questions `lapsed` and
its running tasks `blocked` when it starts again, and this server learns that the next time it reads
that project. A project's entry takes no short conversation, which runs only on the server where the
work runs.

An entry may carry a short conversation about it (since contract 1.38; a 1.37 server sends no
`conversation`, which a client reads as `null`). `POST /creatures/{slug}/ledger/{id}/conversation`
opens one, a fresh session of kind `thread` on this server, titled `About: <entry title>`, its
journal naming the entry (`keywork.creature.ledger-conversation`, so `GET /sessions/{id}` carries
`ledgerEntry: { creature, id }`), and framed with the entry so the creature speaks first. It talks
on the creature's conversation model, as its main conversation does, and never needs the model its
work threads use (since contract 1.39; a 1.38 server chose the work-thread model, so with a model
that serves only conversations the request failed without an answer). Asking
again for the same entry answers the same conversation, open or ended; a question already answered
with no conversation is refused. The conversation ends when the entry's question is answered
(granted, denied or lapsed, `endedBy: "answer"`) or when the keeper closes it with
`POST /creatures/{slug}/ledger/{id}/conversation/close` (`endedBy: "keeper"`, which also stops a
running turn). Ended is read-only and kept in two places: the conversation's own journal gains a
`keywork.creature.conversation-ended` entry `{ at, by, decided }`, so `POST /sessions/{id}/prompt`
and `/inject` answer 409, `GET /sessions/{id}` still reads it with `endedAt`, and it is no longer
among the creature's live `threads`; and the entry's `conversation.state` becomes `ended`, so the
console still reaches it from the entry. One line saying what was decided goes into the creature's
main conversation as a creature report (`The conversation about "<title>" ended: the keeper allowed
it.`). Both survive a restart, and a question the stop answers `lapsed` ends its conversation at
the next start. Each change fires this event with `change: "changed"`. The conversation answers no
question and grants nothing: a permission question is still answered with `POST /asks/{callId}`, and
the conversation's own tool calls pass the same gate as any thread's. It is for work on this server
only: an entry whose `project` is set is refused with 409, since its work runs in that project's
runtime.

| Field | Type | Meaning |
|---|---|---|
| `creature` | `string` | The creature's slug. |
| `change` | `"opened" \| "changed" \| "folded"` | `opened` for a new entry; `changed` when its state, title or session changed; `folded` when it left the kept list. |
| `entry.id` | `string` | Stable for the life of the entry. |
| `entry.kind` | `"question" \| "task"` | What it is. |
| `entry.state` | `"waiting" \| "answered" \| "running" \| "finished" \| "done" \| "blocked"` | The first two for a question, the rest for a task. |
| `entry.title` | `string` | Plain words: `Allow bash git push origin main?`, `May the chore "Morning triage" write?`, or the chore's or thread's title. |
| `entry.directory` | `string` | The working directory of the session the work lives in; the workspace for a chore held on grants. |
| `entry.session` | `string \| null` | That session while it is in the session directory; `null` while it is in the trash (it comes back with `POST /trash/{id}/restore`) or when there never was one. |
| `entry.openedAt` | `string` | When it opened (ISO 8601). |
| `entry.closedAt` | `string \| null` | When it was answered, finished or blocked; `null` while it is open. Marking a task seen leaves it as it was. |
| `entry.answer` | `"granted" \| "denied" \| "lapsed" \| null` | On an answered question: what the answer was, or `lapsed` when nobody answered (the ask timed out, its session or the server closed first, or the chore stopped needing the acceptance some other way). `null` otherwise. |
| `entry.about` | `object` | `{ kind: "ask", callId, tool }` (answer it with `POST /asks/{callId}`), `{ kind: "grants", routineId }` (accept it on the chore), `{ kind: "chore", routineId, runId }` or `{ kind: "thread" }`. |
| `entry.conversation` | `object \| null` | `{ session, state, openedAt, endedAt, endedBy }` once a conversation about the entry was opened: `session` is its session, `state` is `open` or `ended`, `endedAt` and `endedBy` (`answer` or `keeper`) are `null` while it is open. `null` when none was opened. Since contract 1.38. |
| `entry.project` | `string \| null` | The bound project's id (as in `GET /creatures/{slug}/projects`) when the work runs in that project's runtime: `session` and `directory` are then that runtime's, and a question is answered there. `null` for work on this server. Since contract 1.40. |
| `folded` | `number` | How many of the creature's closed entries have left the list so far. |

### creature.worksites

Fires when a row of the worksite tally appeared or changed, so a console that draws each folder a
creature has worked in follows one row without re-fetching `GET /creature-worksites`, which serves
the whole tally for a cold start. A worksite is a folder a creature worked in, one row per creature
and folder. With `root` the directory a conversation started in: when `root` is a repository (it
holds `.git`), every conversation there that had a turn counts toward `root`, from its first turn,
and no folder inside it is ever a worksite. Otherwise the conversation counts toward each immediate
child folder of `root` in which it changed a file, and toward `root` itself only for a file changed
directly in it. A file changed outside `root` counts toward the nearest folder above the file that
holds `.git`, as a row whose `root` is that folder (a few checks up the path, remembered per
folder), and toward nothing when no folder above it holds one. A changed file is a `write` or
`edit` tool call with a `path` that succeeded, as the session journal records it; nothing else
counts, so talking, reading and searching count toward nothing, and neither does a command, since
each command is a fresh process started in `root` and the text of a command is never read for a
folder. `.keywork`, the stead's own state, is never a worksite. A sub-agent's work belongs to the
conversation that delegated it.

A bound project's threads run in that project's own runtime, and that runtime counts them by the
same rule, for the creature that sent the work, with `root` the project's directory: a project that
is a parent folder of several repositories gives a row for each child folder a thread changed files
in, and a project that is itself a repository gives one row. The creature's own server reads those
rows from the project's runtime with `GET /creature-worksites?visitor=<its workspace identity>`, over
the same ticket and the same check it makes before starting a thread there, and carries them as its
own rows with `project` set to the project's id; this grants nothing new, since it learns only about
work done for its own creatures. It reads them when it starts, and after it starts a thread there
once a second for as long as one of that project's visiting threads has a turn running, so a project
row's `active` and its new rows follow the thread within about a second. A project whose runtime
does not answer keeps the rows last read, with `active` false. When one folder was worked in both
from a bound project and from a conversation started here, it is one row carrying the project, and
its `conversations` adds the two. On Windows two spellings of one folder are one row.

Conversations from before contract 1.39 are counted once, from the session journals (sub-agents'
included, and in a project's runtime the project threads it ran for other workspaces' creatures),
when a 1.39 server first starts for the workspace. After that the server counts work as it happens and keeps the tally
for the workspace under the node's state (`creatures/worksites.json` beside the hand-off tally),
saved whenever a row is announced, so a restart reads that file and never the journals. Rows only
grow: later work never takes a building away, and a session moved to the trash keeps its count.
Removing a creature (a confirmed `DELETE /creatures/{slug}`) drops its rows, with one `dropped` event
each, so a creature made again under the same slug starts from none. The event never fires for each
tool call: it fires when a row appears, when its `conversations` changes, or when its `active` flips,
and `latest` rides along with those; rows a project's runtime keeps for visiting creatures fire
nothing there. The tally is for display: it grants, widens and implies nothing about what any
creature may do. Since contract 1.39; an older server sends none and serves no
`GET /creature-worksites`.

| Field | Type | Meaning |
|---|---|---|
| `change` | `"changed" \| "dropped"` | `changed` when the row appeared or changed, carrying it as it now stands; `dropped` when it left the tally with a removed creature, carrying it as it was. |
| `worksite.creature` | `string` | The creature's slug. |
| `worksite.directory` | `string` | The worksite, an absolute path in the form a session reports its `cwd`. |
| `worksite.root` | `string` | The directory the conversations started in: this workspace, or the bound project's directory; for a file changed outside it, the repository folder itself. Equal to `directory` when the root is itself the worksite. |
| `worksite.project` | `string \| null` | The bound project's id (as in `GET /creatures/{slug}/projects`) when the work ran in a bound project; `null` otherwise. |
| `worksite.conversations` | `number` | How many of the creature's conversations worked there, at least 1. |
| `worksite.since` | `string` | The first work there (ISO 8601). |
| `worksite.latest` | `string` | The latest work there (ISO 8601). For a repository root, a turn's start or end; otherwise a changed file. |
| `worksite.active` | `boolean` | Whether a turn is running now in a conversation that has worked there. |

### creature.honours

Fires when a creature or the stead earned an honour while the server runs, or when a removed
creature's honours left with it, so a console plays its ring of light on what was just earned
without re-fetching `GET /creature-honours`, which serves every honour held for a cold start. An
honour is a fact with its proof: once earned it is never taken away, never re-earned and never
counts down, and the event and the route carry only what was earned, never a count in progress,
so no surface can show how close anything is.

A creature earns `conversations` at 10, 100 and 1,000 of its conversations that had a turn;
`night` when a turn of its work finished between midnight and five in the morning, this machine's
time; `partners` at 10 and 100 hand-offs with one partner, both directions of the hand-off tally
together (`with` the partner, one row per partner and tier); `tower` at 30 and 300 conversations in
one folder of the worksite tally (`with` the folder); `standing` at each full year since it was
made; `range` at 4, 8 and 12 kinds of tool, each used successfully ten times, where a kind is a
tool's name as it was called; and `run` at 7, 30 and 100 days in a row, this machine's calendar,
each with a finished turn of its work. When a run ends nothing is said and nothing changes. The
stead earns `first-creature`, `hamlet` (three creatures at once), `town` (eight at once),
`paved-road` (the first pair to reach 20 hand-offs both ways together, `with` the two slugs joined
by `+` in alphabetical order) and `first-tower` (the first `tower` of any creature, `with` the
folder). A sub-agent's work belongs to the creature that delegated it. A creature's threads in a
bound project count exactly as its work here: that project's runtime keeps the dated facts of the
threads it ran for this workspace's creatures, and this server reads them with
`GET /creature-honours?visitor=<its workspace identity>` at the moments it reads that project's
worksites, so a turn finished in a project thread counts toward `conversations`, `night`, `range`
and `run` within about a second.

Honours from before contract 1.40 are counted once, from the session journals, the hand-off tally,
the worksite tally and the creatures' own files, when a 1.40 server first starts for the workspace,
and fire no event; so does anything learnt later that was earned before this server started, such as
a project's facts read after a start. After that the server weighs honours as work happens and keeps
them, with the facts they are weighed from, for the workspace under the node's state
(`creatures/honours.json` beside the hand-off tally), so a restart reads that file and never the
journals. Removing a creature (a confirmed `DELETE /creatures/{slug}`) drops its honours, with one
`dropped` event each; the stead's own stay. Honours are for display: they grant, widen and imply
nothing about what any creature may do. Since contract 1.40; an older server sends none and serves
no `GET /creature-honours`.

| Field | Type | Meaning |
|---|---|---|
| `change` | `"earned" \| "dropped"` | `earned` when the honour was earned while this server runs; `dropped` when it left with a removed creature. |
| `honour.holder` | `string \| null` | The creature's slug, or `null` for the stead's own. |
| `honour.kind` | `"conversations" \| "night" \| "partners" \| "tower" \| "standing" \| "range" \| "run" \| "first-creature" \| "hamlet" \| "town" \| "paved-road" \| "first-tower"` | What was earned. |
| `honour.tier` | `number` | 1 for the first step of a kind, 2 for the next, and so on; a creature that reached 100 conversations holds tiers 1 and 2 as two rows. |
| `honour.with` | `string \| null` | The partner for `partners`, the folder for `tower` and `first-tower`, the pair for `paved-road`; `null` otherwise. A row is named by `holder`, `kind`, `tier` and `with`. |
| `honour.earnedAt` | `string` | When it was earned (ISO 8601). For hand-offs and folders counted before contract 1.40 the engine kept no finer fact, so it is the latest time the honour is known to have been held by, and `proof` says "counted by". |
| `honour.proof` | `string` | One plain sentence a keeper can check, such as `Ten conversations; the tenth began on 20 November 2026.` |

### creature.scenes

Fires when a creature kept a scene or one was forgotten, so a console's list of a creature's scenes
follows without re-fetching `GET /creatures/{slug}/scenes`, which serves them for a cold start. A
scene is an arrangement a creature keeps by name with its window tools and sets out again: what it
had out, and where each thing stood. The creature keeps one with `arrange` and `keep` (what it has
out, or the `panes` it names, as they stand now), sets it out again with `arrange` and `scene`, and
lets it go with `arrange` and `forget`; the keeper sets one out with
`POST /creatures/{slug}/scenes/{name}/set-out` and forgets one with
`DELETE /creatures/{slug}/scenes/{name}`. A scene may belong to a place in the stead (the place
`from` names when it is kept, or the one project all its things rose from), and pressing that place
sets it out. Setting a scene out passes the same gate and limits as setting each thing out by hand:
a terminal or a screen in it asks the keeper every time, each thing spends one of the creature's
settings an hour, and no more than twelve stand outside at once. A creature keeps at most 12; the
thirteenth is refused in words that name the limit, and keeping a name it already keeps replaces
that scene. The server keeps scenes for the workspace under the node's state
(`creatures/scenes.json`). Removing a creature drops its scenes, with one `forgotten` event each.
A creature working in a thread of a bound project keeps its scenes here too: that project's runtime
reads the creature's scenes from this server's keeping and sends a scene kept there with
`PUT /creatures/{slug}/scenes/{name}`, so it is listed, counted against the same twelve and
announced here like any other, and it belongs to that project's place unless `from` named
another. Its things are the project's, so it is set out in the project: from a thread there, or at
the keeper's press here, which this server passes to that project's runtime (`stopped` says so when
that runtime does not answer); setting it out from a thread elsewhere is refused in words. Since
contract 1.40; an older server sends none.

| Field | Type | Meaning |
|---|---|---|
| `creature` | `string` | The creature's slug. |
| `change` | `"kept" \| "forgotten"` | `kept` when the creature kept a scene, new or replacing one of the same name; `forgotten` when it was forgotten or left with a removed creature. |
| `scene.creature` | `string` | The creature's slug. |
| `scene.name` | `string` | As the creature named it, trimmed, at most 40 characters; one per creature and name, compared without regard to case. |
| `scene.place` | `object \| null` | The place in the stead it belongs to, in the shape a setting's `place` has, or `null`. |
| `scene.holds` | `object[]` | `{ kind, title }` for each thing it sets out, in order: `kind` a setting's `what.kind`, `title` its title or, without one, its ref. |
| `scene.keptAt` | `string` | When it was kept (ISO 8601). |

### model.wait

Fires when a turn has waited two seconds on a model that is not answering yet, and again when that
wait is over, so the stead can show what is holding work up; `GET /model-waits` serves the waits
standing now for a cold start. Unlike the other server events it carries the waiting session's id
in the envelope. Only waits the engine already observes are reported, and no queue is kept for
this: a turn whose model request failed and that is waiting to try again. A wait is `limited` when
the provider said it is rate limited (429) and `busy` when it said it is overloaded or timed out
(408, or 500 and above). A provider that cannot be reached is not a busy model and is not reported.
The wait lasts across the tries of one turn until the model answers or the turn ends. A wait
shorter than two seconds is never reported, and `over` fires only for a wait that was. No retry
time, attempt or count is carried, so nothing can count down. For display only. Since contract
1.40; an older server sends none and serves no `GET /model-waits`.

| Field | Type | Meaning |
|---|---|---|
| `change` | `"waiting" \| "over"` | `waiting` once the wait has lasted two seconds; `over` when the model answered, the turn ended, or the session settled. |
| `wait.session` | `string` | The waiting session, the same as the envelope's `sessionId`. |
| `wait.creature` | `string \| null` | The creature whose work waits (a sub-agent's wait is its creature's), or `null`. |
| `wait.server` | `string \| null` | The origin of the local model server it waits on, as `GET /models` gives a server's `root` (for example `http://127.0.0.1:11434`); `null` for a cloud provider. |
| `wait.reason` | `"busy" \| "limited"` | Why the model is not answering yet. |
| `wait.since` | `string` | When the wait began (ISO 8601). |

### routine.fired

A chore (code name `routine`) is scheduled or triggered work a creature does on its own: a file at
`routines/<id>.json` beside the creature's `bot.md`, indexed in the node's SQLite journal. Its
runs are sessions bound to the creature's bot and tagged `kind: "routine"`. Two events describe
a run from the outside; the run's own turn, tool and gate events ride the run's session as usual.
The envelope's `sessionId` is the run's session id once the run has one, and the empty string for
a run that ended before a session opened (refused by the lock or a cap, or unable to start). They
are never replayed from a journal: a client that reconnects re-reads
`GET /creatures/{slug}/routines/{id}/runs`. Since contract 1.8.

`routine.fired` fires when a run's session has started: after the hourly caps, the per-routine
lock and the consent check let it through. A slot that was skipped or dropped fires no
`routine.fired`; its run row says why. A write or act chore whose grant set the keeper has not
accepted does not end: its run parks (`status: "parked"`, `sessionId: null`) and `routine.needs`
carries the chore's `grants` item; `routine.fired` follows when the keeper accepts and the parked
run proceeds, and `routine.finished` with `process: "cancelled"` when the chore is removed, turned
off (a run started by hand outlives that) or the run is cancelled.

| Field | Type | Meaning |
|---|---|---|
| `runId` | `string` | The run's id, stable for one `(creature, routineId, firedAt, attempt)`. |
| `creature` | `string` | The creature's slug. |
| `routineId` | `string` | The chore's id (its file name without `.json`). |
| `attempt` | `number` | 1 for a slot's first run; above 1 for a retry after a failure or an interruption. |
| `trigger` | `"cron" \| "interval" \| "at" \| "file-watch" \| "webhook" \| "event" \| "manual"` | What fired it. The four after `interval` since contract 1.17. |
| `catchUp` | `boolean` | True when the run catches up a slot missed while the node was down or asleep. |
| `firedAt` | `string` | The slot the run is for (ISO 8601): the cron or interval instant, or when it was run by hand. Runs are idempotent by this and `attempt`. |
| `scheduledFor` | `string` | When the scheduler planned to start it: the slot plus the routine's deterministic stagger, a paced catch-up time, or a backoff retry time. |
| `startedAt` | `string` | When the session started. The run's prompt carries scheduled and actual time so it can apply late-run guardrails. |
| `sessionId` | `string` | The run's session. |

Since contract 1.17 a chore may also fire on an occurrence, and a creature may schedule its own
wakeup; no new event name carries either, and both ride the same three events and the same journal.

- `at` fires once at an instant: the shape of a wakeup a creature asked for with the `schedule`
  tool (REQ-057). Such a chore carries `wake: { requestedAt }`, sits on the chore board like any
  other and is cancelled by the keeper with `DELETE`. A paced wakeup is an `interval` with an
  `until` seven days out at most (RUN-048), above a floor of fifteen minutes. A wakeup runs
  read-only unless it asks for write or act tools that one of the creature's keeper-accepted grant
  sets already covers; anything more parks on its own grant set like every chore. A creature asks
  for at most six wakeups an hour and holds at most twelve waiting.
- `file-watch` fires on changes under the workspace that match its paths or globs, debounced so a
  burst becomes one run (RUN-043). Nothing outside the workspace is watched, and a change that
  resolves outside it is dropped.
- `webhook` fires through `POST /hooks/{slug}/{id}`, served on loopback, with the chore's own token
  from `POST /creatures/{slug}/routines/{id}/hook`; its body is capped by the chore's `maxBytes`.
- `event` fires on a bus event by exact name whose payload matches `where` (dotted paths compared
  for equality); a chore never fires on an event about itself.

An occurrence's payload (the changed paths, the webhook body, the matching events) is untrusted
data (RUN-033): it is saved as `<runId>.trigger.json` beside the run journal's outputs, and the
run's prompt names that file and its size, never its text. A fired trigger is a stored
assignment, never consent: every trigger obeys the hourly caps, the per-chore lock and the park on
an unaccepted grant set, and writes the same run rows.

### routine.finished

Fires once per run row that reaches `status: "ended"`: a run that completed, failed, timed out,
was cancelled or was blocked (minutes or dollars over budget), and every run
the node found unfinished when it started again (`process: "failed"`, with `delivery: "unknown"`
when an effect was in flight; such an effect is never replayed). Since contract 1.8.

| Field | Type | Meaning |
|---|---|---|
| `run` | `RunRow` | The whole run row, exactly as `GET /creatures/{slug}/routines/{id}/runs` serves it. |
| `disabled` | `string \| null` | Set when this run's failure turned the chore off (five failures in a row by default): the reason, also shown on the chore as `schedule.disabled.reason`. |

`RunRow` fields that matter to a client:

| Field | Type | Meaning |
|---|---|---|
| `status` | `"running" \| "parked" \| "ended" \| "skipped" \| "dropped"` | `parked` means the run waits on the keeper with no turn running: an ask on its session, or (with `sessionId: null`) the grant set of a write or act chore not yet accepted; `skipped` and `dropped` rows never ran, and `reason` says why. |
| `process` | `"completed" \| "failed" \| "cancelled" \| "timed-out" \| "blocked" \| null` | How the run's process ended. Not whether the work arrived. |
| `delivery` | `"delivered" \| "unknown" \| "failed" \| "none" \| null` | Whether the output reached its destination, tracked apart from the process. |
| `verified` | `boolean \| null` | Whether the goal was checked; `null` in milestone one (no verifier yet). |
| `reason` | `string \| null` | Why the run ended other than `completed`, or why a slot was skipped or dropped. |
| `output` | `string \| null` | The file the run's final output was saved to, beside the journal. |
| `notify` | `{ tier: "interrupt" \| "digest" \| "log", at: string \| null } \| null` | How the keeper should hear about it, and when: `interrupt` for anything that needs the keeper (deferred to the end of quiet hours), `digest` at the next digest time for a chore that notifies `always`, `log` for nothing to report. |

### routine.needs

Fires whenever the set of reasons one chore needs the keeper changes: after `routine.fired` and
`routine.finished`, after the keeper accepts its grant set, and after `PUT` or `DELETE` on the
chore. The payload is the whole current set for that chore, so a consumer replaces what it held
for `(creature, routineId)` and an empty `items` clears it. `GET /routines/needs-you` serves the
same items across every creature for a cold start. Keeper-facing items come from this wire,
never from a pane deriving its own (`adr.keeper-facing-items-come-from-the-wire-never-a-pane`).

| Field | Type | Meaning |
|---|---|---|
| `creature` | `string` | The creature's slug. |
| `routineId` | `string` | The chore's id. |
| `items` | `NeedsYouItem[]` | Each `{ creature, routineId, kind, reason, runId, since, action }`. `kind` is `grants` (held on an unaccepted write or act grant set; `action` is `{ verb: "accept", digest }` and `runId` the refused run, when one was), `run` (the last run ended and needs you), `disabled` or `invalid`. `since` is when that began, when known. |

A held run has no session, so the item names the chore, never a thread. Since contract 1.10.

### workshop.changed

Fires when a creature's workshop is raised, started, stopped or removed: from the
`/workshops` routes, and from the node itself when it restarts each running workshop after login
or reboot (`Workshops.restartRunning`). The payload carries the whole record, so the workshop
pane and the stead (a workshop raised on the ranch when a creature gets one, its window lamp lit
while it runs) need no follow-up request; `GET /workshops` stays the source of truth after a
reconnect. A start that fails its health check, and a request the node refuses, fire nothing: the
route's answer carries the refusal. Health is not evented; a pane polls
`GET /workshops/{id}/health`. Since contract 1.8.

| Field | Type | Meaning |
|---|---|---|
| `change` | `"created" \| "started" \| "stopped" \| "removed"` | What happened. `removed` carries the record as it was, with `state: "stopped"`. |
| `workshop.id` | `string` | The workshop, `<creature>-<6 hex>`. |
| `workshop.creature` | `string` | The one creature it belongs to; two creatures never share a workshop. |
| `workshop.substrate` | `"sbx" \| "compose" \| "host"` | `sbx` is a sealed microVM; `host` is a bare directory on the node. |
| `workshop.state` | `"stopped" \| "running"` | The state the node last put it in; health is read separately. |
| `workshop.workdir` | `string` | Where its tools start: `/home/agent/workspace` inside `sbx`, a directory under the node's state dir on `host`. |
| `workshop.brokers` | `string[]` | Model-provider credentials the node swaps in on egress; inside, the workshop sees only sentinels. |
| `workshop.limitations` | `string[]` | What the workshop lacks, said plainly (a bare host has no VM boundary, no egress policy and no credential proxy). |
| `workshop.display` | `boolean` | Whether `GET /workshops/{id}/display` can stream frames. |
| `workshop.createdAt` | `string` | ISO 8601 creation time. |

### models.changed

Fires when what `GET /models` would answer for one node changed, so the mills pane re-fetches
that node rather than merging a delta: after a probe recorded or refreshed a capability record
(`POST /models/probe`, or the inventory's own scan), after a node manifest advertised a different
server list, or when a server's health moved (a breaker opening or closing). The payload carries
no detail on purpose; `GET /models?node=` is the source of truth. Since contract 1.8.

| Field | Type | Meaning |
|---|---|---|
| `node` | `string` | The node whose model servers changed. |
| `reason` | `"probe" \| "manifest" \| "health"` | What changed it. |

### mesh.listener

The node listens on its tailnet addresses only (one listener per address in
`Status.TailscaleIPs` that a local interface carries, IPv4 and IPv6), only while tailscaled
reports `BackendState == "Running"` with a TUN device, and never while Tailscale Funnel is on
for this node. It polls the status every 5 seconds by default and rebinds on change. Every
inbound connection is identified once by WhoIs on its remote address before any route runs;
admissions and denials are audit rows (`GET /mesh/audit`), not events. One event with a `change`
describes the listener itself. Since contract 1.8.

| `change` | Fields | Meaning |
|---|---|---|
| `bound` | `address`, `port` | A listener opened on a tailnet address (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`), on 47800 unless configured. |
| `unbound` | `address`, `reason` | A listener closed: `not-running`, `userspace-networking`, `no-local-tailnet-address`, `funnel-enabled`, `address-gone` or `closed`. |
| `bind-failed` | `address`, `error` | A planned listener could not open (`EADDRINUSE`, say); the other addresses keep listening and the next poll tries again. |
| `idle` | `reason` | The node moved to listening on nothing, once per change of reason: `not-running`, `userspace-networking`, `no-local-tailnet-address` or `funnel-enabled`. |
| `status-failed` | `error` | A poll could not read the tailscaled status or serve config. Existing listeners stay open; every new connection on them is denied while WhoIs fails, so failing to read is never failing open. |
| `serve-warning` | `message` | Once per distinct message when this node runs Tailscale Serve on a client older than 1.104.4, the release that carries the 2026 Serve security fixes. |

### mesh.pairing

An inbound pairing attempt on this node, through the phases of MESH.md section 3 with one
refinement: the hello carries a SHA-256 commitment to the console's nonce and keys, and the
nonce is revealed only after the target answered, so a machine in the middle cannot search for
keys that make both six-digit codes agree. A client that reconnects re-reads `GET /mesh/pairs`,
whose `pending` carries the same attempts. Every change but `confirming` also leaves an audit
row. Since contract 1.8.

| `change` | Fields | Meaning |
|---|---|---|
| `started` | `pairing` | An identified peer opened an attempt (hello accepted). `pairing` is `{ pairingId, peerStableId, peerUserId, role, caps, confirmation, phase, sas, expiresAt }`; `sas` is `null` until the reveal; `confirmation` is `on-device`, `claim-code` or `endorsement`. |
| `confirming` | `pairing` | The console revealed its nonce; both sides now hold the same six-digit `sas`. A machine with a screen shows it and asks the keeper to compare it with the console (`POST /mesh/pairings/{id}/confirm`). |
| `refused` | `peerStableId`, `reason` | A hello was refused at identify: `not-the-owner`, `other-tailnet`, `needs-a-human` or `unclaimed-needs-a-console`. |
| `aborted` | `pairingId`, `reason` | The attempt ended: `out-of-order`, `caller-changed`, `commitment-mismatch`, `sas-mismatch`, `bad-proof`, `bad-claim-code`, `wrong-confirmation`, `expired` or `cancelled`. Any step out of order aborts; the keeper starts over. |

### mesh.pair

A pair this node trusts came or went. The pair key itself never leaves the key store. Since
contract 1.8.

| `change` | Fields | Meaning |
|---|---|---|
| `added` | `pair` | A pair was stored here (on the target, once both confirmations landed): `{ id, peerStableId, peerUserId, peerTags, peerDeviceKey, role, caps, endpoint, createdAt, confirmedBy }`. |
| `removed` | `pairId`, `peerStableId`, `by` | A pair was forgotten, by the `keeper` here or by a signed `revocation` from an owner console. |

### mesh.grant

A grant lets a creature act on a parcel other than its workshop. A grant is `{ id, issuer,
subject: { creature, node }, target, caps, issuedAt, expiresAt, nonce, signature }`; `caps` are
`{ kind: files:read | files:write, paths }`, `{ kind: exec, commands }` or `{ kind: screen:view |
screen:control | clipboard }`. A client re-reads `GET /mesh/grants` on reconnect. Every change
also leaves an audit row. Since contract 1.8.

| `change` | Fields | Meaning |
|---|---|---|
| `issued` | `grant` | This console signed the grant and the target accepted it. |
| `installed` | `grant` | This node verified the grant's chain to a paired owner console and rendered it into rules for the creature. |
| `refused` | `issuer`, `reason` | A pushed grant was refused: `malformed`, `wrong-target`, `unknown-issuer`, `issuer-not-owner-console`, `bad-signature`, `not-yet-valid`, `expired`, `revoked` or `screen-control-too-long`. |
| `revoked` | `grantId`, `by` | The grant is now denied here, revoked by the `keeper` at this node or by a signed `revocation` pushed from a console. |

### mesh.revocation

A signed revocation could not reach its node yet; the console keeps it and retries. A node that
answers with a 4xx refusal ends the retries and the event says why. Carries no decision, so no
audit row. Since contract 1.8.

| `change` | Fields | Meaning |
|---|---|---|
| `undelivered` | `revocation`, `attempts`, `error` | `revocation` is `{ kind: "grant" \| "pair", id, issuer, target, revokedAt, nonce, signature }`; `attempts` counts deliveries tried so far; `error` is what the last attempt met. |

### mesh.walked

A creature walked through a gate: one envelope per remote tool call that names a live grant for
its creature, emitted before the ordinary gate rules on it, so the desk, the habitat and the
audit all see it. What the gate decided and what the tool said are the audit row and the call's
answer, not a second event; a call refused before the gate (no grant, an invalid grant, a subject
mismatch, a cap outside the grant, the hop limit) leaves an audit row only. Since contract 1.8.

| Field | Type | Meaning |
|---|---|---|
| `origin` | `{ kind: "mesh", creature, node }` | Who acts: the creature and the node it lives on (that node's StableID). |
| `grantId` | `string` | The grant it names. |
| `call` | `ToolCallPart` | `{ type: "tool-call", callId, name, arguments }`, as the gate sees it. |
| `rules` | `PermissionRule[]` | The creature-scoped rules rendered from every live grant for this creature and node. |

### mesh.peers

A tailnet peer's lane changed: the path `GET /mesh/peers` reports for it moved between `direct`,
`peer-relay`, `derp` (and its region) and `offline`. The serving workspace reads the tailscaled status every
15 seconds for this, never the census's hello probes, and says nothing on the first reading, for
a peer that joined or left (the census is re-read for those), or when only a direct endpoint's
port moved. A client that shows lanes updates the named rows or re-reads `GET /mesh/peers`.
Carries no decision, so no audit row. Since contract 1.12.

| Field | Type | Meaning |
|---|---|---|
| `change` | `"lanes"` | The only change today. |
| `peers` | `{ stableId, path }[]` | Each peer whose lane moved, with its new `path`: `{ kind: "direct", endpoint }`, `{ kind: "peer-relay", relay }`, `{ kind: "derp", region }`, `{ kind: "offline" }` or `{ kind: "unknown" }`, the census's own shape. |

### show.proposed

Something was set out for the keeper to see: a file, a diff, a report, a thread, a chore, a link
or a note. The model working a session sets things out with the `show` tool, which every session
`keywork serve` runs carries: a plain conversation, a creature's conversation, a delegated child
and a chore run alike (with `shown`, which lists what is out and where it stands, `arrange`, which
places what it has outside, and `withdraw`, which takes back what it set out). The keeper's own
openings from inside a setting or a thread (a file from a
diff, a test from a file, a link) arrive the same way, through `POST /show`, so every surface
agrees on the trail. It is IDE control: it arranges the console's own space around the conversation, never
the computer, and it changes nothing in the world, so it asks no permission and spends the keeper's
attention instead. The record lives on the server, not in a pane
(`adr.keeper-facing-items-come-from-the-wire-never-a-pane`): `GET /show` seats every setting still
out on a cold start, and a client follows this event and `show.settled` after that. Unlike the
process-level events above, both are scoped to a session: the envelope's `sessionId` is the thread
that set the setting out. What a console does with a setting, and the rung it actually uses, is its
own decision from context (its yard, under either profile), as a beat's play or hold is; the server
only carries the proposal. Since contract 1.27.

A setting belongs to its creature when the session has one, and to its thread otherwise. Showing
the same thing again (the same owner, `what.kind` and `what.ref`) replaces the earlier setting:
`show.settled` with `outcome: "withdrawn"` and `by: "creature"` for the earlier one comes first,
then `show.proposed` with a new id that names the earlier one in `replaces`. An owner sets out at most a hundred settings an hour, replacements
included; the tool answers the hundred-and-first with a sentence, as creature mail answers its limits,
and nothing fires.

Settings are kept for the workspace on disk, in the node's state beside its chores
(`~/.keywork/node/workspaces/<identity>/show/settings.json`, replaced atomically on every change), so
they outlive a console reconnecting, a server restart, a parked workspace waking and a workspace
re-trust. Live and pinned settings come back exactly as they were, with their ids, times, `from`,
`origin` and `replaces`; nothing settled is kept, so the file holds only what is still out. When the
server starts, a live setting whose `until` time passed while it was stopped, a live `rests` setting
(a stopped server is a rested thread) and a live setting whose session no longer exists are withdrawn
with no `show.settled`, since no console was listening; a console cold-starting from `GET /show`
simply does not see them. A pinned setting always comes back, and a live timed one still ahead is
withdrawn by `time` when its time comes, as before. The hourly limit counts what an owner set out
before the stop while it is still inside the hour, so a restart is no way around it. A kept file that
cannot be read is moved aside to `settings.json.unreadable` and the server starts with none, saying
so in one line of its log.

Every setting has a lineage (since contract 1.28). `from` names what it grew from: a setting still
out when it was set out, or a session, or `null` for one that starts a trail of its own. The tool
takes `from` only when it names a setting of the same owner, the calling thread, a thread that
thread delegated, or any thread of the same creature, and answers anything else with a sentence;
every answer of the tool names the new setting's id, so the model can grow the next one from it.
A replacement keeps its predecessor's `from` unless the call names another, and names the
predecessor in `replaces`, so a client moves whatever grew from the old id onto the new one. The
engine never withdraws a setting because the one it grew from was withdrawn or answered: folding a
trail is the console's decision. `origin` says whose hand set
it out: `creature` for the model working a session, with or without a creature, and `keeper` for an
opening through `POST /show`. A keeper's opening takes the thread and the creature of what it grew
from, proposes `unfold`, carries an empty `why` and `until: "seen"`, passes no gate and never counts
toward the hourly limit. Opening the same thing again replaces the earlier setting of that owner, so
its `show.settled` says `by: "keeper"`. A 1.27 server sends none of the three fields; a client
reads their absence as `from: null`, `origin: "creature"` and `replaces: null`.

A setting may name the size it opens at (since contract 1.29). `size` is `readable` or `working`,
absent when the session named none. It is honoured the first time the setting opens and never
re-applied, and the console may still show less. A replacement keeps its predecessor's `size` unless
the call names another; a keeper's opening carries none. A 1.28 server sends none; a client reads its
absence as the console's own choice. What became of a setting is also told to the session that set it
out, once, at the start of its next model request (the keeper's and the clock's settlements only,
never its own withdrawals or replacements and never anything the keeper opened); that note is
engine-internal and adds nothing to this stream.

A setting may stand outside the console window, in a pane of its own (since contract 1.33). `where`
is `beside`, today's behaviour and what its absence means, or `outside`. Outside, the console gives a
session's panes a stage: the free area beside the console when there is one, otherwise the far side
of the console, otherwise the whole display. The stage is a 12 by 12 lattice, and `seat` is a
rectangle on it, `{ x, y, w, h }` in whole twelfths with `x + w` and `y + h` at most 12, never
pixels; a setting outside with no `seat` leaves the place to the console. The tool takes a seat by
name (`full`, `left-half`, `right-half`, `top-half`, `bottom-half`, `left-third`, `middle-third`,
`right-third`, `left-two-thirds`, `right-two-thirds`, `top-left`, `top-right`, `bottom-left`,
`bottom-right`, and the plain ways of saying them), as lattice lines (`columns 4 to 8, rows 0 to 6`)
or as the rectangle, and the engine expands and checks it before anything is stored or sent, so the
wire only ever carries the rectangle. The console turns a seat into a window rectangle with its own
gap and may correct it. `weight` is `lead`, `support` or `aside`: who should have the large seat when
several stand together. `from` is also choreography outside: a setting whose `from` names a setting
that stands outside arises from that pane, and with `weight: "lead"` it drills in, taking the larger
seat while its parent steps down beside it until the setting is withdrawn. `mood` is `calm`, `brisk`,
`eager`, `playful` or `urgent`: how the pane arrives, motion only, which the engine carries without
judging and the console may ignore. `size` gains `card`. A replacement keeps where its predecessor
stands and its `weight` unless the call names others; `mood` belongs to one arrival and is never
carried over. `why` is empty when the session gave none. One owner has at most twelve settings
standing outside at once, and the tool answers the thirteenth with a sentence. A 1.32 server sends
none of these fields; a 1.32 console ignores them and sets everything beside the conversation.

| Field | Type | Meaning |
|---|---|---|
| `setting.id` | `string` | The setting, named in `POST /show/{id}/answer`. |
| `setting.creature` | `string \| null` | The creature's slug, or `null` for a session with no creature. A thread a bound project's runtime runs for a creature of the stead's home is that creature's: the setting carries its slug, its temperament is the mood when it names none, and the limits it counts against are the creature's own on that runtime (since contract 1.40; before, such a thread set out as no creature). |
| `setting.sessionId` | `string` | The thread that set it out. A delegated child sets out on its parent's thread, so the setting follows the thread the keeper sees. A keeper's opening sits on the thread of what it grew from. |
| `setting.what` | `{ kind, ref, title? }` | `kind` is `"file" \| "diff" \| "report" \| "thread" \| "chore" \| "url" \| "note" \| "pane"`; `ref` is the workspace path, change-set id, report id, session id, chore id, url, or the note's own words (at most 2000 characters); `title` is absent when none was given. Since contract 1.34 a `"pane"` is one of the console's own panes, and its `ref` is that pane's name: `"sessions"`, `"arcs"`, `"files"`, `"context"`, `"memory"`, `"needs-you"`, `"permissions"`, `"mcp"` or `"workspaces"`, and since contract 1.38 also `"workshop"`, `"mills"`, `"parcels"`, `"bots"`, `"campaigns"`, `"themes"`, `"posture"`, `"stead"`, `"terminal"` or `"screen"`. A session may name it in other words; the name here is always one of those. A `terminal` or `screen` acts on the keeper's machine, so the `show` that sets one out asks the keeper every time (`gate.ask` with `rule: "always"`) and nothing is proposed unless they allow it. |
| `setting.place` | `object` | Where in the stead the setting rises from, and where it goes back to when it leaves: `{ kind: "workshop", creature }`, `{ kind: "porch" }`, `{ kind: "store" }`, `{ kind: "mill" }` or `{ kind: "project", creature, directory }` with `directory` an absolute path. The session names it in its own words with `show`'s `from` (my workshop, the porch, the storehouse, the mill, a project or folder you have worked in by name or path, another creature's workshop). A project is this workspace or, since contract 1.39, a folder in the creature's worksites (`GET /creature-worksites`), named by its path or by its folder name when no other of that creature's places shares the name; `creature` is the creature whose worksite it is and `directory` that worksite's `directory`, so a console finds the building by it. Naming a place grants nothing and reads nothing from the folder. Left unnamed it is the creature's own workshop, the porch for a session with no creature and for a local agent over a creature's MCP server, and the place of what it grows from when `from` names a setting that is out. In a thread a bound project's runtime runs for a home creature it is that creature's project place, `{ kind: "project", creature, directory }` with `directory` the worksite the thread most recently worked in (the row `GET /creature-worksites` at home carries with that project's id), or the thread's own directory before it has worked in one (since contract 1.40). A replacement keeps its place unless it names another; a keeper's opening takes the place of what it grew from. Settings kept from before take their owner's default on load. Since contract 1.38; a 1.37 server sends none, which a client reads as the creature's workshop. |
| `setting.rung` | `"lantern" \| "card" \| "unfold" \| "stage"` | The rung proposed, `card` unless the tool call asked otherwise. A console may use a lower one; the glyph is rung zero and never proposed. |
| `setting.why` | `string` | One sentence for the card, at most 200 characters; empty for a keeper's opening and, since contract 1.33, when the session gave none. |
| `setting.at` | `string` | When it was set out (ISO 8601). |
| `setting.until` | `"seen" \| "rests" \| string` | When it goes: once the keeper has seen it (the default), when its thread rests (`rests`), or at an ISO 8601 time. |
| `setting.state` | `"live"` | Always `live` here; `GET /show` also serves `pinned`. |
| `setting.from` | `string \| null` | The id of the setting or the session it grew from, or `null` for one that starts a trail. Since contract 1.28. |
| `setting.origin` | `"creature" \| "keeper"` | `creature` for what the model working a session set out, `keeper` for the keeper's own openings through `POST /show`. Since contract 1.28. |
| `setting.replaces` | `string \| null` | The id of the setting this one replaced (the same owner and the same thing, whoever set either out), withdrawn just before by the `show.settled` that precedes this event; `null` when it replaced nothing. Since contract 1.28. |
| `setting.size` | `"card" \| "readable" \| "working"`, optional | The size the session proposed it opens at; absent when none was named. Honoured the first time it opens, and a console may still show less. A keeper's opening carries none. Since contract 1.29; `card` since 1.33. |
| `setting.where` | `"beside" \| "outside"`, optional | Where the session asked for it: beside the conversation, or outside in a pane of its own. Absent means `beside`. Since contract 1.33. |
| `setting.seat` | `{ x, y, w, h }`, optional | The seat asked for on the stage's 12 by 12 lattice: `x` and `y` from 0 to 11, `w` and `h` from 1 to 12, `x + w` and `y + h` at most 12, all integers. Only with `where: "outside"`; absent when the console chooses. Since contract 1.33. |
| `setting.weight` | `"lead" \| "support" \| "aside"`, optional | Who should have the large seat when several stand together. With a `from` that stands outside, `lead` drills in. Since contract 1.33. |
| `setting.mood` | `"calm" \| "brisk" \| "eager" \| "playful" \| "urgent" \| "decisive" \| "tentative"`, optional | How the pane arrives, motion only; absent means the console's own way. `decisive` moves everything at once and lands firmly; `tentative` moves one pane at a time with pauses and lands lightly. Since contract 1.33. |
| `setting.mark` | `string`, optional | A word or two, at most 24 characters, the session asked the keeper to read on the setting for as long as it is out (`chosen`, `draft`, `done`); absent when it has none. A replacement keeps it unless it names another, and `show.changed` follows a change. Since contract 1.33. |
| `setting.markTone` | `"good" \| "caution" \| "bad"`, optional | The tone the mark is drawn in; absent means neutral, and it is only ever present with a `mark`. The session gives it with `show` or `arrange` in other words too (success, warning, error); a console draws it in its own palette and never in the critical red. A new mark without a tone is neutral, and a replacement that names no mark keeps the tone. Since contract 1.38. |
| `setting.agent` | `{ name?, color? }`, optional | Present when an agent outside the session set this out through a creature's MCP server; `name` is the name its client gave, at most 40 characters, and is absent when it gave none. `color` is `cyan`, `magenta`, `green`, `yellow` or `blue` (never red, which a console keeps for errors): the engine gives each agent name one colour, picks a free one while one is free, and keeps it for that name while the server runs and across a restart for as long as one of its settings is kept, so a console draws the agent's square in it. The setting is still the creature's (`origin: "creature"`, the creature's limits, the creature may withdraw it), and a console marks it as the agent's rather than the creature's. Since contract 1.33. |
| `setting.signal` | `"needs-you" \| "critical"`, optional | How much the setting wants the keeper, which a console draws as an outline: `needs-you` (amber) when the session's work waits on the keeper's answer, `critical` (red, and nothing else in a pane's chrome is red) when something is broken or about to be lost. Absent when it has none. The session raises it with `show` or `arrange` and may say it in other words; the wire carries only these two. A `critical` is raised only with a `why` the session gives, which becomes the setting's `why`; only on a setting the raiser set out itself; at most one at a time for the creature or thread and one for each agent; and it holds the setting out until the keeper has seen it, so its `until` becomes `seen`. Only the one who set the setting out, or the keeper through `DELETE /show/{id}/signal`, lowers a `critical`; a timer never does. An agent raising one is written to the audit with its reason. A replacement keeps the signal unless it names another, and `show.changed` follows a change. A console may also draw its own marks (a new arrival, a pane waiting on a question) that never reach the wire. Since contract 1.35; an older server sends none. |

### show.changed

A setting that is still out changed in place: the session set, changed or cleared its `mark` with
its `arrange` tool, or, since contract 1.35, raised or lowered its `signal` (with `arrange`, which
may also give it a new `why` with the signal), or the keeper cleared the signal through
`DELETE /show/{id}/signal`. The payload is the whole setting as it now stands, under the id it
already had, so a client replaces the one it holds and keeps everything else about it (its place,
its rung, what the keeper has done with it). Nothing arrives and nothing leaves. Scoped to the
session that set the thing out, like `show.proposed`. Since contract 1.33; a 1.32 console ignores
the event.

| Field | Type | Meaning |
|---|---|---|
| `setting` | `Setting` | The setting as it now is, with every field `show.proposed` carries. |

### show.settled

A setting moved, so a client updates or drops its card. The keeper's answers come through
`POST /show/{id}/answer`; the engine withdraws the rest on its own, and a session takes back what it
set out with its `withdraw` tool (`outcome: "withdrawn"`, `by: "creature"`), which refuses what the
keeper pinned or opened. Withdrawal only touches a
`live` setting: a pinned one stays out until the keeper unpins or dismisses it. What the server
withdraws as it starts, after a stop, settles without this event (see `show.proposed`). A setting that
settles takes nothing with it: the settings that grew from it stay out, and the payload stays
`{ id, outcome, by }`, since a client already holds the setting and its `from`, with `mood` added
when the session named how the pane should leave. Since contract 1.27.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | The setting. |
| `outcome` | `"seen" \| "pinned" \| "unpinned" \| "dismissed" \| "withdrawn"` | `seen`, `unpinned` and `dismissed` take it out of the yard; `pinned` keeps it out until the keeper unpins or dismisses it; `withdrawn` takes it out without the keeper. |
| `mood` | `"calm" \| "brisk" \| "eager" \| "playful" \| "urgent" \| "decisive" \| "tentative"`, optional | How the pane leaves, motion only, when the session named one in `withdraw`; absent, it leaves in the mood it arrived with. Since contract 1.33. |
| `by` | `"keeper" \| "creature" \| "time"` | `keeper` for every answer, for a live setting withdrawn because its session was removed (`DELETE /sessions/{id}`, or its creature removed), and for one a keeper's opening of the same thing replaced; `creature` when the model working the thread replaced it (a creature's, or a plain session's) or its `rests` thread came to rest (a turn ended with nothing queued); `time` when its `until` time came. |

### show.arranged

The model working a session asked the console to arrange panes it has outside, with its `arrange`
tool. Like the two events above it is scoped to a session: the envelope's `sessionId` is the thread
that asked. `panes` only ever names settings that owner set out itself and that are still out, in
the order the model gave; the engine answers anything else with a sentence and nothing fires. At
most one of `shape`, `relation` and `seats` says how: a shape by name, a hint of how the panes
relate that leaves the shape to the console, or a seat for each pane composed outright, any sizes in
any combination; with none of them the console chooses. A setting named here that still stands
beside the conversation is moved outside by the arrangement, and the record follows: `GET /show`
then serves it with `where: "outside"` and the seat it was given, or with none when the console was
left to choose. The console snaps what it is given to the lattice, keeps it on the display, skips a
pane the keeper has placed since the session last placed it, never takes focus, and says what it
did in its placements report. An owner has at most twelve settings outside at once and a session
arranges at most twelve times a minute; the tool answers past either with a sentence. Since
contract 1.33; a 1.32 console ignores the event.

| Field | Type | Meaning |
|---|---|---|
| `arrangement.id` | `string` | Minted by the engine; the console names it in the placements report that answers it. |
| `arrangement.creature` | `string \| null` | The creature's slug, or `null` for a session with no creature. |
| `arrangement.sessionId` | `string` | The thread that asked. |
| `arrangement.at` | `string` | When it was asked (ISO 8601). |
| `arrangement.panes` | `string[]` | Setting ids, in the order the model gave; never empty. |
| `arrangement.shape` | `"grid" \| "columns" \| "rows" \| "lead-and-cards" \| "lead-and-stack" \| "split" \| "board"`, optional | Equal seats; tall panes side by side; wide panes stacked; one large pane with the rest as cards around it; one large pane beside a column of the rest; two large panes side by side with the rest as cards beneath; columns of cards, for tasks. |
| `arrangement.relation` | `"sequence" \| "alternatives" \| "tasks" \| "notes"`, optional | How the panes relate, leaving the shape to the console. |
| `arrangement.seats` | `{ id, seat }[]`, optional | A seat for each pane the model placed itself, `seat` as in `show.proposed`; every `id` is among `panes`. |
| `arrangement.lead` | `string`, optional | The setting, among `panes`, that should have the large seat. |
| `arrangement.side` | `"left" \| "right" \| "top" \| "bottom"`, optional | Where the large seat stands when the console lays the panes out, the rest taking the other side; absent means left. Never with `seats`. |
| `arrangement.over` | `"room" \| "display"`, optional | `room`, the default, arranges on the stage; `display` takes the whole work area, console included. |
| `arrangement.mood` | `"calm" \| "brisk" \| "eager" \| "playful" \| "urgent" \| "decisive" \| "tentative"`, optional | How the panes move into it, motion only. |
| `arrangement.rest` | `"beside"`, optional | Present when the session's other panes outside, the ones `panes` does not name, should step back beside the conversation as cards, still out, so the named panes stand alone. Absent, a console leaves them as its arrangement finds them. |

The console answers through `PUT /sessions/{sessionId}/settings/placements`, authenticated like the
`/show` routes, with `{ stage, placements, arrangement? }`: the whole current picture for that
session, replacing its last report. `stage` is `{ room, cardsAcross, cardsDown, consoleMaximised }`,
where `room` is `beside` (the free area beside the console), `over` (its far side) or `display`, and
the two counts are how many card-size panes fit side by side and one above another. Each placement
is `{ id, where, seat?, by }`: `where` is `beside`, `outside` or `inside` (the keeper brought the
pane into the console), `seat` is where it stands outside, and `by` is who put it there last,
`creature`, `keeper` or `console`. `arrangement` is `{ id, said }` when the report answers an
arrangement, `said` being one or two plain sentences on what was done and what was corrected. A
console sends a report after an arrangement has played, after a session's pane arrives or leaves,
and after the keeper moves, resizes, re-deals, brings inside or sends outside one of them, coalesced
so a drag does not flood the server. The server answers 204, keeps the latest report of each session
in memory only, and fires no event. The reports are what the tools speak from: `arrange` waits about
a second and a half for the report naming its arrangement and answers with where everything now
stands and what the console said, or says the arrangement was asked for and that `shown` will tell;
`show` waits the same way for a setting it put outside; `shown` gives each setting's `where`, its
`seat` outside and `by`, and the stage once. At the start of its next model request a session also
hears, once, what the keeper has done to its panes since it last looked: moved or resized, brought
inside, sent outside, or re-dealt when three or more changed seats.

### workspace.changed

Files in the workspace changed on disk, whoever changed them: a person in an editor, a build, a
`git checkout`, or the agent. A client rereads what it shows from those paths, so a pane
follows an edit made outside keywork as it follows `changes.updated`. Changes are gathered for
300 ms and announced together, so a burst is one event. `.git/`, `node_modules/` and whatever
`.gitignore` or `.keyworkignore` hides are left out. `keywork serve` watches its workspace
while it runs, with the operating system's whole-tree watch on Windows and macOS; on other
platforms it never fires, because following every folder one by one costs too much on a
large repository. Since contract 1.32.

| Field | Type | Meaning |
|---|---|---|
| `paths` | `string[]` | The changed paths, relative to the workspace root with `/` separators, sorted. A folder can appear beside the files that changed in it. |
| `truncated` | `boolean` | More than 200 paths changed in the burst and only the first 200 are listed; a client rereads everything it shows. |

## Turn facts and journal-only entries

When a turn settles, under `keywork serve` and in the terminal alike, after its messages, the
session log gains a `custom` entry with `customType: "turn_facts"` that freezes what the turn
did, so a ledger reads the same after a restart and never recounts a turn against today's
working tree. Both write the same shape (since contract 1.7 the terminal's facts carry
`session` too):

| Field | Type | Meaning |
|---|---|---|
| `prompt` | `string` | The id of the turn's prompt entry. |
| `checkpoint` | `string`, optional | The tree checkpointed before the turn's first change; absent when the turn changed nothing or checkpoints are off. A store reading the log puts it back on the prompt entry as `checkpoint`, the field a prompt written at settle time carries itself. |
| `settled` | `string`, optional | The tree when the turn settled, present with `checkpoint`. |
| `files` | `{ path, added, deleted }[]` | What changed from `checkpoint` to `settled`: the turn's own files, empty when it changed nothing. Other sessions working at the same moment can land in it. |
| `session` | `{ files, added, deleted }`, optional | The session's net change at that moment over every file its turns touched, the figure the desk row shows after a restart. |
| `outcome` | `"completed" \| "interrupted" \| "failed" \| "shutdown"`, optional | How the turn ended, written under `keywork serve` since contract 1.32: `interrupted` when an abort or a steer stopped it, `shutdown` when the server shut down while it ran. Absent in facts the terminal or an earlier release wrote. |
| `error` | `string`, optional | The message a `failed` turn failed on. |

Snapshots never take in `node_modules` or `.git`, and gitignored files stay out unless an
earlier snapshot already held them; an existing checkpoint store forgets its index once, the first
time this release opens it, so dependency trees it took in before drop out. A restore never writes
them back either: restoring a checkpoint taken before the exclusion leaves every `node_modules`
and `.git` directory as it is now (since contract 1.7).

Some entries exist only as evidence and never reach the model: the `custom` entries for
`permission_ask`, `permission_decision`, `context_injection`, `memory_decision`, `shell_reset`,
`session_grants`, `turn_facts`, `keywork.creature` and `keywork.creature.report`. A session a creature owns carries, right
after its `binding` entry (`{ bot: <slug> }`, the same entry a plain bot session writes), one
`custom` entry `{ "type": "custom", "customType": "keywork.creature", "data": { "creature":
"pip", "kind": "conversation" } }`, where `kind` is `conversation` (the one session the keeper
talks to), `thread` (a task the creature opened), `routine` (a routine run) or `child` (a
sub-agent under a thread; its parent is the session header's `spawnedBy.sessionId`). The entry
is written once and never changes; a session is claimed by one creature as one kind (since
contract 1.8). `GET /sessions/{id}/entries` lists their ids under
`journal` so a tree or a transcript can leave them out or fold them into the row they explain,
and the HTML export leaves them out. A client goes by `journal` rather than its own list of
kinds, so a kind added later needs no client change. Since contract 1.6.

A finished thread reports to its creature's conversation as one `custom` entry
`{ "customType": "keywork.creature.report", "data": { "text", "origin" } }` with `origin`
`{ kind: "creature", creature, thread }`: one line, never a prompt, never in the model context,
so no turn starts. The same write emits one `extension.notice` from the `creature` extension
(`detail: { origin, entryId }`) for a console that is watching, and `GET /sessions/{id}` lists
every such entry under `reports` (`{ index, entryId, at, text, origin, kind? }`) so a console that
reloads draws the same line again. Since contract 1.10.

A frame is the same entry with `"kind": "frame"` in its data, written by `POST
/sessions/{id}/inject` with `frame: { creature }` right before the prompt it frames: the text is
the prompt the creature answers (it is in the model context and starts a turn whose
`turn.started` carries the creature origin), never a keeper prompt. Its notice carries
`detail.kind: "frame"`, its mark `kind: "frame"` with the prompt at `messages[index]`, so a
transcript draws the creature line in the prompt's place; a report has no `kind`.
The session takes the creature's name as its title until the creature's first reply titles it.
Since contract 1.11.

The keeper's review of a thread's delivery lives on the same session as journal-only entries. A
verdict on one hunk of the diff `GET /sessions/{id}/changes` shows is one `custom` entry
`{ "customType": "keywork.review.verdict", "data": { path, header, digest, verdict } }`, written
by `POST /sessions/{id}/changes/verdicts`: `path` the changed file, `header` the hunk's unified
range line (`@@ -a,b +c,d @@`), `digest` eight hex characters over the hunk's removed and added
lines (the stable reference a quote in the thread carries as `hunk <digest>`, so the verdict
follows the hunk when an earlier one is dropped and its line numbers move), and `verdict` one of
`keep`, `drop`, `ask`. Never a prompt, never in the model context, so no turn starts. The same
write emits one `extension.notice` from the `review` extension, `message` the trail line a
transcript draws (`<verdict> · <path> <header> · hunk <digest>`) and `detail: { verdict, entryId }`
with `verdict` the whole mark, so a watching console moves its marks and its conversation at
once. `GET /sessions/{id}/changes/verdicts` lists the trail oldest first, the same hunk as many
times as it was judged (the last word stands; a client folds by `path` and `digest`), and
`GET /sessions/{id}` lists the same marks under `verdicts` (`{ index, entryId, at, path, header,
digest, verdict }`, `index` as `reports` count it) so a reloaded transcript draws the trail where
it fell. A verdict of `ask` parks the hunk as something waiting on the keeper until a later `keep`
or `drop` on the same `path` and `digest`; a console counts those open asks as needs-you items.
Talking to the diff is not an entry of its own: the console quotes the hunk and its reference
into an ordinary keeper prompt on the thread. Since contract 1.18.

A message from another creature (`POST /mesh/messages`) is a report too: one line `Message from
<sender> on <machine>: <text>` in the receiving creature's conversation (`Message from <sender>:`
when both live on one machine), with `origin` `{ kind: "creature", creature: <sender>, thread:
<message id>, node, machine }`, `node` the sender's StableID as WhoIs named it and `machine` its
name. Like any report it is never a prompt and never in the model context, so it starts no turn
and cannot approve, grant, configure or run anything. Since contract 1.16.

Under `keywork serve` a session's grants persist through the same `session_grants` entry the
terminal writes: every grant, quiet grant and revoke appends a snapshot `{ rules }` of what the
session now holds, and reopening the session (after a restart too) adopts the latest one, so a
revoke stays revoked. `GET /permissions` lists the sessions open in the process; a session's
journaled grants come back when it reopens. Since contract 1.7.

`POST /sessions/{id}/undo` and `/restore` write a `custom` `restore` entry at the rewound leaf,
`{ turn?, from, files, redo }`: `from` is the leaf before (where a redo goes back to), `files`
the checkpoint the files went back to (`null` when none moved), `redo` the snapshot taken just
before they did (`null` likewise), and `turn` the restored turn on a restore. `POST /redo`
writes `restore-undone { restore }` naming it. A session reopened on an unsettled `restore`
(nothing sent since) comes back with the undo staged, so `redoable` is true and `POST /redo`
puts the files back from `redo` even after a server restart. The terminal writes the same pair,
so either host can redo what the other staged. Since contract 1.7; an earlier `restore` entry
with moved files and no `redo` is not offered again.

A restore under `keywork serve` is scoped to the session's own files. `POST /undo` and `POST
/restore` (its default `scope: "session"`) put back only the paths this session's turns changed
from the restored turn on, as their `turn_facts` record them, and leave every other path as it
is on disk: a file the keeper created and an edit to a file no turn touched both survive.
`POST /restore` with `scope: "everything"` puts the whole workspace back to the checkpoint as
before. A scoped restore entry carries `paths: string[]`, the paths it put back from `files`;
`POST /redo` puts exactly those paths back from `redo`, after a restart too, so files written
since the restore stay. An entry without `paths` restores and redoes the whole tree. The answer
to `POST /restore` echoes `scope` and lists in `files` only what moved. `GET
/sessions/{id}/restore?turn=N&scope=session|everything` lists every file that differs from the
checkpoint, each `{ path, added, deleted, touched, goesBack }`: `touched` when a turn of this
session from turn N on changed it, `goesBack` when a restore with that scope would put it back
(`touched` itself under `session`). A file another session or an edit outside keywork changed
while one of this session's turns was running lands in that turn's facts and counts as touched.
Since contract 1.32; before, every restore put the whole workspace back.

## Memory flush entries

A memory flush is not a prompt. Since contract 1.7 it is written as a `custom_message` entry
with `customType: "memory_flush"` whose `content` is the prompt keywork sent (it still opens with
`Context is nearly full and will soon be compacted.`), followed by the model's reply as an
`assistant` message entry. The model sees the same exchange as before, but the flush starts no
turn: turn ordinals (`turn_facts`, `POST /sessions/{id}/restore`, `GET /sessions/{id}/restore`)
count prompts only, and a log written before 1.7, where the flush prompt is a plain `user`
message, is counted the same way. `GET /sessions/{id}` marks each flush in `flushes` as
`{ index, entryId, facts }`: `messages[index]` is the flush prompt, `messages[index + 1]` the
reply, and `facts` the lines the reply kept (empty when it answered `NO_REPLY`), so a client
draws `memory flush · 3 facts kept` without matching text. A replay skips the pair.

`GET /sessions/{id}` also says where context edits sit, in `edits`, each `{ index, entryId,
role, kind, text }`: `entryId` and `role` name the edited message, `kind` is `forgotten` (the
message left `messages`; `index` is where it sat, before the message that now follows it) or
`rewritten` (it is `messages[index]`, carrying the replacement), and `text` is its own text
before the edit (empty for a tool result). A client places a forgotten prompt at its turn from
`edits` alone.

`GET /sessions/{id}` also says how each turn ended, in `outcomes`, each `{ index, entryId,
outcome, error? }`: `messages[index]` is the turn's prompt, `entryId` its entry, `outcome` the
`turn_facts` outcome and `error` a failed turn's message. A turn the engine died in leaves its
prompt with no reply and no `turn_facts`; it reads as `shutdown` the next time the session is
read, so a client can mark it interrupted and offer it again. What the turn had written before it
ended (partial text kept on a failure, an abort or a shutdown) stays in `messages`. The turn
still running, a turn compacted away and a turn settled before outcomes were kept carry no mark,
so a client treats a missing mark as unknown, never as a failure. Since contract 1.32.

## In-flight work and stopping gracefully

`GET /work` answers what is running or waiting from memory alone, so a client deciding whether
it may quit asks it without the session scan `GET /sessions` makes. `sessions` lists only the
sessions with something in flight:

| Field | Type | Meaning |
|---|---|---|
| `id`, `title` | `string` | The session. |
| `working` | `boolean` | A turn runs, settles or has a prompt in its queue: `working` on `GET /sessions`. |
| `queued` | `number` | Prompts waiting in its queue. |
| `asks` | `number` | Asks pending on it. |
| `children` | `number` | Delegated children its turn is running. |

The top-level `asks` and `children` count every pending ask and running child in the server.

`POST /shutdown` is the interrupt signal for a client that cannot send one; on Windows a
killed engine loses the turn it was running. It interrupts every running turn and records it
with the outcome `shutdown`, keeping its text. It sets every queue aside so no queued prompt
starts, and refuses every pending ask. The answer comes once all of that is written:
`sessions` lists `{ id, interrupted, setAside }` for each session that had something stopped,
with `setAside` in the `queue.changed` shape so a client can offer those prompts again, and
`asks` counts the refused asks. The process then closes its streams, removes its ticket and
exits, the same path an interrupt signal takes. From the call on, the server answers 503 to
everything but reads and `POST /shutdown` itself. A second call answers the same report. A
server that `keywork serve` did not start answers 503. Both routes since contract 1.32.

## SSE framing

`GET /events` answers `text/event-stream; charset=utf-8` with `cache-control: no-store`. The
first bytes are a comment line, `: connected`, so the client learns the stream is live
before any event exists. Every 15 seconds the server writes another comment, `: keepalive`,
so a client that has heard nothing for longer than that can tell a hung or vanished server from
a quiet one (since contract 1.7; parsers drop comments). Each envelope is one frame:

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

Every type but this one crosses the wire as `JSON.stringify(envelope)` with no per-type
code. `engine.error` carries an `Error` instance, which `JSON.stringify` would flatten to
`{}`. The server serializes every `Error` value anywhere in an envelope as

```json
{ "name": "Error", "message": "…" }
```

through one value-level replacer (`errorsAsPlainObjects` in `sse.ts`). No stack, no cause.
This is the only place the wire form differs from the in-process payload.
