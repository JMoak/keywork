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
and an unanswered ask times out as a headless denial (after 120 seconds by default). Never fired when no guard can answer,
and never replayed. The session journal keeps each ask as a `permission_ask` entry holding
`{ tool, callId, rule, rules, change? }`, where `change` is `{ creates, linesBefore,
linesAfter }` from the preview; the arguments already ride the assistant message, and the
preview's text is never journaled ([`backlog/122`](backlog/122-tool-decision-evidence.md)).

| Field | Type | Meaning |
|---|---|---|
| `ask` | `PermissionAsk` | `{ tool, callId, arguments, rule, rules, preview? }`. |

`rule` says why the gate is asking: `policy` (a configured rule says ask) or `default` (the
tool mutates and no rule covers it). A session left quiet (`POST /sessions/{id}/quiet`) raises
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
and a chore run alike (with `shown`, which lists what is out, and `withdraw`, which takes back what
it set out). The keeper's own openings from inside a setting or a thread (a file from a
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
then `show.proposed` with a new id that names the earlier one in `replaces`. An owner sets out at most thirty settings an hour, replacements
included; the tool answers the thirty-first with a sentence, as creature mail answers its limits,
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

| Field | Type | Meaning |
|---|---|---|
| `setting.id` | `string` | The setting, named in `POST /show/{id}/answer`. |
| `setting.creature` | `string \| null` | The creature's slug, or `null` for a session with no creature. |
| `setting.sessionId` | `string` | The thread that set it out. A delegated child sets out on its parent's thread, so the setting follows the thread the keeper sees. A keeper's opening sits on the thread of what it grew from. |
| `setting.what` | `{ kind, ref, title? }` | `kind` is `"file" \| "diff" \| "report" \| "thread" \| "chore" \| "url" \| "note"`; `ref` is the workspace path, change-set id, report id, session id, chore id, url, or the note's own words (at most 2000 characters); `title` is absent when none was given. |
| `setting.rung` | `"lantern" \| "card" \| "unfold" \| "stage"` | The rung proposed, `card` unless the tool call asked otherwise. A console may use a lower one; the glyph is rung zero and never proposed. |
| `setting.why` | `string` | One sentence for the card, at most 200 characters; empty for a keeper's opening. |
| `setting.at` | `string` | When it was set out (ISO 8601). |
| `setting.until` | `"seen" \| "rests" \| string` | When it goes: once the keeper has seen it (the default), when its thread rests (`rests`), or at an ISO 8601 time. |
| `setting.state` | `"live"` | Always `live` here; `GET /show` also serves `pinned`. |
| `setting.from` | `string \| null` | The id of the setting or the session it grew from, or `null` for one that starts a trail. Since contract 1.28. |
| `setting.origin` | `"creature" \| "keeper"` | `creature` for what the model working a session set out, `keeper` for the keeper's own openings through `POST /show`. Since contract 1.28. |
| `setting.replaces` | `string \| null` | The id of the setting this one replaced (the same owner and the same thing, whoever set either out), withdrawn just before by the `show.settled` that precedes this event; `null` when it replaced nothing. Since contract 1.28. |
| `setting.size` | `"readable" \| "working"`, optional | The size the session proposed it opens at; absent when none was named. Honoured the first time it opens, and a console may still show less. A keeper's opening carries none. Since contract 1.29. |

### show.settled

A setting moved, so a client updates or drops its card. The keeper's answers come through
`POST /show/{id}/answer`; the engine withdraws the rest on its own, and a session takes back what it
set out with its `withdraw` tool (`outcome: "withdrawn"`, `by: "creature"`), which refuses what the
keeper pinned or opened. Withdrawal only touches a
`live` setting: a pinned one stays out until the keeper unpins or dismisses it. What the server
withdraws as it starts, after a stop, settles without this event (see `show.proposed`). A setting that
settles takes nothing with it: the settings that grew from it stay out, and the payload stays
`{ id, outcome, by }`, since a client already holds the setting and its `from`. Since contract 1.27.

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | The setting. |
| `outcome` | `"seen" \| "pinned" \| "unpinned" \| "dismissed" \| "withdrawn"` | `seen`, `unpinned` and `dismissed` take it out of the yard; `pinned` keeps it out until the keeper unpins or dismisses it; `withdrawn` takes it out without the keeper. |
| `by` | `"keeper" \| "creature" \| "time"` | `keeper` for every answer, for a live setting withdrawn because its session was removed (`DELETE /sessions/{id}`, or its creature removed), and for one a keeper's opening of the same thing replaced; `creature` when the model working the thread replaced it (a creature's, or a plain session's) or its `rests` thread came to rest (a turn ended with nothing queued); `time` when its `until` time came. |

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
