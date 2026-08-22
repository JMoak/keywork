# Code Audit 2026-08-22: Findings and Work Plan

> **Audit overlay + work plan** (2026-08-22). Read-only pass over the whole tree (66k lines of
> TypeScript, 347 files, the docs corpus, scripts, CI). Where this file names a defect or a task it
> is the record; it changes no decision in `105`/`108`/`110` and below. Standing guardrails
> unchanged: Anthropic is API-key / Agent-SDK only, Crush is not a source, the user commits.
>
> **How it was run.** Fourteen territory auditors (Opus for the code territories, Sonnet for the
> two mechanical sweeps) each read every non-test file in one slice and wrote a full report. The
> synthesis below was written by the lead after reading all fourteen and re-checking the headline
> claims against the tree. Every P0 and most P1s were reproduced by the auditor with a script
> against the real module, or re-read by the lead at the cited lines; the few that were not are
> marked `(report)`. Two auditor findings were dropped as wrong and one reframed, see "Skepticism
> ledger". The raw reports (about 6,000 lines, with file:line detail and repro notes for every
> item below) live at `artifacts/audit-2026-08-22/01-engine-core.md` through `14-test-health.md`
> (gitignored; copy them out if a fix wave needs them as a durable reference).

> **Status (2026-08-22, same day): Waves A and B LANDED; gate green (`bun run check` clean,
> `bun run test` 158 files / 2263 tests, up from 151 / 2052; native `bun test` 2263 / 0 fail;
> `bun run e2e` 11/11).** Five new tests were made runner-agnostic by adding disk/scheduler seams
> (`writePrivateFile(file, contents, disk?)`, `TrustStoreOptions.disk`,
> `SessionTreePaneSeams.scheduleFrame`) instead of vitest-only mocking; `arcs-pane.ts` still uses
> the raw `setTimeout` frame pattern and should take the same seam in Wave C. Ten Fable agents on disjoint
> territories, each re-verifying the auditor's claim before fixing; lead reconciled. Every row in
> Wave A (A1-A18) and Wave B (B1-B7) is done, plus E-01 (all 34 code/test/script em dashes gone:
> a U+2014 grep over `packages` and `scripts` is empty). Decisions taken by the lead and flagged for Jordan:
> **deny wins** in the bash matcher (A11; schema text updated, one tie-break test rewritten);
> `writeWorkspaceDeclaration` refuses to declare above an existing inner workspace (write-side
> guard, PD11.3 open semantics untouched); ARM64 Windows install refuses with a message rather
> than falling through to x64; the release `check` job runs `bun run test`. Notable API changes
> other code consumes: `SessionAttachment.append` returns an `AppendReceipt` (`{ entryId }`),
> `turn.started` carries an optional `entryId`, `ConversationPorts.forkAtPrompt(promptId)`,
> `attachOnFork(trees, sessions, sessionEscrow(sessions))`, `sessionsCommand(args, dir, io)`,
> `HeadlessOutcome.interrupted.saved`, `RunOptions.workspaceSlug`, `WorkspaceSlot.problem`,
> `McpRegistry.surface` is now a live view (the registry holds no reference; `dropSurface` is
> gone), `DiagnosticsLog.open(file, { onWriteFailure })`, `EventBus` generic requires an
> `engine.error` event, `PaneBorderTheme` includes `borderFocus`, `focusLift(hex, focusHex)`,
> pane-model `handleKey(chord, pageRows, sequence?)`, `picker-keys.ts` exports
> `isPrintable(chord, sequence)`, `ArcOpenQuestionsOptions` is `{ store, now?, cap? }`,
> `MemoryStore` gains `reservedPaths` / `readReserved` / `writeReserved` / `listReserved` and
> `vault-files.ts` (`writeFileAtomic`, `isMissingFileError`), `Scenario.goldens` replaces
> `{ golden: true }` captures, guardrail patterns live in `scripts/guardrail-patterns.json`.
> Two auditor claims were corrected during the wave: `arc-commands.test.ts:62`'s `flush()` waits
> on the arc port's promise chain, not the escrow macrotask; `ghp_` tokens were only caught by the
> entropy path when they happened to contain a digit. Left for Wave C, noted here so it is not
> lost: the `surface` live view is a `Proxy` impersonating an array (works, but `Agent` reading
> tools through a function would be plainer); `conversation-model.ts` keeps its own `isPrintable`
> until the dedupe; `fixture-server.ts` still lives in `src/`; the `memory/index.ts` barrel does
> not yet re-export `PathOutsideVaultError` / `ReservedPathError` / `InvalidDailyDateError`;
> `focusOrOpen` in the session-tree and arcs panes still calls `openSession` after a false
> `attach` (the core now refuses with a notice, so only the notice is redundant).

## The short version

Statement-level quality is genuinely high and consistent across every package: 175 non-test
files carry 13 comment lines total (six sites, four of them irreducible platform constraints), no
`as any`, no non-null assertions, strict TypeScript everywhere, and tests that assert behavior.
The house rule from `AGENTS.md` is being lived, not just written down. Several territories earned
an unprompted "best-written code I would expect to find" from their auditor (memory kernel, MCP
lifecycle, layout geometry, wire codecs, trust boundary).

The failures cluster in three shapes that the statement-level discipline does not protect against:

1. **Boundaries are unguarded.** A throwing bus listener wedges the agent as busy forever; the
   root jail is lexical so a symlink or junction escapes it; the persistent shell has no child
   `error` handler so an unspawnable shell takes the process down; the memory store will approve a
   staged write to any path; two stores (session JSONL, memory vault) have no write serialization
   and lose data under overlapping calls; a dozen bare `catch {}` sites erase the difference
   between "absent" and "corrupt".
2. **The TUI grew by copy.** Six row-list models, five panes over them, three pickers and the
   tray each re-implement one 60-line skeleton; `visibleRows` is byte-identical in all six. About
   570 lines of the TUI is a near-verbatim copy of another TUI file. `app-core.ts` (99 methods),
   `app.ts` (542 lines of view code), `conversation-model.ts` (twelve responsibilities) and
   `layout.ts` (six) are the four God files.
3. **Parallel mechanisms for one job.** Two shell drivers, two human-approval queues in memory,
   two loaders for `keywork.json` (one of which can erase it), `run.ts` rebuilding what
   `compose.ts` already composes (so headless silently lost skills, linked dirs and arc recall),
   `Theme` duplicating `FlavorTokens`, three `globMatches` with two semantics.

Docs are the em-dash reservoir (1,932 of 1,965 occurrences); source, tests and scripts together
hold 34 lines. The tooling that keeps the project honest (`scripts/`) is the only code compiled by
nobody, and the e2e pack never runs in CI.

## Skepticism ledger

What the lead checked, downgraded or dropped after reading the auditors' claims:

- **Dropped:** "a provider's `defaultModel` never outranks its model list" (providers P1-3).
  IR-07 in `105` has no provider-default rung and says resolution "never chooses by registry
  order"; IR-19 says even a sole reported model needs explicit selection. The registry is doing
  what the contract says. What remains is a naming tension: built-ins carry a `defaultModel` that
  only matters while the catalog is empty. Listed under questions, not defects.
- **Reframed:** "deny never beats a longer allow in the bash matcher" (shared P1). True, and
  verified by running it, but `schema.ts:190` documents "the most specific matching pattern wins".
  This is a policy decision for Jordan (deny-wins is what every comparable engine does), recorded
  as A-21 with a decision flag rather than as a plain bug.
- **Corrected:** "app-core.ts has no direct test" (test-health). It has no sibling file; it is
  exercised by eight test files through `AppProbe`. Not a coverage gap. Likewise `naming.ts` is
  covered through `store.test.ts` (one auditor said "its own tests", another said "zero tests";
  both were off).
