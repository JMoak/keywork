# 117: The influence sweep

> **Kind:** research overlay + work plan (2026-10-02); written before anything was built, and
> since then phases 1 to 4 and SW9 landed 2026-10-02 and SW11 plus four lanes landed 2026-10-07
> (ledgers from "Landing ledger" down; SW10 and the scope-first remainder stay open). Six research lanes
> (Pi; OpenCode + OpenTUI; Claude Code, Codex, Gemini and the provider APIs; the wider ecosystem
> and protocols; memory and skills; terminal feel and the Bun runtime) swept what shipped since
> the August research set. Every candidate here was checked against the tree: **confirmed** means
> the gap was read in keywork's own code; **on report** means the external fact rests on the
> lane's cited source and was not re-fetched. Where it speaks it wins; it changes no vision
> decision, and it records three of Jordan's calls in the ledger at the end.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only on the public
> Messages API. Crush is not a source. Pi and OpenCode are MIT and liftable with attribution in
> `NOTICE`; Apache-2.0 sources carry their license text. The user commits.

## What the field did since August

- **Pi reversed on MCP.** Pi 1.0 (2026-10-01) ships MCP as a built-in extension with lazy
  `tool_search` and per-tool exposure, which is D1 by another name. `influencers/pi.md` and the
  `ux-principles.md` §4 row "No MCP in the core loop" cited Pi as the anti-MCP authority; both
  are amended by this overlay. Pi also shipped `ContextEditEntry`, mid-run compaction,
  cache-preserving prompt deltas, cache warming, `/bug`, and Pi Durable (a checkpointed harness
  layer). Earendil acquired Pi in April 2026.
- **The MCP spec moved twice.** The 2026-07-28 revision is a stateless redesign: no
  `initialize` handshake, no `Mcp-Session-Id`, per-request `_meta`, a mandatory
  `server/discover`, multi-round-trip results for elicitation, and OAuth hardened to RFC 9207
  with Client ID Metadata Documents. A legacy-only client fails against a modern-only server.
  keywork speaks `2025-06-18` with the handshake (`engine/src/mcp/wire.ts`). OpenCode and Codex
  already speak the new revision.
- **A real terminal pane is now reachable.** Bun 1.3.14, keywork's own pin, added
  `Bun.spawn({ terminal })` with ConPTY on Windows (2026-05-13), and OpenTUI 0.5.2+ ships an
  embedded terminal renderable on libghostty. `docs/windows.md` and the C15 ledger say neither
  exists; both are amended.
- **The 5.5-generation Claude models change the wire rules.** Opus 5.5 (2026-09-22) and Sonnet
  5.5 (2026-09-28): effort is the depth and cost knob, thinking cannot be disabled, forced
  `tool_choice` returns 400, and thinking blocks are bound to the conversation prefix (a changed
  prefix returns 400 on accounts created after 2026-08-31). Cache-miss diagnostics are GA.
- **OpenCode v2 is a rewrite** (tagged 2026-09-11, no release notes): one ordered permission
  array, a shared background service by default, undo that returns the prompt to the composer,
  transcript verbosity levels, cache warming, references. The service-by-default shape
  conflicts with D7 and is context only. The repo moved to `anomalyco/opencode`; OpenTUI to
  `anomalyco/opentui`, latest 0.5.14 (keywork pins 0.5.1).
- **Elsewhere.** Omarchy 4 ships Herdr, an agent-aware multiplexer with a self-report
  protocol, and its agent picker does not list keywork. Windows Terminal 1.25 stable has the
  kitty keyboard protocol. Anthropic's `sandbox-runtime` is Apache-2.0 with a Windows alpha.
  ACP reached 1.0 in June. Aider is dormant (last release 2026-02-12). Bun 1.4 (2026-08-20) is
  the runtime rewritten in Rust; 1.4.1 and 1.4.2 fix regressions and Windows stdin and Ctrl+C.

## Confirmed gaps in the tree

| Where | What was read |
|---|---|
| `engine/src/session/store.ts` `open` / `appendEntry` | no trailing-newline repair; a file whose last line lacks `\n` glues the next entry onto it and both lines drop on the next parse |
| `packages/*/src` | the word `effort` appears nowhere; 5.5-generation models run at their default |
| `engine/src/pricing.ts` | no rows for `claude-opus-5-5`, `claude-sonnet-5-5`, GPT-6 Sol / Luna |
| `engine/src/mcp/registry.ts` `activate` / `rebuildTools` | tool activation rebuilds the live tool list inside a tool loop; the search tool's `description` getter changes with the catalog; `messages-wire.ts` folds system-role messages into the top-level `system` |
| `engine/src/mcp/client.ts`, `http.ts`, `wire.ts` | `initialize` + `notifications/initialized`, `mcp-session-id`, `capabilities: {}`; no OAuth, no elicitation |
| `engine/src/memory/notes.ts` `parseProvenance` | a note with no `provenance` key parses as `user`; `tools/confine.ts` knows roots only, nothing about the vault, `AGENTS.md` or skill dirs |
| `engine/src/skills` | `authored_by` is a top-level frontmatter key; `validatedName` allows uppercase and `_`; no `.agents/skills` discovery; `compaction.ts` treats skill results like any message |
| `tui/src/core-commands.ts` `undoCommands` | `/undo` restores files only |
| `shared/src/trust/permissions.ts` | tool-name lookup plus bash command globs; no path resources for `read` / `edit` |
| `packages/tui/package.json` | `@opentui/core` 0.5.1 |
| `tui/src` | no mode 2031 handling, no OSC 8 links, no focus-last-pane verb; `notifications.ts` special-cases `TMUX` only |
| `packages/*/src` | nothing inhibits system sleep during a turn |
| `engine/src/tools/command-run.ts` | shell output is capped at 30,000 chars per call, so the mid-run compaction exposure is many medium results in one turn, not one giant one |

## Tasks

Point scale as in the README. Order is the recommended pickup order within each group.

### Group 1: currency and correctness

**SW1 (1pt): repair a missing trailing newline before appending.** `SessionStore.open` checks
whether the file ends in `\n` and the first `appendEntry` after opening prefixes one when it
does not. **Accept:** a session file truncated mid-line reopens, the next entry lands on its own
line, and a reparse keeps every well-formed entry; a test covers the truncated case.
`OWN` (Pi fixed the same bug in v0.84.4). Confirmed.

**SW2 (1pt): refresh the model table.** Add `claude-opus-5-5`, `claude-sonnet-5-5`,
`claude-mythos-5-1`, GPT-6 Sol / Luna / 6.1 Sol with cache rates; mark Sonnet 4.5's
2026-11-30 retirement; settle the per-model `maxOutputTokens` deviation for the 128k-output
models. Assert no code path sends `tool_choice` any / tool or `budget_tokens` to a
5.5-generation id. **Accept:** pricing tests cover each new id; the cost line is right for a
5.5 turn. `OWN`. Confirmed gap; rates on report, verify against the live pricing page.

**SW3 (3pt): a stable request prefix across tool activation.** When `mcp_tool_search`
activates tools, the Anthropic provider appends them as `tool_addition` blocks in a
mid-conversation system message (`inline-tools-2026-09-15`) instead of replacing `tools`, and
emits system-role messages in place rather than folding them into `system`. Other providers
keep today's behavior. The search tool's description stops changing with the catalog.
**Accept:** a live smoke on a post-2026-08-31 key runs a tool-search turn on Opus 5.5 without
a 400; the cache-read count on the following request does not fall to zero; the G2 checklist
is re-run and its "no `anthropic-beta`" line is reworded per decision 117-1. `OWN`. Gap
confirmed; the 400 is on report and is what the smoke proves or disproves.

**SW4 (3pt): effort as a first-class control.** `/effort` beside `/thinking`, a session entry
so it replays, the per-message form so changing it keeps the cache, mapped to
`output_config.effort` on Messages and `reasoning.effort` on Responses. Default stays the
provider's. **Accept:** the entry round-trips through the JSONL store; the C20 picker shows
effort next to the model; the cost line reflects the change. `OWN`; the C20 scope note already
asked for "model + effort in one picker". Confirmed.

