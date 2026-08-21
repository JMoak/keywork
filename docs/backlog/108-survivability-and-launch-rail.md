# Survivability & the Launch Rail — Work Plan (2026-08-21)

> **Planning overlay + ledger** (2026-08-21, wins over 107 and below where it speaks). Two
> file-disjoint lanes, both unblocked by the inference-resolution stream (107) and both
> pointed at the M2 bar: public repo at the demo, "zero-to-working in 60 seconds", exit gate =
> one keywork feature built *using* keywork. Stream 3 is the dogfooding lane (long sessions
> in panes on small-context local models); stream 4 is the launch rail (install, headless
> contract, endurance). Task ids reuse their originating overlays (C55 from 100, A19/A20 from
> 103, G3 from 90, FR1.2 from 101, IR-10/IR-14 from 105); acceptance bars below are the bar.
>
> **Standing guardrails unchanged:** Anthropic is API-key / Agent-SDK only and has no provider
> wiring before G1; Pi/OpenCode lifts carry `NOTICE` attribution; Crush is not a source; the
> user commits.

## Stream 3 — Long-session survivability in panes (the dogfooding lane)

**Why now.** Dogfooding is about to happen in panes on local models, and local models have
small context windows. The TUI turn loop has no compaction trigger (the flush latch never
re-arms outside the chat REPL), `flushAfterTurn` uses an assumed context window, and nothing
on screen says how close a session is to the edge. Every long session ends in a silent wall.
This lane also turns IR-T1's declared `contextWindow` into something real.