- **Verified by re-reading the tree:** A-01, A-02, A-04, A-07, A-08, A-11, A-17, A-19, A-24,
  A-26, A-29, A-30, A-31, A-32, A-34, A-36, A-39, A-41, A-43, A-44, A-45, A-46, A-47, A-49, the
  four orphan goldens, the NUL bytes in `graph.ts`, `frameWrap` having no caller, the `theme`
  catchall. Everything else marked `(repro)` was executed by the auditor against the real module;
  `(report)` means read-only confirmation by the auditor, not re-checked by the lead.

## Defects

Severity: P0 = data loss, jail escape, or process death reachable today; P1 = user-visible wrong
behavior or latent data loss; P2 = hardening, drift, or a contract gap. Ids are `A-nn`.

### P0

| Id | Where | What | Evidence |
|---|---|---|---|
| A-01 | `engine/src/agent.ts:101-104` | `announceStandingInjections()` and `bus.emit("turn.started")` run before `send`'s try/finally, so one throwing listener leaves `active` set: every later `send` throws `AgentBusyError`, injections are lost | repro + lead |
| A-02 | `engine/src/tools/confine.ts` | `confinedPath` is `resolve`+`relative` only, no `realpath`; a symlink or Windows junction inside the root reads and writes outside it, `write` will `mkdir` outside too | repro on Windows + lead |
| A-03 | `engine/src/tools/shell-session.ts:83-148` | no `child.on("error")` (bash.ts has one); an unspawnable shell is an uncaughtException and `run()` never settles | repro |
| A-04 | `engine/src/memory/store.ts:288,476,689` | `approve` writes wherever the staged sidecar's `target` says; `.staging/` is attacker-influenced by design; `../outside.md` was written | repro + lead |
| A-05 | `engine/src/session/store.ts:230-243` | `appendEntry` reads `leaf` before awaiting disk I/O with no write queue; two overlapping appends become siblings and one drops off the active path. Reachable: `tapJournal` (main.ts:424) writes during a turn while `app.ts:1020` appends messages | repro |

### P1

**Engine core and providers**

| Id | Where | What | Evidence |
|---|---|---|---|
| A-06 | `engine/src/bus.ts:37-41` | `emit` has no listener isolation: one throw skips later listeners and turns a successful turn into a rejected `send` | repro |
| A-07 | `engine/src/agent.ts:120-128` | a mid-stream provider failure discards the partial assistant message; history becomes `user, user, assistant` on retry (the interrupt path keeps and repairs, this path does not) | repro + lead |
| A-08 | `engine/src/diagnostics.ts:40-42` | one failed `appendFile` leaves `pending` rejected forever; every later log line is dropped silently | repro |
| A-09 | `engine/src/tools/confine.ts:8-31` | `normalizeScope` re-runs `toolScope`, which always prepends `cwd`; a `ToolScope` narrower than its cwd is silently widened | repro |
| A-10 | `cli/src/inference/connections.ts:276` | `connectionConfigOf` emits only endpoint/protocol/credential/insecureTransport, and `persistDraft` replaces the entry; a `/connect` re-save erases hand-written `models` and re-enables a disabled connection | lead |
| A-11 | `cli/src/codex-login.ts:330-342` | `spawn("cmd", ["/c","start","",url])` leaves the URL unquoted; `cmd.exe` splits at `&`, the browser opens a truncated authorize URL and the rest runs as commands | repro + lead |
| A-12 | `cli/src/inference/runtime.ts:243`, `codex-login.ts:63` | OAuth refresh is not single-flighted; two concurrent streams past the skew window both redeem the same rotating refresh token | report |
| A-13 | `cli/src/auth-store.ts:34,48`, `inference/observations.ts:29` | read-modify-write with plain `writeFile`; a crash mid-write truncates `auth.json` and every saved key with it | report |

**Session, MCP, memory**

| Id | Where | What | Evidence |
|---|---|---|---|
| A-14 | `engine/src/session/compaction.ts:57-79`, `entries.ts:153-163` | `firstKeptEntryId` is chosen in context order but resolved in physical order; a second `/compact` re-admits the old summary after the newest message and folds almost nothing | repro |
| A-15 | `engine/src/mcp/registry.ts:129-137` | `surface()` pins every agent tool array in a map; `dropSurface` is called only from a test, so every agent rebuild (model change, subagent, post-compaction swap) leaks | report |
| A-16 | `engine/src/memory/redaction.ts:11-38` | the entropy heuristic needs upper+lower+digit, so AWS `AKIA…`, Slack `xox*`, `npm_…`, PEM bodies and `scheme://user:pass@host` reach disk | repro |
| A-17 | `engine/src/memory/store.ts:265,459` | no mutation serialization; three concurrent `appendDaily` calls left one entry on disk while the ledger recorded three, so two ledger rows are permanently `needs-rebase` | repro + lead |
| A-18 | `engine/src/memory/store.ts:483`, `inbox.ts:128`, `ask-gate.ts:77`, `arcs/registry.ts:182`, `arcs/questions.ts:185` | every persistence site is a bare `writeFile`; no atomic helper exists in the package ("files are truth" makes torn writes the failure that matters) | report |
| A-19 | `engine/src/memory/arcs/registry.ts:138,180`, `questions.ts:182` | `arcStore(slug)` builds a fresh `MemoryStore` per call so its ledger is garbage the moment the expression ends; MOC and question writes bypass the ledger entirely. Invariant 3 ("one-key revertable") is false for the arc layer | lead |
| A-20 | `engine/src/memory/store.ts:565`, `gardener.ts:184,292` | `walk` does not exclude `MOC.md` / `questions/*` inside an arc store; the airlock filters them ad hoc, the gardener does not, and `distillDailyLogs` runs a full sweep against the arc store. Exploit path (supersede the MOC) traced, not executed | report, path unverified |
| A-21 | `shared/src/trust/permissions.ts:18-36` | `mostSpecific` ranks on literal length only; `{"git push*":"allow","*--force*":"deny"}` allows `git push --force` in either order. **Decision needed:** schema documents most-specific-wins | repro + lead |
| A-22 | `engine/src/memory/ask-gate.ts:116-124` | bare `catch` on read returns an empty state, caches it, and the next `record()` overwrites the real ledger; EACCES/EBUSY on Windows resets "stop asking" silently | report |
| A-23 | `shared/src/config/workspace.ts:81-104` | `listWorkspaces` throws on the first corrupt named declaration; the workspace picker hard-fails with no in-app recovery | repro |

**CLI**

| Id | Where | What | Evidence |
|---|---|---|---|
| A-24 | `cli/src/user-config.ts:27-37` | `readKnownConfig` returns `{}` when `keywork.json` fails validation and `updateUserConfig` writes `mutate({})` back; one bad field lets `keywork connect` or a preset change erase the whole user config | lead |
| A-25 | `cli/src/main.ts:84`, `dispatch.ts:70` | unknown flags throw a raw `TypeError` stack and exit 1 (headless contract says usage exit 2); `--help`/`-h` are not commands, so `keywork --help` refuses or throws | repro |
| A-26 | `cli/src/main.ts:84-98,241-246`, `sessions.ts:194` | `parseArgs` eats `--json` before `sessionsCommand` looks for it; `keywork sessions list --json` prints prose. The unit test calls the function directly and passes | repro + lead |
| A-27 | `cli/src/run.ts:159-166` | five teardown awaits sit unguarded in `finally`; one rejection replaces the outcome and skips `conclude`, emitting zero `run.finished` lines against a contract of exactly one | report |
| A-28 | `cli/src/arcs.ts:98-106`, `engine/memory/arcs/airlock.ts:179,198` | close/abandon release bindings only in the in-memory `ArcBindings`; no `arc_binding` release is appended to any session, so the next launch re-binds every session to the closed arc and flushes keep routing into it | lead |
| A-29 | `cli/src/main.ts:276-279` | `void openPanes(slug, switchTo)` inside `new Promise`: any rejection from `composeWorkspace`/`runApp` is swallowed and `launchPanes` never settles (hang) | lead |

