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

### P2.5 (2pt): HTML export & sharing
`/export` static HTML of a session branch (self-contained, themed); optional gist upload.
**Strategy:** `LIFT:pi`.
