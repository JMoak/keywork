# Progress Ledger & User-Feedback Tasks

> Authoritative overlay, companion to [`90-plan-review.md`](90-plan-review.md), 2026-08-09.
> Two jobs: (a) an honest **completed ledger** mapping the working tree (108 tests green) onto
> backlog IDs, and (b) **new tasks from first-hands-on user feedback**, with IDs continuing the
> existing schemes (C24+, D12+). Where this file marks status, resizes, or resequences, it wins
> over the workstream files; where it is silent, `90-plan-review.md` then the workstream files
> apply. Integrate physically at the next planning pass.
>
> **Standing guardrails (unchanged):** no Anthropic wiring of any kind before workstream G;
> API-key / Agent-SDK only, ever; no subscription-OAuth code paths ported from any source.
> Pi/OpenCode are MIT — lift with attribution in `NOTICE`; Crush is FSL — never a source
> (no code ever, and since 2026-08-10 no design credits either — those features are `OWN`).

## Completed ledger (verified against the working tree)

Status vocabulary: **done** = acceptance criteria met, tests green · **partial** = usable
subset landed, remainder listed · **—** = not started.

| ID | Status | Notes |
|---|---|---|
| M0.1–M0.6 | done | Monorepo, pins, AGENTS/NOTICE, Biome, CI (incl. the resequenced guardrail grep from 90 §Resequencing), config foundation. |
| A1 | partial | Message/turn model live; **image parts** and the Anthropic-shaped paper-fixture round-trip (90 §Resequencing) outstanding. |
| A2 | done | Landed inside A6/A8 rather than as a standalone task; steer-abort tests prove mid-stream cancellation. |
| A3 | done | Mock provider drives the whole test suite. |
| A4 | done | Typed bus. |
| A5 | partial | Bus event types exist; `docs/events.md` vocabulary doc not written — names are becoming de-facto API without the bikeshed pass. |
| A6 | done | Agent loop. |
| A7 | done | System prompt. |
| A8 | done | Interrupt/steer (Esc in chat; wired into ConversationPane). |
| A9–A12 | done | Four tools; A12 ships the Git Bash → PowerShell fallback per spec. |
| A13 | done | `keywork run` headless CLI. |
| A14 | done | OpenAI-compatible + OpenRouter via raw fetch/SSE; no OAuth anywhere. |
| A15 | done | Usage totals surfaced in chat. |
| A16 | done | Retry/resilience taxonomy with fault-injection tests. |
| A17 | — | Diagnostics logging. |
| B1 | partial | JSONL **parent-chain** store; full tree semantics (branch points beyond a single chain, Pi-fixture compatibility test) outstanding. |
| B2 | partial | Session dirs + `--continue` resume in chat; `--resume <id>` and list APIs outstanding. |
| B3 | partial | Replay reconstructs the chain for resume; replay-as-bus-events with `replay: true` (the D3 extension contract) outstanding. |
| B4–B8 | — | Fork/clone, labels, tree data, compaction, stats. |
| C0 | — | **TUI E2E harness spike still unbuilt** — the risk 90 flagged; C-stream is now well ahead of its own test infrastructure. |
| C1 | partial | `keywork panes` boots a full-screen multi-pane app; crash-safe restore + error boundary not hardened to C1's acceptance bar. |
| C2 | — | Render discipline / perf budgets. |
| C3 | done | Keymap engine: chords, **leader `ctrl+k`** + sticky nav mode. Note: shipped leader differs from the C3 default (`ctrl+x`) — a C23 keymap-spec input, not a bug. |
| C4 | — | Keybinding hot reload. |
| C5 | — | Command palette (now superseded in scope by C26 below; C5's acceptance folds into it). |
| C6 | done | Hotkeys overlay (leader `/`), rendered from the live keymap. |
| C7 | partial | Prompt input works; multiline/history/`$EDITOR` escape outstanding. |
| C8 | done | Dwindle layout tree with property tests. |
| C9 | partial | Directional nav via sticky nav mode; directional **swap/move** partially present (the /move aliases in D12 formalize the verbs). |
| C10 | — | Zoom & layout cycle. |
| C11 | partial | Generic Pane contract + registry seed; summon-per-type chords outstanding. |
| C12 | partial | ConversationPane streams with agent+session per pane (= multi-session); markdown/code rendering, collapsed tool blocks, steer-vs-queue keys, scroll perf outstanding. |
| C13–C15a | — | Session-tree, diff, terminal-spike panes. |
| C16 | done | Theme system: tokens, `keywork-night` (Tokyo-Night purple) default, config overrides. |
| C17 | — | `system` terminal-derived theme. |
| C18 | — | Status line. |
| C19 | partial | `keywork setup` writes apiKeys to user config — the guided-key-setup half; the in-TUI welcome surface outstanding (and now auto-triggered per D13). |
| C20–C23 | — | Model picker, @file/paste, deep links, keymap spec. |
| D0–D11 | — | D-stream untouched; **D0 is now the critical path** for the feedback tasks below and is pulled forward (see Resequencing). |
| E1–E6 | — | Trust & safety untouched — including the interim hardcoded ask-before-bash/write flag 90 attached to A6. Flagged, not forgotten. |
| F, G, P2 | — | As planned (G-gated guardrail intact). |

Unplanned extras that landed without a backlog ID (recorded here so the ledger stays honest):
auto kebab-case session titles via `suggestTitle` (nearest home: B2 polish); `keywork chat` v2
as the interactive CLI surface (an A13 sibling, kept as the engine's manual smoke harness).

## New tasks from user feedback

IDs continue the existing schemes. Same point scale and style as the workstream files.

### C24 (1pt) — No-window empty state
Closing the final pane must never strand or crash the app: render a deliberate empty state
(logo/hint surface) with visible paths back — new-pane binding, quick menu (C26), and `/exit`
semantics from D12 (last-pane `/exit` closes the app cleanly).
**Accept:** close every pane → empty state renders; new-pane key restores a working layout;
quitting from the empty state restores the terminal cleanly (C1 discipline).
**Strategy:** `OWN`.

### C25 (2pt) — In-pane slash autocomplete
`/` in the prompt opens inline, relevance-ranked completion over the D0 registry:
prefix + fuzzy match, recency boost, descriptions inline, Tab/Enter accept, Esc dismiss.
Must work **with no provider configured** — completion is registry-driven, never model-driven.
**Accept:** with zero apiKeys resolvable, `/ex` ranks `/exit` then `/exitall` with
descriptions; accepted command dispatches through D0; ranking unit-tested.
**Strategy:** `LIFT:opencode` completion UI patterns; `OWN` ranking.

### C26 (3pt) — Quick menu & quick-commands palette (supersedes C5)
The IDE-grade Ctrl+P-style surface: one overlay, fuzzy search across **commands, panes,
sessions, and files**, keeping C5's palette-as-docs rule (every row shows its live binding)
and recently-used ranking, plus keywork-unique sections: jump-to-pane by title, session
switch (the B6/C5 palette-reachability fix from 90), theme/agent quick-switch, and
user-customizable pinned entries via config (M0.6 schema, `.describe()` justified).
**Accept:** opens via chord; fuzzy tests per section; rebind reflects in rows; pinned entries
round-trip config; usable with no provider configured.
**Strategy:** `LIFT:opencode` palette; Omarchy palette-as-docs; `OWN` sections.

### C27 (2pt) — Dock layout engine *(in flight)*
Extend `layout.ts`: a full-height dock column locked to the left or right viewport edge,
width-adjustable, holding a vertical stack of panes; panes move between dock and the dwindle
tree; the tree re-balances around the dock ("outer viewport rectangular locking"). Being
built now by another agent — this ID gives that work its address.
**Accept:** property tests extended — dock + tree remain gapless/overlap-free through any
move/resize/close sequence; empty dock collapses; C8 invariants still hold.
**Strategy:** `OWN` (C8 companion).

### C28 (2pt) — Dock UI integration
Keyboard verbs and rendering over C27: move-focused-pane-to-dock chord, in-dock stack
navigation and reorder, dock width resize keys, dock state persisted per project, `/move-*`
(D12) aware of dock edges.
**Accept:** E2E (C0 harness or interim snapshot test): pane docks, stacks, navigates,
resizes, survives restart; nav between dock and tree stays geometric (C9).
**Strategy:** `OWN`.

### D12 (1pt) — Provider-free built-in commands
First residents of the D0 registry, all functional with no provider configured: `/exit`
(closes focused pane; from the last pane, exits the app), `/exitall` (exits immediately),
`/move-right` `/move-left` `/move-up` `/move-down` (aliases of the C9 nav/swap verbs, so the
grammar is reachable by name as well as by chord).
**Accept:** each command dispatches through D0 in tests without any provider; last-pane
`/exit` path covered together with C24.
**Strategy:** `OWN` on D0.

### D13 (1pt) — `/onboarding` & auto-trigger
Register onboarding as a D0 command reusing the `keywork setup` flow in-TUI; **auto-fires on
app start when no key-like credential is resolvable** (env or config), landing the user in
guided setup instead of a dead prompt; dismissible, never re-nags once a key resolves or the
user opts out (persisted). Completes C19's welcome-surface half.
**Accept:** empty `~/.keywork/` + empty env → onboarding opens on start; completing it writes
apiKeys via the setup path and reaches a working prompt; `/onboarding` re-runs it on demand.
**Strategy:** `OWN` over existing setup code.

**New totals: 7 tasks, +12 points** (C5's 2pt are absorbed by C26, not double-counted).

## Current milestone — corrected statement

We are **mid-M2-equivalent, out of order — deliberately**. The 90 map assumed M1 (core loop)
completes before M2 (identity demo) begins; in reality the engine core of M1 is essentially
done (A-stream complete except A17 and the A1/A5 partials) while the **C-stream identity work
was pulled ahead** — tiling (C8), keymap (C3), themes (C16), overlay (C6), and a streaming
multi-session ConversationPane (C12 partial) all landed before the D/E streams started and
before several M1-tagged items (B4–B8, C0, D0, E3/E4). That resequencing is honest and
intentional: the tiling identity is the riskiest bet and needed proving early.

What it cost: C-stream is running **ahead of its own safety nets** — no C0 E2E harness, no C2
perf budgets, no E3/E4 snapshots/undo during the rawest dogfooding period (exactly what 90
moved them to M1 to prevent), and no interim ask-before-bash/write flag on A6.

**Remaining for the M2 demo gate** (one keywork feature built *using* keywork): the M1
stragglers (A17 · A1/A5 completion · B4–B8 · C0 · C2 · C4 · C7/C12 completion · C19 via D13 ·
C20 · D0 · E3/E4), then the M2 body (C10, C13, C14, C15a, C17, C18, C21–C23 · C24–C28 ·
D1–D13 · E1, E2, E5, E6). The gate definition itself is unchanged.

## Resequencing (this overlay)

- **D0 moves to now** (was early-M2): C25/C26/D12/D13 all dispatch through it; building any
  of them without the registry recreates the exact slash-plumbing fragmentation 90 created D0
  to prevent.
- **C24, C25, D12, D13 are in progress by the maintainer; C27 is in flight** (layout.ts, other
  agent); C28 follows C27.
- **E3/E4 + the A6 interim ask-flag remain overdue M1 items** — first in line after the
  feedback batch; every day of dogfooding without undo is borrowed luck.

## Next up

1. **C24 + D12 + C25 + D13** — the feedback batch, on a minimal **D0** landed first (in
   progress).
2. **C27 → C28** — dock engine (in flight) then its UI.
3. **E3/E4 + A6 ask-flag** — the overdue safety net for dogfooding.
4. **C26** — quick menu, once D0 has real registrants to search.
5. **C0** — E2E harness spike, before more C-stream acceptance criteria pile onto it.
6. **B4–B8** — finish the session tree (fork/labels/tree/compaction/stats) to unlock C13 and
   the Pi-format compatibility claim.
