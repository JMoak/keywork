# 115: The open ledger

> **Kind:** running pickup list (2026-09-07). Decides nothing; every item cites the overlay that
> owns it. Read this first when resuming, then the owning overlay before building. Strike items
> as they land and add the landing date; when a section empties, delete it.

## Where the tree stands (2026-10-12, wave three)

Uncommitted on top of the alias and theme lanes, four workstreams run on Opus 5.5 at high
effort or above: subagents (new overlay [120](120-subagents.md): a child is its own session
filed under its parent at `<parent>.children/`, the `delegate` tool, trust inherited never
widened, cost rolls up, FR6.17 rows with `o` to open a finished child, `child.started` /
`child.finished` over SSE, `keywork run --json` children, headless asks answer no), E8 sandbox
modes (options note and ledger in [103](103-dsh-influence.md): the `Sandbox.confine` seam
bash, the persistent shell, the pty and LSP go through, `sandbox: off | workspace | isolated`
user-layer only, a bubblewrap runner for Linux that has only been read-checked, fail-closed
refusal everywhere else routed through the ask gate as an `unconfined` call, `keywork doctor`
row), permissions part 2 (ledger in [50](50-trust.md): `/permissions` in attach over typed
client methods, `POST /permissions/session/{id}/revoke`, shell escapes in the quiet-run rows,
two gate bugs fixed on the way), and three fixes at the cause (one clock per approve so an op
stays above its echo, `costBasis` in `engine/src/pricing.ts` as the one home, and
`scripts/check-contract.ts` in `bun run check` and CI). Contract bumped once to 1.1 for the
additive route and events. Gate on the integrated tree: `bun run check` clean, vitest 363 files / 4992 tests (3 skipped), e2e 50 of 50 (the `delegation` scenario is new).

Earlier state (2026-10-12, later):

The five-lane wave below is committed (`6a9aa2d`). On top of it, uncommitted: workstream
aliases for the arc family (`workstream`, `workstreams`, `ws` on all seven arc commands, the
arcs node teaching line, `keywork attach ws` refused like `arcs`, the vocabulary note in
`docs/README.md`; ledger in [110](110-arcs-on-screen.md)) and theme parity with keywork-app
(the app's gallery and derivation were already a mirror of K6; keywork now carries
`whiplash` and `whiplash-flash`, the polarity rule in `parseTheme`, `contrastMeasurements`
and `auditTheme` in `shared/src/config/theme-audit.ts`; the OpenAPI fixture regenerated,
contract still 1.0; ledger in [118](118-app-surface.md)). Gate on the integrated tree:
`bun run check` clean, vitest 354 files / 4878 tests (1 skipped), e2e 49 of 49.

Earlier state (2026-10-12):

PR #7 merged `app-surface/next` into `main` (`8952a27`): K6 themes and K7 trusted reads and ask
scopes landed with it, so the permissions proposal below is built. On top of it, uncommitted,
the 2026-10-12 wave in five lanes: the reliability floor (two e2e flakes fixed at the cause,
two shown to be load; ledger in [117](117-influence-sweep.md)), the serve gaps and the merge
audit (exit sweep under `serve`, `chat` on the shared settle, `closingProvider` from
`main`, stat-first on `/changes/file` with 413, `changes.updated` once per burst, the
`changedSince` cost measured and left; ledger in [118](118-app-surface.md)), contract hardening
(strict fixture gates for the OpenAPI document and the event shapes, `x-keywork-contract` on
`/doc`, `bun run contract:fixtures`, the promise in `docs/events.md`, a consumer test the app
can copy; ledger in [118](118-app-surface.md)), the permissions surface (`keywork permissions
list | revoke`, `/permissions` with revoke and drop keys, the ask row names what `[a]` would
remember; ledger in [50](50-trust.md)), and a voice and experience pass over everything
user-facing since August (ledger in [112](112-feel-and-look-wave.md)). Gate on the integrated
tree: `bun run check` clean, vitest 353 files / 4840 tests (1 skipped), e2e 49 of 49.

Earlier state (2026-10-11):

