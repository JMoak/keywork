# Forensic stress harness — MCP lifecycle under adversarial conditions

> 2026-08-15. Design + implementation notes (analysis and plan; no code lands from this doc).
> Scope: the MCP subsystem (`packages/engine/src/mcp/*`, `packages/tui/src/mcp-pane*`) plus the
> process-hygiene machinery it shares with `tools/bash.ts`. All findings reference the current
> working tree. Cross-refs: `AGENTS.md` (quality bar), `docs/vision.md` D1/D2 (MCP in core),
> `docs/backlog/92-iteration-3.md` (MCP status), `docs/backlog/93-adversarial-review.md` (WP-1/WP-2
> precedent). Everything here is `OWN` work; the only third-party inputs are public methodology
> writeups (FoundationDB, TigerBeetle, sled, s2.dev, fast-check docs) — ideas, not code.

## 1. What we'd build

A two-tier harness that treats the MCP registry as a distributed system under attack and proves,
after every run, that the process reached a **deterministic final state with zero residue**.

- **Tier 1 — deterministic model-based fuzz (per-PR, runs in vitest).** The registry driven by
  fast-check stateful command sequences (`fc.commands` + `asyncModelRun`) against a **fake
  transport and virtual clock**, thousands of randomized enable/disable/restart/stop interleavings
  per run, with a shadow model asserting the reachable-state invariants after every command.
  Failures shrink to a minimal command sequence and replay from `{seed, path}`.
- **Tier 2 — real-subprocess forensic soak (nightly + on-demand, standalone supervisor).** A
  `bun run scripts/stress-mcp.ts` supervisor (NOT under vitest/bun:test — a wedged suite must not
  hide a wedged registry) that spawns real fixture servers from an expanded misbehavior catalog
  and runs seeded action bursts, then audits the OS: PID ledger vs live process sweep, handle
  trend, heap object counts. Crash dumps captured, not just Bun's crash URL.

The acceptance bar (verbatim from the request, all achievable):

1. Thousands of randomized restart/enable/disable sequences — Tier 1 volume + Tier 2 soak.
2. Shutdown during connect, handshake, and tool enumeration — Tier 1 scheduler interleavings +
   Tier 2 `slow-handshake` / `stall-tools-list` fixture profiles.
3. Servers that hang, crash, spawn grandchildren, or ignore termination — fixture profiles (§4).
4. Pane creation followed immediately by disposal — Tier 1 pane commands via `AppProbe`.
5. Deterministic final state after every action burst — quiescence oracle (§5).
6. Zero tracked tasks, timers, connections, subprocesses after shutdown — residue oracle (§5).
7. No monotonic handle/process growth across repeated cycles — trend oracle (§5).
8. Identical runs on Bun 1.3.9, 1.3.14, and a pinned canary — CI matrix (§7).
9. Native crash → full dump, not only Bun's crash URL — crash capture (§6).

## 2. Why it would help — the current code already has the bugs this harness exists to catch

Forensic pass over the working tree (keep this list; it is the first regression corpus):

| # | Target | Defect the harness must provoke |
|---|--------|--------------------------------|
| 1 | `client.ts:144` `StdioChannel.close()` | Never resolves if the child ignores SIGTERM: `child.kill()` once, no SIGKILL escalation, no timeout. Hangs `dropConnection` → `serve()` → `stop()`; `runClosers` (tui/lifecycle.ts:14) then `process.exit(0)` at 5 s **leaking the child**. |
| 2 | `client.ts:90` spawn | No `detached`/process-group, no `taskkill /t` — **grandchildren of MCP servers are never killed**, ever. Contrast `bash.ts:181` `killWindowsTree` which does this right; the transport should adopt the same machinery. |
| 3 | `registry.ts:497` `Wakeup` | Backoff `setTimeout` not `unref()`'d; a server parked in an 8 s backoff pins the event loop. |
| 4 | `mcp-pane.ts:39` `pending` | In-flight `load()`/`listTools()` resolve after `dispose()` and mutate the model / call `notify()` on a dead pane — no `disposed` flag, `pending` never drained on dispose. |
| 5 | `app.ts:212` `mcpDropWatcher` | Subscription never unsubscribed; its `lastStates` map (`mcp-pane.ts:22`) is never pruned — unbounded under server-name churn. |
| 6 | `registry.ts:77` `surfaces` | Keyed by returned-array identity; any caller that forgets `dropSurface` retains the view forever (per-pane agent construction at `main.ts:306` is the live risk). |
| 7 | `registry.ts` `runtime.activated` | Never cleared on disable/restart — monotonic growth across cycles. |
| 8 | `handleLoss` (`registry.ts:279`) | `restartAttempt` not reset when a *healthy* connection is lost — a flapping server walks the ladder to `retriesExhausted`. Decide intended semantics, then encode it in the model. |
| 9 | `stop()` (`registry.ts:101`) | Verbs racing `closing` in the same tick; concurrent double-`stop()` unguarded. |
| 10 | `client.ts:79` `pending` request timers | Cleared only via `settleClosed()` on child exit/error; a deliberate close with in-flight requests depends on the exit event firing. |