| Task | Pts | Scope | Cites |
|---|---:|---|---|
| **S3.1 — Compaction in the pane turn loop** | 3 | After-turn check on real thresholds (`binding.capabilities.contextWindow` ?? provider default table ?? assumed); Pi's B7 algorithm already in engine; compaction appends its entry, the flush latch re-arms, the agent rebuilds on the compacted history through the existing rebuild seam; `/compact` in panes; interrupted/busy panes defer, never compact mid-stream. | IR-04, IR-10, IR-14, A22 |
| **S3.2 — Context gauge C55 on real numbers** | 3 | PD17 cockpit: options-first (2–3 C40-rendered candidates for Jordan's pick), density-carried, thresholds = the actual flush reserve and compaction reserve, lives in the title-bar telemetry zone C64 left open; reduced-motion/monochrome fixtures. | PD17, C64 |
| **S3.3 — Declared context windows flow end to end** | 2 | `/connect` receipt and `/model` rows show `ctx: declared N \| undeclared`; `models` glob declarations reach the binding and the gauge; `keywork doctor` lists models with undeclared windows. Closes the IR-10 deviation honestly: undeclared still binds, but it is visible. | IR-10 |
| **S3.4 — `model_change`-aware cost rollups** | 2 | Per-turn cost attributed to the model in force via `model_change` entries; sessions-node row and `/cost` correct across switches; `session_cost` tests with a mid-session switch. | FR4.12 |

**Acceptance.** A 4k-context local model runs a 30-turn session in panes without a provider
error; the gauge crosses flush → compaction visibly; `/cost` after two model switches matches
a hand computation; captures approved.

**Files owned.** `tui/src/conversation-model.ts` (turn loop), `tui/src/title-bar.ts`
(telemetry), `cli/src/memory.ts`, `engine/src/session/compaction.ts`, `engine/src/pricing.ts`,
`cli/src/inference/port.ts` (row facts), new `tui/src/context-gauge.ts`.

## Stream 4 — The launch rail: packaging, headless contract, endurance

**Why now.** The release posture says the repo goes public at the M2 demo with the 60-second
screencast (install → onboarding → first turn → first undo). Onboarding is honest after 107;
install and "trust the build" are the two legs that don't exist. A20 was deliberately held
until IR-18's typed failures existed; they do now.

| Task | Pts | Scope | Cites |
|---|---:|---|---|
| **G3 — Packaging & release pipeline** | 3 | `bun build --compile` per-platform binaries (Linux primary, Windows, macOS) + npm bin fallback; tagged release workflow with SHA-pinned actions (WP-8 discipline), checksums, `keywork --version`; the G3 desktop entries from 80 (Windows Terminal profile fragment / `.desktop` / macOS shim); install instructions measured against the 60-second clock. | G3, 80, WP-8 |
| **A20 — Headless exit contract** | 2 | Stable exit codes and a JSON event schema for `keywork run`: resolution failures (IR-18 codes), interrupted, tool denied, provider error, success; `--json` schema documented and fixture-tested; non-TTY behavior table in `dispatch.ts`. | A20, IR-18, Q-DSH2 |
| **A19 — Every gate and injection as session entries** | 2 | Permission decisions and context injections already ride the bus; persist them as entries so replay, the sessions tree, and the headless stream agree; Pi-fixture compat stays byte-stable. | A19, D8 |
| **FR1.2 — Endurance soak** | 2 | `scripts/soak.ts` drives the e2e harness for N hundred turns/splits/closes on the mock provider, asserting bounded memory, no listener leaks, a frame-budget ceiling; runs in CI nightly, not on PRs. | FR1.2, C39–C43 |

**Acceptance.** A clean Linux box reaches first undo from the release artifact in under 60s
(timed, recorded); `keywork run --json` has a golden fixture per exit class; a soak of 500
turns holds RSS flat and leaves zero dangling bus subscriptions.

**Files owned.** `scripts/`, `.github/workflows/`, `package.json`, `cli/src/{run,dispatch,main}.ts`
(exit paths only), `engine/src/session/{journal,entries}.ts`, new `scripts/soak.ts`.

### Stream 4 design of record

**A19 — where the gap actually was.** `journal.ts` already persists `permission_decision` ·
`preset_change` · `mode_change` · `context_injection` · `shell_reset` as Pi `custom` entries and
`extensionState()` reconstructs them. The disagreement was upstream: only `keywork run`
announced `project-instructions`, `memory-bootstrap`, and `memory-recall` injections on the
bus; a panes agent announced skills only, so panes sessions never recorded what the model saw.
Fix: the engine `Agent` takes `standingInjections` (provenance of context already folded into
its system prompt) and announces them on the bus right before its first `turn.started`, after
every subscriber has attached; `composeAgents` and `run.ts` both pass the same list and both
journal recalls through one helper. Entry vocabulary, format version, and the Pi fixture are
untouched. A headless-answered `ask` records `gate: "headless"` (new `PermissionGate` value).

**A20 — the contract.**

| exit | class | when |
|---:|---|---|
| 0 | `completed` | the turn reached `turn.completed`; content that reports inability is still 0 (Q-DSH2 resolved: exit codes describe the harness, never the model's self-report) |
| 1 | `failed` | the turn ended in `engine.error`: provider failure after retries, tool-loop abort, internal error |
| 2 | `usage` | bad invocation: no prompt, unknown command, or `panes`/`chat`/bare `keywork` without a terminal |
| 3 | `unresolved` | inference resolution failed; the IR-18 `code` rides in the payload |
| 4 | `denied` | a tool call needed an approval nobody could give; the turn still ran to its end with that call refused |
| 130 | `interrupted` | SIGINT/SIGTERM mid-turn: `agent.interrupt()`, orphaned tool calls settled, session persisted |

**Headless `ask` posture (decision, flagged for Jordan).** A headless run has no one to ask,
so `ask` answers *no* (recorded as `gate: "headless"`) instead of the silent auto-approve it
did before; a script that wants mutations says so with `keywork run --preset open` (run-scoped,
never persisted; the E2 vocabulary, not a new flag). The exit is 4 whenever such a refusal
happened, because the harness knows the run lacked a permission it asked for even when the
model routed around it; `--json` consumers see the exact gate in `gate.permission`. Reversal is
one default; the rest of the contract stands either way.

**`--json` stream.** Single-line JSON objects, one per event, all with `type`. Every
invocation ends with exactly one `run.finished` carrying `outcome` and `exitCode`; bound runs
open with `run.started`. Bus events ride under their bus names (`turn.*`, `tool.*`,
`gate.permission`, `context.injected`, `engine.error`) with their bus payloads, so a CI script
reads the same events a pane does. `resolution.failed` (107, IR-T5) folds into
`run.finished { outcome: "unresolved", failure }`. Golden fixtures live beside `run.test.ts`,
one per exit class; the full contract is `docs/headless.md`.

**G3 — how the binaries are built.** OpenTUI 0.5.1 resolves its native library and tree-sitter
assets with `import(…, { with: { type: "file" } })`, exactly what `bun build --compile` embeds,
so a single-file binary is real (spike: Windows `keywork.exe`, 125 MB, `doctor` · `run --json`
· `help` all run from the binary). Each target is built **on its own runner** (the platform
package installed at build time is the one embedded; no cross-compile, no trust gap), then
smoke-tested there (`--version`, `doctor`) before upload. Targets: linux-x64 (primary),
linux-arm64, windows-x64, darwin-arm64, darwin-x64. A tag `v<version>` (matching
`packages/cli/package.json`) runs `release.yml`: build matrix → checksums → GitHub Release
via `gh` (no third-party release action) → a timed `install.sh` run against the published
release, printed in the job log as the 60-second measurement. `keywork --version` prints the
build-time version (`--define`) or the manifest version in dev. The npm fallback is a
generated `dist/npm/` package (`keywork` bin = bundled `main.ts` with `@opentui/core` external,
needs Bun at runtime); publishing it is gated on a repository variable so it stays Jordan's
call. Desktop entries ship under `packaging/`.

**FR1.2 — what the soak proves.** `scripts/soak.ts` is a standalone supervisor (not under
vitest, per the forensic-harness principle that a wedged suite must not hide a wedged app):
it composes the TUI through the e2e harness with a self-scripting mock provider, runs N turns,
cycles panes (split, move, `/exit`) every K turns so transcript growth can't masquerade as a
leak, and samples heap-after-GC, RSS, render time, and bus listener counts. It fails on heap
growth past a warmup baseline, on any disposed pane whose bus still has listeners, on process
fatal-guard listeners surviving quit, and on a render p95 above the ceiling. `soak.yml` runs it
nightly and on demand, never on PRs.

## Merge rules

- The lanes don't touch each other: stream 3 is TUI/engine-session/pricing; stream 4 is
  scripts/CI/CLI-exit/journal. The one shared file is `entries.ts` if A19 adds entry kinds
  while stream 3 adds compaction fields; both are additive unions; land A19 first.
- Neither waits on a decision except the gauge's options round (C40 renders, Jordan's pick,
  the C61 ritual) and the headless `ask` posture above (proceeds under the stated default).
- Runner-ups held: PD12 modes (wants E7's design session first); arcs/workspaces nodes (FR2,
  C46, J19; the lane after this one); the bots overlay (106) awaits Q-B1–Q-B7.

## Ledger

| Task | Status | Landed as |
|---|---|---|
| A19 | ✅ landed (stream 4, 2026-08-21) | `Agent.standingInjections` announced before the first `turn.started`; `ToolGuard.gate` + `PermissionGate` `"headless"`; `compose.ts` `standingInjectionsFor` / `journalingRecall` shared with `run.ts`, so panes and headless journal the same `context_injection` entries; tests in `agent.test.ts`, `compose.test.ts`, `run.test.ts`; Pi fixture untouched |
| A20 | ✅ landed (stream 4, 2026-08-21) | exit table above as `exitCodes` in `dispatch.ts` (+ `withoutTerminal` posture table, `--version`); `run.ts` `HeadlessOutcome` · `conclude` · `exitCodeOf`, `run.started`/`run.finished`, `--preset` run-scoped, SIGINT/SIGTERM → `interrupted` (130); `resolution.failed` folded into `run.finished{outcome:"unresolved"}` (amends 107 IR-T5 wording); `docs/headless.md`; golden fixture per class in `cli/src/fixtures/headless/` (`KEYWORK_UPDATE_GOLDENS=1` rewrites) |
| G3 | ✅ landed (stream 4, 2026-08-21) | `scripts/release/{targets,build,build-npm,npm-manifest}.ts` (+ tests), `release.yml` (5-target matrix built on own runners, checksums, `gh release`, timed `install.sh`, npm publish gated on `NPM_PUBLISH`), `scripts/install.sh` / `install.ps1`, `packaging/` (WT fragment, `.desktop`, macOS `.app` shim), `cli/src/version.ts` + `keywork --version`, `docs/release.md`, README quickstart. Verified locally: Windows binary 125 MB via the script, smoke `--version` ok; npm bundle installs its deps and runs. **Open:** first tag not cut yet (the 60 s measurement prints in the `publish` job); `macos-15-intel`/`ubuntu-24.04-arm` runner labels assumed; macOS launcher needs `+x` in git (`git add --chmod=+x`); npm name `keywork` availability unchecked |
| FR1.2 | ✅ landed (stream 4, 2026-08-21) | `scripts/soak.ts` + `scripts/soak/{budget,provider}.ts` (+ tests), `Scenario.agentFactory` + `Stage.renderOnce` seams in the e2e harness, `EventBus.listenerCount`, `soak.yml` nightly + dispatch. First run found a real leak: every session attachment's usage listener outlived its pane (`cli/sessions.ts` `replay`) and live panes were never released at quit; fixed (`sessionPort.release` unsubscribes via `onListen`; `paneSessions.closeAll()` in `onExit`). 500-turn run on Windows: heap 36.4 → 33.5 MB, RSS 339 → 342 MB, render p95 0.4 ms, zero residue |
| S3.1–S3.4 | ✅ landed (stream 3, 2026-08-21) | ledger in [`109-long-session-survivability.md`](109-long-session-survivability.md): engine `context-budget.ts` + `settle.ts`, `Provider.capabilities`, `/compact` · `/context` in panes, `tui/context-gauge.ts` (C55 options round open), `/model` ctx facts + `doctor` context section, per-model cost ledger; e2e `long-session` |
