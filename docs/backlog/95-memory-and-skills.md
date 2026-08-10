# Memory & Self-Healing Skills — Workstream J

> Planning overlay, 2026-08-10. Where this file speaks for workstream J it wins; elsewhere
> [`94-file-browser-and-mouse.md`](94-file-browser-and-mouse.md) → 92 → 91 → 90 →
> workstream files apply.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing before
> workstream G; Pi/OpenCode are MIT — adapt with attribution in `NOTICE`; Crush is FSL —
> never a source. The user commits; agents never `git commit`/`git push`.
>
> **Sources for this workstream (all adaptable):** OpenClaw is MIT
> ([`influencers/openclaw.md`](../influencers/openclaw.md)) and Hermes Agent is MIT
> ([`influencers/hermes.md`](../influencers/hermes.md)) — adapt with attribution in
> `NOTICE` (both pre-staged there). rosavera is Jordan's own private work
> ([`influencers/rosavera.md`](../influencers/rosavera.md)) — adapt freely, no attribution
> obligation.

## Vision

Memory is a workspace-level (eventually cross-workspace) management and context-support
system built into the engine and **beautifully visible to the user in various scopes and
forms** — soft and malleable, yet self-standing, clean, simple software. The layered
synthesis:

- **OpenClaw** supplies the ergonomics and lifecycle: markdown files as truth, index as
  disposable cache, budgeted bootstrap injection, the pre-compaction silent flush,
  taint-gated background consolidation with an audit trail.
- **rosavera** supplies the scope model and curation depth: fail-closed scope federation,
  RRF hybrid retrieval, Gardener-grade curation (merge/contradiction/supersession,
  usefulness feedback with anti-gaming caps, human review queue) — plus two known gaps
  keywork fixes from day one (recall metrics, proactive recall).
- **Hermes** supplies the skills side: skills as procedural memory, versioned by reality —
  execution-time self-patching, telemetry-driven curation whose blast radius is strictly
  agent-created files, progressive-disclosure loading.

Memory, the MCP status pane (D14), and the notification formula (G6/P2.4) share one visual
vocabulary — one family of marks for idle / working / needs-you / failed — designed as a
single system.

## Binding decisions (from Jordan, 2026-08-10)

**J-D1 — Workspace is the top memory scope; user is global.** A **workspace** is defined
in the VS Code/Cursor sense: the user declares one relative to a project and may add
additional directories for context/scope. Distinguish workspace from project carefully —
the project is a directory; the workspace is the declared working set. The **user scope**
is global and also carries global settings: MCP servers, global system prompts applied to
all models and then overridable per specified model pattern. Cross-workspace federation is
the later rung (P2-style), designed-for now, built later.

**J-D2 — Memory is engine core.** Written justification (required by vision D2): memory is
context management, and context is the engine's primary resource — bootstrap injection,
the pre-compaction flush, and scope policy are loop-adjacent in the same way sessions and
compaction are, and every pane and extension builds on it. What stays extensible: curation
policies, embedding providers, and the memory pane presentation remain replaceable
surfaces; the store, scopes, and recall tools are core.

**J-D3 — Hybrid retrieval is the design center.** Lexical (SQLite FTS5/BM25) + semantic
(embeddings) fused via Reciprocal Rank Fusion, then scope-filtered — designed as one
retrieval system from day one, not keyword search with a vector bolt-on. Vectors remain
*optional at runtime*: with no embedding provider the same pipeline runs lexical-only,
gracefully — but the architecture, tests, and scoring assume hybrid as the normal state.

**J-D4 — Write gating: OPEN.** The trust-ladder framing is not assumed. A research pass on
creative gating methodologies with first-class visual design (provenance made visible,
staged "curing," optimistic-apply-with-beautiful-undo, review-as-garden, …) reports before
J7/J9 land; the invariant already fixed regardless of outcome: **agent-initiated curation
never auto-touches human-authored files** (the Hermes blast-radius rule).