**SW5 (2pt): progress updates between tool calls.** With thinking off on a 5.5-generation
model the transcript goes silent between tool calls because the model's notes arrive as empty
thinking blocks. Request `display: "updates"` when off and render non-empty update blocks as
transcript prose; keep `summarized` when thinking is on. **Accept:** G4 assumption 1 ("off is
byte-identical") is reversed in 109's ledger with the reason; a mock-provider test renders an
update block. `OWN`. On report.

**SW6 (2pt): cache-miss reasons on the cost line.** Opt into `diagnostics` on Anthropic and
Responses and show the reported miss reason with the token count beside cost. **Accept:** a
miss after a tool change reads "cache missed: tools changed" in `/cost` and the C18 readout.
`OWN`. On report.

**SW7 (2pt): guard agent writes to the vault, instruction files and skills.** The core
`write` / `edit` tools route any path under the memory vault, `AGENTS.md`, `CLAUDE.md` and the
skill directories through provenance stamping or the J11 protected-core proposal path; a note
written by the agent can never parse as `provenance: user`. **Accept:** a failing test first
(agent writes a frontmatter-less note into the vault; it must come back `agent`, or be staged);
the ask gate still applies on top. `OWN`; closes J11's protected-core criterion. Confirmed by
reading, not yet reproduced.

**SW8 (1pt): neutralize injected memory text.** Strip invisible characters and lookalikes of
keywork's own markup from bootstrap, `memory_search` and `memory_get` output before it reaches
the model. **Accept:** a fixture note carrying zero-width characters and a fake tool-result
frame reaches the prompt as plain text. `OWN`. On report (Claude Code 2.1.284).

**SW9 (2pt): bump `@opentui/core` to 0.5.14.** Pins move under `check-pins`; the e2e baseline
runs; the native double / triple-click selection added in 0.5.7 must stay inert under the 94
overlay's mouse refusals. **Accept:** gate and e2e green on Windows and Linux; a note of any
behavior change. `OWN`. Pin confirmed; compatibility untested.

**SW10 (2pt): bump Bun per decision 117-3.** See the ledger; the task exists so the gate is
written down: `bun run check && bun run test` three times, e2e, `bun run soak`, and
`build:binary` on Windows and Linux, on its own branch, `packageManager` and `@types/bun`
together, revert on any soak signal.

### Group 2: the pane story and the protocol

**SW11 (3pt): real terminal pane spike.** Replace C15's pipe-based shell with OpenTUI's
embedded terminal renderable fed by `Bun.spawn({ terminal })`. Timebox Windows: Bun documents
no termios, no `\r` translation, no mouse on Windows 10, and oven-sh/bun#43450. **Accept:**
`vim`, `htop` and an interactive prompt work in the shell pane on Linux; a written verdict on
Windows with the exact failures; `docs/windows.md` and the C15 ledger say what is true. Depends
on SW9. `OWN`. On report from two lanes.

**SW12 (5pt): a dual-era MCP client.** Probe modern first (`server/discover` on stdio, a
modern request with `Mcp-Method` / `Mcp-Name` on HTTP), fall back to `initialize` bumped to
`2025-11-25`, remember which style each server speaks. Modern style: per-request `_meta`,
`resultType`, `ttlMs` on lists, `subscriptions/listen` for `list_changed`. Do not implement
Roots, Sampling, Logging or HTTP+SSE (deprecated). **Accept:** the stdio fixture server runs in
both styles and the client talks to each; a modern-only server that today fails now works.
`OWN`. Gap confirmed; how many real servers are modern-only is unknown and sets the urgency.

**SW13 (2pt): diff of what a shell command changed.** Use the E3 shadow checkpoint before and
after each `bash` call; append the diff to the tool result for the model and publish it to the
C14 diff pane. **Accept:** a command that edits two files yields a two-file diff in both
places; a read-only command yields none. `OWN`. Design is keywork's; the behavior is on
report (Claude Code 2.1.269).

**SW14 (2pt): undo that returns the prompt.** `/undo` stages the file rollback, drops the last
prompt and its turn from the active path, and puts the prompt text back in the composer;
submitting commits, `/redo` cancels. Only paths attributed to agent steps are restored.
**Accept:** the staged state is visible in the title row; a test walks undo, edit, resubmit.
`LIFT:opencode` (design; record in `NOTICE` only if code is adapted). Confirmed gap.

**SW15 (3pt): ordered, resource-per-action permission rules (decision 117-2).** One ordered
list of `{action, resource, effect}` where the last match wins and no match means ask;
resources per tool (path for `read` / `edit`, pattern for `bash`, URL for fetch, server or
tool for MCP); a compound shell command scans into several resources and any deny denies; the
project layer still cannot widen; `--preset` keeps its meaning. **Accept:** the existing
permission tests pass through a migration of today's config shape; `deny read **/.env*` works;
the trust ladder in the status line is unchanged. `LIFT:opencode`. Confirmed gap.

**SW16 (2pt): Agent Skills conformance.** Move `authored_by` under `metadata` (read the old
key for one release), validate names to `[a-z0-9-]+` matching the directory, scan
`.agents/skills/` at project and user level, parse leniently. **Accept:** the spec's reference
validator accepts every skill keywork writes. `OWN`. Confirmed.

**SW17 (2pt): skill content survives compaction.** Pin activated skill bodies and
instruction-file rules ahead of the B7 cut. **Accept:** a compaction test keeps a loaded skill
verbatim while cutting older tool results. `OWN`. Confirmed.

### Group 3: feel, no options

**SW18 (1pt): draft recovery.** Up on an empty composer restores the draft that Ctrl+C
cleared, pastes included. `OWN`. On report.

**SW19 (1pt): keep the machine awake during a turn.** `SetThreadExecutionState` on Windows,
`systemd-inhibit` on Linux, `caffeinate` on macOS, held while a turn runs and released on
idle or exit. `OWN`. Confirmed absent.

**SW20 (1pt): focus-last-pane verb, MRU focus on close.** One chord bounces between the two
most recent panes; closing a pane focuses the most recently used one. `OWN`. Confirmed absent.

**SW21 (2pt): live theme follow.** Enable mode 2031, re-run the color queries on `CSI ?997;n`,
re-derive the system flavor, disable on exit beside focus reporting. `OWN`. Confirmed absent.

**SW22 (2pt): OSC 8 file:line links** in transcript and tool output, degrading to plain text
where unsupported (T5). The archived C22 returns to the live backlog as this task. `OWN`.

**SW23 (1pt): zellij notification transport.** `ZELLIJ` set means OSC 777 or 9; tmux keeps
the bell; Windows Terminal keeps OSC 9. `OWN`. Confirmed.

**SW24 (2pt): Herdr self-report.** When `HERDR_ENV` is set, map `LifecycleState` to
`report-agent` working / blocked / idle, fire-and-forget with a timestamp sequence, release on
quit. Protocol only, no code from the Apache-2.0 repo. `OWN`. On report.

**SW25 (2pt): transcript verbosity cycle.** One bindable command cycles three disclosure
levels; adjacent reads collapse into one row. No config key. `OWN`. On report.

**SW26 (1pt): terminal-mode hygiene kill test.** An e2e that kills keywork and asserts the
title, focus reporting, mouse modes, kitty keyboard flags and the alternate screen are all
popped. `OWN`.

### Scope first

- **E8 runner on `sandbox-runtime` (2pt spike).** Apache-2.0; bubblewrap + seccomp on Linux,
  Seatbelt on macOS, Windows alpha behind an elevated install. Whether it runs under Bun is the
  Q-DSH6 spike. Windows tier is opt-in; it cannot be zero-config.
- **Mid-run compaction** (amends S3.1 "never compact mid-stream"): check the projected
  context after each tool batch and compact before the next model call. Smaller than it looks
  because of the output cap; an options note first.
- **MCP OAuth to the 2026 rules** (5pt, after SW12 and E9): CIMD with dynamic registration as
  fallback, RFC 9207 `iss` validation, credentials keyed by issuer through E9. OAuth to tool
  servers, not to Anthropic; the guardrail does not apply.
- **Elicitation through the S1 ask queue** (3pt, after SW12): `input_required` renders through
  `gate.ask`, then the call retries with the answers; URL mode prints the link, never opens a
  browser.
- **Pi Durable as input to P2.3:** idempotent `requestId` submits, `replay: "safe"` tool
  declarations, committed-view-then-deltas join, any-client steer.
- **Pi codemode as the answer to Q-DSH5:** nested `ctx.executeTool()` calls pass the same
  gate, carry `parentToolCallId`, run in an in-process QuickJS with no FS or network. A note
  updating 103; building it is 5pt+ and post-M2.
- **Memory:** the claim-specific drift check ("does this note still hold given this diff",
  3pt), `memory forget` by session origin (3pt), Hermes-style curator hygiene for skill review
  (archive folder, pin, dry run, actor ledger, 2pt), skill history review (2pt), a memory-off
  control in J4's recall metrics (2pt on top of J4; the probe corpus J4 specifies has no code
  yet, so the control lands with it).