The 2026-10-10 wave is committed on `main` (`4b35b5e`). On top of it, uncommitted, the
2026-10-11 wave: 118 K2 (entries, fork, label, leaf, changes and per-file diff over HTTP,
`session.tree` and `changes.updated`, `followMutations` shared from the engine), session
removal and restore across every surface (new overlay [119](119-session-lifecycle.md):
`SessionTrash`, `keywork sessions remove | restore | trash | purge`, `DELETE /sessions/{id}`
and the `/trash` family, `x` with an in-pane confirm in the tree, arcs and arc panes), serve
parity (after-turn settle with `session.settled`, bot binding rebuilds the agent, arc close
with flushes and the closing judgment, `keywork mcp login` reconnects a running server), and
J14 multi-host memory sync (per-host segments, git merge driver, conflict intake, sweep
lease, `keywork memory sync`). Gate on the quiet tree: `bun run check` clean, vitest 342
files / 4645 tests (1 skipped), e2e 49 of 49.

Earlier state (2026-10-10): the 2026-10-10 wave: 118 K0 + K1 (checkpoints and per-session inference under `serve`, the
session verbs, `session.state`, `/events?session=`), K3 (workspace, files, trust, surfaces,
flavors, `surface.changed`), K4 (memory and the arc airlock over HTTP, `memory.inbox`), the
extension host wired into panes, chat, run and the CLI (per-session hosting,
`host.observe(bus)`, `/extensions`, `docs/extensions.md`), MCP elicitation through the ask
gate and OAuth sign-in (`keywork mcp login`), and the `serve.ts` integration (`servedHost`
mounts every family over one eager composition and runs the extension lifecycle). Gate after
integration on the quiet tree: `bun run check` clean, vitest 331 files / 4549 tests (1 skipped), e2e
49 of 49.

Earlier state (2026-10-07):

The 117 sweep is committed at `25e9f67`. On top of it, uncommitted: the 2026-10-07 round
(wave one: the pty terminal pane SW11, the extension host D1 to D3, thinking replay per
generation + mid-run compaction + `/forget`, six feel-polish items, the memory lane; wave two
stopped early at the wrap-up call: runway audit rows cleared, MCP elicitation parsing only,
extension product wiring planned in 40). Gate after integration: `bun run check` clean,
vitest 324 files / 4426 tests, e2e 48 of 48 (`memory-browser` and `terminal-mirror` can flake on
timing under full-run load and pass in isolation). Earlier state: wave 4 committed at `0c8ac9a`.

## Pickup order

Read [117](117-influence-sweep.md) before this list. Its four phases landed on 2026-10-02 (29 tasks,
ledger at the end of that file, gate 302 files / 4229 tests, e2e 47 of 47, all uncommitted); what
remains of it is SW10 (Bun, decision 117-3), SW11 (the terminal pane spike) and the scope-first
items, plus the calls listed under "Where the tree stands" there.

1. Jordan reviews and commits the 2026-10-11 wave (commit messages proposed per lane in the
   118 / 119 / 95 ledgers); installs Bun 1.3.14 locally so the e2e harness stops segfaulting
   on Ctrl+C.
2. ~~118 K2 (tree and diff families)~~ landed 2026-10-11. ~~Next on the app surface: the gaps the
   K2 and serve-parity ledgers name~~ all closed 2026-10-12 (ledger "Serve gaps and merge debt"
   in [118](118-app-surface.md)). Still open there: `costBasisOf` in the server verbs and the
   private `costBasis` in the TUI ledger are the same three branches and want one engine home;
   `keywork attach` composes no permissions port so `/permissions` is absent in attach mode;
   pane shell escapes (`!cmd`) do not reach the quiet-run log the `/permissions` view shows.
2b. ~~Permissions: bash asks for every inspection command under `standard` and `[a] always` is a
   pane-local flag; trust grants no permissions.~~ Built as K7 (2026-10-11, Jordan's three
   decisions in [50](50-trust.md) E1) and given a keyboard surface 2026-10-12.
3. `serve` gaps the wave named (all four closed 2026-10-11, ledger "Serve parity" in
   [118](118-app-surface.md)): ~~no after-turn settle (flush, auto-compaction) under `serve`~~;
   ~~binding a session to a bot records the binding but builds no bot agent~~; ~~an arc close
   under `serve` runs with no flushes or closing judgment~~; ~~after `keywork mcp login` a
   running pane needs a manual server restart~~.
