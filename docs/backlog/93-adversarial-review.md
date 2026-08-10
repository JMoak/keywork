# Adversarial Review — Consolidated Findings & Parallel Work Plan

> **GO (Jordan, 2026-08-10): WP-1 + WP-2 + WP-3 land now, before the remaining
> iteration-3 tracks.** Rationale: five P0s are live under daily dogfooding, and
> workstream J (95) structurally depends on WP-1 — the protected core needs filesystem
> confinement (D), and memory's secret redaction (95/P5) needs the env allowlist (E).

> **Status (2026-08-10): wave 1 landed — WP-1 + WP-2 + WP-3 all complete, gate green (287 tests).**
> WP-1: root-jail via `tools/confine.ts` across read/write/edit, bash env scrub
> (`*_API_KEY`/`KEYWORK_*`), detached-group SIGTERM→SIGKILL (taskkill `/t` on Windows),
> settle-on-exit, live output cap, CRLF round-trip edit, non-overlapping match count
> (P0 C/D/E, P1 G, P2 15/16, sec-5).
> WP-2: interrupt repair synthesizes errored results for orphaned tool_calls before persist
> (wire-valid history, `--resume` safe), `AgentBusyError` busy-guard on `send()`,
> `ConversationModel.dispose()` unsubscribes + interrupts on pane close, usage kept on
> partial turns (P0 A/B, P1 I, P2 11).
> WP-3: mid-stream SSE errors surface as `ProviderStreamError`, hardened line parsing with
> trailing-buffer flush, set-once callId/name with synthesized ids, 1 MiB buffer/args
> ceilings, `isTransient` narrowed off bare TypeError, abortable backoff (P1 F/H/O, P2 9/10, sec-6).
> **Wave 2 landed same day — WP-4 + WP-7 + WP-8 complete, gate green (312 tests).**
> WP-4: project config layer contributes `keybindings`/`theme` only — `apiKeys`/`model` stripped
> before merge; per-field deep merge replaces the shallow clobber; theme validated `#rrggbb`;
> unreadable config is a hard `ConfigError`, never "no config"; `baseUrl` reconfirmed
> config-unreachable (P1 N, P2 17).
> WP-7: session files named `<ms>-<counter>-<pid>.jsonl` via `newSessionFileName()` (sortable,
> collision-free; also fixes run.ts persistSession); `keywork run` without a provider exits 1
> with the chat setup hint, no fabricated output; setup masks key entry (`readMaskedLine`,
> paste-safe); `saveApiKey` re-persists only schema-known validated fields (F14/15/16, eng-12).
> WP-8: CI actions pinned to resolved SHAs (checkout v4.4.0, setup-bun v2.2.0, tags as comments);
> guardrail scan widened to repo root incl. scripts/; check-pins walks all package.json and
> `findUnpinnedActions` fails CI on any non-SHA `uses:` (sec-9/10).
> Remaining: WP-5 + WP-6 (input & render wave), then iteration-3 gates (Track P, B7).

> Three hostile reviewers (engine, TUI, security), 2026-08-09, over the 158-test working tree.
> Findings deduped and cross-verified — several issues were independently found by two reviewers
> (noted). Severity: **P0** broken/exploitable now · **P1** will bite soon · **P2** debt.
> This overlays 92-iteration-3.md: it promotes Track S and reshapes the parallel batch.

## Cross-reviewer corroboration (highest confidence)

- **No filesystem confinement** — security P0-#1 + engine P2-#14 (both). Absolute paths and `..`
  accepted by read/write/edit.
- **bash unbounded buffer + weak kill** — engine P0-#2 & P2-#16 + security P2-#4/#5 (both).
- **Project-local config overrides user apiKeys/model** — security P1-#3 + engine P1-#7 (both).
- **setup echoes key in cleartext** — security P2-#7 + TUI P2-#14 (both).
- **Session files keyed by Date.now() collide/race** — engine P2-#12 + TUI P2-#15 + security P2-#11 (all three).
- **Agent keeps running after its pane closes** — TUI P0-#F1, the UI face of engine's interrupt cluster.

## Prioritized master list