**TUI**

| Id | Where | What | Evidence |
|---|---|---|---|
| A-30 | `tui/src/app-core.ts:589-593` | `handlePaste` returns when any overlay is open and no overlay model has a paste path; an API key cannot be pasted into `/connect` | lead |
| A-31 | `tui/src/app-core.ts:595-602` | any mouse-down dismisses the preset/model/arc/workspace/connect overlays; rows render as selectable, clicking one discards the overlay (and a half-typed credential) | lead |
| A-32 | `tui/src/app.ts:201-203,290-304`, `session-tree-pane.ts:214-222` | a resume whose attachment is missing wires nothing: no `sessionId`, no persistence, no arc binding, and `focusOrOpen` discards `attach`'s boolean so the tree opens a duplicate pane on every click | lead |
| A-33 | `tui/src/conversation-model.ts:755`, `backtrack.ts:12` | backtrack ordinal counts transcript `user` entries; `promptAnchor` counts session-tree user messages; replay skips flush prompts and renders compaction summaries as `user`, so after any flush or compaction esc-esc-enter forks at the wrong prompt and `restoreForkedFiles` restores the wrong checkpoint | lead |
| A-34 | `tui/src/conversation-model.ts:863-865` | the mutation ask matches `chord.name` only; `ctrl+a` is unbound and reaches the pane, silently setting session-wide `alwaysAllow` | lead |
| A-35 | `tui/src/conversation-model.ts:981-991,430` | streaming appends to `last.text` in place and the wrap cache keys on text, so every delta re-renders the whole accumulated message through `renderMarkdown`: quadratic per turn on the hot path | report |
| A-36 | `tui/src/chroma.ts:94` | `focusTarget` is a module constant from `keyworkNight.borderFocus`; every other flavor gets night-purple focus borders at Lc 33-38 against a declared floor of 40 (measured on `first-light`) | repro + lead |
| A-37 | `tui/src/pane-tasks.ts:31` | `(cause as Error).message` inside the catch throws on a non-Error rejection: unhandled rejection, leaked `pending` entry, pane never repaints, `settled()` rejects | repro + lead |
| A-38 | `tui/src/browser-model.ts:309`, `session-tree-model.ts:284`, `arcs-pane-model.ts:359` | three local `isPrintable(chord)` append `chord.name`, which `keys.ts:65` lowercases; session-tree labels cannot contain a capital, multi-char key names are dropped, browser filter cannot contain a space. The correct `isPrintable(chord, sequence)` exists at `conversation-model.ts:1208` | lead |
| A-39 | `tui/src/arcs-pane.ts` (346 lines) | never constructed by any test; refresh timer, dispose, mouse mapping and both render levels are dark. `FilePane` is stubbed everywhere too | lead |

**Scripts, CI, installers**

| Id | Where | What | Evidence |
|---|---|---|---|
| A-40 | `tsconfig.json`, `packages/*/tsconfig.json` | `scripts/` is in no project, so `tsc --build` compiles none of the tooling; real errors hide there now (`e2e/live.ts:83` resolves to `keyof never`, leaving `agentFactory` as `unknown` and three implicit `any`; `harness.ts:124` cannot resolve `@opentui/core/testing`) | repro + lead |
| A-41 | `.github/workflows/ci.yml` | nothing runs `bun run e2e`; the 12-scenario pack and every golden are unverified in CI. Consequence already committed: four orphan goldens in `scripts/e2e/goldens/discovery/` (golden identity is keyed by capture ordinal, `--update-goldens` never prunes) | lead |
| A-42 | `scripts/check-pins.ts:6` | `.claude` is not excluded, unlike biome and check-guardrails; 48 of 54 manifests scanned are agent worktree copies | lead |
| A-43 | `scripts/check-guardrails.ts:21-26,48` | bypass surface: four-extension allowlist, `docs/` excluded, two files self-exempted whole, walk rooted at `cwd`, proximity patterns defeated by ordinary layout, the "no provider wiring before G1" sentence not enforced, and zero tests on the walk where all of that lives | lead |
| A-44 | `scripts/install.ps1:44-46` | reads the user PATH expanded and writes it back as `REG_SZ`, freezing `%VAR%` entries and downgrading the value type; no `WM_SETTINGCHANGE`; null PATH yields a trailing `;` | lead |

### P2 (by area, counts, headline items)

Full lists with file:line are in the raw reports; the items below are the ones worth planning.

- **Engine core (6):** duplicate `bus.on(fn)` collapses to one entry; `SentinelScanner.buffer` unbounded on newline-free output; `bash.ts` spawns before honoring an already-aborted signal; `redactSecrets` recursion has no cycle guard; `Agent.history()` hands out the live array; settle-after-exit leaves the process group alive by design but unrecorded.
- **Providers (7):** SSE size ceiling checked before draining complete lines; null body throws a plain `Error` that `isTransient` cannot classify; retry has no jitter, ceiling, or `Retry-After`; responses protocol treats `response.incomplete` as success and drops refusals; malformed tool arguments pass through as a raw string in three places; `lastFailure` is modeled and rendered but never written; `Object.freeze` on the binding is shallow.
- **Session/MCP (9):** flush failures swallowed with no notice; malformed mid-file JSONL lines truncate the context prefix silently; `create`/`clone` append onto an existing file; replay's flush latch can eat a real assistant message after a crash; MCP stdout buffer unbounded; `tools/list_changed` ignored so the catalog goes stale; `enable()` resolves before the server is up; branch selection not durable across reopen; `reserveTokens` is a dead field carried through four layers and asserted by a test.
- **Memory (3 + minors):** `readDaily` interpolates its argument into a path (gated upstream today); `graph.ts` holds four raw NUL bytes as string separators so ripgrep treats the file as binary and every repo-wide search silently skips it; the ledger keeps full before/after content for the process lifetime; the embedding cache field named `hash` holds the full text and never evicts.
- **Shared (4):** `writeWorkspaceDeclaration` checks only upward so an outer declaration bricks inner ones; `updateWorkspaceDeclaration` skips the slug guard its siblings have (`../..` reads outside the root); `config?.tools?.[name]` leaks prototype keys (`constructor` returns a function typed as `PermissionAction`, which at `agent.ts:229` suppresses the default posture and falls through to granted); trust-file writes are not atomic; `TrustStoreOptions.home` overrides the blanket check but not the file path.
- **CLI (10):** `--workspace` silently dropped by `run` and `chat`; headless gets a narrower tool scope and no skills than panes; the interrupt notice claims a save that did not happen; headless JSONL order differs from panes; Windows path identity not case-folded in `paths.ts` while trust and anchor identity are; `chat`'s mutation guard fails open without a TTY; three different answers for "bad subcommand"; seven silent catches in `sessions.ts`; every command pays for full inference composition including `help`.
- **TUI shell (8):** `bindSessionLifecycle` advances `persisted` before the appends succeed; extension commands silently shadowed by built-ins with palette and `/name` disagreeing; `runApp` has no containment before the fatal guards; workspace re-serialized on every keystroke and mouse move; `revive` swallows every failure; closing a pane mid-animation leaks its motion regions; eleven `(cause as Error).message` casts beside an unexported correct `toError`; `escrowUntilClaimed` races on a macrotask.
- **TUI layout (8):** layout never re-fits on terminal resize (zero-width panes at 6x3, a pane outside the screen at 1x1; the 300-step fuzz never resizes); `titleBar` ignores configured page thresholds; `leader ctrl+x` bindings parse but can never fire; duplicate chord bindings resolve by insertion order; `schema.ts` `theme` is a `catchall` while `resolveTheme` throws on unknown tokens (typos fail inside `runApp`, not at load); `tray.clipLine` measures UTF-16 units; `Animator.emit` calls `onFrame` synchronously (re-entrancy hazard held off by caller guards); `frameWrap` is detected, tested, exported and never called.
- **TUI conversation (10):** all width math counts code points not cells (CJK wraps to 8 cells against a 4-cell measure; `conversation-model.test.ts:732` pins the bug as intended); `wrapSpans` overflows by one when a long token abuts a span; `swapAgent` silently depends on the new agent sharing the old bus; `confirmMutation` can orphan a pending ask; connect "verifying" swallows escape; connect text fields have no cursor; lifecycle latching happens as a render side effect; scrolled-back rendering is O(total lines) per frame.
- **TUI nodes (7):** `BrowserPane`/`FilePane` have no `dispose` so async reads call `notify` after close; four of six models never guard modifier keys (`shift+d` discards an inbox item); `ArcsPaneModel.selectVisible` drills on click; recall row ids are positional; `rows()` performs filesystem I/O in the browser model; `gardenerSweepView` renders object keys as prose; dead exports with 50 lines of tests.
- **Scripts (11):** harness can leak cwd and a temp dir; an unset version ships `keywork undefined` and passes smoke; `build-npm --outdir ..` deletes the repo; release workflow publishes without running checks and with write scope on every job; `soak.yml` interpolates an input into a shell command; `ci.yml`/`soak.yml` declare no `permissions`; checkpoint-open failures swallowed twice; installers' checksum wording overstates the assurance (same origin, unsigned); `install.ps1` arch detection misses 32-bit-on-x64 and ARM64; `paneTitleCount` is a substring tally; mask truncation collapses distinct short values.

