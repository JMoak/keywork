# Long-Session Survivability — Stream 3 Ledger (2026-08-21)

> **Implementation overlay + ledger** for stream 3 of the plan in
> [`108-survivability-and-launch-rail.md`](108-survivability-and-launch-rail.md) (S3.1–S3.4
> there map to S3-T1–S3-T5 here). Cites PD17/C55 (`100-visual-craft.md`), IR-10/IR-14
> (`105-inference-resolution.md`), A22 (`103-dsh-influence.md`), B7 compaction
> (`92-iteration-3.md`), J8 flush (`95-memory-and-skills.md`), FR4.12 cost capture
> (`101-feedback-round-4.md`). Where this file and those records disagree, they win; this file
> adds the how and the landed state. Stream 4 (the launch rail) keeps its ledger in 108.
>
> **Standing guardrails unchanged:** Anthropic is API-key / Agent-SDK only and still has no
> provider wiring before G1; Crush is not a source; the user commits.

## Why this stream, in one paragraph

Before this stream the pane turn loop had no compaction trigger (the memory-flush latch never
re-armed outside the chat REPL), `flushAfterTurn` measured against an assumed 200k window, and
nothing on screen said how close a session was to the edge. On a 32k local model every long
session ended in a silent provider wall. Now one engine module decides the budget, one settler
runs after every turn (flush → compact → re-arm), the gauge in the title bar is the same
arithmetic made visible, and cost survives agent swaps.

## Tasks (sized; all `OWN`)

| Task | Pts | Decisions | Landed |
|---|---:|---|---|
| **S3-T1 — context budget as one engine primitive** · `engine/src/session/context-budget.ts`: `contextBudgetFor(declaredWindow)` (assumed 200k when undeclared; reserves scale to the window — flush ⅛, compaction ¹⁄₁₂, keep-recent ¹⁄₁₀ — capped at the historic 24576 / 16384 / 20000), `readContext(used, budget)` → absolute `flushAt` / `compactAt` marks, `flushDue` / `compactionDue`, `contextFullness`, `formatTokenCount`. `shouldFlush(reading)` and `shouldCompact(reading)` now take the reading (J8/B7 thresholds derive from the same budget); `estimateConversationTokens` exported; `defaultCompactionSettings` derive from the caps. | 2 | PD17 (real thresholds), A22, IR-10 | ✅ 2026-08-21 |
| **S3-T2 — the settler: compaction in the pane turn loop** · `engine/src/session/settle.ts`: `settleTurn({store, provider, history, budget, flush?})` runs flush-if-due (appends the flush turn), then compaction-if-due through B7, re-arms the flush latch, and returns a `TurnSettlement { history?, notices, flushed, compacted }`; `compactNow(...)` is the manual door. `Provider` gained `capabilities?` (declared capabilities ride with the bound provider; `withDeclaredCapabilities`, `RetryingProvider`, `followingProvider`, `materializer.wrapProvider`, `MockProvider` carry it) so `declaredContextWindow(agent.provider)` needs no side table. TUI: `AppOptions.afterTurn` now returns a settlement, `AppOptions.compact` is the manual hook, `bindSessionLifecycle` posts notices and rebuilds on the settled history through the existing `rebuild` seam; `/compact [focus]` in panes (busy ⇒ refused with a notice; never mid-stream, IR-04); `/context` prints the readout. CLI: panes + `keywork chat` both settle through the engine (chat gains auto-compaction it never had); `cli/memory.ts` `flushAfterTurn` and `assumedContextWindow` retired. | 3 | B7, J8, IR-04, IR-14 | ✅ 2026-08-21 |
| **S3-T3 — context gauge C55 on real numbers** · `tui/src/context-gauge.ts`: **calm** flavors show one density cell + count (`░ 268` → `▒ 1.6k` → `▓` past the flush mark → `█` past the compaction mark; the only non-threshold stop is half the flush headroom); **cockpit** flavors show a ten-cell bar whose used ink `█` eats a track that names its zones — room `░`, the cell holding the flush mark `▒`, the cell holding the compaction mark `▓` (`█░░░░░░░▒▓ 277/2k`); tier 0 renders `#...:+`. Absent until something is measured; lives in the title-bar telemetry zone beside cost and on the masthead status line; `PaneContext.instruments` carries the flavor's tier; `AppOptions.flavors` adds closet entries (`/flavor-<name>` hot-swaps). Readout rule honored: `/context` prints exact absolute marks. | 2 | PD17, C55, C64 telemetry zone, PD14 tiers | ✅ 2026-08-21 — **options round open** (see below) |
| **S3-T4 — declared windows end to end** · `/model` rows add `ctx 33k` when a window is declared (`models["qwen*"].contextWindow` in `keywork.json`), the `/model` notice says `ctx 33k` or `ctx assumed`, `keywork doctor` gains a `context` section listing each connected provider's models with declared or `assumed` windows. Undeclared still binds (IR-10 floor kept) but is visible everywhere it matters. | 1 | A22, IR-10 | ✅ 2026-08-21 |
| **S3-T5 — cost across model switches** · `ConversationModel` keeps a per-model ledger: an outgoing agent's usage + cost fold into its `provider/model` key on every swap (model switch, flush rebuild, compaction rebuild), so the title `$` and `/cost` never reset mid-session; `/cost` adds per-model lines when more than one model served (`mock/gpt-5-mini · 1 turn · 10000▸1000 · $0.0045`). On disk `sessionCost` already honoured `model_change` entries (FR4.12); the open half was the live pane. | 1 | FR4.12, IR-11 | ✅ 2026-08-21 |