### P0 — fix before more dogfooding
| # | Area | Defect | Source |
|---|---|---|---|
| A | engine | Interrupt orphans `tool_calls` (no matching tool responses) → next request 400s → **persisted, poisons `--resume` forever**. | eng-1 |
| B | tui | Closing a busy pane never interrupts its agent or unsubscribes bus listeners (`ConversationPane` has no `dispose`) → tools keep mutating repo invisibly, uninterruptible. | tui-F1 |
| C | engine | bash hangs forever on any backgrounding command (`npm run dev &`) — `close` never fires; timeout kills dead shell; Esc no-op. Uninterruptible frozen agent. | eng-2 |
| D | security | Tools not root-confined: one injected call reads `~/.keywork/keywork.json` (API key → model) or writes `.git/hooks`, `~/.ssh/authorized_keys` (code-exec persistence). | sec-1 / eng-14 |
| E | security | bash inherits full env → `printenv` returns API key to model **and persists it to session JSONL at rest**. | sec-2 |

### P1 — will bite soon
| # | Area | Defect | Source |
|---|---|---|---|
| F | engine | Mid-stream `{"error":...}` SSE events swallowed → empty successful turn → bare `{role:assistant}` → next request 400s. | eng-3 |
| G | engine | read normalizes CRLF→LF, edit demands exact bytes → **every edit of a Windows-authored file fails** in a doom loop. | eng-4 |
| H | engine | SSE `JSON.parse` unguarded: one empty/keepalive/truncated `data:` line kills a partial turn unretryably; trailing buffer never flushed (usage lost). | eng-5 |
| I | engine | `send()` fully reentrant, no busy guard → concurrent sends interleave one history; interrupt reaches wrong turn. | eng-6 |
| J | tui | Leader ignores ctrl/alt: `ctrl+k ctrl+k` (or held/repeated leader) fires focus.up; while armed `ctrl+x`→close, `ctrl+s`→split. Wrong actions from wrong chords. | tui-F2 |
| K | tui | Paste does nothing — OpenTUI emits pastes on a separate `paste` event app.ts never subscribes to. Near-P0 for a "paste an error" harness. | tui-F3 |
| L | tui | `layout.focus()` doesn't clear zoom → command-driven focus change while zoomed sends keystrokes to an invisible pane. | tui-F4 |
| M | tui | Every keypress/delta tears down and rebuilds the whole tree, re-wrapping every pane's unbounded transcript → latency ∝ session length × pane count. | tui-F5 |
| N | both | Project-local config overrides user `apiKeys`/`model` wholesale (shallow merge) → key vanishes or attacker key injected. | sec-3 / eng-7 |
| O | engine | Missing tool-call `id` → `callId:""` → 400; duplicate-index fragments concatenate names (`"bashbash"`). | eng-8 |
| P | tui | `go-<title>` names with spaces (from FilePane basenames) are suggested but unrunnable; duplicate titles jump to first only. | tui-F6 |

### P2 — debt (batched, not exhaustively tabled)
engine: `isTransient` retries any `TypeError` incl. coding bugs (eng-9); interrupt dead during retry backoff (eng-10); usage lost on interrupt/error (eng-11); SessionStore no validation, mid-file corruption truncates chain silently (eng-12); two-pane append forks parent chain (eng-13); edit overlapping-match miscount (eng-15); config: theme not `#rrggbb`-validated, EACCES swallowed, `baseUrl` trailing-slash, unconditional `stream_options`, `suggestTitle` no timeout (eng-17).
tui: palette runs arg-requiring commands with no args/no affordance (F7); help overlay non-modal (F8); pane dims use raw terminal size ignoring border+status, dock percent re-rounded (F9); no resize handler (F10); Unicode as UTF-16 units — can't type emoji, wrap shreds surrogate pairs/CJK (F11); `chordOf` ignores kitty `option` so alt-bindings dead on kitty (F12); palette selection diverges on async retitle (F13); `keywork run` with no provider fabricates a fake successful response incl. `--json` (F16).
security: bash SIGKILL escalation/process-group (sec-5); SSE size ceiling (sec-6); guardrail scan skips scripts/root (sec-9); CI actions pinned to mutable tags not SHAs (sec-10).

