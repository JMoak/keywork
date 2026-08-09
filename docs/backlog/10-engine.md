# Workstream A — Engine Core

> `packages/engine`. The headless heart: message model, event bus, agent loop, four tools,
> providers. Everything here must run and test without a TUI (D7 headless mode is not an
> afterthought — it is how this workstream is tested).

---

### A1 (3pt) — Message & turn model
Provider-agnostic types in `packages/shared`: `Message` (role, content parts: text / image /
tool-call / tool-result), `Turn`, `Usage` (input/output/cache tokens, cost), tool definitions
(name, description, JSON-schema params). This is the format every provider adapts *to* —
mid-session model switching (table stakes) depends on it being truly neutral.
**Accept:** round-trip serialization tests; a fake two-provider conversation replays losslessly.
**Strategy:** study both `LIFT:pi` (`pi-ai`) and `LIFT:opencode` (`packages/llm` message shape);
lift the cleaner one, record choice + attribution.

### A2 (2pt) — Streaming abstraction
`AsyncIterable<TurnDelta>` per assistant turn: text deltas, tool-call deltas, usage final;
`AbortSignal` cancellation that resolves cleanly mid-stream (steering depends on this).
**Accept:** mock stream cancels mid-delta without unhandled rejection; deltas reassemble into
the final `Message` exactly.
**Strategy:** `LIFT:pi` streaming contract.

### A3 (2pt) — Mock provider
Deterministic scripted provider for tests: plays back configured turns (with timed deltas and
tool calls) so the loop, TUI, and extensions test without network or cost. Ships forever — it
is part of the public testing story.
**Accept:** Vitest fixture drives a full multi-turn tool-using conversation offline.
**Strategy:** `OWN`.

### A4 (2pt) — Event bus core
Typed pub/sub in-process bus: event envelope `{id, ts, sessionId, type, payload}`;
subscribe-by-type with full inference; sync dispatch, no external deps.
**Accept:** type-safe subscription (compile error on wrong payload); ordering guaranteed;
1k events dispatch < 5ms.
**Strategy:** `REIMPL:crush` bus shape; `OWN` implementation.

### A5 (2pt) — Event vocabulary v1
`docs/events.md`: the named event set, SSE-shaped from day one (D7) — session lifecycle, turn
deltas, tool lifecycle (`tool.requested` / `tool.approved` / `tool.started` / `tool.finished`),
config/keybinding reloads, pane hints. Names are API — bikeshed once, here.
**Accept:** doc exists; bus types generated from / checked against it.
**Strategy:** `LIFT:opencode` SSE event naming as reference.

### A6 (3pt) — Agent loop
The turn engine: assemble context (system prompt + session messages + tool defs), call
provider, dispatch tool calls, append results, repeat until end-of-turn; every step emits bus
events; errors become events, not crashes.
**Accept:** mock-provider integration test runs a 3-turn tool-using conversation end-to-end
via events only (no direct calls from test into loop internals).
**Strategy:** `LIFT:pi` loop structure.

### A7 (2pt) — System prompt
Shortest-viable prompt: identity, four tool contracts, response conventions; ingests
`AGENTS.md` / project instructions when present; measured — target within ~15% of Pi's token
count, tracked in a test.
**Accept:** snapshot test pins token count; AGENTS.md content appears when file exists.
**Strategy:** `LIFT:pi` prompt structure.

### A8 (2pt) — Steer & queue semantics
Two delivery modes for user input mid-turn (D6 identity anchor): **steer** aborts in-flight
tool batch (via A2 cancellation), injects message now; **queue** holds until turn completes.
Exposed as engine API (`send(message, {behavior: 'steer'|'queue'})`) mirroring Pi's RPC
`streamingBehavior`.
**Accept:** test proves steer interrupts a slow mock tool mid-execution; queue delivers
post-turn in order.
**Strategy:** `LIFT:pi`.

### A9 (1pt) — `read` tool
Path validation, offset/limit, binary detection, line-numbered output contract.
**Accept:** unit tests incl. CRLF, huge file truncation, missing file error shape.
**Strategy:** `LIFT:pi`.

### A10 (1pt) — `write` tool
Create/overwrite with parent-dir creation; emits file-changed event (git-snapshot hook point).
**Accept:** unit tests incl. new dirs, readonly failure surfaced as tool error.
**Strategy:** `LIFT:pi`.

### A11 (2pt) — `edit` tool
Exact-match old/new replacement with uniqueness enforcement and replace-all mode; the
error messages are UX — make non-unique / not-found failures instructive for the model.
**Accept:** unit tests: unique success, ambiguous rejection listing match count, whitespace
fidelity, CRLF preservation.
**Strategy:** `LIFT:pi`.

### A12 (3pt) — `bash` tool (Windows-first)
Command execution with timeout, streamed output events, cwd tracking, kill on steer.
**Decision made here:** on Windows prefer Git Bash when present, else PowerShell, with the
active shell visible to the model in the tool description; document the story in
`docs/windows.md`.
**Accept:** cross-platform tests in CI (both matrix OSes); timeout kills process tree;
output streams as events.
**Strategy:** `LIFT:pi` + `OWN` Windows story.

### A13 (2pt) — Headless print/JSON mode
`keywork run "prompt"`: executes one conversation headless; `--json` emits the event stream
as JSONL to stdout. This is the E2E test harness for every other workstream and the CI
scripting surface.
**Accept:** E2E Vitest spawns the CLI with mock provider, asserts on JSONL events.
**Strategy:** `LIFT:pi` print-mode contract.

### A14 (2pt) — OpenAI-compatible provider + OpenRouter
Adapter for the OpenAI chat-completions/responses surface (streaming, tool calls, usage);
OpenRouter as a config preset on the same adapter (base URL + key + model routing). Keys from
env/config; never logged.
**Accept:** recorded-fixture tests (no live calls in CI); manual smoke doc for live keys;
usage/cost populated.
**Strategy:** `LIFT:opencode` provider configs; **no OAuth of any kind**.

### A15 (1pt) — Token & cost accounting
Per-turn and per-session aggregation from provider usage; cost table per model (static map,
config-overridable); surfaced as events for C8's honest display.
**Accept:** unit test aggregates a mock conversation to exact totals.
**Strategy:** `OWN`.
