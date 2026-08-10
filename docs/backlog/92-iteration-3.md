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
| A6 ask-flag | **done** (2026-08-10) | `Tool.mutates` marks write/edit/bash; `ToolGuard.confirm` pauses mutating calls — panes render a modal y/a/n ask row in the owning pane (`a` = allow for the pane's lifetime), chat asks via keypress; declines return an errored `declined by user` tool result to the model. Interim until J11's provenance-gated model replaces it. |

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
- **I6 (E1, 2pt):** OpenCode permission model — allow/ask/deny per tool category,
  glob-scoped bash rules, per-agent overrides. Pi supplies persistence (I5), OpenCode the
  rule engine. ADAPT.
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
