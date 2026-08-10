# Iteration 3 — Trust the Floor, Raise the Ceiling

> Authoritative overlay atop [`91-progress-and-feedback.md`](91-progress-and-feedback.md),
> 2026-08-09. Where this file speaks it wins; where silent, 91 → 90 → workstream files apply.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing before
> workstream G; Pi/OpenCode are MIT — adapt with attribution in `NOTICE`; Crush is FSL —
> never a source (no code, and since 2026-08-10 no design credits either).
> The user commits; agents never `git commit`/`git push`.
>
> **Platform priority (new, binding):** Linux is primary, Windows fully supported. When a
> design forks, Linux wins the default and Windows gets the accommodation.

## Ledger delta since 91 (verified, 158 tests green)

| ID | Status | Landed as |
|---|---|---|
| C0 | **done** | `AppProbe` (probe.ts) + workflows.test.ts — deterministic, renderer-free E2E harness over `AppCore`; 16 workflow tests. |
| C24 | **done** | Empty state renders with hints; split revives; `/exit` from last pane quits cleanly. |
| C25 | **done** | In-pane slash autocomplete over the registry, provider-free, ranked, Tab/Enter/Esc. |
| C26 | partial | Palette (ctrl+p) with fuzzy + shortcuts + dynamic `go-<session>` jump source; pane/file/pinned sections outstanding. |
| C27, C28 | **done** | Dock engine + full keyboard verbs (`leader d/D/u/./,`, `/dock-*`), property-tested. |
| D12 | **done** | Provider-free `/exit`, `/exit-all`, `/move-*` through the registry. |
| D13 | **done** | Onboarding auto-fires when no provider resolvable (TTY); `keywork setup` reusable. |
| C11 | partial→ | FilePane wired: `/open <path>` (args now flow through `CommandSpec.run`); summon-per-type chords still outstanding. |
| — | extra | `AppCore` extraction (pure state machine — the external-agent event surface), global `keywork` shim, 0600 key storage. |
| E3/E4 | **done** (2026-08-10) | Track S landed: `Checkpoints` (engine) — shadow-git snapshots per I3 (ADAPT recorded in `NOTICE`), undo/redo ring (limit 64, dup-skipping, serialized), captured once per send before the first mutating tool via the new `ToolGuard` seam on `Agent`; `/undo` + `/redo` in panes (status-bar notice) and chat. Ring is in-memory per session by design. Headless `keywork run` deliberately unguarded. |
| Track V | **done** (2026-08-10) | C7/C12 completion: `InputBuffer` (own editor core — cursor, line nav, home/end, newline) behind `ConversationModel`; shift+enter multiline with a real cursor in the prompt; input history (up/down at empty prompt, browse exits on edit, ring 50); transcript scrollback (pageup/pagedown + wheel via `Pane.handleMouse`, clamp-at-render like `FileModel`, esc snaps to live, dim "↓ n more" marker row); tool blocks collapsed to one in-place-settling line (`· name args` → `✓ name — result`); enter-while-busy queues (`⋯` dim entry, drains FIFO on complete/interrupt/error — esc-then-queued is the interim steer). Deferred to I4: $EDITOR escape, kill-ring, undo-stack, word-nav from pi-tui. |
| Track Q | **done** (2026-08-10) | All four quirks resolved by decision. (1) Second `ctrl+k` while armed disarms; sticky re-arm now carries a chain scope — only sticky actions continue the chain, `chainable: true` actions (browser.summon) fire once without re-arming, and anything else falls through as a fresh press, so `/` after a nav chain starts slash input while fresh `leader /` still opens help; unresolved keys during a chain fall through too (explicit arm stays modal and cancels). (2) Split from a docked pane opens into the main tree via `focusMainArea`, mirroring file opens. (3) `leader x` on the last pane quits — `closePane` owns the /exit semantics and the command delegates; empty-state view retained as defensive rendering only. (4) **Affirmed, not changed:** the dock is one column; d/D dock the pane and choose the column's edge — per-pane dual docks deferred to the dock-identity work. |
| QA pass | **done** (2026-08-10) | Session-wide quality pass (manual audit + multi-agent /code-review, adversarially verified). Fixed: uninterruptible queued turn (Agent.send finally clobbered a re-entrant turn's AbortController — ownership guard + hang-detecting regression test); queued prompts moved OUT of the transcript (model.queued() + dim ⋯ rows in the pane — fixes multi-queue order inversion and makes dispose-clearing trivial); dispose() clears the queue, denies a pending ask, and interrupts (no zombie sends on pane close); InputBuffer.home() no longer jumps forward past a leading newline (lastIndexOf clamping); esc snaps scrollback to live BEFORE it interrupts a busy turn; scrolled marker renders from the post-clamp value (no "↓ 0 more"); per-entry wrap cache (WeakMap keyed on width+text+failed) ends full-transcript rewrap per keystroke; Checkpoints strips only repo-state GIT_* vars (precise denylist keeps GIT_EXEC_PATH/GIT_SSH/GIT_CONFIG_* working, hostile-env test); leaderArmed derives from Keymap.armed(now) with a renderer-side expiry timer (no stale accent border); shared wheelSteps() in pointer.ts. Refuted with pinning tests: all-docked split lands in main (tree is undefined when all panes docked); esc-during-ask = deny + stop stays as designed. |
| A6 ask-flag | **done** (2026-08-10) | `Tool.mutates` marks write/edit/bash; `ToolGuard.confirm` pauses mutating calls — panes render a modal y/a/n ask row in the owning pane (`a` = allow for the pane's lifetime), chat asks via keypress; declines return an errored `declined by user` tool result to the model. Interim until J11's provenance-gated model replaces it. |
| Track T | **done** (2026-08-10) | B1–B8 landed on Pi's version-3 entry vocabulary per I1/I2 (ADAPT in `NOTICE`). B1: `session/entries.ts` — full entry union (message/compaction/branch_summary/label/session_info/custom/custom_message/thinking_level_change/model_change, id/parentId/timestamp), legacy-header migration, hand-written Pi-format fixture pinned in `pi-format.test.ts`. B4: `branch(fromId)` in-file forks + `clone()` into a fresh session with `parentSession` header; both branches independently continuable (tested). B5: labels as persisted entries (set/clear/lookup/fork-at-label). B6: `tree()` → `SessionTreeNode[]` (children, labels, active-path flags) + `keywork sessions list|tree|fork` CLI. B7: `compaction.ts` per Pi's algorithm — reserve/keep-recent settings, backward cut walk at message boundaries (never tool results), iterative summaries folding the previous one, cumulative file tracking; callable seam (`compactSession`) + `/compact [instructions]` in chat, mock-provider tested, branch-isolated. B8: `stats()` (entries/messages/branch points/labels/compactions/token usage/timestamps), surfaced in `/session` and the list API. B2 completion: `--resume <id>` (prefix match) wired through chat; session list API (id/title/mtime/message count). B3 completion: `replaySession` re-emits historical bus events flagged `replay: true` from the compaction-aware context (event-parity test vs a live run); chat wires it on resume. Deferred: split-turn dual summaries, auto-compaction trigger on the agent loop, cost figures (no pricing table yet), lazy branch-switch summary generation (entry type + `appendBranchSummary` exist). |

| Track P | **done** (2026-08-10) | Workspace persistence: `~/.keywork/workspaces/<hash>.json` keyed by `workspaceIdentity(cwd)` (cwd-hash today, the J1 seam — swap the identity function, nothing else moves). `Layout.toJSON/parse/load` serialize tree shape + split ratios + dock side/ratio/order + focus (zoom never persisted); `workspace-state.ts` wraps it with versioned pane descriptors (conversation → sessionId, file → path, browser → root only — expansion state absent per C31) and discards corrupt/version-mismatched files wholesale. `AppCore` saves through an injectable `saveWorkspace` on every layout/descriptor change (fingerprint-deduped) and on shutdown; cli side debounces (500ms) with flush-on-exit. Restore on `keywork panes` revives panes via the existing factories, reattaches sessions through a `SessionPort` (open-by-id / create; panes mode is now session-backed — turns append to the store, resumes seed history + replay), and skips missing sessions/files/throwing factories without crashing; `--fresh` opts out of loading while still saving. Probe round-trip, revival-degradation, save-trigger, and corrupt-file tests in workflows/layout/workspace-state/cli suites. Deferred: dock-pane session persistence needs nothing extra; per-pane scroll positions and input drafts deliberately not persisted. |
| B2 note | — | The `--resume`/session-list half of Track P landed with Track T (see above); not redone here. |
| Bedrock provider | **done** (2026-08-10) | `BedrockProvider` (engine `providers/bedrock/`) speaking Bedrock ConverseStream, OWN work from AWS public API docs, zero new dependencies: hand-rolled SigV4 signing (`node:crypto`, pinned to the official aws-sig-v4 get-vanilla test vector) + incremental `vnd.amazon.eventstream` binary parser (prelude/message CRC32 validated, 1MiB frame ceiling, arbitrary chunk boundaries). Engine deltas match the SSE provider's contract exactly (text deltas streamed, tool calls assembled from partial-JSON input deltas and emitted before `done`, usage from `metadata`); stream exceptions are typed with self-declared transience (`throttling`/`serviceUnavailable`/`modelStreamError`/`internalServerException` retry via `RetryingProvider`). Catalog resolves bedrock after the API-key providers from AWS env credentials + region; endpoint is derived from the region alone (validated shape; new `bedrockRegion` config option, user layer only — config can never supply a base URL). Provider is model-agnostic and ships with Nova/Llama ids only — **Anthropic model IDs stay out until G1**. Deferred: AWS profile/SSO/IMDS credential chain (env creds only), `inferenceConfig` knobs, `reasoningContent` mapping, cross-region inference profiles. |
| J4 retrieval kernel | **done** (2026-08-10) | Hybrid retrieval over the vault: `memory/search.ts` — own BM25 lexical leg (field-weighted title/aliases×3, in-memory disposable index per R1; no SQLite dependency at vault scale), injectable `EmbeddingsPort` semantic leg (content-keyed vector cache, only changed notes re-embed), RRF fusion (k=60) with per-hit leg attribution; `RetrievalSource` surfaced for the J4 mandatory-familiarity disclosure (`lexical` / `hybrid:<id>` / `lexical-degraded` with reason — embed failure never loses lexical results); superseded notes hard-floored below successors per F2 (usefulness never enters ranking); untrusted vault fully inert per P1. Provider-matched embedding wiring + onboarding disclosure land with the config/onboarding slice; graph/PPR third leg (J12) later. |
| V2 outline | drafted (2026-08-10) | `96-conversation-enrichment.md` — streaming-feed/conversation-pane enrichment overlay: 12 sized candidates (tool tail-follow, diff-preview ask, markdown, thinking blocks, context/cost HUD, queue editing, @-mentions, `!` escape, recall citations, retrieval disclosure, provenance gutter, OSC) bound to design-language principles; unadopted until the coding-agent nuance survey (`docs/research/coding-agent-nuances.md`, in flight) merges. |
| J5+J8 | **done** (2026-08-10) | Recall surface + pre-compaction flush (`memory/recall-tools.ts`, `bootstrap.ts`, `flush.ts`): `memory_search`/`memory_get` as non-mutating core tools (untrusted vault fully inert, superseded hits annotated, daily-log leg fused with note hits); `bootstrapMemory` resolves MEMORY.md per layer with per-layer token budgets, whole-notes-only, pinned-first then most-useful (R4); `MemoryFlush.maybeFlush` runs one silent provider turn (bypasses the bus — silent by construction) at a reserve threshold that opens before `shouldCompact`, flush prompt asks about wrongness, `NO_REPLY` escape, single-fire latch re-armed by `compactionCompleted()`; flush turns persist to JSONL (honest replay) and `replaySession` suppresses them from rendering. Both acceptance E2Es proven (ordinary-write → fresh-session recall; flush survives compaction into a new session). Deferred: F4 session overlay, bus-level `silent` flag. |
| J7 kernel | **done** (2026-08-10) | Gardener (`memory/gardener.ts`) + `ReviewInbox` (`memory/inbox.ts`, R3's one inbox at `<vault>/.staging/inbox.json`): score-gated promotion from daily logs behind a structural taint gate (untrusted entries filtered before the `CurationJudgmentPort` sees them; returned proposals re-validated — tainted/hallucinated/hostile-title refs rejected); merge/contradiction/supersession over Jaccard candidate pairs, auto-action only for agent↔agent above threshold, everything else → inbox proposal; usefulness EMA (α=0.3) with per-session anti-gaming cap, stamped only on agent notes, feeding bootstrap selection (per the fifth-pass F2 resolution it stays OUT of search ranking); unlinked-mention link proposals (never auto-edits); one audit entry per sweep; sweep idempotent; untrusted store inert; human-authored files provably untouchable under a malicious port. Deferred: graph duties → J12, skills telemetry → J10, persistent recall ledger → J13. |
| J9 pane | **done** (2026-08-10) | Memory pane (`tui/memory-pane-model.ts` + `memory-pane.ts`, session-tree architecture): scopes at a glance, curing ramp `░▒▓█` with `~`-prefixed fresh notes, provenance glyphs, the one review inbox (airlock digest surface) keyboard-drainable (`a`/`d`), Gardener tile-fill activity line, recent recalls with staleness annotation, focused-note backlinks + local 1–2-hop outline (never global), calm zero-state; 500-step randomized cursor-invariant property test. Wired: `/memory` + `leader m`, `memory` workspace descriptor persists/revives, probe pass-through, cli `memoryPanePort` over MemoryStore/ReviewInbox (untrusted vault = calm emptiness). Deferred: `[[` autocomplete (no text-input surface yet), unlinked-mention/orphan lint rendering, recalls/Gardener live feeds (await J13 recall ledger). |
| V2.1/V2.2/V2.13 | **done** (2026-08-10) | Conversation-pane opening trio per `96-conversation-enrichment.md`: **V2.1** live tool tail-follow (`tail-follow.ts` — ≤3-line sanitized bounded tail, `\r` rewrite handling, density-ramp progress mark; render-only: bus `tool.output` taps bash stdout/stderr, model still sees only final output; wired to stdout in chat and JSONL events in run); **V2.2** diff preview in the y/a/n ask (`diff-render.ts` — own LCS unified diff, bounded/scrollable window, new-file/deletion/no-op/CRLF handled, truthful notes on unreadable targets); **V2.13** empty-input Esc-Esc backtrack over prior prompts with transcript highlight → edit-and-fork through the B4 tree seam with draft preloaded (busy = interrupt first; failures render truthfully). Remaining for V2.13: checkpoint-paired file restore (needs per-turn checkpoint tags + `Checkpoints.restoreTo`); $EDITOR diff editing → I4. |
| E2 | **done** (2026-08-10) | Permission presets (`shared/trust/presets.ts`): `careful · standard · open` as plain policy bundles (`standard` = the empty bundle ≡ engine's built-in posture, so fresh installs honestly read `standard`); active preset **derived** from the live matrix by semantic rule-set equality — any divergence → `custom`, never a preset name (errs only toward `custom`); `requiresConfirmation` true when loosening and always when leaving `custom`. Wired live: mutable policy ref behind a stable resolver (`cli/presets.ts`), `/preset` in chat with y/n confirmation, panes status line shows `provider · activePreset` recomputed per render. Deferred: TUI `/preset` switching (needs confirmation overlay). |
| D5/D6/D7 | **done** (2026-08-10) | Markdown extensibility (`engine/extensions/`): D5 commands (`.keywork/commands/*.md` user+project, OpenCode format in NOTICE; templates tokenized into segments BEFORE substitution so `$ARGUMENTS` can never smuggle interpolations; `@file` through the root-jail; `` !`cmd` `` runs as a synthetic bash call through the real mutation guard — no parallel executor); D6 agents (`tools:` allowlist filter-only + `allow/ask/deny` overrides that narrow but provably never widen; `/agent` rebuilds mid-session; flat-list frontmatter is a deliberate deviation from OpenCode's nested maps); D7 skills (`.keywork/`+`.claude/`+`.cursor/skills/` walk, symlink-cycle safe, one `skill` tool). Untrusted repo contributes zero commands/agents/skills; precedence built-in > project > user. Palette-wired (see integration row). Deferred: `model:` frontmatter → provider switching (needs provider-factory seam, G1-adjacent), nested command names. |
| D8/D10 | **done** (2026-08-10) | MCP client (`engine/mcp/`), hand-rolled zero-dep (Bedrock precedent): stdio JSON-RPC 2.0 client (handshake 2025-06-18, paginated tools/list, tools/call, per-request timeout, garbage-tolerant parser, stderr folded into exit errors); `McpRegistry` — connecting→connected→down lifecycle, crash restart with 500ms…8s backoff storm-capped to manual, generation counters kill stale completions; D10 lazy surface: only `mcp_tool_search` exposed with a LIVE roster description, fetch activates tools mid-turn via `surface(base)` live arrays; measured token test: 3 connected servers < 200 tokens pre-fetch; every activated tool carries `{server, trusted}` provenance + `onToolResult` external-content callback (P2 taint hook). In-repo fixture server with hostile profiles. Deferred: D9 http/sse (seam = `McpConnection`). |
| D14 | **done** (2026-08-10) | MCP status dock pane (`tui/mcp-pane-model.ts`/`mcp-pane.ts`, session-tree architecture): density-ramp states (`█`/`▒`/`░`), tile-fill progress mark (▛ = failed, no spinner), per-server inline menu (restart / enable-disable / tools listing with retry), calm zero state, 400-op cursor property test. Wired: `/mcp` summon, startup auto-dock right when ≥1 server configured (zero config ⇒ never constructed), workspace revive, push-based live updates via port `subscribe`, one dim notice per connected→down transition (needs-you-only). `progress` honest-undefined until the registry exposes handshake stages. |
| TUI lifecycle | **done** (2026-08-10) | Async seams closing Wave 5's gaps: awaited serialized after-turn hook in the model's deliver chain + `runApp` shutdown awaiting closers (5s bound, closeOnce latch, errors to stderr). Flush now runs in panes (per-session `MemoryFlush`, same-bus agent rebuild), Gardener sweep once at shutdown, recall tap late-bound to pane session ids, `/preset` overlay picker with y/n loosening confirmation (takes precedence over pending ask, tested), V2.10 retrieval disclosure end-to-end (one-time dim line naming the embedding source; silent-lexical today since no embeddings provider is wired — the seam is fully tested). Honest note: panes have no compaction trigger yet, so `compactionCompleted()` re-arm awaits a TUI compaction path. |
| V2.13 restore | **done** (2026-08-10) | Checkpoint-paired backtrack-fork completed: `Checkpoints.captureTree()` (capture keeps its void signature), `restoreTo(tree)` (hash-shape + cat-file validated, typed `UnknownCheckpointError`, serialized, snapshots current state first so restore is UNDOABLE), `takeTurnTag()` consumable first-capture-since-last-take; `MessageEntry.checkpoint?` optional tag surviving disk/branch()/clone() with the Pi compat fixture green; `checkpointForPrompt` ordinal lookup. Wired through both persist paths (chat `persistNewMessages`, panes `attachmentOf` tag source) and the TUI fork: restorable → files restored + quiet note; untagged → "file state unchanged"; restore failure → fork survives, truthful error note. Deferred: per-pane turn-tag isolation under concurrent multi-pane turns (shared Checkpoints mints one tag). |
| Wave 6 integration | **done** (2026-08-10) | Cross-lane wiring: checkpoint tag sources into both persist paths + fork-restore; MCP registry in chat/run/panes with live `surface()` arrays and `stop()` on every exit path (TUI via closers); D14 pane registered end-to-end with registry→pane adapter (`cli/mcp.ts`); palette surfacing of extension commands (through the pane's real tool-confirm surface; declined shell ⇒ calm notice, no turn), agent switching per pane (shared-bus rebuild, refused mid-turn), skills into every pane agent; extensions bridge deleted in favor of `@keywork/engine` imports. Honest gaps: `$ARGUMENTS` commands excluded from palette (no argument-input UX; fully usable as `/name args` in panes), agent-switch entries visible without a provider (refused with notice). Gate: 1047 tests / 73 files, checks green. |
| Wave 5 integration | **done** (2026-08-10) | Cross-lane wiring: recall tools + bootstrap injection + flush loop + Gardener sweep-on-close in chat (`cli/memory.ts`); memory pane registered end-to-end (descriptor, revive, probe, port); bash `tool.output` tap through `coreTools(cwd, memory?, onToolOutput?)`; `RecallListener` seam feeds `recordRecall`; `listStaged` hardened to require the `.json`+`.md` pair (inbox.json collision fix). Honest gaps: flush/sweep and `/preset` are chat-REPL-only — the TUI turn loop and `runApp`'s synchronous `onExit` have no awaitable after-turn/on-close seam yet (unblock: async lifecycle hooks in `runApp`); recall tap needs a session id so panes/headless pass tools untapped. Gate: 864 tests / 61 files, checks green. |
| C13 | mostly done (2026-08-10) | Session-tree pane over Track T's `tree()` API: pure `SessionTreeModel` (windowed flattened outline, indent only under branch points, collapse/expand, path-anchored cursor surviving refresh, inline label editor) + `SessionTreePane` (chrome, entry-count title, `●/○` active-path markers, `▸/▾` branch glyphs); `/tree` command + `leader t` summon-or-focus, opens docked (browser precedent); `f` fork → `PaneIntents.openSession` → new session-backed conversation pane (fork attachments pre-opened so history seeds the agent); `session-tree` workspace descriptor persists/revives. Injected `SessionTreePort` is TUI-side only — the cli `sessionPort`-style disk implementation is the remaining wiring (cli was owned elsewhere this wave). Jump-to-node deferred honestly: switching a live pane's branch requires rebinding the agent's seeded history mid-flight — lands with the steer/agent-rebuild seam. Unit + property + probe workflow tests. |

## The shape of this iteration

Two themes, run as parallel tracks sized for multi-agent workloads. Every track lands with
probe-harness workflow tests — that is what makes the parallelism safe.

**Theme 1 — Trust the floor (overdue safety + persistence).** We are dogfooding daily with
no undo and no restart survival. That debt goes first.

**Theme 2 — Raise the ceiling (the session-management differentiator).** Multi-session and
cross-session management is the identity bet; this iteration makes sessions durable,
navigable, and forkable.

## Tracks

### Track S — Safety net *(first; blocks nothing, protects everything)*
- **E3/E4** git-snapshot checkpoints + `/undo` — snapshot before each tool-mutating turn,
  restore on demand. *(3pt)*
- **A6 interim ask-flag** — hardcoded ask-before-bash/write confirmation until the E-stream
  trust ladder exists. *(1pt)*

### Track P — Workspace persistence *(the "it remembers" moment)*
- **Workspace state file** per project (`~/.keywork/workspaces/<hash>.json`): layout tree,
  dock side/ratio, pane types + session ids, focused pane. Restore on `keywork panes`
  launch; `--fresh` opts out. *(3pt)*
- **B2 completion** — `--resume <id>`, session list API; palette section "recent sessions"
  (feeds C26). *(2pt)*

### Track T — Session tree (B4–B8)
- Fork/clone from any point, labels, tree read API, compaction, stats — the Pi-format
  JSONL tree made real, unlocking the session-tree pane (C13) next iteration. *(5pt)*

### Track V — Conversation pane completion (C7/C12)
- Multiline input (shift+enter), input history (up/down at empty prompt), scrollback for
  long transcripts, collapsed tool blocks, steer-vs-queue on busy. *(4pt)*

### Track Q — Quirk fixes *(all documented as current behavior in workflows.test.ts)*
- Sticky-leader greed: explicit second `ctrl+k` while armed should disarm, not act as
  `leader k`; `/` while armed should start slash input, not help. *(1pt)*
- Split-while-docked grows the dock — new panes should open into the main tree. *(1pt)*
- `leader x` on the last pane strands a paneless app — align with `/exit` semantics
  (C24 empty state stays for deliberate closes only if we choose; decide + test). *(1pt)*
- `shift+d` moves the whole dock; wanted-per-pane or wanted-global — decide + test. *(1pt)*

### Track L — Linux-primary validation
- Full manual pass on Linux terminals (kitty, alacritty, foot): Kitty keyboard protocol,
  key-release filtering, colors, resize. Fix what breaks; record findings. *(2pt)*
- Packaging seed (G3 slice): `bun link` flow verified on Linux; `keywork` bin story
  documented. *(1pt)*

### Track I — Influencer leverage *(from the 2026-08-09 research pass)*

Correction of record: Pi's source monorepo is **`earendil-works/pi-mono`** (not
`earendil-works/pi`); the installed npm package (`@earendil-works/pi-coding-agent`
v0.84.1, on this machine) is a verified local reference. OpenCode file paths are from the
dossier era — re-verify at lift time. Every ADAPT lands with its `NOTICE` Adaptations line
in the same PR.

Items that merge into this iteration's tracks (do these as part of the track work):
- **I1 → Track T:** Pi's session entry vocabulary (`session-manager.ts`: version 3; entry
  union incl. `compaction`/`branch_summary`/`label`; tree API) is the exact B4–B8 contract —
  pin it as the B1 Pi-fixture compatibility test. ADAPT. *(counted in T)*
- **I2 → Track T:** Pi's compaction + branch-summarization algorithm (`docs/compaction.md`:
  reserve-token trigger, keep-recent cut walk, iterative structured summaries, cumulative
  file tracking). B7 + future C13 land together off it. ADAPT. *(counted in T)*
- **I3 → Track S:** OpenCode's snapshot mechanism for E3/E4 — separate `GIT_DIR` under the
  data dir with `--work-tree` at the project; `add -A` + `write-tree` per checkpoint,
  `read-tree`/`checkout-index` to restore. Never touches the user's real git state. ADAPT.
  *(counted in S)*
- **I4 → Track V:** pi-tui's renderer-independent editor internals for C7 — `$EDITOR`
  escape, undo-stack, kill-ring, word-navigation. Contracts/internals only; never rendering
  code into OpenTUI. ADAPT. *(counted in V)*

New backlog entries (next iterations, sequenced by existing IDs):
- **I5 (E6, 1–2pt):** Pi `ProjectTrustStore`/`resolveProjectTrusted` — per-path persisted
  tri-state trust, cwd-is-$HOME handling, session-only trust. E6's design already
  edge-cased. ADAPT.
  **Landed (2026-08-10):** `TrustStore` in `packages/shared/src/trust/store.ts` (NOTICE
  Pi entry) — `~/.keywork/trust.json`, nearest-ancestor resolution, $HOME/root decisions
  never blanket children, session-only grants shadow persisted ones; `loadConfig` takes
  `projectTrusted` and ignores the project layer entirely (unread) until trusted;
  `keywork trust`/`untrust` CLI; first-open TUI overlay still open.
- **I6 (E1, 2pt):** OpenCode permission model — allow/ask/deny per tool category,
  glob-scoped bash rules, per-agent overrides. Pi supplies persistence (I5), OpenCode the
  rule engine. ADAPT.
  **Landed (2026-08-10):** `permissionPolicy` in `packages/shared/src/trust/permissions.ts`
  (NOTICE OpenCode entry) + `permissions` schema field; `Agent` resolves the verdict before
  the interim guard ask. Bash rules: most literal characters wins, first declared breaks
  ties; commands containing `; & | < > \` $ ( )` or newlines can only match deny rules.
  Per-agent overrides await D6 agents.
- **I7 (D1–D3, 2–3pt):** Pi extension host contract — `ExtensionAPI` (`registerTool` with
  render hooks + `details` state reconstruction, `registerCommand`, `appendEntry` replayable
  state); installed `docs/extensions.md` is the D2 event-taxonomy spec. ADAPT types/taxonomy.
- **I8 (A5/P2, 1pt now):** name keywork's bus vocabulary with Pi's RPC event names
  (`agent_start/end/settled`, `message_update`, `tool_execution_*`) so the P2 wire format
  becomes a codec, not a redesign; closes the `docs/events.md` gap. ADOPT vocabulary.
- **I9 (C18, 1pt):** Pi `FooterDataProvider` — debounced git-branch watching that handles
  worktrees, detached HEAD, and reftable repos; extension-status registry. ADAPT data layer,
  OWN rendering.
- **I10 (D5/D6, 1–2pt):** OpenCode markdown commands/agents format — `$ARGUMENTS`,
  `` !`cmd` `` (gated behind trust), `@file`, frontmatter. Format is the lift. ADAPT.
- **I11 (C4/C23, 1pt):** Pi keybindings config schema + live reload semantics (namespaced
  action IDs, single-or-array values). ADAPT schema only.
- **I12 (E5/robustness, 1pt each):** Pi tool hardening — output truncation budgets,
  `withFileMutationQueue` (serializes concurrent file mutations — directly relevant to
  multi-pane parallel agents), `createReadOnlyToolDefinitions` (Plan-mode toolset). ADAPT.
- **I13 (C17, 2pt):** OpenCode `system` theme — terminal-derived grayscale ramp via
  OSC 10/11 + ANSI reuse. Spec-level ADOPT (their TUI was rewritten; old code stale).
- **I14 (C20, 1pt):** Models.dev *metadata* for cost hints — without adopting the AI SDK.

Crush intake retired (2026-08-10 decision): the items once slated as Crush-idea
reimplementations — G6 notifications, D7 cross-agent skill-dir discovery, A17 tailable
project-local log, F4 LSP registration UX — are `OWN` designs from first principles. G6
notifications in particular will derive from keywork's own work-management model rather
than a flat mode enum.

Anti-regression notes (where the influencers are worse — do not import):
Pi's tool count has drifted to 7 + find/grep/ls (stop citing "Pi has 4 tools"; additions
are deliberate D2 decisions); OpenCode's single-column no-tiling TUI (lift overlay patterns
only); OpenCode's heavy stack (Effect/Drizzle/AI SDK — our 200-line raw-fetch provider
stays); OpenCode's mandatory client/server split (D7 in-process bus with wire-ready names
wins for v1); Pi's zero-safety defaults (no permissions, no undo — our E-stream stance is
strictly better). Pi's auth/oauth modules and OpenCode's provider auth flows are excluded
per guardrail — never studied, never ported.

## Sequencing

1. Track S alone, first — small, and everything after it is safer.
2. Tracks P, T, V, Q in parallel (four agents; disjoint files: persistence vs session store
   vs conversation-model vs keymap/layout). Probe workflows are the merge gate.
3. Track L + Track I as they become concrete.

**Exit criteria for the iteration:** restart `keywork panes` and find your layout and
sessions where you left them; fork a session and see both branches; `/undo` a bad tool turn;
all four quirks resolved by decision (fixed or affirmed with rationale); gate green on
Linux CI and a real Linux terminal.
