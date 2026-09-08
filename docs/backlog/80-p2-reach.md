# P2: Reach (post-v1; coarser by design)

> Built after v1 ships; listed so the v1 event vocabulary (A5) and pane registry (C11) are
> designed with these in mind. Tasks here are honestly bigger than 3pt; they'll be split
> when P2 planning starts.

---

## External-surface posture (Jordan, 2026-08-10)

How keywork meets every tool that isn't keywork, decided while examining dictation
(Wispr Flow) support, then generalized to a citizenship ladder. Baseline finding:
dictation already works by construction (OS-level injection arrives as keystrokes or
paste, and WP-5's paste seam made injected newlines literal), so these decisions make
the class first-class rather than accidental:

- **Tier 0, keyboard citizens** (dictation, text expanders, clipboard managers,
  password managers): no integration surface; the contract is input robustness:
  bracketed paste never submits, bursts render without stutter, no timing-sensitive
  chords anywhere, and a burst arriving while the leader is armed falls through as
  text (Track Q semantics). Wispr Flow is the named flagship; C34 is the fixture.
- **Tier 1, stream citizens** (scripts, CI, other agents): `keywork run --json`
  (A13), already shipped.
- **Tier 2, pane citizens** (LLM interaction windows, voice assistants, overlays):
  P2.1's server + P2.2's attach; external prompt injection is P2.6. Anything wanting
  a live conversation mounts a pane or drives the SSE surface, never a bespoke
  per-tool integration.
- **Voice capture stays external, permanently.** Terminals have no audio surface and
  that is also the correct trust boundary: keywork is a great citizen to injectors;
  it never hosts a microphone.
- **Native-shell revisit gate (D10 restated).** A native app is a *third mounting
  surface* over the D7 server (a Tauri-class shell embedding the TUI, or panes
  rendered natively from SSE), never a port, and it is not considered before the M2
  public demo *and* P2.1 have both landed. Until then, native presence ships as
  G3's desktop entries (Windows Terminal fragment, `.desktop`, macOS `.app` shim).

### C34 (1pt, v1-timed): Injection citizenship fixture
Probe-harness fixture simulating dictation-class input: a multi-hundred-event burst,
paste with embedded newlines (never submits), burst-during-armed-leader falling
through as text, grapheme-heavy content (emoji/ZWJ/CJK) landing intact.
**Accept:** fixture green in CI; paste/burst regressions fail here first.
**Strategy:** `OWN` on WP-5's `Pane.handlePaste`/`probe.paste()` seams.
**Landed 2026-09-06.** `packages/tui/src/injection-citizenship.test.ts` (8 probe cases: a
400-event burst, newline and CRLF pastes that never submit until enter, a burst on an armed
leader, a burst opening on a bound leader key, emoji/ZWJ/flag/CJK/combining text typed and
pasted then submitted byte-for-byte, burst+paste+burst in one prompt) plus the e2e scenario
`injection-citizenship` (`scripts/e2e/scenarios/injection-citizenship.ts`, goldens `burst`,
`leader-burst`, `graphemes`) registered in the scenario index test.
*Assumptions Jordan may reverse:* the armed-leader burst asserts today's Track Q reality,
where the first unbound key cancels the leader and is consumed and the rest lands as text
(a burst beginning with a bound key fires that verb, `z` zooms); if the intent is that the
whole burst lands, the keymap changes and this fixture flips. The e2e stage has no paste
verb and OpenTUI's `typeText` splits astral characters into surrogate halves, so the e2e
step covers BMP graphemes (accents, CJK, Hangul) and the paste plus astral-emoji cases live in
the vitest probe; a `Stage.paste` seam in `harness.ts` is the follow-up.

### P2.6 (2pt): External prompt injection
Server endpoint submitting text into a session from outside, the Tier-2 door for
LLM interaction windows and voice assistants: provenance-tagged external per J's
taint boundary, policy-gated per J6, echoed on the bus so every pane sees it as an
ordinary prompt.
**Accept:** injected prompt renders and runs identically to a typed one; any memory
write it causes carries external provenance; unauthorized client rejected.
**Strategy:** `OWN` on P2.1.

---

### P2.1 (5pt): HTTP/SSE server wrap
Wrap the A4 bus in a Bun HTTP server: OpenAPI 3.1 spec served at `/doc`, REST for commands,
SSE for the event stream; localhost + token auth by default. Mechanical if A5 held its
SSE-shape promise; this task is the test of D7.
**Strategy:** `LIFT:opencode` `packages/server` patterns.

#### P2.1 ledger (landed 2026-09-06)

**What landed.** A new workspace package `packages/server` (`@keywork/server`, no third-party
dependency) wraps the A4 bus: `EventLog` is a bounded ring (1000 envelopes) that subscribes to
every type in the vocabulary and stamps `{id, ts, sessionId, type, payload}`; `/events` streams
the ring as SSE and resumes from `Last-Event-ID`; a typed route table projects to the OpenAPI
3.1 document at `/doc`; the `SessionHost` port (`host.ts`) is the seam the CLI fills.
`packages/cli/src/serve.ts` fills it with `fileSessionHost` (composes the workspace once, opens
sessions from the session dir as live agents on first prompt, journals through `tapJournal`,
persists with `persistNewMessages`) and `serve()` (token, ticket file, listen, run until the
signal). `keywork serve [--port N] [--model] [--preset] [--session-dir]` dispatches from
`main.ts`; `serve --help` and unknown flags exit 2 through the existing usage contract.

| Route | Auth | Answer |
|---|---|---|
| `GET /doc` | none | OpenAPI 3.1 JSON, every route below listed, `/doc` itself marked `security: []` |
| `GET /events` | bearer | `text/event-stream`; each envelope as `id:` + `event: <type>` + `data: <envelope json>`; `Last-Event-ID: n` replays retained ids above `n`, `0` replays all retained; a resume point that fell off the ring is announced in an SSE comment line |
| `GET /sessions` | bearer | `{ sessions: [summary] }`, newest first, live-but-unsaved sessions included |
| `POST /sessions` | bearer | 201, a fresh empty session in this workspace's session dir |
| `GET /sessions/{id}` | bearer | summary + `cwd` + `live` + `messages`; 404 when unknown |
| `POST /sessions/{id}/prompt` | bearer | body `{ text }`; 202 `{ sessionId, accepted }`, the turn runs headless (A20: `ask` answers no, surfaced as `gate.permission{gate:"headless",verdict:"denied"}`); 400 on a bad body, 404 when unknown |
| `POST /sessions/{id}/abort` | bearer | 200 `{ sessionId, interrupted }`; 404 when unknown |

**Security by construction.** `listen()` binds `127.0.0.1` only and takes no host option. The
token is 32 random bytes (base64url) per launch, compared with `timingSafeEqual`, printed once
as `token <value>` and written to `~/.keywork/server.json` as `{ url, token }` through
`jsonFileStore({ private: true })` (directory 0700, file 0600, removed on shutdown). Every
route but `/doc` answers a missing or wrong token with a bodiless 401 plus `WWW-Authenticate:
Bearer`. No CORS headers are ever emitted; `OPTIONS` is an ordinary 404. Default port 4770:
unassigned by IANA, outside the ephemeral range, and far from the 3000/8080 crowd so a dev
server on the same box never collides.

**Evidence.** `packages/server/src/server.test.ts` (19): `/doc` structural check against the
route table, six 401 rows, wrong-length and wrong-scheme tokens, CORS preflight, the D7
round-trip over all 15 types, resume from `Last-Event-ID`, the ring-gap comment, malformed
resume id, list/create/read, mock-provider prompt with `turn.*` and `tool.*` on the stream,
400/404 bodies, abort of a hanging turn producing `turn.interrupted`, shutdown closing every
open stream, and a real-socket bind on an ephemeral port that stops cleanly.
`packages/cli/src/serve.test.ts` (6): tool-using turn persisted to the session file, listing
and reading a stored session, headless ask flagged on the stream, `serve()` printing URL and
token and writing then removing the ticket, exit 1 on `EADDRINUSE`, memory/file host parity.
`main.test.ts` rows: `serve --help` exit 2, `serve --port http` exit 2.

**Crossings.** `dispatch.ts` gained the `serve` command word, its `withoutTerminal` posture and
a usage line (additive); `main.ts` gained `runServe`, `parsePort` and the `--port` option;
`packages/cli/package.json` and both tsconfigs reference the new package; `bun.lock` records
it. `NOTICE` is unchanged: nothing was adapted from OpenCode's server, the code is `OWN`.

**The D7 finding.** The vocabulary held: 14 of 15 event types cross `/events` as
`JSON.stringify(envelope)` byte for byte, with no per-type table anywhere in the server. The
one exception is `engine.error`, whose payload carries an `Error` instance; `JSON.stringify`
would emit `{"error":{}}`. The wire form is `{ name, message }` through a single value-level
replacer (`errorsAsPlainObjects` in `sse.ts`), the same shape `keywork run --json` already
uses. Second finding: `docs/events.md` (A5's deliverable) does not exist; the vocabulary lives
only in `bus.ts` `LiveEvents`. `engineEventTypes` in `events.ts` is the runtime list, and a
type-level check (`vocabularyIsComplete`) fails the build if `EngineEvents` grows without it.

**Seams left.** P2.2 `attach` reads `~/.keywork/server.json` (`readServerTicket`) and mounts
panes over `/events` plus the session routes; `SessionHost` is the only surface it needs. P2.6
provenance injection hangs off `POST /sessions/{id}/prompt`: the body gains a `provenance`
field, `fileSessionHost.prompt` tags the user message, nothing else moves. Per-session event
filtering (`/events?session=`) was left out; every envelope already carries `sessionId`.

**Assumptions Jordan may reverse.**
- `listen()` is `node:http` with a fetch adapter, and `Bun.serve` is unused: vitest is the gate
  and runs on Node, where `Bun` is undefined, and `codex-login.ts` already sets the
  `node:http` precedent. Swapping to `Bun.serve` is a 30-line change in `listen.ts`.
- `POST /sessions` exists though the task listed only `/sessions/{id}/prompt`; without it a
  fresh install has nothing to prompt.
- The ticket file is `~/.keywork/server.json` (one server per user); a per-workspace ticket
  would move it under `workspaces/<identity>/`.
- `/events` without `Last-Event-ID` starts live; history is P2.2's replay from the store.
- Prompt on a busy session queues, the engine's default `queue` behavior; a 409 would need a busy check in the host.
- The ring holds 1000 envelopes; `turn.delta` chatter will churn it fast on long turns.

### P2.2 (3pt): `keywork attach`
Thin client mounting any registered pane type over the server (`keywork attach --pane diff`);
this is the tmux/zellij composition story from the Q6 synthesis: same components, second
mounting surface.
**Strategy:** `OWN` on C11's registry.

#### P2.2 ledger (landed 2026-09-07)

**What landed.** `keywork attach` mounts the TUI as a second surface over a running
`keywork serve`, with no local workspace composition at all: no memory, no MCP, no tools, no
checkpoints. Three pieces. `packages/server/src/client.ts` is a typed client over the P2.1
routes (`sessions`, `session`, `createSession`, `prompt`, `abort`) plus `events()`, an async
iterator over `/events` that carries `Last-Event-ID` across reconnects and backs off 250ms
doubling to a 5s ceiling; it is pure over an injected `fetch`, frame reader and delay, and
`resolveServerTicket` reads `~/.keywork/server.json` unless `--url` and `--token` both arrive.
`packages/cli/src/remote-ports.ts` fills the TUI ports over that client: `remoteSessionPort`
(open and create; history from `GET /sessions/{id}`, replayed onto the pane's bus with
`replay: true`), `remoteSessionTreePort` (overview from `/sessions`, a linear tree from the
message list, refresh on every `turn.completed` envelope) and `remoteAgentFactory`, which builds
a real engine `Agent` whose turns run on the server. `packages/cli/src/attach.ts` validates the
pane kind, resolves the ticket, checks the server answers, opens the event feed before any
prompt can race it, and calls `runApp` with a one-pane workspace.

**The engine seam.** `AgentFactory` returns the `Agent` class, and the conversation pane consumes
that class directly, so the remote agent had to be a real `Agent`. Rather than subclass, `agent.ts`
gained one option, `turns?: TurnDelegate`: when present, `runTurn` still pushes the user message,
emits `turn.started`, queues and settles exactly as before, and hands the body of the turn to the
delegate, which returns the assistant message, usage, an interrupted flag and optionally the whole
history to adopt. The remote delegate posts the prompt, relays every envelope for that session
onto the pane's bus except `turn.started` and `queue.changed` (the local agent owns those), settles
on the server's `turn.completed` or `turn.interrupted`, then re-reads the session so local history
matches the server's byte for byte (tool messages included). `interrupt()` aborts the local
controller, which posts `abort`; the server's `turn.interrupted` settles the turn. The pane renders
the turn through the same feed it uses locally, with no rendering code touched.

**Command grammar.**
`keywork attach [--pane conversation|session-tree] [--session <id>] [--url <url>] [--token <token>]`.
The default pane is `conversation`. `--session` binds the pane to an existing server session and
exits 1 if the server does not have it. The chrome label reads `attached · 127.0.0.1:4770`
through the existing `statusLabel` seam, and the first notice says the server answers asks with
no. Refusals: an unknown kind exits 2 with usage; `browser`, `file`, `diff` and `terminal` exit 2
naming the local files they would need; `memory`, `mcp`, `arcs`, `arc` and `workspaces` exit 2
naming the local workspace; a missing ticket, an unreachable server, a refused token or an unknown
session exit 1 with one line each. `attach` needs a terminal and is refused without one.

**Evidence.** `packages/server/src/client.test.ts` (11): ticket read with each override, every
route with the bearer header captured per call, missing ids as outcomes, 401 as `ServerRefusal`
on routes and on the stream, resume with `since`, a dropped stream reconnecting with
`Last-Event-ID: 2` after one 250ms delay, the backoff table, abort without reconnect, and two
real-socket tests through `listen()` on an ephemeral port (a prompt read from `/events`, and an
abort of a hanging turn). `packages/cli/src/remote-ports.test.ts` (7): a tool-using turn reaching
an in-memory server and landing on the pane's bus in local order with history equal to the
server's, the headless ask refusal arriving as `gate.permission{gate:"headless"}` plus a failed
tool card, interrupt forwarding to abort and settling as `turn.interrupted`, refusal before a
session is bound, open plus replay of served history, tool rounds replayed as pairs, and the tree
port's overview, linear tree, refused edits and change feed. `packages/cli/src/attach.test.ts`
(11): the pane table, four exit-1 paths, the label and the mounted workspace state.
`main.test.ts` rows: `attach` without a terminal exits 2; at a terminal `attach --help`,
`--pane bogus` and `--pane diff` exit 2 and `--pane session-tree` with no ticket exits 1.

**Crossings.** `packages/engine/src/agent.ts` gained `DelegatedTurn`, `DelegatedOutcome`,
`TurnDelegate`, the `turns` option and `runDelegatedTurn` (additive; every existing agent test
passes unchanged). `dispatch.ts` gained the `attach` command word, its refused-without-terminal
posture and a usage line. `main.ts` gained `runAttach` and the `--pane`, `--session`, `--url`
and `--token` options. `packages/server/src/index.ts` exports the client. `NOTICE` is unchanged.

**What attach cannot do yet.** Asks: the server answers no headlessly, so a mutating tool call
from an attached pane arrives as a denied gate and a failed tool card; answering from the client
needs a server-side ask queue and is a follow-up. Labels and forks in the session tree refuse with
a notice, since the server has no route for either. Renames, model switches, thinking switches
and arc or bot bindings made in an attached pane stay local to the pane. The tree view is linear
because `GET /sessions/{id}` returns messages, not entries. Cost and model shown in the masthead
are empty: the attached provider has no model id. Only one server per user is reachable through
the ticket file.

**Assumptions Jordan may reverse.**
- The remote ports live in `packages/cli/src/remote-ports.ts`, beside `sessions/ports.ts`, so the
  server package keeps its two dependencies and never learns about the TUI. Moving them into
  `packages/server` means adding `@keywork/tui` to its manifest.
- The engine seam is a turn delegate on `AgentOptions`; the alternative was a `Provider` that
  streams from the server, which would have re-run tool calls locally.
- The probe-harness test for the attached pane was left out: `AppProbe`, `SessionPanes` and
  `ConversationPane` are internal to `packages/tui`, so the remote ports are proven at the bus
  level, which is the surface the pane consumes. Exporting a probe from the TUI would let a pane
  level test land in `attach.test.ts`.
- A server title of `(untitled session)` is treated as no name so the pane's own titler runs.
- `--pane` accepts `diff` and `terminal` as refusals even though neither is a registered kind
  today; both are named in the task.
- The feed opens before the pane mounts and one stream serves every pane in the process; per
  session filtering waits for `/events?session=`.

### P2.3 (5pt): Shared workspaces
Same `--cwd` ⇒ implicit workspace join with live session mirroring across clients; local
socket/Bun IPC discovery; concurrent-access story for the B1 store decided here (index or
sqlite sidecar per D8).
**Strategy:** `OWN`: own design, protocol, and storage.

### P2.4 (2pt): Notifications
Formula decided (Jordan, 2026-08-10; see [`../design-language.md`](../design-language.md)):
**needs-you only**, exactly two triggers, both when unfocused: an agent blocked on a
decision (ask-gate, protected-core proposal) and the review inbox crossing its threshold.
Completions/failures/milestones stay silent (dock state on return). Transports
(native toast / OSC 777 / bell / off) auto-select per terminal underneath,
policy-configurable; the formula is not a mode enum.
**Accept:** a keywork notification always corresponds to a wanted keystroke (fixture:
completion while unfocused does NOT notify; ask-gate does); transport fallback chain
tested per terminal fixture.
**Strategy:** `OWN` design.

#### P2.4 ledger (landed 2026-09-07)

**What landed.** `packages/tui/src/notifications.ts` holds the formula as code. `Notifier`
takes a `WorkSnapshot` after every paint (`title` of the focused session, `asks` = titles of
every conversation pane with a pending ask, `inbox` = review items waiting) and fires on exactly
two rising edges, both only while the terminal reports the app unfocused: a new ask (`asks`
grew) and the inbox reaching its threshold (`inbox` climbed from below 3 to 3 or more). Each
trigger fires at most once per unfocused stretch; a focus-in resets both budgets. Nothing
else is observed, so a completion, a failure or an ask answered elsewhere can never notify;
they stay dock state (the C64 stamp and the V2.12 title glyph). Content is the session title
plus a reason (`needs you · ask`, `inbox · 3 waiting`), and every transport runs it through
the title sanitizer `osc.ts` already had (OSC 777 also turns `;` into `,` so a hostile title
cannot shift the fields). `notificationTransport(facts)` is the pure detector beside
`terminalSupport`; `transportFor(policy, facts)` lets the config force one.

Focus tracking is keywork's own: OpenTUI 0.5.1 never enables DECSET 1004 and its stdin parser
files unknown CSI finals under a `response` event, so `osc.ts` gained `enableFocusReporting`,
`disableFocusReporting` and `focusEventsIn(bytes)` (a scanner for `CSI I` / `CSI O`), and
`app.ts` taps the input stream (`TerminalSeams.input`, default `process.stdin` `data`) beside
the existing OpenTUI listener, forwarding focus events to the notifier. Focus reporting is
switched on after the title push and off before the title pop, and only when the transport
is not `off`. Until the first report arrives the notifier assumes focus, so a terminal without
focus reporting never notifies.

| Terminal (facts) | Transport | Bytes |
|---|---|---|
| `TERM` starts with `rxvt` | OSC 777 | `ESC ] 777 ; notify ; <title> ; <reason> BEL` |
| `TERM_PROGRAM=ghostty`, `TERM_PROGRAM=WezTerm`, `VTE_VERSION` set | OSC 777 | same |
| `WT_SESSION`, `TERM_PROGRAM=iTerm.app`, `TERM=xterm-kitty` | OSC 9 | `ESC ] 9 ; <title> · <reason> BEL` |
| `TMUX` set (checked before the rows above) | bell | `BEL` |
| any other live terminal (plain xterm, conhost) | bell | `BEL` |
| stdout not a TTY, or `TERM=dumb` | off | nothing, and no focus reporting either |

**Config.** `notifications: "auto" | "osc777" | "osc9" | "bell" | "off"` in
`shared/config/schema.ts` with a `.describe()` justification; `auto` is the default when the
key is absent. It forces a transport or silences everything; what notifies is fixed and has
no setting. `compose-panes.ts` passes it through and wires the inbox count as an
`AppOptions.inbox` feed that recounts `store.listStaged()` plus bot-staged items whenever the
session change feed fires (trusted workspaces only), reporting only when the number changed.

**Evidence.** `notifications.test.ts` (24): ten terminal fixtures for transport selection,
dumb and piped stdout, the policy override, exact bytes per transport, the sanitizer path, and
the `Notifier` probes: nothing while focused, one ask notification then silence for a second
ask in the same stretch, a refocus then a new ask notifies again, the newly waiting pane is the
one named, completion and failure and a cleared ask never notify, the inbox crossing its
threshold notifies once with the count, an inbox already over the threshold at blur stays
quiet, ask and inbox keep separate budgets, `off` emits nothing, the threshold is a
constructor knob. `osc.test.ts` (+5): the DECSET 1004 strings, the bell byte, OSC 777 and OSC
9 bytes, hostile titles, and the focus scanner on mixed input. `load.test.ts` (+1): every
policy value round-trips and an unknown transport is a `ConfigError`.

**Crossings (additive).** `app.ts`: `AppOptions.notifications`, `AppOptions.inbox`,
`TerminalSeams.input`, `Terminal.notifier`, `watchFocus` and `workSnapshot` beside the
terminal reporter; `session-panes.ts`: `SessionPanes.awaiting()` beside `busyCount()`;
`compose-panes.ts`: the option pass-through, `reviewInboxFeed` and `stagedCount`.

**Assumptions Jordan may reverse.**
- The inbox threshold is the constant `defaultInboxThreshold = 3` in `notifications.ts`, the
  count P3 said would live in the policy plane; it is a constructor argument, so a config key
  is one line when P3's threshold lands.
- Both triggers are edge-triggered: an ask already pending when you blur does not notify
  (you saw it), and neither does an inbox already over the threshold at blur.
- The transport table is a best reading of what each terminal speaks: VTE terminals get OSC
  777 on the strength of the distro-patched builds (an unpatched VTE ignores it silently);
  kitty and Windows Terminal get OSC 9 as the task specified, though kitty's native protocol is
  OSC 99 and Windows Terminal's OSC 9 support is a toast in some builds and a no-op in others;
  tmux gets the bell because passthrough is off by default. A wrong row costs one env check.
- Ask titles fall back to the pane id when a session is untitled, matching the window title.
- The inbox feed recounts on every session change because the memory store has no change
  feed of its own; the count is cheap (one directory listing).

### S0 · S1: serve discovery and the ask queue

Requested by keywork-app (its `docs/plan.md` server lane), built here under keywork's rules so
every surface benefits: the app, `keywork attach`, and any Tier-2 client.

#### S0 · S1 ledger (landed 2026-09-07)

**What landed.**

*Discovery (S0).* `keywork serve --port 0` binds an ephemeral port (`parsePort` accepts 0; the
usage line says so). The ticket now lives per workspace at
`~/.keywork/workspaces/<identity>/server.json` (`workspaceTicketFile`, keyed by the same
`workspaceIdentity` that keys sessions and snapshots) and is also written to the old
`~/.keywork/server.json` for one release as a fallback read path (`ticketFilesFor` returns both;
remove the second entry to end the compatibility window). Before listening, `serve` reads each
candidate ticket and health-checks it (`answersAsKeywork`: `GET /doc` with a 1.5 s timeout,
answered by a document whose `info.title` is `keywork`): a live server makes the new serve
refuse with `keywork serve: a keywork server for this workspace is already listening at <url> ·
attach to it, or stop it first` and exit 2 (`alreadyServingExit`); a dead or foreign ticket is
removed and the start proceeds, so a crash never blocks the next launch. `keywork attach` with
no `--url`/`--token` tries the workspace ticket first, then the user-level one
(`ticketCandidates`; `main.ts` passes `cwd` and `workspaceSlug`). `/doc` `info` gains
`workspace: { anchor, identity }` (`workspaceInfoOf`), so a client can confirm which workspace a
server serves; `ServerOptions.workspace` carries it and `listen` passes it through.

*The ask queue (S1).* The engine gained one event, `gate.ask` `{ ask: { tool, callId,
arguments, rule } }`, emitted right before the guard is consulted whenever the policy would ask
and a guard exists to answer; `rule` is `policy` or `default`. `ToolGuard.confirm` may now
resolve `{ approved, gate }` as well as a boolean (`Confirmation`), so the gate label follows the
answer rather than the guard: `user` for an answered ask, `headless` for a timeout. The server
package gained `AskQueue` (`asks.ts`): `guardFor(sessionId)` yields a guard whose `confirm`
parks the call until `answer(callId, verdict)` or the timeout (`defaultAskTimeoutMs`, 120 s;
`HostOptions.askTimeoutMs` overrides it), `list()` for the pending set, `close()` settles
everything as headless denials. `fileSessionHost` and the testing memory host (`asks: "queue"`)
both build agents on it. Routes:

| Route | Auth | Answer |
|---|---|---|
| `GET /asks` | bearer | `{ asks: [{ sessionId, callId, tool, arguments, askedAt }] }`, oldest first |
| `POST /asks/{callId}` body `{ verdict: "granted" \| "denied" }` | bearer | 200 `{ callId, settled: true }`; 400 on a bad body; 404 when nothing by that id is pending; 409 when it was already answered or timed out |

`GET /sessions/{id}` gains `asOf`, the event log's latest id at the moment the messages were
read, so a client that opened `/events` before fetching history drops buffered envelopes with
`id <= asOf`. The typed client (`client.ts`) gained `asks()` and `answerAsk()`.

*Doc correction.* `docs/events.md` claimed a refused tool never fires `tool.started`. The engine
emits `tool.started` in `executeToolCalls` before `executeToolCall` decides the gate, so the
true refusal sequence is `tool.started` → `gate.permission{denied}` → `tool.finished{isError}`;
the doc now says so, and names where `gate.ask` sits in that sequence. The engine was left as
is: announcing the call before the gate is what lets a client show the ask on the very row that
will carry the outcome.

**Evidence.** `agent.test.ts` (+2): the ask precedes the guard and the decision carries the
guard's named gate; no ask without a guard. `bus.test.ts`: the vocabulary check demands the new
section. `server.test.ts` (+4): announce → list → 400/404 → answer → `gate.permission{user}` →
409 → the tool ran; the timeout as headless; `/doc` workspace and `{callId}` path parameter;
`asOf` equals the last streamed id. `serve.test.ts`: the rewritten ask test (answered as `user`,
timed out as `headless` with `askTimeoutMs: 20`) and the discovery test (both tickets written
under a temp `userRoot`, `/doc` workspace matches, a second serve exits 2 naming the URL, both
tickets removed on shutdown, a stale ticket replaced). `attach.test.ts` (+1): candidate order.
`main.test.ts` rows unchanged (`--port http` still exits 2).

**Crossings.** `packages/engine`: `bus.ts` (`gate.ask`), `journal.ts` (`PermissionAsk`,
`AskRule`), `agent.ts` (`Confirmation`, `emitAsk`), `index.ts` exports. `packages/server`:
`asks.ts` (new), `host.ts` (`asks`, `answerAsk`, `asOf`), `openapi.ts` (two routes,
`WorkspaceInfo`, path parameters derived from the path), `server.ts`, `events.ts`, `client.ts`,
`testing.ts`, `index.ts`. `packages/cli`: `serve.ts`, `attach.ts`, `main.ts`, `dispatch.ts`.
`docs/events.md`, `docs/headless.md`. `NOTICE` unchanged; all `OWN`.

**Assumptions Jordan may reverse.**
- Both ticket files are written during the compatibility window; a terminal `keywork attach`
  from another workspace still finds the user-level one and may attach to the wrong server, as
  before. Dropping the second file ends that.
- The health check trusts `info.title === "keywork"`; a non-keywork listener on a recycled port
  is treated as stale and its ticket removed.
- The ask timeout is an option on `HostOptions`, not a config key: no `.describe()`d surface yet.
  A `--ask-timeout` flag on `serve` is a one-line follow-up if wanted.
- `keywork run --json` does not forward `gate.ask`: the headless guard refuses at once, so the
  stream would carry an ask and its denial back to back.
- `AskQueue` remembers the last 200 settled ids to answer 409 rather than 404 for late answers.

### P2.5 (2pt): HTML export & sharing
`/export` static HTML of a session branch (self-contained, themed); optional gist upload.
**Strategy:** `LIFT:pi`.