## Tasks

### J1 (2pt) — Workspace definition
First-class workspace identity: a declared workspace (name, root, additional context dirs)
persisted per J-D1; upgrade Track P's cwd-hash workspace state to key off declared
workspace identity with cwd-hash as the undeclared fallback. `keywork` opens a workspace,
not merely a directory.
**Accept:** declare workspace with two extra dirs; state/persistence keys by workspace
identity; undeclared cwd still works exactly as today.
**Strategy:** `OWN` (VS Code workspace *concept* as prior art; no code to lift).

### J2 (2pt) — User-global config layer
User scope carries global settings: MCP servers (feeds D8–D10/D14), global system prompts
applied to all models, then per-model-pattern overrides (glob on model id). Schema-validated
per D9 — every option `.describe()`-justified.
**Accept:** global prompt applies to all providers in fixture; pattern-scoped override wins
for matching model ids; precedence documented in the schema.
**Strategy:** `OWN`; `LIFT:opencode` config-merge patterns where useful.

### J3 (2pt) — Memory store & layout
The canonical record, per scope (workspace + user): budgeted `MEMORY.md` (bootstrap layer),
`memory/YYYY-MM-DD.md` daily logs, distillation snapshots, curation audit file. Files are
truth; plain markdown; git-able at workspace scope.
**Accept:** round-trip tests; over-budget `MEMORY.md` truncates the injected copy, never
the file; layout documented in `docs/memory.md`.
**Strategy:** `LIFT:openclaw` layout + budgets; `OWN` scope split.