- **Cache warming:** Pi and OpenCode both shipped it in September. One option that has to
  win the D9 argument; the honest-cost line must show what it spends.
- **ACP agent dialect on the P2 server** (5pt): the protocol is 1.x now; the WATCH rating in
  `mit-feature-candidates.md` row 22 is stale. Still behind D10 and the no-IDE-plugins refusal.
- **Pi `ContextEditEntry`** (2pt): append-only omit or replace of an earlier entry's model
  context. Keeps D8 format compatibility and gives redaction a clean door.
- **Gate `terminate` outcome** (1pt): a blocked call ends the run without another model
  call, which matters when headless `ask` answers no (A20).
- **`/bug` redacted diagnostics bundle** (2pt): a local file, so the share-service refusal
  does not apply.

### Declined

Every Anthropic subscription or copy-code login (Pi, OpenCode, Cline, Zed; the guardrail is
Anthropic-specific, and keywork's existing ChatGPT sign-in adapted from Pi stays, see `NOTICE`;
Pi renaming its Codex provider to "legacy" is a drift watch for `cli/src/codex-login.ts`);
model-classified
auto-approval (Codex `--approve-for-me`, Claude Code auto mode); marketplaces, registries and
synced skill catalogs; voice; image panes; `/goal` autonomous loops; hosted harnesses and
memory services; MCP Apps (HTML UI); enterprise authorization extensions; server-side model
fallbacks (IR-04); OpenCode's shared background service as a default (D7); per-model
compaction overrides (D9); mouse selection semantics (94).

## Documents amended by this overlay

- `influencers/pi.md`: a dated note at the top that Pi 1.0 ships MCP, and §5.3 / §6 read as
  history.
- `ux-principles.md` §4 row "No MCP in the core loop": superseded by D1 and by Pi's reversal.
- `windows.md` and `30-tui.md` C15 ledger: the ConPTY claim is false at the current pin.
- `mit-feature-candidates.md`: row 22 ACP re-rated; Aider rows marked dormant upstream;
  rows already landed in keywork marked as such.
- `115-open-ledger.md`: a pointer to this overlay in the pickup order.

## Decisions ledger

| Call | Decision (Jordan, 2026-10-02) | What it changes |
|---|---|---|
| 117-1 `anthropic-beta` headers | **Allowed** for public Messages API feature betas (`inline-tools-2026-09-15`, `thinking-display-updates-2026-08-18`, `mid-conversation-output-config-2026-07-01`, `compact-2026-09-04`). The two betas `check:guardrails` denies (`claude-code-*`, `oauth-*`) stay denied. | `compliance/anthropic-review.md` rewords its header line when SW3 lands and lists each beta sent; SW3, SW4, SW5 unblocked. |
| 117-2 permission model | **Follow OpenCode v2:** one ordered last-match list with a resource per action; keep "project file cannot widen" and the trust ladder. | SW15 is the task; D3's lift target is the v2 model. |
| 117-3 Bun 1.4 | **Recommendation (research lane, 2026-10-02): stay on 1.3.14, run SW10 as a gated trial when 1.4.3+ exists, start no exit.** Jordan's call pending. | SW10 waits on the answer; see "The Bun question" below. |

## The Bun question

What the controversy is (primary sources): Anthropic acquired Bun on 2025-12-02
(bun.com/blog/bun-joins-anthropic); Bun stays MIT (LICENSE.md). The runtime was rewritten in
Rust by up to 64 Claude agents over May 3 to 14, 2026 (bun.com/blog/bun-in-rust, 2026-07-08:
about 6,500 commits, about 1M lines, about 13,000 `unsafe`, 128 bugs in 1.3.14 fixed, no tests
skipped), shipped inside Claude Code from 2.1.181 (2026-06-17) and as Bun 1.4.0 on 2026-08-20.
Critics (Andrew Kelley 2026-07-09, Lockwood 2026-07-27, Piirainen 2026-08-19): a million
unreviewed lines, `unsafe` counts far above hand-written Rust, slipping release dates, a PR
firehose written by Claude, and governance worries now that an AI lab owns the runtime.
Defenders: it ran in Claude Code for months at scale, the 1.4.0 regressions were an ordinary
.0 release and were fixed in two weeks (1.4.1 on 2026-09-04, 1.4.2 on 2026-09-05). No release
since 1.4.2. The mainstream position is pin, wait and watch; nobody serious is leaving.