## Structure

Ranked by leverage. Each is a move, not a rewrite; sizes are for the move.

| Id | File | Finding | Proposal | Size |
|---|---|---|---|---|
| S-01 | `tui/src/app-core.ts` (1624) | one class, 99 methods, 21 fields: layout, keymap, registry, pane map, 8-variant overlay machine, mouse routing, arc/workspace verbs, preset/model/connect flows, persistence, numbering, revival, 179 lines of command registration | `app-actions.ts`, `pane-kinds.ts` (one record per pane kind replaces five byte-identical `summonX` + five `openXPane` + seven counters + the revive switch), `overlays/`, `core-commands.ts`, `pointer-routing.ts`, core-side `arc-commands.ts`/`workspace-commands.ts`; `AppCore` lands near 350 lines | L |
| S-02 | `tui/src/app.ts` (1573) | 542 lines are pure `Screen + state -> Box` view code, so `runApp` sits at line 161 and the last helper at 1573 | `view/frame.ts`, `view/overlays.ts`, `view/status-bar.ts`, `session-attachment.ts`, `crash-log.ts`, `restore-plan.ts`, `fork.ts`, `arc-index.ts`; `app.ts` becomes a ~250-line composition root | M |
| S-03 | `tui/src/conversation-model.ts` (1272) | twelve responsibilities; model stores view geometry mutated during render, pane stores domain identity | `transcript-feed.ts`, `transcript-view.ts`, `session-ledger.ts`, `prompt-editor.ts`, `ask-gate.ts`, `transcript-navigation.ts`, ~180-line orchestrator; split the 1362-line test to match | L |
| S-04 | `tui/src/layout.ts` (956) | persistence, tree mutation, dock mutation, geometry, hit-testing, fit policy in one class plus 30 module functions (geometry itself is single-sourced and excellent) | `layout-tree.ts` (pure node algebra), `layout-state.ts` (parse/serialize), `layout.ts` (orchestrator); `geometry.ts` holding `Rect`/`contains` shared with `app-core.ts` | M |
| S-05 | `engine/src/index.ts` (486) | flat barrel of 374 names from 63 modules; 262 imported nowhere outside the engine; mixes `Agent` with `MalformedInboxError` and `bearerHeaders`; `engineVersion` hand-duplicates package.json | trim to what crosses the package line; named subpath exports for memory/mcp/inference/providers; a `scripts/` check that fails when a new barrel export has no external consumer; derive the version | L |
| S-06 | `tui/src/index.ts` | 167 exports, 121 never referenced outside the package | same treatment: `runApp`, ports, option types, the value types the CLI constructs | S |
| S-07 | `engine/src/mcp/registry.ts` (636) | reconciler (~230) + tool-surface projection (~90) + lazy schema search tool (~110) | extract `mcp/tool-search.ts` first (needs only a catalog accessor and an activate callback), then `mcp/reconciler.ts`; registry becomes a ~200-line facade | M |
| S-08 | `engine/src/memory/store.ts` (763) | `MemoryStore` holds walking/parsing, name resolution, the staging kernel and the ledger | pull note parsing and directory walking into `vault-files.ts` (pure over a root); store keeps gate/resolve/commit; under 500 lines | M |
| S-09 | `cli/src/main.ts` (456) | the `panes` case (lines 253-436, 14 dynamic imports) is the real composition root, not `compose.ts`; no `main.test.ts`; five of the six CLI P1s live here | `composePanes(...)` beside `composeWorkspace`; `main.ts` is dispatch plus one call per command and gains a table-driven `main(argv)` test | L |
| S-10 | `cli/src/sessions.ts` (503) | store lookup helpers + TUI ports + the `keywork sessions` printer | `sessions/store.ts`, `sessions/ports.ts`, `sessions/command.ts`; drop the function-form `CheckpointTagSource` union (one test caller); split the 662-line test to match | M |
| S-11 | `scripts/e2e/scenarios.ts` (923) | twelve scenario factories, twelve fixtures, nine frame helpers, not top-down | one file per scenario under `scripts/e2e/scenarios/`, thin `index.ts` registry, `frame-queries.ts` with its own tests, `paneTitleCount` reimplemented to count title rows | M |
| S-12 | `tui/src/workflows.test.ts` (2568) | 30 feature areas, two of which duplicate `memory-pane.test.ts` and `mcp-pane.test.ts` | split into `workflows-layout/palette/pointer/panes/conversation/session/preset.test.ts` (table in report 07), move the two pane blocks | M |
| S-13 | `engine/src/inference/registry.ts` (352) | registration map + resolution algorithm + CLI-facing failure copy (`"run /connect to add one"`) | `resolution.ts` as pure functions; move `nextAction` authoring to `cli/inference/port.ts` keyed off `failure.code` | M |
| S-14 | `tui/src/memory-pane-model.ts` (582), `arcs-pane.ts` (346) | fifteen private row builders in one model; a pane doing port orchestration, a debounced timer, two render levels, a 49-line inline tray table and an exported prose function that `app-core.ts` imports from a render file | `memory-rows.ts`; move `describeCloseOutcome` to `arcs.ts`, lift the tray table (also duplicated in `session-tree-pane.ts:292`) | M |
| S-15 | `shared/src/config/workspace.ts` (288) | declaration schema + anchor walk + named-workspace slot management | `workspace.ts` + `named-workspaces.ts`, one shared `namedDeclarationFileFor` with the slug guard (closes the P2 above) | M |
| S-16 | `packages/extensions` | a one-line stub nothing imports, wired into the root tsconfig so `tsc --build` pays for it; the real extensions subsystem lives in `engine/src/extensions/` | delete the package and its tsconfig reference | S |
| S-17 | `engine/src/mcp/fixture-server.ts`, `session/entries.ts` `BranchSummaryEntry` | a test double in `src/` compiled into `dist/`; an entry type with eight handlers across seven modules and no production writer | move the fixture out of the build; decide branch_summary (land a producer or delete the type) | S |
| S-18 | `cli/src/chat.ts:97-167` | a 70-line if-chain REPL mixing slash dispatch, settlement and rebuild bookkeeping; `startsWith("/label")` matches `/labelfoo`; 52 lines of tests for 446 lines | handler table keyed by command name; an IO seam so it can be tested | M |