Items 1–2 are exactly the class of bug behind the native-crash/orphan symptoms this initiative is
reacting to, and they are invisible to the current test suite because every existing test uses
well-behaved fixtures or injected fake connections. The harness makes this whole class
unwriteable: any future lifecycle change that can leak or hang fails CI within one nightly.

**Sequencing note:** several of these are fixes-before-harness. Building the harness against known
bugs is fine (each becomes a "harness catches it" demo, then a fix, then a committed regression
example), but #1/#2 (termination escalation + tree kill in the transport) should probably land
first as ordinary work, since every Tier 2 run would otherwise wedge on them immediately.

## 3. Architecture

### 3.1 Determinism seams (prerequisite refactor, small)

The registry must never reach for ambient nondeterminism directly. Introduce injectable seams,
defaulting to the real thing so production call-sites don't change:

- `Clock` — `now()`, `sleep(ms, signal?)` → replaces the raw `setTimeout` inside `Wakeup`
  (and gets `unref` handling in the real impl, fixing #3 in passing).
- `connect` — already injectable (`McpRegistryOptions.connect`, the seam the existing tests use).
  Extend the fake-connection helpers into a proper `FakeTransport` with scriptable
  delay/drop/garbage/close-hang behavior per phase (connect, handshake, tools/list, close).
- No `Math.random`/`Date.now` in lifecycle logic today — keep it that way (lint-greppable).

This is the minimum-viable slice of deterministic-simulation testing (FoundationDB / TigerBeetle /
sled prescription): single-threaded logic + seeded inputs + virtual time behind interfaces. Full
DST (owning the event loop) is not achievable in JS userland and we don't chase it; promise-order
nondeterminism is covered by `fc.scheduler` instead.

### 3.2 Tier 1 — model-based fuzz (vitest, per-PR)

- **Dependency:** `fast-check` v4.x, exact-pinned (`check-pins.ts` will enforce). Only Tier 1
  needs it. jsverify/testcheck/jazzer are all dead; fast-check is the only living option and its
  stateful API (`fc.commands`, `fc.asyncModelRun`, `fc.scheduler`) is exactly this shape.
- **Commands:** `Enable(name)`, `Disable(name)`, `Restart(name)`, `Stop`, `ServerDrop(name)`
  (synthesized loss via the fake connection), `PaneOpen`, `PaneDispose`, `PaneKeypress(k)`,
  `AdvanceClock(ms)`, `SurfaceTake`/`SurfaceDrop`. Weight toward restart/backoff branches.
- **Shadow model:** tiny pure object per server — `{enabled, epoch-ish phase, restartAttempt,
  toolNamesActivated}` — updated in each command's `run`, compared against `registry.status()` /
  `listTools()` after every command. This is where invariants like "disable during backoff clears
  lastError" and the #8 flap-semantics decision get encoded once, authoritatively.
- **Interleaving bugs:** a second property using `fc.scheduler({act})` wrapping the fake
  transport's promises, targeting shutdown-during-connect/handshake/enumeration specifically —
  the scheduler permutes resolution order under a seed.
- **Quiescence + residue after every sequence:** run the §5 oracles (in-process subset: no live
  fake connections, no pending waiters, `Wakeup` timers cleared, pane `pending` empty, `surfaces`
  empty, listener set empty).
- **Meta-test (steal from s2.dev):** run one seed twice, diff the emitted event logs byte-for-byte.
  Catches any stray real timer or ambient nondeterminism sneaking back in.
- **Regression persistence:** fast-check's own guidance — `{seed, path}` is troubleshooting-only
  (invalidated by fast-check version bumps); shrunk counterexamples get committed via the
  `examples:` parameter or promoted to named unit tests. Committed examples ARE the corpus; no
  corpus-repo infrastructure.
- **Existing convention bridge:** the repo already hand-rolls seeded-LCG op walks
  (`mcp-pane-model.test.ts:434`, `gating.test.ts:19`, etc.). Tier 1 supersedes that pattern for
  the registry; the pane-model LCG walks stay as-is.

### 3.3 Tier 2 — real-subprocess forensic soak (standalone supervisor)

`scripts/stress-mcp.ts`, run as `bun run` directly — **not** under vitest (vitest under the Bun
runtime is broken — tinypool/worker issues) and not under `bun:test` (single sequential process;
one wedged `exited` promise stalls everything). Shape:

- **Supervisor/worker split.** The supervisor spawns each scenario as its own child
  `bun stress-worker.ts --seed N --profile X` with `timeout` + `killSignal: "SIGKILL"`, races
  `exited` against a wall-clock deadline, and does OS-level cleanup itself. A hung worker is a
  *finding* (recorded with its seed), never a stuck run.
- **Seeded action bursts.** Hand-rolled seeded PRNG (repo's LCG convention) generating action
  sequences — deliberately NOT fast-check here: with real OS scheduling and pipe buffering,
  fast-check's shrinker produces bogus minimal counterexamples. The seed reproduces the *scenario*
  (sequence + profile + timings), not the interleaving; that's the honest contract.
- **Burst structure:** N cycles of {spawn registry with K fixture servers of mixed profiles →
  seeded verb burst → `stop()` with deadline → forensic audit → assert clean}. Cycle count is the
  axis for the monotonic-growth assertions.
- **Watchdog on every await.** Any registry promise (`stop()`, verb settle) is raced against a
  deadline; deadline breach dumps the supervisor's view (ledger, last actions, seed) and hard-kills.
- **Failure artifact:** JSON per failure — seed, profile mix, action trace, `Bun.revision`,
  ledger diff, paths to any dumps. Written to `stress-artifacts/`, uploaded on CI failure.

## 4. Fixture-server misbehavior catalog

`fixture-server.ts` already has: `basic` (incl. paginated tools/list), `silent` (never responds,
60 s keep-alive), `crash-once`, `hazard` (blast/boom), `garbage` (non-JSON, split frames). Add:

| Profile | Behavior | Targets |
|---|---|---|
| `ignore-term` | Traps/ignores SIGTERM (and on Windows just never exits on stdin close); only dies to SIGKILL/taskkill | #1 close-hang, termination escalation |
| `spawn-grandchildren` | Spawns 2–3 children (which touch a marker file on exit) then serves normally | #2 tree kill; ledger proves grandchild death |
| `slow-handshake` | Sleeps a scriptable delay before the initialize response | shutdown-during-handshake |
| `stall-tools-list` | Handshake fine; `tools/list` never responds (or responds after long delay) | shutdown-during-enumeration; `openConnection`'s close-on-listTools-throw path |
| `flap` | Serves, then self-exits after a scriptable interval, repeatedly | #8 backoff-reset semantics |
| `exit-race` | Responds to shutdown but exits without flushing / closes stdout before stdin | Bun stdio-teardown bug class (upstream #11892/#33020 shape) |
| `huge-catalog` | Thousands of tools, deep pagination | catalog/memory pressure, `activated` growth |

Profiles stay in the one fixture file, selected by argv, marker files for observability — the
existing pattern. This catalog is genuinely novel ground: surveyed MCP/LSP ecosystems (official
MCP TS SDK, Cline, opencode, vscode-languageserver-node) and none ship a misbehaving-server
fixture or a lifecycle stress suite. vscode-languageserver-node's *bug history* is a ready-made
scenario source (stop-hangs-when-server-crashes-mid-shutdown, double-registration after
crash-restart, restart-budget storms) — fold those into the action generator.

## 5. Oracles — what "clean" means, mechanically

**Critical platform fact (verified): Bun stubs Node's entire handle-introspection surface.**
`process.getActiveResourcesInfo()` / `_getActiveHandles()` return `[]` always; `async_hooks`
hooks never fire. Therefore `why-is-node-running`, `wtfnode`, and vitest's `hanging-process`
reporter are all useless here. The oracles below are what actually works under Bun:

1. **Quiescence (determinism):** after each burst + `stop()`, `registry.status()` and the model
   must match a state computed purely from the seed's action sequence; two runs of the same seed
   produce identical event logs (Tier 1 byte-for-byte; Tier 2 same final state + same status
   sequence modulo timing).
2. **PID ledger + CIM sweep (primary subprocess oracle, Tier 2):** record `{pid, CreationDate}`
   at every spawn (fixture servers self-report grandchild pids via marker files). At audit:
   recursive `Get-CimInstance Win32_Process -Filter "ParentProcessId=…"` sweep from the worker's
   pid, plus lookup of every ledgered pid **matched against CreationDate** (PID-reuse guard).
   Assert empty; `Stop-Process -Force` stragglers individually and fail the run. POSIX analogue:
   process-group scan via `ps -o pid,ppid,lstart`.
3. **Windows Job Object (upgrade, decision needed):** `KILL_ON_JOB_CLOSE` makes orphans
   *impossible* rather than merely detected; neither Node nor Bun exposes Job Objects, but ~40
   lines of FFI via `koffi` does, and koffi works under Bun. This is a new exact-pinned native
   dependency — propose it as its own small decision (likely worth it: it also hardens production
   `bash.ts` and MCP spawns, not just tests). The CIM sweep then regression-tests the job wiring.
4. **JS-object growth:** `bun:jsc` `heapStats().objectTypeCounts` diffed after `Bun.gc(true)`
   between cycle k and cycle 2k — assert no unbounded growth in `Subprocess`, stream, timer, and
   our own class names. Escalation path: `Bun.generateHeapSnapshot("v8")` on breach.
5. **Handle-count trend (secondary, trend-only):** `(Get-Process -Id $pid).HandleCount` sampled
   per cycle. Noisy by nature (GC, threadpool) — flag only monotonic growth across ≥5 consecutive
   samples beyond ~100-handle tolerance; never single-sample assertions.
6. **In-process residue (Tier 1 + end of every Tier 2 worker):** registry `runtimes` loops all
   settled, `listeners`/`surfaces`/waiters empty, no live `Wakeup` timer, pane `pending` empty,
   fake-transport open-connection count zero.

## 6. Crash capture — beyond Bun's crash URL

Verified behavior that shapes the whole design: **Bun installs a first-chance vectored exception
handler** for ACCESS_VIOLATION / ILLEGAL_INSTRUCTION / STACK_OVERFLOW, prints the bun.report
trace-string URL, then `ExitProcess(3)` — the exception **never becomes second-chance**, so WER,
AeDebug, and plain `procdump -e` see *nothing* for Bun's own native crashes. Also verified:
ProcDump cannot follow child processes at all. Hence a split strategy:

- **For arbitrary child processes (MCP servers, node.exe, etc.): WER LocalDumps** — one registry
  key (`HKLM\...\Windows Error Reporting\LocalDumps`: DumpFolder, DumpType=2, DumpCount), kernel-
  side, automatically covers **all descendants**, no per-process attach. This is the default,
  always-on layer in the stress CI job.
- **For Bun itself: harvest bun.report first** (exit code 3 + stderr URL captured into the failure
  artifact — the URL encodes the trace), and on recurrence escalate to a **first-chance ProcDump
  wrapper**: `procdump -accepteula -ma -e 1 -f ACCESS_VIOLATION,ILLEGAL_INSTRUCTION,STACK_OVERFLOW
  -x C:\dumps bun.exe stress-worker.ts …` — first-chance is the only thing that beats Bun's VEH.
  ProcDump is not preinstalled on GitHub windows runners (`choco install procdump`); heap
  corruption (0xC0000374) and `__fastfail` still reach WER even in Bun.
- **Never `procdump -i`** (AeDebug registration suppresses WER LocalDumps — the two are mutually
  exclusive; LocalDumps is the better default).
- **Triage in CI:** `cdb.exe` ships on the runner images (WDK path, not on PATH):
  `cdb -z crash.dmp -y "srv*…*https://msdl.microsoft.com/download/symbols" -c "!analyze -v; ~* k; lm; q"`
  into the job summary; dumps + artifacts uploaded via `actions/upload-artifact` on `failure()`.
- Bun's crash handler is being rewritten (Zig→Rust on main) — re-verify the VEH behavior whenever
  the pinned Bun moves.

## 7. Bun version matrix

- Add `.bun-version` = `1.3.9` (current CI pin; repo has no engines/packageManager field today)
  and switch `ci.yml` to `bun-version-file`. Exact-pin fits `check-pins.ts` culture.
- Stress workflow matrix: `["1.3.9", "1.3.14"]`, `fail-fast: false`, both OSes for Tier 1;
  Tier 2 initially windows-latest + ubuntu-latest nightly.
- **Canary cannot be pinned via setup-bun's version input** — `canary` is a single moving tag
  whose assets are replaced per-commit. To satisfy "a pinned canary": download a chosen canary
  zip once, archive it (repo release asset or cached URL), and install via setup-bun's
  `bun-download-url`. Record `bun --revision` (e.g. `1.4.x-canary.N+<sha>`) in every artifact and
  the job summary — it's the only repro handle. `bunx bun-pr <commit>` reproduces a specific
  upstream build locally when chasing a canary-only failure. Canary job: scheduled,
  `continue-on-error: true` (signal, never a gate).

## 8. CI shape — and how it stays top-tier

- **Per-PR (blocking):** Tier 1 with default `numRuns` (~seconds), meta-test, committed examples.
  Runs inside the normal `bun test` gate.
- **Nightly (non-blocking alert):** Tier 2 soak, large cycle counts; Tier 1 rerun with a big
  `numRuns` budget (fast-check's fuzzing guidance: one property per process, huge budgets, catch
  and log). This is the ClusterFuzzLite shape: cheap PR fuzz + scheduled deep batch.
- **Weekly canary job** per §7.
- **Flake policy (the part that keeps it top-tier):** in this subsystem a nondeterministic failure
  IS the bug — **no blanket auto-retry on the stress lane, ever**. Every failure ships a
  self-contained repro artifact (seed + trace + revision). Quarantine only after a deterministic
  replay attempt is recorded, with an owner and an expiry; quarantined = still running,
  non-blocking, visible.
- **Ratchets:** each fixed defect from §2 lands as a committed example/named test; the harness's
  own determinism is guarded by the meta-test; `check-guardrails.ts`-style grep can forbid raw
  `setTimeout`/`Date.now` in `src/mcp/` once the Clock seam exists.
- **Skip list (evaluated, rejected):** Antithesis (paid hypervisor DST — overkill), coverage-
  guided fuzzing in JS (jazzer.js discontinued 2024, no living option; use weighted generators
  instead), `@fast-check/worker` (solves hung predicates, not hung subprocesses), MCP validators/
  Inspector (target servers, not client lifecycle), corpus-repo infra (committed `examples` are
  the corpus), vitest-under-Bun for the stress lane.

## 9. Implementation plan sketch (for the eventual backlog entry — next free overlay: 97)

1. **(pre) Transport hardening** — SIGTERM→SIGKILL escalation + timeout in `StdioChannel.close()`;
   tree kill for MCP children (lift the `bash.ts` `killTree` machinery into a shared module).
   Fixes §2 #1/#2 so Tier 2 can run at all. ~2pt.
2. **Seams** — `Clock` injection, `Wakeup` on the clock + unref; `FakeTransport` with scriptable
   phase behavior grown from the existing test helpers. ~2pt.
3. **Tier 1** — fast-check (exact-pinned), commands + shadow model + scheduler property +
   meta-test + residue oracle; encode §2 #4–#10 as invariants/examples. ~3pt.
4. **Fixture profiles** — §4 table. ~2pt.
5. **Tier 2 supervisor** — worker split, seeded bursts, watchdogs, PID ledger + CIM/ps sweep,
   heapStats + handle trend, failure artifacts. ~3pt.
6. **CI wiring** — `.bun-version`, stress workflow (matrix, nightly, canary via archived zip),
   WER LocalDumps step, ProcDump escalation path, cdb triage, artifact upload. ~2pt.
7. **(decision) Job Objects via koffi** — separate proposal; benefits production spawns too. ~2pt.

Accept criteria for the overlay = §1's nine-point bar, verbatim, each mapped to its oracle.

## 10. Source index

FoundationDB testing/Flow docs · TigerBeetle VOPR doc + "tale of four fuzzers" · sled
simulation guide · Phil Eaton DST notes · s2.dev DST (meta-test) · Resonate TS SDK (`sim/`,
`dst.yml`) · fast-check v4 docs (model-based, scheduler, fuzzing, `examples` persistence,
discussion #4406) · Bun Node-compat docs (introspection stubs) · Bun `crash_handler.zig`
(VEH → `ExitProcess(3)`) · Bun issues #33020/#11892/#16994 (stdio teardown/zombies) ·
ProcDump docs (no child-follow; `-i` vs LocalDumps) · WER LocalDumps docs · MS Job Objects
docs + koffi · oven-sh/setup-bun (canary tag semantics, `bun-download-url`) ·
vscode-languageserver-node PR #715 / issue #211 / cpptools #6856 (scenario catalog) ·
MCP TS SDK issue #2023 (`StdioClientTransport.close()` orphans — the exact bug class, upstream).