What it means for keywork, read from the tree: product code under `packages/*/src` imports
`node:*` only and calls no `Bun.*` API; `Bun.*` appears in `scripts/` alone (release build,
npm build, soak, e2e harness); the test gate is `vitest run`. The real lock-in is OpenTUI's
native FFI layer, `bun build --compile` for the single binary, and `bun.lock`. OpenTUI now
documents a Node path (Node 26.4+ with experimental `node:ffi`, on by default since 26.9) and
Node single-executable builds with pre-extracted assets, so an exit is moderate work, not a
rewrite. OpenCode: its v1 `dev` branch still pins 1.3.14 with OpenTUI 0.4.5; its v2.0.22 tag
pins Bun 1.4.2 with OpenTUI 0.5.14, and a community PR to bump the v1 embedded Bun (#44946)
is blocked on a 1.4.1+ `--compile` + `splitting` crash (oven-sh/bun#42837, closed, fix
unverified).

Recommendation: stay on 1.3.14 now; trial 1.4.x on a branch once a 1.4.3+ exists and the
compile regression is confirmed fixed, under the SW10 gate; start no exit, but keep product code
on `node:*` and add no new `Bun.*` call outside `scripts/`, which keeps the exit cheap. Signals
toward 1.4.x: a 1.4.3+ release and OpenCode's v1 bump merging. Signals toward exit: a license or
governance change, releases stalling past three months, repeated Windows or `--compile`
regressions in point releases, `node:ffi` going stable, OpenTUI deprioritizing Bun. Note for
SW11: `Bun.spawn({ terminal })` is a `Bun.*` call in product code and would be the first; the
spike should weigh that against the Node path OpenTUI's embedded terminal needs.

## Sources of record

Pi releases v0.84.2 to v1.0.0 (github.com/earendil-works/pi/releases), earendil.com/posts/pi-1-0
and /pi-durable; OpenCode v2 docs (opencode.ai/v2/docs: permissions, snapshots, warming,
references, migrate-v1), anomalyco/opentui releases; Claude Code CHANGELOG.md with npm publish
dates; platform.claude.com release notes, Opus 5.5 and Sonnet 5.5 what's-new, cache-diagnostics,
effort and thinking docs; openai/codex and google-gemini/gemini-cli releases; the MCP
2026-07-28 changelog, versioning page, client best practices and extensions matrix;
agentclientprotocol CHANGELOG; anthropics/sandbox-runtime README; agentskills.io specification
and client guide; OpenClaw releases and dreaming / provenance docs; Hermes curator doc; Omarchy
v4.0.x releases; Windows Terminal 1.25 / 1.26 releases; zellij 0.45; Herdr add-support doc;
bun.com blog 1.3.14, 1.4, 1.4.1, 1.4.2.

## Landing ledger

### Phase 1 (2026-10-02): currency and correctness

Gate after the phase: `bun run check` clean, vitest 281 files / 3974 tests (1 skipped).

| Task | Landed | Where | Notes |
|---|---|---|---|
| SW1 | ✅ | `engine/src/session/store.ts` `endsOnItsOwnLine` / `closeOpenLine` | a torn final line is closed before the first append after open; test "closes a torn final line before the next append so neither entry is lost" |
| SW2 | ✅ | `engine/src/pricing.ts`, new `providers/claude-models.ts` (+tests) | rows for Opus 5.5, Sonnet 5.5, Mythos 5 / 5.1, GPT-6 Sol / Luna / Astra, 6.1 Sol, 5.6 Sol / Luna, all checked on the live pricing pages 2026-10-02; `retirementOf()` records Sonnet 4.5 → 2026-11-30 (not yet shown in the picker); one generation table replaces `takesThinkingBudget` and fixes snapshot-date ids parsing as minor versions; deviation 5 settled: wide-output models default `max_tokens` 128k, others 32k; Responses provider no longer counts cached tokens twice |
| SW3 | ✅ built, live smoke open | `engine/src/request-marks.ts`, `providers/messages-wire.ts`, `mcp/tool-search.ts` | mid-conversation tools go out as `tool_addition` blocks in an in-place system message on models that support it; neutral system-role messages are emitted in place there; the search tool's description is static (the roster moved to a no-argument call, a D1 wording change: names cost one call instead of riding in the description); an agent-level test proves the earlier prefix stays byte-stable through search-and-activate; `docs/live-smoke/anthropic.md` steps 6 and 7 hold the 400 and cache-read checks; known limit: a baseline tool vanishing mid-conversation still changes the prefix (`tool_removal` needs a beta 117-1 does not list) |
| SW4 | ✅ | `engine/src/provider.ts` (`EffortLevel`), `agent.ts`, `session/entries.ts` + `store.ts` (`effort_change`), `tui/src/conversation-model.ts` (`/effort`), `model-picker.ts` | opening level as top-level `output_config.effort`; later changes as effort-only system messages on per-message models so the cache survives; `reasoning.effort` on Responses (no per-message form there, support unverified); `/cost` ends with the effort; no config key, no reset-to-default, no `/effort` in `keywork chat` (matches `/thinking`) |
| SW5 | ✅ | `providers/messages-wire.ts`, `tui/src/transcript-feed.ts`, `cli/src/chat.ts` | thinking off on a progress-update model sends `display: "updates"`; non-empty update blocks render as prose (`TurnDelta` `progress`); not stored as message parts, so replay does not show them; G4 assumption 1 reversed in 109 "Reversals of record" |
| SW6 | ✅ | `agent.ts` (`cacheMiss()`), both providers, `tui/src/session-ledger.ts` | diagnostics always on (Anthropic every model, Responses gpt-5.6+); `*_changed` reasons surface in the status line and `/cost`; finding for Jordan: keep-all models will likely report `messages changed` after tool turns because the deviation-3 replay policy drops the previous turn's thinking, a real cost now visible, unverified live |
| SW7 | ✅ | new `engine/src/tools/protected-writes.ts`, `write.ts`, `edit.ts`, `core.ts`, `memory/store.ts` | agent `write` / `edit` under the vault becomes a staged proposal stamped `provenance: agent`; the vault's structure, `AGENTS.md`, `CLAUDE.md` and every skill convention dir are refused with a message naming the right door; untrusted workspace keeps `MemoryInertError`; the bash tool can still write these files (SW13 lane to consider) |
| SW8 | ✅ | new `engine/src/memory/neutralize.ts`, applied in `bootstrap.ts`, `recall-tools.ts`, `point-of-action.ts` | invisible characters and the Unicode tag block stripped; framing tags and keywork's own prompt / recall framing lines escaped; note names are left alone so `memory_get` still resolves |
| SW16 | ✅ | new `engine/src/skills/spec.ts`, `authorship.ts`, `library.ts`, `genesis.ts`, `extensions/skills.ts`, `memory/frontmatter.ts` | `metadata.authored_by` with a one-release legacy read; spec name and description rules; `.agents/skills` discovered at project and user level; frontmatter parser gained one-level nested maps; in-repo conformance checker in tests (no dependency) |
| SW17 | ✅ | `engine/src/session/compaction.ts` | latest successful `skill` / `skill_view` loads ride the compaction summary verbatim inside `<skill_content>` blocks and carry forward across compactions; the summarizer never sees them; instruction files needed no pin (they live in the system prompt) |
| SW18 | ✅ | `tui/src/prompt-editor.ts`, `paste-placeholder.ts`, `overlays/help.ts` | Ctrl+C now clears the prompt (it did nothing before) and Up on an empty prompt restores the draft, pastes included |
| SW19 | ✅ | new `engine/src/keep-awake.ts`, `tui/src/app.ts`, `session-panes.ts` | held only while a pane is working; Windows via a dynamic `bun:ffi` import of `SetThreadExecutionState` (the one `Bun.*` surface in product code; it degrades to a no-op), macOS `caffeinate -w`, Linux `systemd-inhibit` wrapping `tail --pid`, all dying with the process |
| SW20 | ✅ | `tui/src/app-actions.ts`, `app-core.ts`, `layout.ts`, `layout-state.ts` | `leader tab` bounces between the two most recent panes (sticky); close focuses the MRU pane; the focus trail persists as an optional `recent` field |
| SW23 | ✅ | `tui/src/notifications.ts` | `ZELLIJ` set means OSC 777; tmux keeps the bell even inside zellij; Windows Terminal keeps OSC 9 |

Docs amended in the phase: `compliance/anthropic-review.md` (2026-10-02 re-run, three betas listed, sign-off open), `live-smoke/anthropic.md`, `109` reversals, `95` J10 note, `memory.md` invariant 2.

### Phase 2 (2026-10-02): the pane story and the protocol

Gate after the phase: `bun run check` clean, vitest 288 files / 4076 tests (1 skipped), e2e 45 of 45 (the `discovery` goldens regenerated for the new `focus-last` rows).

| Task | Landed | Where | Notes |
|---|---|---|---|
| SW12 | ✅ | new `engine/src/mcp/era.ts`, `errors.ts`, `http-headers.ts`; `client.ts`, `http.ts`, `registry.ts`, `wire.ts`; fixture `--era=legacy|modern|dual`, `--mute-discover`, `--ttl` | modern probe (`server/discover` with `_meta`) then legacy fallback at `2025-11-25`; era remembered per server for the process; `resultType` tolerated, `input_required` fails with a clear message (elicitation routing is the scope-first follow-on); `ttlMs` honored on next use, no timers; `subscriptions/listen` for list_changed; `Mcp-Method` / `Mcp-Name` / `x-mcp-header` on HTTP; deprecated Roots / Sampling / Logging / HTTP+SSE not implemented; the probe has its own 2s timeout so a silent legacy server costs two seconds once |
| SW13 | ✅ | `engine/src/checkpoints.ts` (`snapshot`, `changesBetween`), new `tools/command-changes.ts`, `tools/core.ts` `worktree`, `tui/src/diff-model.ts` | snapshot before and after each `bash` call; changed files with per-file counts and the unified diff appended to the tool result (paths only past the 30,000-char cap); the diff pane refreshes on bash like write / edit; fix on the way: a shadow repo inside its own worktree now excludes itself |
| SW14 | ✅ | new `tui/src/prompt-undo.ts`, `conversation-model.ts`, `core-commands.ts`, `cli/src/sessions/ports.ts` (`rewindBefore`, `moveLeaf`) | `/undo` restores files, moves the leaf to the prompt's parent (JSONL keeps everything), rebuilds the agent on the shorter path, and puts the prompt back in the composer; send commits, `/redo` cancels (files, leaf and transcript return); title row reads `undo staged`; deviations: whole-tree restore (attribution is not cheap), one level of staging, mark hidden under 70 columns, `/redo` needs an empty composer |
| SW15 | ✅ | `shared/src/trust/permissions.ts` (rewritten), new `trust/rules.ts`, `presets.ts`, `glob.ts` (`commandGlob`, `pathGlob`), `config/schema.ts` (`permissionRule`), `cli/src/presets.ts`, `cli/src/run.ts` (AB2 hint) | one ordered `{action, resource, effect}` list, last match wins; path resources for read / write / edit, command globs for bash, `mcp` action and `<server>__*` for a whole server (AB3); compound commands split on `; & \| \r \n`, any deny denies, then ask, opaque parts never ride an allow; legacy `{tools, bash}` shape still loads with a documented migration order and all 12 legacy tests unchanged; deviations: no match keeps the built-in posture (read-only allow, mutating and MCP ask) so `standard` stays `[]`; the project layer still contributes no permissions (stronger than the spec's "may add deny"); agentbox system fragments now allow their whole server (a policy change AB3 asked for) |
| SW21 | ✅ | `tui/src/osc.ts`, `system-theme.ts` (`followTerminalTheme`), `flavor.ts` (`refit`), `app.ts` | mode 2031 on, 997 report re-queries colors and refits the `system` flavor, repaint only when `system` is worn; off at exit; OpenTUI 0.5.1 already sets 2031 for its own dark/light mode, so keywork's explicit set is belt and braces |
| SW24 | ✅ | new `tui/src/herdr.ts`, `app.ts` | `HERDR_ENV=1` plus pane id and bin path required; `report-agent` working / blocked / idle on change, one in flight, latest state only, monotonic `--seq`, `-- keywork` resume argv, `release-agent` on quit; a spawn error silences it for the run |
| SW26 | ✅ | new `scripts/e2e/captured-terminal.ts`, `scenarios/terminal-hygiene.ts`, harness `kill()` / `terminalBytes()` / `answer()`; `app.ts` | the scenario proves title, 1004, 2004, mouse modes, kitty `CSI < u`, 1049 and 2031 are all popped on SIGTERM; two real bugs fixed: on SIGTERM OpenTUI's handler destroyed the renderer but keywork's `onExit` never ran (title and focus reporting leaked), and OpenTUI's teardown `OSC 0 ;` clobbered our title pop; a real OS SIGTERM on Windows is TerminateProcess and cannot be handled or tested; e2e default count 44 → 45 |

Findings for Jordan from the phase:
- **The `bun` on this machine is 1.3.9** (chocolatey), while the repo pins 1.3.14. Pressing Ctrl+C inside the e2e harness segfaults Bun 1.3.9 (`panic(main thread): Segmentation fault`), reproduced on a clean checkout of `4fe536e` before any of today's work, so it is not a regression; the e2e scenarios avoid Ctrl+C for that reason and should be retested once the local Bun matches the pin. Installing 1.3.14 locally is an environment change and waits for Jordan.
- The phase-1 SW19 Windows inhibitor (`bun:ffi`) was ruled out as the cause (the crash reproduces with it stubbed).

### Phases 3 and 4 (2026-10-02): feel, and the open ledger

Run together as four lanes with disjoint files. Gate after the lanes: `bun run check` clean, vitest 302 files / 4229 tests (1 skipped), e2e 47 of 47 (two scenarios added).

| Task | Landed | Where | Notes |
|---|---|---|---|
| SW22 | ✅ | new `tui/src/file-references.ts`, `osc.ts` (`hyperlinks` support), `markdown.ts`, `markdown-ink.ts`, `transcript-view.ts`, `app.ts` (`AppOptions.hyperlinks`) | `path:line[:col]` references link to `file://<abs>#L<line>` in prose, tool rows, detail and thinking; on for Windows Terminal, kitty, Ghostty, WezTerm, iTerm2, foot, VTE 5000+, Konsole; off when unknown, under tmux / screen / zellij, and over SSH (a `file://` link would point at the wrong machine); links are attached before wrapping so each row carries its own span; the e2e harness pins links off so goldens do not churn; scenarios `file-links` and `file-links-off` |
| SW25 | ✅ | new `tui/src/transcript-verbosity.ts`, `transcript-feed.ts`, `transcript-view.ts`, `app-actions.ts` | `leader v` cycles low / medium / high (sticky); medium is today's rows plus adjacent agent reads collapsed into one row; high adds arguments (8 rows) and the first 3 result lines; low collapses any run of two or more adjacent agent calls into `N tools: read 4, bash 1`; session-local, no config key |
| V2.11 | ✅ detection, stamp unchanged | `transcript-feed.ts` (`ToolRun.provenance`), `transcript-view.ts` `toolVoice` | untrusted recalled memory is detected as external on the rail and never joins a verbosity group; the visible stamp stays PD18 (tool rows ░, a user's `!cmd` █ per V2.8); flipping agent tool rows to ▓ is one line in `toolVoice` plus five goldens, Jordan's call; gap: MCP results cannot be marked external until `tool.started` carries a server's trust flag |
| V2.7 | ✅ | new `tui/src/mention-completer.ts`, `mention-attachments.ts`, `prompt-editor.ts`, `conversation-model.ts` | `@` opens an inline completion over the file index (same ignore rules as file jumps), Tab / Enter insert the repo path, Esc dismisses; on send each mentioned file is attached once (`<attached path>` block, 30,000-char cap, deduplicated against history byte for byte); the transcript, queue, `/undo` and fork show the prompt as typed; the tray prefix is `/` or `@` by mode |
| V2.17 | ✅ | new `tui/src/away-summary.ts`, `side-question.ts`, `conversation-model.ts` (`attend`, `terminalFocusChanged`, `/btw`) | one info line on return (`while you were away: changed …; it ended on "…"; waiting on you: …`) derived from bus events, no model call, never notifies (PD25); `/btw <question>` is one tool-less provider request over a flattened `<session>` block (newest 60,000 chars) whose question and answer never enter history or the JSONL |
| V2.16 | ✅ | new `tui/src/commit-draft.ts`, `app.ts` | `/commit-draft` (aliases `draft-commit`, `commit-message`) drafts a conventional commit from the staged diff (else unstaged) through the bound provider, shows it fenced, copies it over OSC 52, and ends with `keywork never commits, that part is yours`; the only git call is `git diff` with external diff, textconv and fsmonitor disabled |
| P2.5 | ✅ | new `cli/src/sessions/export-html.ts`, `export.ts`, `tui/src/core-commands.ts` (`/export [tree] [path]`), `keywork sessions export [id] [--tree] [--out]` | self-contained HTML (inline stylesheet, light / dark by preference, CSP with no scripts or fetches), every entry type including `context_edit`, thinking in closed `<details>`, tool calls paired with results, per-turn tokens and cost, provenance glyphs, images inlined only for safe types, every string escaped and invisible characters shown as `U+XXXX` chips; a local file only; independent implementation, nothing adapted from Pi |
| P2.6 | ✅ | `server/src` `POST /sessions/{id}/inject` `{text, client}`, `engine/src/agent.ts` (`SendOptions.origin`, `turnOrigin()`), `bus.ts` (`origin` on `turn.started` and queued prompts) | bearer ticket like every route; 202 with `queued`; queue over steer ("runs identically to a typed prompt"); a vault proposal made during an external turn is staged `untrusted`; a separate route rather than a field on `/prompt` so an external tool cannot land an untagged prompt by omission; limits: origin is not persisted, attached panes do not show another client's injection (P2.2), settle-time flushes still stamp `agent` |
| E9 | ✅ | new `shared/src/secrets/` (`vault.ts`, `dpapi.ts`, `secret-service.ts`, `keychain.ts`, `refs.ts`), `cli/src/auth-store.ts`, `inference/connections.ts`, `engine/src/mcp/registry.ts` (`reveal`), `config/schema.ts` (`secretStore`) | credentials live in DPAPI (Windows, PowerShell `ProtectedData`, ciphertext under `~/.keywork/secrets/`), Secret Service (`secret-tool`), or Keychain (`security`); `auth.json` holds `{"type":"vault","secret":"provider.<name>"}`; `secret:<name>` references in MCP `env` / `headers` are revealed per server on connect; `secretStore: "os" \| "plaintext"` is the justified opt-out, user layer only; a missing backend falls back to plaintext with a notice; one real DPAPI round trip ran on this machine; not built: `keywork secret set`, migration of existing plaintext entries, the first Codex sign-in in `setup.ts` still saves plaintext |
| Gate terminate | ✅ | `engine/src/agent.ts` (`ToolGuard.declineEndsRun`), `cli/src/run.ts`, `fixtures/headless/denied.jsonl` | a headless decline ends the run after the tool result with no further model call; later calls in the same reply settle as skipped so history stays paired; exit 4 unchanged, stderr says the run stopped there; interactive runs unchanged |
| ContextEditEntry | ✅ | `engine/src/session/entries.ts`, `store.ts` (`appendContextEdit`), `NOTICE` (Pi line) | `type: "context_edit"` with `targetId` and `replacement: null \| content`, applied on the active path after compaction, latest edit per target wins, branch-relative; keywork's own rule: removing one half of a tool call / result pair removes the other; no `/forget` UI yet (needs a prompt picker and an agent rebuild like `/undo`) |

| Thinking replay (deviation 3) | ✅ 2026-10-07 | `providers/claude-models.ts` (`preserved-thinking`), `providers/messages-wire.ts` (`thinkingReplayFor`), `session/entries.ts` (keep-tail strip) | prior-turn owned thinking replayed unchanged on Opus 4.5+, Sonnet 4.6+, Fable 5+, Mythos 5+ when a thinking config is on the wire, so the second request's prefix is the first's byte for byte; Haiku, older ids, and thinking-off requests keep the current-turn drop; the B7 keep-tail projection strips blocks bound to the pre-compaction prefix so a compacted history never replays a signature the API rejects; closes the SW6 `messages changed` finding; 70 deviation 3 amended, compliance re-run 2026-10-07 |
| Mid-run compaction | ✅ 2026-10-07 | `agent.ts` (`settleToolBatchesWith`), `session/settle.ts` (`phase`), `tui/src/session-attachment.ts`, `conversation-model.ts`, `cli/src/compose-panes.ts` (forwards the phase) | after each tool batch, with no stream open, the pane persists the turn so far and runs B7 if the projected context is past the mark; the running agent adopts the compacted projection before its next call; no flush mid-turn, the after-turn settler never compacts twice; S3.1 amended in 108, reversal in 109 |
| `/forget` | ✅ 2026-10-07 | new `tui/src/forget.ts`, `core-commands.ts`, `conversation-model.ts` (`beginForget`, `pickerHint`), `transcript-navigation.ts` (picker purpose), `transcript-feed.ts` (`ToolRun.callId`, `forgettableIndices`), `session-attachment.ts` (`forget` port), `cli/src/sessions/ports.ts` | `/forget [replacement]` opens the backtrack picker over saved prompts and tool rows, appends a `context_edit` (`null` or the typed line) for the picked entry on the active path, rebuilds the agent on the edited projection through the `/undo` adopt seam, and posts one confirming line; the store's pair rule removes the other half of a tool call / result; refused while a turn runs |
| Cache warming | note only, 2026-10-07 | this file, "Cache warming: the options note" below | not built: it cannot win without a config key, and a key that spends while the user is away needs Jordan's call |

Still open from the four phases: SW9 (OpenTUI 0.5.14, bumped and under its own gate, see below), SW10 (Bun, decision 117-3), SW11 (the terminal pane spike, waits on SW9 and the Bun call), the scope-first items not named above (sandbox runtime spike, MCP OAuth and elicitation routing, Pi Durable note, codemode note, the memory items, ACP; mid-run compaction and the cache-warming note landed 2026-10-07, see the lane section at the end).

### SW9 (2026-10-02): OpenTUI 0.5.1 → 0.5.14

Landed: `packages/tui/package.json` and `bun.lock`. Gate on the new version: `bun run check` clean, vitest 302 files / 4229 tests, e2e 47 of 47 (one run showed `terminal-mirror` flaking on masked timing widths under full-run load; it passes in isolation and passed twice before the bump, so it is a timing flake to pin, not a regression). One behaviour change found: since 0.5.14 OpenTUI writes OSC 8 hyperlinks only when its own XTVERSION probe recognises the terminal, so SW22 links need both OpenTUI's check and keywork's to agree; the `file-links` scenarios answer XTVERSION as kitty to prove the emission. On a terminal OpenTUI cannot name (Windows Terminal unless it answers XTVERSION in a recognised shape, untested) links stay off; the native library has a `setHyperlinksCapability` symbol the JS layer does not bind, so making them work there needs an upstream change or a binding. The native double / triple-click selection added in 0.5.7 did not disturb the pointer scenarios.

### Memory lane (2026-10-07): the scope-first "Memory" bullet

All five items landed (`OWN`; the Hermes items are designed from the curator doc, no code
copied), plus the single-vault rung of J14. Detail and evidence in
`95-memory-and-skills.md` "Memory lane, 2026-10-07"; invariants 8 and 9 and the "Skills
beside the vault" section in `docs/memory.md`.

| Item | Landed | Where | Notes |
|---|---|---|---|
| drift check | ✅ | new `engine/src/memory/drift.ts`, `store.ts` (`annotateNote`), `staging.ts` (`drift-review`), new `cli/src/memory-command.ts` | one bounded provider question per touched note; verdict stamped as frontmatter `drift` map plus a `curation.md` line with evidence; body never edited; stale → one Gardener proposal; `keywork memory drift [range]` |
| memory forget | ✅ | `notes.ts`, `store.ts`, new `memory/forget.ts`, `staging.ts` (`forget-proposal`), `flush.ts` | `origin_session` / `revised_by` on notes, session inside the daily marker; dry run default, `--apply` stages one proposal; approval removes through the ledger, revert restores; mixed provenance refused with a reason; `compose.ts` / `protected-writes.ts` still need to pass the session (outside the lane) |
| curator hygiene | ✅ | new `engine/src/skills/curator.ts`, `library.ts`, `gardener.ts` (pinned skip) | archive folder `.keywork/skills-archive/<name>/<stamp>/`, actor ledger `ledger.jsonl`, `metadata.pinned`, dry run by default, agent-authored only |
| skill history | ✅ | new `cli/src/skills-command.ts`, `dispatch.ts`, `main.ts` | `keywork skills history <name> [--restore <stamp>]`, `pin`, `unpin`, `archive`, `curate` |
| memory-off control | ✅ seam + stub | new `engine/src/memory/recall-probe.ts` | J4's corpus had no code: `memoryOffControl`, `compareAgainstMemoryOff` (lift), four-note corpus stub with a multi-hop case as the graph-leg target |
| J14 first rung | ✅ | `engine/src/memory/search.ts` (`reconcile`) | outside edits re-embedded, deleted notes leave no ghost, no rebuild command; multi-host half still open |

### SW11 (2026-10-07): the real terminal pane

Landed: new `engine/src/tools/pty.ts` (`probePtySupport`, `interactiveShell`, the one
`Bun.*` surface, read through `globalThis.Bun`), new `tui/src/terminal-backend.ts`
(`TerminalBackend` = `pty` | `pipes`, `chooseTerminalBackend`), `terminal-surface.ts`
(`TerminalSurface` over OpenTUI's `EmbeddedTerminalRenderable`, frame-surviving subclass),
`terminal-shell.ts` (`PtyShell`), `terminal-pane.ts` (backend chosen once per pane; pipe
shells carry `· pipes` and a first-line reason), `terminal-model.ts` (`banner`),
`testing/fake-terminal-backend.ts`, `app.ts` (factory now built where the renderer is in
scope, `TerminalPanePort.pty`), engine `index.ts`; docs `windows.md` and the C15 ledger in
`30-tui.md`. Tests: 4361 vitest (62 in the terminal and pty files), e2e `terminal-mirror`
and `terminal-hygiene` pass. Mirror mode (the C14/C15 agent `bash` mirror) is untouched.

The Bun question, answered for this task: the `Bun.spawn({ terminal })` call exists, in
exactly one small file, behind a structural probe, so a Node build reports "this runtime
has no Bun.Terminal" and runs the pipe shell; the exit stays one file (swap the opener for
`node-pty` or Node's future pty) and the renderable side is already OpenTUI's Node path.

**Windows verdict.** No pty: `bun-types@1.3.14` documents the `terminal` option as POSIX
only (the "ConPTY at 1.3.14" sentence in SW11's task text was wrong), and on this machine
Bun 1.3.9 throws `PTY not supported on this platform` from `new Bun.Terminal`. The probe
refuses `win32` before touching Bun, so ConPTY, `\r` translation and Windows 10 mouse
never come up; the failure is one line and the pipe shell stays the Windows shell, which
`docs/windows.md` now says in a table.

**Linux verification (not run here; acceptance is by construction plus the fake-backend
tests).** On Linux with the pinned Bun 1.3.14 in a trusted workspace: (1) `/terminal shell`
and the title reads `terminal · shell · bash` (or `zsh`), with no `· pipes` and no
`· pipes:` line; (2) the shell's own prompt appears and `ls` colors; (3) `vim` opens, `i`,
typing, `escape`, `:q!` returns to the prompt with the screen restored; (4) `htop` draws,
`F10` or `q` leaves; (5) `sleep 30` then `ctrl+c` interrupts; `ctrl+d` prints
`· shell exited (0) · enter restarts it` and `enter` brings a new prompt; (6) `tput cols`
equals the pane's content width and changes after `leader .`; (7) `ctrl+k h` leaves the
pane, typing goes to the prompt editor, `ctrl+k l` returns; (8) `leader x` on the pane and
`ps -ef | grep -- -i` shows no leftover shell; the same after `ctrl+q` with a shell open.
Risks only Linux can settle: the frame-survival subclass relies on OpenTUI 0.5.14's
`destroyRecursively` iterating a copy of the children and on `add()` reparenting (both
read from the shipped source), and the yoga box must honour the explicit `width`/`height`
the pane sets on the renderable each frame.

Not built, by choice: focus-in/out escapes to the child and keyboard scrollback of the pty
surface (OpenTUI 0.5.14 exposes neither publicly), mouse into the pty (94's refusals),
`ctrl+q` as pty input (keywork's quit wins), a `TERM` other than `xterm-256color`.

## Where the tree stands (end of 2026-10-02)

Four phases landed in one day on top of the sweep: 29 tasks (SW1 to SW9, SW12 to SW26, V2.7, V2.11, V2.16, V2.17, P2.5, P2.6, E9, gate terminate, ContextEditEntry, AB2, AB3), all uncommitted, 186 files changed. Gate: `bun run check` clean, vitest 302 files / 4229 tests (1 skipped), e2e 47 of 47. Jordan reviews and commits.

Calls waiting on Jordan after the day: 117-3 Bun (and installing the pinned 1.3.14 locally; the PATH `bun` is 1.3.9 and segfaults on Ctrl+C in the e2e harness, pre-existing); whether agent tool rows flip to ▓ (V2.11, one line plus goldens); the SW3 / SW5 live smoke with a real key (`docs/live-smoke/anthropic.md` steps 6 and 7) and the compliance sign-off line; ~~the SW6 finding that keep-all models will likely report `messages changed` after tool turns because the deviation-3 replay policy drops thinking~~ (closed 2026-10-07: thinking replays per generation, 70 deviation 3 amended); the SW15 choices (no-match keeps the built-in posture, project layer contributes no permissions, agentbox systems allow their whole server); whether to persist injection origin (P2.6); `keywork secret set` and migrating existing plaintext credentials (E9); ~~the `/forget` UI for context edits~~ (landed 2026-10-07).

## 2026-10-07: the context-economy lane

Three builds and one note from the scope-first list, landed uncommitted on top of the four
phases. Rows added to the landing ledger above (thinking replay, mid-run compaction, `/forget`,
cache warming). Gate for the lane's files: biome and vitest green on every file it touched;
the repo-wide `check:types` run carried errors in other lanes' in-progress files
(`engine/src/memory/*`, `engine/src/skills/curator.ts`) and one biome format diff in the
hooks lane's `agent.ts`, none in this lane's code.

**Assumptions Jordan may reverse**

1. The replay cut is the generation that preserves prior-turn thinking (Opus 4.5, Sonnet 4.6,
   Fable 5, Mythos 5 and later), read off the prompt-caching page, not the narrower 5.5
   generation the task named. On a model that strips prior thinking server-side, replaying it
   costs cache; on one that keeps it, dropping it costs cache. The table has one row per
   family and a narrower cut is a four-number edit.
2. A request with no thinking config (thinking off on Opus 5, Sonnet 5, the 4.x line) keeps
   the current-turn-only drop even on a preserving model, because the API documents a strip
   when thinking is off and the lane could not verify the alternative live.
3. Mid-run compaction rebuilds the running agent's in-memory history from the store projection
   rather than swapping the agent, because the turn is in flight and `swapAgent` is an
   between-turns operation; the after-turn rebuild seam is untouched. `keywork chat` keeps
   after-turn-only settlement.
4. `/forget` keeps the transcript row as it was and says so in its confirmation line; a visual
   mark on forgotten rows was deliberately left out (one line of `transcript-view` later if
   wanted).

### Cache warming: the options note

**What shipped elsewhere (on report, from the sweep's Pi and OpenCode lanes, not re-fetched).**
Pi 1.0 and OpenCode v2 both keep the prompt cache alive across the gap after a turn by
re-sending the finished request to the provider shortly before the cache entry would expire,
as long as the user is still around; both expose it as a setting rather than an always-on
behaviour, and neither showed the spend as its own line in the sweep's reading.

**What the API offers.** The prompt-caching page's keep-alive: re-send the previous request
with `max_tokens: 0` and `stream` off while idle. It refreshes the 5-minute entry, bills one
cache read of the whole prefix and no output tokens, and is rejected with `stream: true`,
structured outputs, forced `tool_choice`, or inside a batch. keywork's Anthropic provider
streams every request, so warming needs a second, non-streaming request path in
`anthropic.ts` (same headers, same body minus `stream`, `max_tokens: 0`), which the compliance
checklist would re-run on. The alternative is the 1-hour TTL (`cache_control.ttl: "1h"`),
which writes at 2x instead of 1.25x and needs no idle traffic at all.

**What it costs.** One keep-alive every ~4.5 minutes reads the full prefix once. For a 100k-token
prefix, from `pricing.ts` (USD):

| model | one keep-alive (read) | one cold miss (write) | keep-alives a miss is worth |
|---|---:|---:|---:|
| claude-fable-5-1 | $0.025 | $1.25 | 50 (about 3.75 h of idle) |
| claude-opus-5-5 | $0.020 | $0.50 | 25 (about 1.9 h) |
| claude-sonnet-5-5 | $0.020 | $0.25 | 12 (about 56 min) |
| claude-haiku-4-5 | $0.010 | $0.125 | 12 (about 56 min) |

Warming pays only if the user comes back inside that window, and every keep-alive is spent
whether or not they do. The 1-hour TTL costs 0.75x of one write up front (the extra over the
5-minute write) and covers the first hour with no further traffic, which beats keep-alives on
Sonnet and Haiku for any gap over ~40 minutes and loses on Fable 5.1 for any gap under three
hours, where reads are nearly free.

**How the honest-cost line would show it.** A keep-alive is not a turn, so it never folds into
turn cost. `/cost` would gain its own row (`warm · 6 keep-alives · $0.15`), the title-bar `$`
would include it, and the per-model lines would carry a `warm` column; the session entry
would be a `custom` `cache_warm` record so replay and `sessionCost` agree with the live
ledger. The context gauge is unaffected (nothing enters context).

**Recommendation: do not build it now, and not without a key.** The D9 test is whether the
behaviour can ship with no option. It cannot: warming spends money while the user is away,
with no turn to attribute it to, and the right bound differs by model (near-free on Fable 5.1,
roughly break-even on Haiku), by key (metered personal key versus a team's), and by habit
(lid closed for the night versus a coffee). Any built-in default is a policy someone will need
to turn off, which is exactly the option D9 says must be justified first. The justified shape,
if Jordan wants it: one key, `cacheWarming: "off" | "<minutes>"`, off by default, Anthropic
only, the `.describe()` saying it spends while idle and naming the per-model read price; plus
the non-streaming request path, the `cache_warm` entry, and a live check that `max_tokens: 0`
behaves as documented on the 5.5 generation. Until then the cheaper lever is already in hand:
the thinking replay above removes the self-inflicted miss after every tool turn, which on
Fable 5.1 was worth more than any keep-alive schedule.

## 2026-10-07: the feel-polish lane (group 3 extended)

Six small items, no options, one e2e scenario (`feel-polish`, goldens `after-editor` and
`image-chip`). Gate for the lane: the touched suites plus the full vitest run and e2e.

| Item | Landed | Where | Notes |
|---|---|---|---|
| C7 `ctrl+g` external editor | ✅ | new `tui/src/external-editor.ts`, `renderer-hold.ts`; `app-actions.ts` (`prompt.editor`, `/editor`), `app-core.ts`, `app.ts`, `osc.ts` (`refresh`) | `$VISUAL`, `$EDITOR`, then `notepad` / `vi`; renderer suspended with keywork's modes popped and pushed back; draft never lost; see the C7 ledger in `30-tui.md` |
| Cost in the terminal title | ✅ | `osc.ts` (`WindowTitleState.spend`), `notifications.ts` (`terminalFocused`), `session-ledger.ts` (`spendSummary` public), `conversation-pane.ts` (`spend()`), `app.ts` | while the terminal is unfocused the title reads `█ name · $0.42 · keywork` (stamp · name · telemetry · app, the PD19 order); the spend is `/cost`'s first figure (`formatCostNanos`, or `in▸out` when unpriced); a focused terminal keeps the calm title; needs focus reporting, so a terminal without mode 1004 never shows it |
| Send-now key | ✅ | `prompt-editor.ts` (`SendMode`, `holdAside`), `conversation-model.ts` (`setQueueAside`), `overlays/help.ts`, the busy prompt hint | `ctrl+enter` cancels every queued prompt, sends the composer as steer (interrupt and run), posts `N queued prompts set aside · up on an empty prompt brings them back`; the newest flushed prompt becomes the SW18 draft and older ones join history, so Up walks them all back; `alt+enter` keeps the queue as before; nothing in the model drops a queued prompt silently (moves and `dispose` were already explicit) |
| `/bug` diagnostics bundle | ✅ | new `tui/src/bug-bundle.ts`; `app.ts` (`AppOptions.bugReport`, `EventRecorder` over every agent bus); `cli/src/compose-panes.ts` (version, config, dir) | writes `~/.keywork/bug-reports/bug-<stamp>.json` with version, OS, Bun, terminal facts, the config with secret-looking keys stripped and `redactForPersistence` over the whole text, the last 60 bus events as type plus a contents-free detail, the focused session's last 20 messages as shapes (type and length, tool names, never text) and its last 5 error lines redacted; prints the path into the session; nothing is uploaded |
| Image paste | ✅ TUI half | new `tui/src/image-paste.ts`; `prompt-editor.ts` (`ImageVault`, chips), `conversation-pane.ts` (`handlePaste` with `PasteFacts`), `app-core.ts` (`/image [path]`, `ctrl+v`), `app.ts` (OpenTUI 0.5.14 `createHostClipboard`) | a pasted png / jpg / gif / webp path (bare, quoted, escaped or `file://`) becomes `[image #n, png 24 KB]`; `ctrl+v` and a bare `/image` read the OS clipboard through OpenTUI's host clipboard; `/image <path>` attaches a file; 5 MB cap; the chip survives Ctrl+C and Up; at send the `ImagePart` is built and the words go out with `the image stayed behind · this build's engine sends text only`, because `Agent.send` takes a string and `agent.ts` is outside this lane |
| V2.5 compaction offer | ✅ | new `tui/src/compaction-offer.ts`; `conversation-model.ts` (`offerCompaction`) | one info line once per crossing of the flush line; never auto-runs; see the V2.5 ledger in `96` |

Terminal support, stated plainly:

- External editor: any terminal, since the renderer suspends and the child inherits the
  tty; Windows Terminal with `notepad` works without `$EDITOR`; over SSH the editor runs on
  the remote side as expected.
- Cost in the title: needs focus reporting (mode 1004), which Windows Terminal, kitty,
  Ghostty, WezTerm, iTerm2, foot, VTE and xterm send; without it the terminal reads as
  focused forever and the title stays calm. Under tmux the title needs `set -g set-titles on`.
- Image paste: bracketed paste carries text in every terminal, so the path route works
  wherever a file manager drops or copies a path (Explorer "Copy as path" into Windows
  Terminal, Finder drag into iTerm2 or Terminal.app, kitty and Ghostty drag-drop). No terminal
  hands image bytes through a paste event; OpenTUI's `PasteMetadata.mimeType` is honored if
  one ever does. `ctrl+v` reaches keywork in kitty, Ghostty, WezTerm, foot and iTerm2 (their
  paste chord lives elsewhere); Windows Terminal and most VTE terminals take `ctrl+v` as
  paste, so `/image` is the door there. The host clipboard read is OpenTUI's native backend;
  where it reports unsupported the notice points at `/image <path>`.

Open: the engine hop for images (`Agent.send` accepting a `Message` so the built `ImagePart`
rides the user turn; the TUI already hands `images` on every submission); the C7 kill-ring.

## MCP lane (2026-10-07): stopped early at the user's wrap-up call

Scope was two builds from the scope-first list: elicitation through the S1 ask queue (3pt)
and MCP OAuth to the 2026 rules (5pt). The lane was halted before either build was wired, so
only the first coherent piece landed; nothing half-built is left in the tree.

**Landed.** `engine/src/mcp/elicitation.ts` with `elicitation.test.ts` (5 tests): the pure
layer that turns an `InputRequiredResult` into typed elicitation requests and shapes the
answers back. Spec revision relied on: MCP `2026-07-28`, pages `basic/patterns/mrtr`,
`client/elicitation`, `schema`. Field names: `resultType: "input_required"`, `inputRequests`
(server-keyed map of `{ method: "elicitation/create", params }`), `requestState` (opaque,
echoed verbatim), retry params carry top-level `inputResponses` keyed like `inputRequests`
plus `requestState` (`InputResponseRequestParams`); elicitation params `mode` (`form`, or
absent meaning form, or `url`), `message`, `requestedSchema` (flat object of string /
number / integer / boolean / enum via `enum` or `oneOf` `const`, multi-select via `array` of
`items.enum` / `anyOf` `const`), `url`; answers `{ action: "accept" | "decline" | "cancel",
content? }`; client capability `elicitation: { form: {}, url: {} }` under
`_meta["io.modelcontextprotocol/clientCapabilities"]`. The module refuses sampling and roots
requests and non-http(s) elicitation URLs with the existing `McpInputRequiredError`.

**Not built.** The `McpSession.callTool` retry loop, the `elicit` option on the stdio and
http transports and the registry, the ask-gate adapter (a synthetic `ToolCallPart` through
`guard.confirm` so the TUI prompt and `GET /asks` both see it; yes accepts with schema
defaults, no declines; headless answers no), the fixture's modern-era elicitation tools, and
the whole OAuth build (401 challenge parsing, RFC 9728 and RFC 8414 discovery with the
path-aware order, CIMD then dynamic registration, PKCE S256, RFC 9207 `iss` check, RFC 8707
`resource`, refresh on 401, loopback callback on `127.0.0.1` with a random port, credentials
through E9's `SecretVault`, `keywork mcp login`, pane rows). SW12's behavior is unchanged:
`input_required` still fails with a clear message.

**Design decisions taken so far, for whoever resumes.** Tokens keyed by issuer and canonical
resource together (RFC 8707 audience makes an issuer-only key share tokens across two servers
behind one AS); DCR client credentials keyed by issuer per the spec's authorization-server
binding rule; a connection never starts the interactive flow on its own (the reconciler
retries on a timer), it fails with a sign-in hint and `keywork mcp login <server>` runs the
flow; the loopback link is printed, never opened. Wiring the handler and vault into the
registry needs one line each in `cli/src/compose.ts` (`startMcpRegistry`) and the guard
sites in `chat.ts` / `compose-panes.ts`, which are outside this lane's files; `keywork mcp`
needs a `commandNames` entry in `cli/src/dispatch.ts` and a case in `main.ts`.