### J4 (3pt) — Hybrid index & recall metrics
SQLite sidecar per scope: chunking (~400 tokens, overlap), FTS5/BM25 lexical + embedding
vectors (provider or local; chunk-hash cache), RRF fusion (K=60), scope filter, debounced
file-watcher reindex. Index is disposable — rebuildable from files, deleting it loses
nothing. Ships with a **recall-metrics fixture** (the rosavera P0 gap): a probe corpus with
expected-hit assertions gating regressions.
**Accept:** hybrid beats lexical-only on the probe corpus; lexical-only mode passes its own
floor with no embedding provider; delete-index-and-rebuild property test.
**Strategy:** `ADAPT:rosavera` RRF pipeline (Jordan's own — free adapt);
`LIFT:openclaw` chunking/watcher/cache mechanics.

### J5 (2pt) — Recall surface & bootstrap injection
`memory_search` / `memory_get` (line-range read after a hit) as core tools; memory *writes*
are prompt-driven through the ordinary write/edit tools per conventions (no bespoke write
tool); bootstrap injection of budgeted layers at session start, per-layer token budgets.
**Accept:** E2E — mock agent stores a fact via ordinary edit, new session recalls it via
`memory_search`; bootstrap respects budgets; sub-agent sessions get the filtered bootstrap
(see J6).
**Strategy:** `LIFT:openclaw` tool contracts + prompt-routing conventions.

### J6 (2pt) — Scope policy (fail-closed federation)
rosavera's policy layer translated to keywork's scopes: a validated session context
resolves allowed scopes; unvalidated or reduced contexts (sub-agents, external attach
clients, headless callers) fail closed to reduced scope; imported memory (other tools'
formats) is searchable, never bootstrap-injected. Designed so cross-workspace federation
(P2) is a new scope, not a redesign.
**Accept:** policy matrix unit tests; sub-agent fixture cannot read user-scope memory;
unknown context ⇒ workspace-public only.
**Strategy:** `ADAPT:rosavera` fail-closed resolution.

### J7 (3pt) — The Gardener (unified curation)
One curation concept serving memories *and* skills: score-gated promotion from daily logs
into `MEMORY.md` (confidence + source-trust gates, taint-gated against untrusted-source
content), merge/contradiction/supersession detection, usefulness-score EMA with an
anti-gaming per-session cap, human review queue for borderline cases, every sweep leaving
an audit entry. Runs on session close/idle — keywork has no daemon; the engine's own
lifecycle is the heartbeat. **Blast radius: agent-created content only, never
human-authored files.**
**Accept:** fixture sweep promotes/merges/flags exactly per thresholds; human-authored
file untouched by construction (test proves it); audit entry per sweep; review queue
surfaces borderline items.
**Strategy:** `ADAPT:rosavera` Gardener v2 + `LIFT:openclaw` dreaming/taint gates +
Hermes Curator telemetry (`LIFT:hermes` contracts).

### J8 (2pt) — Pre-compaction memory flush
Before B7 compaction fires, one silent turn prompts the agent to persist anything worth
keeping to the daily log (null-reply action, user sees nothing), triggered at a reserve
threshold before the context limit. Rides the bus; visible in the session JSONL (honest
replay), invisible in the conversation pane.
**Accept:** E2E — long mock conversation flushes before compaction; the flushed fact
survives into a new session via recall; `NO_REPLY` never renders.
**Strategy:** `LIFT:openclaw` flush mechanism; depends on B7.

### J9 (2pt) — Memory pane & proactive recall
Dock-native memory visibility (the rosavera P5 gap, answered with keywork's identity):
scopes at a glance, recent recalls with provenance, Gardener activity, review-queue count —
in the shared D14/notification visual vocabulary. Proactive recall: bus-driven surfacing of
relevant memories as quiet pane events, never interruptions.
**Accept:** probe workflow — recall event renders in pane with scope + provenance; review
queue reachable by keyboard; zero-memory state is calm, not empty-noisy.
**Strategy:** `OWN` presentation; pane rides C27/C28 dock.

### J10 (3pt) — Self-healing skills
Hermes' mechanism on D7's skills: execution-time self-patching when a skill's command
fails or mismatches reality (surgical patch preferred, rewrite fallback), autonomous skill
creation after complex successes / error-derived workflows / user corrections,
progressive-disclosure loading (list → view → reference file), telemetry counts feeding
the Gardener (J7). Human-authored and bundled skills are never auto-modified.
**Accept:** E2E — fixture skill with a stale command self-patches mid-run and the fix
persists; human-authored fixture skill provably untouchable; telemetry increments.
**Strategy:** `LIFT:hermes` contracts, reimplemented in TypeScript; depends on D1 + D7.

### J11 (2pt) — Write-gating design (resolves J-D4)
Decide and land the gating model for agent-initiated durable writes (memory, skills,
config) from the research pass: mechanism + its visual/interaction design as one artifact,
unified with the trust work (E-stream) rather than parallel to it. Until it lands, J7/J9
default conservatively (borderline promotions queue for review; self-patches apply but are
prominently visible and one-key revertable).
**Accept:** decision recorded here as J-D4-resolved; gating behavior property-tested;
E-stream tasks updated to reference one shared mechanism.
**Strategy:** `OWN` design.

## Sequencing & dependencies

```
J1 (workspace) ──► J3 (store) ──► J4 (index) ──► J5 (recall) ──► J6 (policy)
J2 (user config) ─┘                                   │
B7 (compaction) ──────────────► J8 (flush)            ├─► J7 (gardener) ──► J9 (pane)
D1 + D7 (skills) ─────────────► J10 (self-healing) ───┘
J11 (gating) informs J7/J9/J10 — research first, decide by the time J7 lands
```

Wants iteration-3's Track P (workspace persistence) and Track T (B7 compaction) landed
first — workstream J is the natural **iteration-4 headliner**. ~25pt total.

## Non-goals (v1)

- Cross-workspace federation (designed-for via J6's scope seam; built post-v1).
- Memory encryption at rest (rosavera's person-scope privacy weight doesn't apply to
  workspace/user coding scopes; revisit if scopes ever carry personal data).
- GEPA-style skill evolution (recorded in the Hermes dossier; not v1).
- A memory daemon — curation rides the engine lifecycle (session close/idle), no separate
  process.