4. Linux walk for SW11 (`docs/windows.md` lists the steps) and the launch runway walk.
5. Options-first notes for P2.3 and E8 (E8 gates the LSP runner seam per 114).
6. One sitting for the decisions below; the newest calls are listed first.

## Unblocked, specified, unbuilt

| Item | Owner | Size | Note |
|---|---|---|---|
| ~~P2.5 HTML export (`/export`)~~ | [80](80-p2-reach.md) | 2 | landed 2026-10-02: `/export [tree] [path]` and `keywork sessions export`, own renderer (no Pi code) |
| ~~P2.6 external prompt injection~~ | [80](80-p2-reach.md) | 2 | landed 2026-10-02: `POST /sessions/{id}/inject`, queues behind a running turn, origin on `turn.started` |
| ~~S0 serve discovery (per-workspace ticket, `--port 0`, stale-ticket tolerance, `/doc` workspace)~~ | [80](80-p2-reach.md) | 2 | landed 2026-09-07 |
| ~~S1 the ask queue (`gate.ask`, `GET /asks`, `POST /asks/{callId}`, `asOf`)~~ | [80](80-p2-reach.md) | 3 | landed 2026-09-07 |
| P2.3 shared workspaces | [80](80-p2-reach.md) | 5 | also decides B1 store concurrency; scope first |
| ~~E9 secrets at rest~~ | [103](103-dsh-influence.md) | 2 | landed 2026-10-02 |
| E8 sandbox modes | [103](103-dsh-influence.md) | 3+ | fail-closed runner seam; scope first |
| ~~V2.7 @-mention~~, V2.11 provenance gutter, ~~V2.16 commit drafting~~, ~~V2.17 away summary + `/btw`~~, ~~V2.5 compaction offer~~ | [96](96-conversation-enrichment.md) | 1–2 each | V2.7, V2.16, V2.17 landed 2026-10-02; V2.5 landed 2026-10-07; V2.11 detection landed, glyph flip is Jordan's call |
| ~~Extension host product wiring~~ | [40](40-extensions.md) | 5 | landed 2026-10-10 |
| ~~MCP elicitation retry through the ask gate · MCP OAuth~~ | [117](117-influence-sweep.md) "MCP lane" | 3 + 5 | landed 2026-10-10; CIMD waits on a document URL |
| 118 K2 tree and diff families | [118](118-app-surface.md) | 3 | K0, K1, K3, K4 landed 2026-10-10 |
| ~~Session removal and restore (engine trash, `keywork sessions remove`, `restore`, `trash`, `purge`, the overview `x` key and trash view, `DELETE /sessions/{id}` and the `/trash` family)~~ | [119](119-session-lifecycle.md) | 4 | landed 2026-10-11; Q-SL1 to Q-SL3 for Jordan |
| SW11 Linux verification · SW10 Bun trial | [117](117-influence-sweep.md), `../windows.md` | 1 + 2 | pane landed 2026-10-07 by construction; steps written |
| ~~J14 multi-host half (per-host layout, merge driver, lease)~~ | [95](95-memory-and-skills.md) | 3 | landed 2026-10-11; single-vault reconcile landed 2026-10-07 |
| FR6.18 enterprise security scoping doc | [101](101-feedback-round-4.md) | 2 | a document |
| ~~AB2 honest MCP denial hint~~, AB5 agentbox first boot | [116](116-agentbox.md) | 1 each | AB2 and AB3 landed 2026-10-02; AB1 waits on Q-AB1; AB5 needs a Docker host |
| Audit phase 3 crumbs | [111](111-code-audit.md) | 1 | `isPresetName` guards in `presets.ts`, `clip` in `mcp-pane-model.ts`, five-field copy in `cli/src/mcp.ts` |
| K0 checkpoints and per-session inference under `keywork serve` | [118](118-app-surface.md) | 1 | prerequisite for K1 undo and K2 changes; `serve` composes `checkpoints: "off"` and one process provider today |
| K1 session verbs (`behavior` on prompt, `/events?session=`, model, thinking, effort, compact, undo, redo, context, cost, export, rename, `model` on summaries) | [118](118-app-surface.md) | 3 | the app's S3 + S8 + half of S4; shapes dictated by the engine, cited in 118 |
| K2 tree and diff (entries, fork, label, changes, per-path diff, `changes.updated`, `session.tree`) | [118](118-app-surface.md) | 3 | the app's S2 + the rest of S4 |
| K3 workspace, files, trust, status (`/workspace`, `/tree`, `/files`, `/workspace/trust`, mcp, arcs, bots, workspaces, flavors, `surface.changed`) | [118](118-app-surface.md) | 3 | the app's S5 + S7 + S9; the trust route waits on Q-AS1 |
| K4 memory (inbox, layers, notes, daily, verbs, `memory.inbox`) | [118](118-app-surface.md) | 2 | the app's S6 expanded; inert when untrusted |