**Acceptance evidence:** `scripts/e2e` scenario `long-session` (2k declared window, shared
mock script): the gauge climbs `░ 268 → ░ 804 → ▒ 1.1k → ▒ 1.6k`, turn 7 posts
`compacted 1.9k tokens into a summary · context now 279 of 2k` and the gauge drops to `░`,
`/context` prints `context 279 of 2000 tokens · estimated from the conversation text /
memory flush at 1750 · compaction at 1834 / window declared in keywork.json`, a further turn
then `/compact focus on decisions` folds again (gauge drops), `/flavor-cockpit` renders
`█░░░░░░░▒▓ 277/2k`. Captures in `artifacts/e2e/long-session/` (01–11). Unit coverage:
`context-budget.test`, `settle.test`, `flush.test`, `compaction.test` (engine);
`context-gauge.test`, `conversation-model.test` (ledger, `/context`, `/compact` gating),
`workflows.test` (settlement application, `/compact` through the lifecycle),
`conversation-pane.test` (gauge in titles and masthead) (TUI); `doctor.test`, `port.test` (CLI).
Gate at landing: 1951 tests / 140 files, 10/10 e2e, check + pins + guardrails + biome clean.

## The C55 options round (Jordan picks)

PD17 asked for 2–3 rendered candidates. Two are live and flavor-bound, one is a text sample:

1. **Ramp cell** (calm, shipped as default): `▒ 1.6k` — one cell of the density ramp, stops at
   the two real marks plus half the flush headroom. Capture: `long-session/06-turn-06.txt`.
2. **Density bar** (cockpit, shipped behind `instruments: "cockpit"`): `█░░░░░░░▒▓ 277/2k` —
   used ink over a track whose cells name the zones. Capture: `long-session/11-gauge-cockpit-bar.txt`.
3. **Tile-fill cell** (not wired): `▖▌▙█ 1.6k` using `tile.fill` at tier 2 — the dwindle-tile
   gaining ink. Identical information to (1) with the layout tile's vocabulary; one-line swap
   in `context-gauge.ts` if preferred.

The decision also settles whether calm shows the count at all (today it does; a count-free
`▒` is the minimal alternative).

## Deviations of record (flag for Jordan)

- **Estimate, not measurement.** The gauge and both triggers read `chars / 4` over the
  conversation text (B7's estimator). Provider-reported `inputTokens` would be truer per turn
  but stale after every rebuild and provider-shaped (OpenAI counts cached tokens inside the
  prompt, Bedrock outside); one estimator keeps the gauge honest about *when* compaction fires.
  The readout says "estimated from the conversation text". System prompt + tool schemas are not
  counted; the reserves absorb them. Upgrade path: a `Provider.countTokens` capability.
- **Reserves are proportional below the caps.** A 4k window gets flush 512 / compaction 341 /
  keep 400; that makes a 4k model *survive* but compaction will fire roughly every few turns.
  Realistic local floors are 8k–32k.
- **`keywork chat` gained auto-compaction.** It went through the same settler for parity; the
  REPL prints notices as `· compacted …` lines.
- **Local slash suggestions match by prefix**, not fuzzy subsequence (`/ex` no longer offers
  `context`).

## Follow-ups (not in this stream)

- Title-bar masthead tier hides telemetry by design; the gauge is reachable via `/context`.
- `/context` and the gauge show the window the *provider* declares; a per-session override
  (`/context window 32k`) was deliberately not added — declare in `keywork.json`.
- Cockpit flavor exists only as a test closet entry until C49's gallery ships; the
  `AppOptions.flavors` seam is what C49 will use.
- Named auxiliary roles (IR-14: compaction/flush on a cheaper model) still use the session's
  provider; the settler takes a `provider` so the role map is a one-line change when it lands.