## Redundant systems

Ranked by value of fixing. "Absorb direction" names which side survives.

| Id | Both sides | Overlap | Absorb direction | Size |
|---|---|---|---|---|
| R-01 | six row models (`session-tree`, `browser`, `memory-pane`, `mcp-pane`, `arcs-pane`, `sessions-overview`) + five panes over them | `visibleRows` byte-identical x6, `reanchor` x6, `cursorRow` x5, j/k/page/refresh key prefix x6, `moveCursor` x4, `touch`+memoized `rows()` x4, `settleOnSelectable`/`moveSelection` x2, `isPrintable` x3 with three semantics, selected-row `Text(...)` literal x7, "N sessions" pluralizer x7, tone tables x2; ~570 lines | one `RowCursor<Row>` (cursor, scroll, anchor, revision cache, navigation) and `rowsView`/`selectedLine` in `pane-chrome.ts`; models keep their row builders and verbs | L |
| R-02 | `ArcPicker`, `WorkspacePicker`, `ModelPicker`, `PaneTrayModel`, three overlay renderers in `app.ts:1317/1354/1382` | the same 18-line intent switch x3 (tray re-decodes keys by hand), `move`/`retype` byte-identical, fuzzy map/filter/sort pipeline x5, three near-identical overlay `Box` literals; three different index-clamping behaviors (model picker can return `undefined`) | `picker-keys.ts` grows `runPickerKey` (+`tab`) and `rankByFuzzy`; one `FilterPicker<Seed>`; one `filterOverlay`; `arcRowParts` so `app.ts:1428` stops slicing prose by slug length | M |
| R-03 | `cli/src/run.ts:85-113` vs `compose.ts` (`composeWorkspace` + `composeAgents`) | headless rebuilds composition by hand and has drifted: bare-string scope (no linked dirs), one-arg `memoryRecall` (no arc recall), no skills, no workspace slug, journal entries ordered before messages; the engine carries `string \| ToolScope` and `CoreToolTaps \| fn` unions only to keep the old call shape alive | `run.ts` calls compose with a headless guard; then narrow `coreTools` and delete `normalizeScope`'s union | M |
| R-04 | nine hand-rolled `~/.keywork` JSON stores (`trust.json`, two loaders for `keywork.json`, `auth.json`, `connections.json`, `anchors.json`, `workspace-mru.json`, `state-layout.json`, TUI layout state) | five failure policies, inconsistent 0600; `anchor.ts:34-52` and `workspaces.ts:237-262` are verbatim copies; the lenient `keywork.json` loader is A-24; `readFileIfExists`/`parseJson` duplicated inside shared itself | one `jsonFileStore(validator, mode)` primitive in `@keywork/shared` (strict/lenient a parameter, tmp+rename write); `pathKeyedStringStore` for anchors/MRU | L (S for the verbatim pair) |
| R-05 | `engine/src/tools/bash.ts` vs `shell-session.ts` | two full shell drivers: same constants, same truncate-and-append, same settle-once/clear-timer/abort teardown, same exit-code format, both named `bash`; only the persistent one can honor "cwd and exports survive" | `shell-session.ts` absorbs `bash.ts` (a one-shot run is a session that resets after every command); at minimum hoist constants, `BoundedOutput`, and the settle machine | L |
| R-06 | `MemoryStore` staging (`.staging/*.md`+`.json`, ledger-backed, revertable, redacted) vs `ReviewInbox` (`.staging/inbox.json`, none of those) plus the airlock's "fourth door" vocabulary layered on the inbox | two "a human has to say yes" queues with two error types and two caches; plus `isMissingFileError` x4, `mostUsefulFirst` x2, entity/title dispatch x3, wikilink target x2, daily-marker grammar x2, `noteName` x2 | inbox becomes a staged-item kind inside the store kernel (inherits ledger, revert, atomic writes); delete the "fourth door" naming; one `vault-files.ts` for the helpers | M |
| R-07 | `tui/src/theme.ts` `Theme` vs `shared/config/flavor.ts` `FlavorTokens`; `config.theme` overrides vs the Flavor system; `#rrggbb` regex x5 | field-for-field duplicate kept in sync by accident (extra properties are assignable); `resolveTheme` re-implements validation zod already does; two validators with two error vocabularies on one value | `export type Theme = FlavorTokens`; `config.theme` becomes a partial-token override on a named flavor validated through the shared schema (fixes the `catchall` P2); one color primitive | M |
| R-08 | `globMatches`+`literalLength` in `engine/capabilities.ts`, `engine/prompt.ts` (byte-identical), `shared/trust/permissions.ts` | engine compiles `*` to `.*`, shared to `[\s\S]*`, all backing one documented `*` wildcard; `mostSpecificDeclaration`/`mostSpecificOverride`/`mostSpecific` are one algorithm | one `globMatches`/`mostSpecificMatch<T>` in `@keywork/shared`, newline behavior chosen once and stated in the schema | S |
| R-09 | `session/compaction.ts` `CompactionSettings`/`shouldCompact`/`compactionSettingsFor` vs `context-budget.ts` `ContextBudget`/`compactionDue` | `shouldCompact` is `return compactionDue(reading)`; the settings shape duplicates `reserveCaps` and half of it (`reserveTokens`) is never read but is asserted by a test | `ContextBudget` absorbs; compaction/context-budget/settle are otherwise one coherent arithmetic/work/orchestration system | S |
| R-10 | `extensions/skills.ts` discovery vs `extensions/layers.ts` | two discovery philosophies in one folder: agents/commands are user+project layered but hard-coded to `.keywork/`, skills scan three conventions under one root; consequence: user-level skills do not exist | `layers.ts` grows a `conventions` axis; `discoverSkills` becomes `loadLayered(...)` | M |
| R-11 | `cli/src/main.ts` `openPanes` vs `scripts/e2e/live.ts` `composeLiveApp` vs `scripts/e2e/harness.ts` `composeMockApp`; three byte-identical `PresetsPort` literals | the `--live` tier runs a 2-versions-old sketch of the app (no extensions, MCP, memory, arcs, feeds, settlement) | export a seam-injectable launch from `main.ts`; `live.ts` shrinks to seams; mock becomes overrides; `presetsPortFor` in `presets.ts` | L |
| R-12 | providers: `imageDataUrl` x2, `toWireTool` inline tool shape x2, tool-argument parsing x3, streaming tool-call accumulator x2, bearer-header construction x3, model-reference formatting x4; `errors.ts` reached through a re-export in `openai.ts` by six sites | the two wire formats themselves are correctly separate; only the leaves are duplicated | `providers/wire-parts.ts` + `transport.ts`; export `errors.ts` directly; `formatReference` absorbs the template literals | M |
| R-13 | `ArcStatus`, `McpServerState`, `ConnectionProtocol`, `PresetName` re-declared in tui against engine/shared that tui already imports from; `cli/src/mcp.ts:23-31` exists only to copy five fields | stringly-typed ports force re-narrowing adapters (`connections.ts:123`, `main.ts:344-352`) | tui imports and states the delta with `Pick`/`&` | S |
| R-14 | `Agent.busy()` (engine) vs `conversation-model.ts:113` busy flag (drives the queue) | two sources of truth for "a turn is in flight"; the engine has `AgentBusyError` but no queue | decide: engine owns the queue (CLI and TUI share it) or drop `Agent.busy()` from the public surface | M, decision |
| R-15 | small sweep: `isMissingFileError` x4, `WorkspaceCommandIo` x2 + inline x2, confirm callback under four names, four stdin readers in cli, `excerpt` x3 (two semantics), inline `clamp` x5 beside `clamp.ts`, reserved-device-name regex x2, wikilink parser x2, `toUnixEol`/`countOccurrences` duplicated between the edit tool and `tui/diff-render.ts` (the preview can lie), `firstLine`/`compact`/`isRecord`/`megabytes`/`sessionsFact`/`truncate` pairs, two unrelated features both named `doctor`, `tui/slug.ts` vs `shared/slug.ts` (not redundant, same filename for two meanings: rename tui's to `slug-ink.ts`), three "find the focused conversation pane" walks, `lifecycle.ts toError` unexported beside 20 `(cause as Error).message` casts across tui and cli | | one pass | S |

**Deliberate layering that looks redundant and is fine (keep):** TUI declares ports, CLI
implements them; three bus sinks for one event vocabulary (D7); `SoakProvider` beside
`MockProvider`; `chat-wire` vs `responses-wire` twins; `shared/flavor.ts` vs `tui/flavor.ts`
(schema vs runtime); `naming.ts`/`ledger.ts`/`anchors.ts` staying separate from `store.ts`;
`extensions/layers.ts` being the single frontmatter consumer.

**Test-helper duplication (no shared test-support module exists anywhere):** `tempDir()` +
`afterEach` cleanup in 52 files (~400 lines, 16 of them byte-identical); the memory vault
bootstrap under four names in 11 files; `press()` in 9 TUI files; `waitFor` in 4; `flush` in 2;
five bespoke fake providers beside `MockProvider`; `pricing.test.ts` is the one file that never
removes its temp dirs. One `testing/` module per package (`useTempDir`, `openVault`, `press`,
`waitFor`, `recordingProvider`, `steppingClock`) removes roughly 600 lines.

## Comments and documentation

**Code comments: nothing to plan.** 13 comment lines in 175 files, six sites. Keep: `sigv4.ts:92`
(double-encoding quirk), `responses-wire.ts:12` (empty-instructions rejection), `app.ts:424` and
`app.ts:670` (OpenTUI hit-grid and native-buffer constraints), the two `biome-ignore` lines in
`naming.ts`. Trim: `check-guardrails.ts:4-6` to its first sentence (the other two narrate), and
`codex-login.ts:340` (it justifies an empty catch; rename the function or let the block stand).
One place that would legitimately earn a comment and has none: `harness.ts:160` resolving
`@opentui/core/testing` through `Bun.resolveSync` anchored at a tui source file.

**Docs: the overlay chain is the cost, not the prose.** The corpus is ~9,950 lines / ~106k words.
The chain a reader must traverse for current truth is 16 authoritative/implementation overlays
(~40k words) over nine base workstream files; precedence is topic-scoped ("wins where it speaks")
but nothing maps topic to owning file. The standing-guardrails blockquote is restated near-verbatim
in 23 files (~1,800 words) and the Crush retirement in 10; both are deliberate (overlays are meant
to read standalone) but it means the em-dash pass edits the same sentence 20 times. Worst
preambles: `98` (a five-branch supersession sentence before 542 lines), `106` (authority state
that cannot be determined from the document itself), `108`. `mit-feature-candidates.md` and
`comparison.md` carry no in-document status banner though both are partly superseded by
`vision.md`. Proposed (Jordan decides; this changes how the docs are meant to be read):

| Id | Action | Size |
|---|---|---|
| D-01 | add a topic -> owning-overlay index table to `backlog/README.md` (workspace/modes -> 99, chroma/arcs -> 98, typography -> 104, inference -> 105/107, survivability -> 108/109, arcs-on-screen -> 110, bots -> 106 pending) | S, highest leverage |
| D-02 | move `90`, `91`, `92`, `93` to `backlog/archive/` and delink from the primary index (`97` already declares them superseded); keep `93` as the defect corpus it is | S |
| D-03 | keep the guardrails text once (`AGENTS.md`/`vision.md`) and replace the ~20 restatements with a one-line pointer | S |
| D-04 | shrink `docs/tasks.md` to a pointer; add status banners to `mit-feature-candidates.md` and `comparison.md` matching `ux-principles.md`; decide whether `96` can close out | S |
| D-05 | trim the three worst preambles and the 150-250-word index cells in `backlog/README.md` | S |

## Em dashes

Counts (U+2014): **1,965 occurrences on 1,853 lines in 73 tracked files.** Docs 1,932
(`docs/backlog` 1,139 lines with `95` at 159 and `98` at 126; `docs/research` 150;
`docs/influencers` 215; top-level `docs/*.md` 301; `AGENTS.md` 3; `NOTICE` 11; root `README.md`
0). Source (non-test) 17 lines in 9 files; tests 7 lines in 4 files; scripts 10 lines in 4 files.
Goldens: zero (checked byte-wise). En dashes: 169, every one a numeric/ID range with no spaces,
zero prose use; leave them.

**Every source, test and scripts occurrence** (34 lines; paired sites must move together):

| File:line | Kind | Note |
|---|---|---|
| `engine/src/mcp/registry.ts:328` | user-facing (MCP status) | asserted by `registry.test.ts:220`; `·` matches `settle.ts` |
| `engine/src/mcp/registry.ts:398` | model-facing (tool roster) | `: ` or `·` |
| `engine/src/memory/arcs/airlock.ts:175` | persisted to the daily log | paired with `airlock.test.ts:202` |
| `engine/src/memory/recall-tools.ts:138` | model-facing tool output | line 139 already uses `·` |
| `engine/src/titles.test.ts:84` | test name | free |
| `shared/src/config/schema.ts:43,190,201,250,260,263,266` | `.describe()` justifications (D9) | rewrite by hand so each stays one clean sentence |
| `shared/src/config/workspace.ts:20` | `.describe()` | same |
| `shared/src/trust/store.ts:16` | user-facing error | semicolon or period |
| `cli/src/chat.ts:231` | user-facing agent list | neighbors use `·` |
| `tui/src/conversation-model.ts:229` | user-facing (the dash-prefixed `interrupted` marker) | drop the dash or `· interrupted` |
| `tui/src/conversation-model.ts:1092` | user-facing failed-tool row | paired with `conversation-model.test.ts:1238` and `workflows.test.ts:1336` |
| `tui/src/conversation-pane.ts:383` | user-facing scroll banner (2 glyphs) | already mixes `·`; finish the job |
| `tui/src/conversation-model.test.ts:1078,1082` | fixture pair | move together |
| `tui/src/workflows.test.ts:1780` | test name | free |
| `scripts/check-guardrails.ts:56` | CI output | colon |
| `scripts/e2e/goldens.ts:16` | dev-facing error | colon or semicolon |
| `scripts/e2e/scenarios.ts:113,128` | scripted turn + `until()` marker | same-file producer/consumer; edit both or the scenario hangs |
| `scripts/e2e/scenarios.ts:304,386` | scripted turns | not golden-covered |
| `scripts/e2e/scenarios.ts:799,800` | evidence-file text | line 797 already uses `·` |
| `scripts/e2e-capture.ts:21,22` | `--list` output | colon |

**Plan**

| Id | Step | Size |
|---|---|---|
| E-01 | hand-edit the 34 source/test/scripts lines above, paired sites together; `bun test` and the e2e pack green (no golden needs regenerating today, but `scenarios.ts:113/128` would bake a dash into any future capture) | S |
| E-02 | scripted pass over `docs/**`, `AGENTS.md`, `NOTICE` with a context-aware replacement (two clauses -> period or semicolon; aside -> comma or parentheses; label-then-elaboration in tables -> colon; UI-style status lines -> `·`), then a human skim of `95`, `98`, `NOTICE` (attribution wording, not punctuation, carries weight there) | M |
| E-03 | land D-03 first so the guardrails sentence is edited once, not twenty times | S |
| E-04 | add a repo check (`scripts/check-prose.ts` or a grep step in `bun run check`) that fails on U+2014 anywhere tracked, with an allowlist only if E-05 says NOTICE keeps them | S |
| E-05 | **decision:** the 2026-08-16 voice pass deliberately left NOTICE's em-dash convention in place for attribution consistency; "remove all" now says otherwise. Default in this plan: remove, pending Jordan's word | |

## Work plan

Four waves, file-disjoint where possible, full gate (`bun run check && bun test` + e2e) as the
merge bar, adversarial self-review in every agent prompt per the 2026-08-10 working style. Sizes:
S under two hours, M a half-day, L a day.

### Wave A: safety and data integrity (all S/M; do first)

| Task | Closes | Size | Acceptance |
|---|---|---|---|
| A1 move `send`'s pre-turn side effects inside try/finally; isolate listener failures in `EventBus.emit` (route to `engine.error`, guard recursion) | A-01, A-06 | S | throwing `context.injected` / `turn.started` / `turn.completed` listeners leave `busy()` false, later listeners still run, a successful turn never rejects |
| A2 resolve symlinks in `confinedPath` (nearest existing ancestor for the create case); give `ToolScope` honest semantics; add cross-drive and junction tests | A-02, A-09 | M | a junction inside the root pointing outside is rejected by all three file tools; a scope narrower than cwd is not widened |
| A3 `ShellSession` child `error` handler + stdin EPIPE; cover the PowerShell arm of `framedCommand` with an explicit PowerShell shell on win32 | A-03 | M | unspawnable shell rejects `run()` with no uncaughtException; PowerShell persistence/exit-code/timeout cases run regardless of Git Bash |
| A4 contain every vault write (`parseStagedMeta` target validation + containment in `apply`); promise-chain mutex around `commit`/`audit`; one `writeFileAtomic` used by all five memory write sites | A-04, A-17, A-18 | M | planted `../outside.md` sidecar makes `approve` throw and writes nothing; three concurrent `appendDaily` yield three entries and three honest ledger rows |
| A5 single append queue in `SessionStore` with `parentId` computed inside it; fix `firstKeptEntryId` ordering; never re-admit an earlier compaction entry | A-05, A-14 | M | `Promise.all([append, appendCustom])` yields a linear path of 3; two `compactNow` calls leave one summary at index 0 in chronological order |
| A6 prefix-anchored redaction shapes (AWS, Slack, npm, GitHub, GitLab, PEM, URL credentials) joined to the entropy heuristic | A-16 | S | each shape elided; "leaves lowercase git hashes, uuids, and prose alone" still passes |
| A7 cache `MemoryStore` per arc slug and route MOC/question writes through it; teach the store its reserved paths and delete the two ad hoc filters; narrow `ask-gate`'s bare catch | A-19, A-20, A-22 | M | `arcStore(slug)` returns the same instance twice; `listNotes()` never returns `MOC` or `questions/*`; a non-ENOENT read error throws instead of resetting the ledger |
| A8 `updateUserConfig` reads through the strict parser and refuses to write when the file does not parse; `auth.json`/`connections.json`/trust file get tmp+rename writes; single-flight the OAuth refresh; quote the Windows opener URL | A-24, A-13, A-12, A-11 | M | a `keywork.json` with one invalid field survives `keywork connect`; ten concurrent `headers()` calls issue one token request; a URL with `&` round-trips through `cmd /c echo` |
| A9 preserve `models`/`enabled` on `/connect` re-save | A-10 | S | re-saving a connection with both fields keeps both |
| A10 `DiagnosticsLog` fails open; keep the partial assistant message on stream failure and settle orphaned calls like the interrupt path | A-08, A-07 | S | after one `appendFile` rejection later lines still write; after a mid-stream throw history ends `[user, assistant]` and no retry produces `user, user` |
| A11 **decision then fix:** deny wins in the bash matcher, schema text updated; `Object.hasOwn` (or a `Map`) for tool lookup; `listWorkspaces` degrades per slot; unify the three slug guards; refuse declaring a workspace above an existing one | A-21, A-23, shared P2s | M | `{"git push*":"allow","*--force*":"deny"}` denies `git push --force` in either order; `policy("constructor", {})` is `undefined`; a corrupt named declaration lists as unavailable |
| A12 usage-exit contract in `main.ts` (`--help`/`-h`, unknown flags exit 2); thread `--json` and `--workspace` to the subcommands; make `runHeadless` teardown non-fatal and guarantee one `run.finished`; surface `openPanes` rejections; add `main.test.ts` table-driven over `main(argv)` | A-25, A-26, A-27, A-29, CLI P2-1 | M | `keywork run x --nope` exits 2 without a stack; `sessions list --json` prints JSON; an `append` that rejects still yields exactly one `run.finished` |
| A13 persist arc release: after close/abandon append `arc_binding` release to every store in `releasedSessions` (the CLI holds the stores map; give `arcService` what it needs) | A-28 | M | close, relaunch, neither `boundSessionCounts` nor `arcs.attached` reports the session bound |
| A14 route paste to the open overlay; give the five newer overlays hit routing; make the session-attachment handshake explicit (`attach` returns the attachment; `focusOrOpen` honors the result; notice on missing session) | A-30, A-31, A-32, TUI-shell P2-8 | M | pasting a key into `/connect` fills the field; clicking a model row selects it; a `SessionPort.open` returning `undefined` produces a notice and no pane, and no test needs a real-timer `flush` |
| A15 fork by prompt identity (session entry id on `user` transcript entries) instead of ordinal; respect modifiers at the ask gate | A-33, A-34 | M | a replayed session with a compaction and a flush prompt backtracks to the right prompt and restores that prompt's checkpoint; `ctrl+a` at an ask neither approves nor sets `alwaysAllow` |
| A16 thread `borderFocus` into `focusLift`; `PaneTasks` survives non-Error rejections, drains `pending` in `finally`, per-task failure accounting; `BrowserPane`/`FilePane` get `dispose` via `PaneTasks` | A-36, A-37, nodes P2 | S | `paneBorder(firstLight, t, true)` clears the Lc floor; a task rejecting with `undefined` records a failure, notifies once, no unhandled rejection; closing a browser pane mid-read fires no `notify` |
| A17 one `isPrintable(chord, sequence)` (from `conversation-model.ts:1208`) in `picker-keys.ts`; thread `sequence` into the two panes; guard modifiers in the four unguarded models | A-38, nodes P2 | S | `Shift+H i` typed into a session-tree label reads back `Hi`; `shift+d` in the memory pane is a no-op |
| A18 MCP surfaces released by construction (handle or weak keys); cap the MCP stdout buffer; surface flush failures as a notice; report dropped JSONL lines on open | A-15, session P2s | S | 100 agent builds leave one live surface; 10 MB without a newline fails with `McpProtocolError`; a throwing flush provider posts `flush failed: …` |

### Wave B: tooling and CI (file-disjoint from A)

| Task | Closes | Size | Acceptance |
|---|---|---|---|
| B1 `scripts/tsconfig.json` referenced from the root, `paths` for `@opentui/core/*`, fix the surfaced errors | A-40 | S | `bun run check:types` compiles `scripts/` and fails if `live.ts:83` is reverted |
| B2 `bun run e2e` in `ci.yml` with artifact upload on failure; key goldens by step name; `--update-goldens` prunes orphans; a test asserting golden tree == `{golden:true}` captures; delete the four stale files | A-41 | M | a one-character golden change fails CI; the test fails while `discovery/01-palette.txt` exists |
| B3 `scripts/lib/repo-files.ts` with one exclusion set (adding `.claude`) used by both checkers, tested; widen `scannedExtensions`; stop excluding `docs/`; narrow the self-exemption to pattern literals; add the fixed-literal patterns (Claude Code public client id, the OAuth token-endpoint path, PKCE near `claude`); a pre-G1 test that no Anthropic-endpoint registration carries a non-api-key auth kind | A-42, A-43, providers policy note | M | a seeded OAuth flow in `docs/scratch.md` and `scripts/probe.mjs` both fail `check:guardrails`; `check-pins` reports 6 manifests |
| B4 `install.ps1`: `HKCU:\Environment` read/write preserving `REG_EXPAND_SZ`, null PATH, `WM_SETTINGCHANGE`, `PROCESSOR_ARCHITEW6432`; soften or back the checksum wording | A-44, scripts P2 | S | after install the value type is still `REG_EXPAND_SZ` and the unexpanded entry survives |
| B5 workflows: `permissions: contents: read` on ci/soak, `write` only on the publish job, gate release on `bun run check && bun test`, `inputs.turns` through `env:`; validate the release version against the `targets.ts` grammar; refuse `--outdir` outside `dist/` | scripts P2s | S | `soak.yml` has no `${{ }}` inside `run:`; a manifest without `version` fails the build by name |
| B6 harness: `chdir`/`beforeBoot` inside the try; log checkpoint-open failures; `paneTitleCount` counts title rows; shorter mask placeholders instead of truncation | scripts P2s | S | a throwing `beforeBoot` leaves cwd unchanged and removes its temp root |
| B7 `connections.test.ts:170` `.not.toContain` on an object (fails under native `bun test`); `pricing.test.ts` temp-dir leak; `skills.test.ts` `it.skipIf` instead of silent return | test-health | S | `bun test` and `vitest run` agree at 2052/2052 |

### Wave C: structure and redundancy (the big one; sequence so territories stay disjoint)

| Task | Closes | Size |
|---|---|---|
| C1 `RowCursor<Row>` + `rowsView`/`selectedLine` in `pane-chrome.ts`; six models and five panes rebased; `pluralize`; recall rows get stable ids; `arcs-pane.test.ts` written; dead exports and their tests deleted | R-01, A-39, nodes P2s | L |
| C2 `runPickerKey`/`rankByFuzzy` in `picker-keys.ts`; `FilterPicker<Seed>`; one `filterOverlay`; `arcRowParts`; `ConnectModel` backed by `InputBuffer` per field with an escape out of `verifying` | R-02, conversation P2s | M |
| C3 `runHeadless` through `composeWorkspace`/`composeAgents`; narrow `coreTools`; headless gets skills, linked dirs, arc recall, workspace slug, interleaved journal order | R-03, CLI P2-1/2/4 | M |
| C4 `jsonFileStore` primitive in shared (strict/lenient, mode, tmp+rename); `pathKeyedStringStore` for anchors/MRU; `canonicalTrustPath` in `paths.ts`/`link.ts` | R-04, CLI P2-5/6 | L (S for the verbatim pair first) |
| C5 `shell-session.ts` absorbs `bash.ts` (or at minimum shared constants, `BoundedOutput`, settle machine); `SentinelScanner` bound; abort-before-spawn | R-05, engine P2s | L |
| C6 inbox becomes a staged-item kind in the store kernel; "fourth door" renamed; `vault-files.ts` extraction and the seven helper dedupes; `graph.ts` NUL bytes written as `\0`; `readDaily` validates its argument | R-06, S-08, memory P2s | M |
| C7 `Theme = FlavorTokens`; `config.theme` as a partial override on a flavor through the shared schema (replaces the `catchall`); one `#rrggbb`; `"calm" \| "cockpit"` from `Flavor["instruments"]` | R-07, layout P2 | M |
| C8 `globMatches`/`mostSpecificMatch` in shared; `ContextBudget` absorbs the compaction adapter; `layers.ts` grows conventions and skills get a user layer; `tool-search.ts` out of the MCP registry; `fixture-server.ts` out of `src/`; decide `branch_summary` | R-08, R-09, R-10, S-07, S-17 | M |
| C9 `app-core.ts` decomposition (S-01) and `app.ts` view extraction (S-02); `geometry.ts` shared `Rect`; `toError` exported and used; extension-command collisions detected at registration; `bindSessionLifecycle` persists one message at a time; animator regions settled on dispose; workspace capture dirty-flagged | S-01, S-02, TUI-shell P2s | L |
| C10 `conversation-model.ts` decomposition (S-03) with the test split; incremental streaming render; `width.ts` with display-cell `width`/`clip`/`wrap` replacing the five clippers and the `.slice(0, width)` calls; rewrite the CJK test to assert cells; `wrapSpans` off-by-one | S-03, A-35, conversation P2s | L |
| C11 `layout.ts` three-way split; `Layout.reflow(screen)` on resize with the fuzz test resizing mid-sequence; `Keymap` rejects duplicate chords and modified leader keys; `titleBar` takes page thresholds; decide `frameWrap` | S-04, layout P2s | M |
| C12 engine and tui barrel trims with a CI check for consumer-less exports; `engineVersion` derived; delete `packages/extensions`; providers `wire-parts.ts`/`transport.ts`; `nextAction` copy moved to the CLI; cross-boundary types imported (R-13); `sse.test.ts` with a chunk-boundary table | S-05, S-06, S-16, S-13, R-12, R-13 | L |
| C13 `composePanes` out of `main.ts`; `sessions.ts` three-way split; `chat.ts` handler table with an IO seam; CLI `CommandIo`/`Confirm` unified; one terminal-input module; `presetResolver` absorbs `runScopedPermissions` | S-09, S-10, S-18, R-15 (cli part) | L |
| C14 three app compositions collapsed (main exports a seam-injectable launch; `live.ts` shrinks; mock becomes overrides); `scenarios.ts` one-per-file; `presetsPortFor` | R-11, S-11 | L |
| C15 `testing/` module per package (`useTempDir`, `openVault`, `press`, `waitFor`, `recordingProvider`, `steppingClock`); migrate the 52 files; `workflows.test.ts` split; real-timer sleeps converted where a settle promise exists | test-helper duplication, S-12 | M |
| C16 the R-15 small sweep (one pass) and `tui/slug.ts` -> `slug-ink.ts`; `/doctor` naming | R-15 | S |
| C17 decide R-14 (engine-owned turn queue vs drop `Agent.busy()`) | R-14 | M |

### Wave D: em dashes and docs

E-01 through E-04 as listed, D-01 through D-05 if Jordan adopts them. E-01 can ride with Wave A
(it touches user-facing strings in files Wave A already edits); E-02/E-03 are their own lane.

## Questions for Jordan

1. **A-21 / A11:** deny-wins in the bash matcher (the plan assumes yes, schema text follows)?
2. **E-05:** NOTICE em dashes too, reversing the 2026-08-16 attribution-consistency call?
3. **D-01..D-05:** appetite for the docs consolidation, given overlays are deliberately standalone?
4. **R-14 / C17:** should the engine own the turn queue, or should `Agent.busy()` leave the public surface?
5. **R-05 / C5:** merge the two shell drivers fully, or only hoist the shared machinery?
6. **S-05 / C12:** barrel trim via named subpath exports (`@keywork/engine/memory`) or a flat cut?
7. **S-17:** `branch_summary`: land a producer or delete the type and its eight handlers?
8. **defaultModel naming:** rename the built-ins' `defaultModel` (it only matters while the catalog is empty under IR-07) or add a rung to IR-07?
9. **S-16:** delete `packages/extensions` (nothing imports it)?
10. **`/doctor`:** rename the TUI crash-log command or unify it with `keywork doctor`?