## Parallel work packages (disjoint file territory — safe to run concurrently)

Each package owns a distinct file set; the AppProbe harness + engine tests are the merge gate.
Every package lands with the test gap it closes.

### WP-1 · Tool confinement & bash hardening *(engine/src/tools/)* — P0 D, E, C + P2 15,16, sec-5,6
Root-jail read/write/edit (reject absolute/`..` escaping a resolved project root; allowlist opt-out later via E-stream); scrub `*_API_KEY`/`KEYWORK_*` from bash child env; bash: detached process group, SIGTERM→SIGKILL escalation, cap output during capture, settle on child exit not pipe drain, fix CRLF/exact-match (G) and overlapping-match count. **Test gap: bash process-tree + CRLF round-trip.**

### WP-2 · Agent interrupt & lifecycle *(engine/agent.ts + tui/conversation-*.ts)* — P0 A, B + P1 I + P2 11
Repair history on interrupt (drop or synthesize responses for orphaned tool_calls so it's always wire-valid, before persist); busy-guard `send()`; add `ConversationPane.dispose()` → interrupt agent + unsubscribe bus listeners; capture usage on partial turns. **Test gap: life-after-interrupt + close-mid-turn.** (Coordinate the agent.ts touch with WP-4 via clear seams.)

### WP-3 · SSE robustness *(engine/providers/openai.ts, retry.ts)* — P1 F, H, O + P2 9,10,17
Handle mid-stream error events (surface as turn error); guard `JSON.parse` (skip keepalives, tolerate `[DONE]`/no-newline, flush trailing buffer); reject/repair empty `callId` and de-dupe fragment names; size ceiling on buffer + tool-args; narrow `isTransient` off bare TypeError; abortable backoff sleep. **Test gap: hostile/degenerate SSE inputs.**

### WP-4 · Config trust boundary *(shared/config/, cli/provider.ts, main.ts)* — P1 N + P2 17
Drop `apiKeys` (and gate `model`) from the project-layer overlay; deep-merge or explicitly document layer semantics; validate theme hex; surface EACCES instead of swallowing. **Test gap: project-overlay must not touch credentials.**

### WP-5 · Keymap & input fidelity *(tui/keys.ts, keymap.ts, app.ts input)* — P1 J, K + P2 F11,F12
Leader resolution must reject modified chords (ctrl/alt) and cancel cleanly; subscribe `paste` event → route into focused pane input; kitty `option`→alt; Unicode by code point (type emoji, wrap by grapheme-ish boundaries). Also fold the four known nav quirks (Track Q) here — same files. **Test gap: leader with modifiers + key-repeat.**

### WP-6 · Render correctness & perf *(tui/app.ts, conversation-pane.ts, layout.ts)* — P1 L, M + P2 F7,F8,F9,F10,F13
`layout.focus()` clears zoom; resize handler re-renders; pane dims account for border+status; bound transcript work to visible rows (scrollback ring — pairs with Track V); modal help; palette arg affordance (or hide arg-commands). **Test gap: zoom composed with focus/move in the layout property test.**

### WP-7 · CLI & session identity *(cli/sessions.ts, run.ts, setup.ts)* — P0-adjacent + P2 F14,F15,F16
Monotonic/unique session ids (counter or pid+time, lock append); `keywork run` must error (not mock) with no provider, matching `chat`; mask key input in setup; `saveApiKey` shouldn't blindly re-persist unknown fields. **Test gap: run-without-provider exit code.**

### WP-8 · CI/supply-chain *(scripts/, .github/)* — P2 sec-9,10
Pin Actions to SHAs; extend guardrail/pin scans to scripts + root. Standalone, tiny.

## Suggested sequencing
1. **WP-1 + WP-2 + WP-3 in parallel first** (the P0/P1 safety+correctness core; disjoint files).
   These *are* Track S, expanded — the undo work (E3/E4) slots behind WP-1's root-jail.
2. **WP-4 + WP-7 + WP-8** next wave (config/CLI/CI; small, disjoint).
3. **WP-5 + WP-6** fold Track Q + Track V scrollback in (input & render; the biggest UX wins).
Merge gate for every package: `bun run check && bun test` green, new tests for its named gap.