## Waiting on Jordan

| Call | Owner | What it frees |
|---|---|---|
| 118: Q-AS1 trust route as built (declares the workspace too, `reopens` from compose-time trust) · Q-AS2 body `confirmed: true` · Q-AS3 effort reset and title pin · Q-AS4 per-model lineage in the host · Q-AS5 `&only=session` · Q-AS6 one `surface.changed` · Q-AS8 `system` omitted from `/flavors` · generic port refusal as 409 · `memory.inbox` buckets or count only · a third `MemoryPort.trusted()` state for an undeclared workspace · `gate.preset` also as a process-level envelope | [118](118-app-surface.md) ledger | all built on the overlay's proposals; each is a small reversal |
| MCP: the CIMD document URL (dynamic registration until set) · auto-restart a server after `keywork mcp login` · DCR redirect port strictness | [117](117-influence-sweep.md) "MCP lane" | sign-in polish |
| Extensions: per-session hosting (recommended) vs single store · whether `keywork extensions` activates to report standing · `/extensions` with no pane as a summary line vs an overlay | [40](40-extensions.md) | reversals only |
| Thinking replay cut (Opus 4.5+ / Sonnet 4.6+ / Fable 5+ / Mythos 5+ versus the 5.5 generation only) · thinking-off requests on a preserving model · the live smoke on a post-2026-08-31 key | [70](70-anthropic.md) deviation 3, [117](117-influence-sweep.md) | built on the wider cut; a four-number edit narrows it; smoke closes the compliance sign-off |
| Cache warming: build the keyed off-by-default version or leave it | [117](117-influence-sweep.md) options note | recommendation is leave it |
| Extension host: activation order (project first, then user; Pi does the reverse) · `extension.notice` at `info` over SSE · hook deadline 10s · multi-session hosting shape · `host.observe(bus)` · bot tool restriction over extension tools | [40](40-extensions.md) | the product wiring lane |
| `memory forget` should also drop `curation.md` audit lines that mention the session | [95](95-memory-and-skills.md) | one rule in `forget.ts` |
| Feel polish: `ctrl+v` as the clipboard-image chord · `vi` as the POSIX editor fallback · cost in the title unfocused-only | [30](30-tui.md) C7 | rebinds only |
| V2.11 agent tool rows flip to ▓ | [96](96-conversation-enrichment.md) | one line plus five goldens |
| 117-3 Bun 1.4 · hold the first `Bun.*` product call (`tools/pty.ts`) until then? | [117](117-influence-sweep.md) | SW10; the probe makes the pty call harmless on Node |
| Persist injection origin (P2.6) · `keywork secret set` and plaintext migration (E9) | [80](80-p2-reach.md), [103](103-dsh-influence.md) | small follow-ups |
| Q-B6 bot briefing: own task or folded into J21 | [106](106-bots.md) | C68 part 2 (bot tag in memory pane and digest, `/bot <slug>` briefing), J21 arc briefing (spec only, three open questions) |
| Q-B3 global bot memory location · Q-B4 mid-session switch (look at Grok Bot first) · Q-B7 self-naming trigger | [106](106-bots.md) | built as assumptions; a no reverses them |
| J27 `self` level | [106](106-bots.md) | reads "not built yet, runs as notes" |
| Q-L1 to Q-L5 | [114](114-lsp.md) | all built on the recommendations; F5 read tools wait on a dogfooding note |
| Audit decision 5, shell drivers | [111](111-code-audit.md) | recommendation written (keep both); a yes closes R-05 with no code |
| Q-P1 needs-you stamp · C71-c main-area pins · C72-c heat candidates · C57 frame-budget bar | [113](113-arcs-and-chrome-wave.md), [112](112-feel-and-look-wave.md), [100](100-visual-craft.md) | render options, Jordan picks |
| Lens grammar Q1–Q9 | [102](102-instrument-grammar.md) | design session never scheduled |
| First tag, npm name, README one-liner, Linux walk | [`../launch-runway.md`](../launch-runway.md) | the launch button |
| Subagents Q-SA1 to Q-SA7 (off switch shape · four children per process · J6 recall scope for a child · a no to a child's ask keeps it going or ends it · the live child pane S5 next · removing a child alone restores it top-level · the name `delegate`) | [120](120-subagents.md) | phase two (S5 to S10) |
| Sandbox Q-E8-1 to Q-E8-7 (keep the "run unconfined until exit" yes or refuse strictly · terminal pane and `!cmd` under the mode · template `!\`cmd\`` under the mode · bubblewrap plus the sysctl on the ubuntu CI job so the live tests run · honour `CARGO_HOME` / `GOMODCACHE` / `npm_config_cache` · Plan mode under `isolated` · flip the Linux default to `workspace` after dogfooding) | [103](103-dsh-influence.md) E8 note | the Linux walk is the first real run of the runner |
| Permissions part 2: `last changed` on `GET /permissions` for attach · session grants into the ledger so pane, serve and REPL share one path · fall back to the local store when a server refuses the token | [50](50-trust.md) part 2 ledger | small follow-ups |
| Contract gate: also require a major bump when an operation id or event name disappears · comparing only `HEAD^` on a multi-commit fast-forward push | [118](118-app-surface.md) "Contract version gate" | a stricter script |
| Themes: polarity as a hard refusal in `parseTheme` or audit-only · keep `selection.text` as the one polarity-free pair (built that way) or refuse inverted selections like the app · the app drops `gallery.json` for house pair + `GET /themes`, or keeps the full sync · carry `minMarginLc` / `sectionMarginLc` per theme on `GET /themes` for the designer pane | [118](118-app-surface.md) "Theme parity" | the app can delete its derivation and audit copies once decided |
| Arcs as workstreams: give keywork-app the same alias table and empty-state line now, or wait for the shared-term call · render matched aliases in the tray (`arc · also workstream`, touches the discovery golden) · carry the synonym in the `/arc-new` tip instead of the `/arcs` description | [110](110-arcs-on-screen.md) "Workstream aliases" | app parity; a render choice |
| Contract: keywork-app should pin the `x-keywork-contract` major instead of `protocolVersion = "0.1.1"` (app repo) · enforce the version bump mechanically when a fixture changes, or leave it as prose · whether the `progress` delta is meant for external clients or gets filtered in `sse.ts` | [118](118-app-surface.md) "Contract hardening" | app attach check; a guardrail; one filter |
| Memory ledger: an approve writes its op and its audit echo a millisecond apart, so the top row of the ledger lens is sometimes the echo and `u` from the top does nothing; fix is a store clock seam or a sort that keeps the op above its echo | [95](95-memory-and-skills.md), found by the 2026-10-12 reliability lane | a one-key revert that always works |
| Windows: `taskkill /t` never reaches a `sleep` behind a forked Git Bash shape, so the bash tool's timeout leaks that grandchild and resolves through the 1 s fallback; a job object is the real fix and Bun has none | [`../windows.md`](../windows.md) | accept or find a job-object path |
| Local Bun is 1.3.9 against the 1.3.14 pin (Jordan installs) | [117](117-influence-sweep.md) 117-3 | the e2e harness Ctrl+C segfault |

## Parked by design

- FR6.17 subagent transparency: nothing to attach to until spawning exists ([101](101-feedback-round-4.md)).
- ~~FR4.11 ChatGPT provider: behind its ToS gate ([101](101-feedback-round-4.md)).~~ Landed: `cli/src/codex-login.ts` is wired into setup and the inference runtime, recorded in `NOTICE` (noticed stale 2026-10-02).
