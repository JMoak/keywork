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

Second research pass (2026-08-10, knowledge graphs + Obsidian —
[`influencers/knowledge-graphs.md`](../influencers/knowledge-graphs.md),
[`influencers/obsidian.md`](../influencers/obsidian.md)) raised the bar: the store becomes
an **atomic-note vault** (Obsidian-citizen), retrieval gains a **graph leg** (entity-seeded
PPR as a third RRF list + bi-temporal supersession), and the memory graph **shares an
entity space with the F2 repo map** — code structure and accumulated decisions join into
one queryable neighborhood. That last cross-join is the not-yet-seen part.

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

**J-D4 — Write gating: provenance-gated optimism + airlock, rendered as a curing garden**
(resolved 2026-08-10 after the gating research pass; not a trust ladder). Four layers:

1. **Provenance is structural.** Every durable line carries its origin — user-stated,
   agent-inferred, untrusted (tool output / web / unauthored file content) — rendered as a
   per-line glyph. Untrusted-origin writes are *structurally* forced into staging and can
   never auto-promote; this closes the injection path by construction, not by prompt.
2. **Trusted-origin writes apply optimistically** and appear as session-ledger chips
   (`M+` memory, `S±` skill, `C±` config) with one-key diff + revert. The agent is never
   blocked mid-turn.
3. **The airlock**: session end is the review boundary — a calm digest ("this session
   wants to remember 4 things and change 1 skill") where staged items cross over:
   review / approve all / leave staged. Staged items persist across restarts; a `◇n`
   counter lives in the status line meanwhile.
4. **Curing rendering**: independent of staging, entries harden visually — fresh writes
   render dim/provisional (`~` prefix) and cure to full saturation by surviving sessions
   and successful recalls; the pane's rendering *is* the trust model, and a poisoned
   memory is by construction the most eye-catching newest thing on screen.

Fixed invariants beneath all four: a **protected core** (trust config, guardrail skills,
human-authored files) the agent can only ever *propose* against at any trust state, and
the Hermes blast-radius rule — **agent-initiated curation never auto-touches
human-authored files**. Rationale anchor: approval prompts run at ~93% autopilot, so the
design makes trust ambiently visible and review cheap and batched instead of asking more.
This mechanism also supersedes the ladder framing for E2's presentation — one gating
vocabulary across memory, skills, config, and tool trust.

**J-D5 — Atomic-note vault + graph leg** (2026-08-10, from the KG/Obsidian research
pass). Three commitments:

1. **Distilled memories are atomic notes** (Matuschak evergreen style): one concept per
   file, concept-oriented unique titles, `[[wikilinks]]` as graph edges, frontmatter
   carrying the machine layer — provenance, curing state, confidence, `aliases`, typed
   relations. This is where J-D4's per-entry metadata lives; daily logs stay episodic and
   append-only. Notes are *revised*, not appended to — append-only memory rots.
2. **The memory directory is a first-class Obsidian vault** (open conventions only —
   the app is proprietary and untouchable; Dataview/Datacore/Breadcrumbs are MIT;
   ⚠️ Juggl is GPL-3.0, ideas only). Users get a world-class GUI over their agent's
   memory for free. Vault-citizenship spec in the dossier.
3. **Retrieval is three-legged**: FTS5/BM25 + embeddings + entity-seeded Personalized
   PageRank over a bi-temporal entity-normalized SPO graph, fused by RRF, followed by a
   1-hop expansion that always attaches `supersedes`/`contradicts` edges to results —
   staleness becomes structurally visible. Ontology is small, closed, and typed. Memory
   entities and the F2 repo map share canonical IDs (file paths, package names) — one
   entity space across code and knowledge.
4. **Skills stay outside the vault** (Jordan, 2026-08-10): skills are an evolving facet
   and remain a distinct entity with their own directories and D7 discovery walk
   (OpenCode-style separate registry) — not vault-resident, not coupled to the memory
   layout. The graph references skills as entities (the ontology's `tool`/skill node,
   pointing at the skill's path) so "what do we know about this skill" still works, but
   skill files never depend on vault conventions. Revisit only after both systems have
   stabilized in daily use.

## Implementation refinements (third pass, 2026-08-10)

Simplifications found by pushing "files are truth" all the way through — each removes a
moving part rather than adding one:

**R1 — Notes are nodes; the graph is fully vault-derived.** J12 initially implied a
second authoritative store (entity + fact tables). Refined: an **entity is an atomic
note** (its frontmatter already carries `aliases`, its filename is the canonical name;
file/module entities are notes named by repo path), an **edge is a wikilink or a typed
frontmatter relation**, and **supersession is a typed link pair** — the new note declares
`supersedes: "[[old-note]]"`, the Gardener stamps the old note `superseded_by` + `valid_to`.
History therefore lives in the vault too (superseded notes remain as files, dimmed, not
deleted), so the *entire* SQLite side — FTS, vectors, entity/fact tables, adjacency —
is one derived, disposable index. Delete it, lose nothing, including history. Obsidian
users see supersession chains as ordinary links. Fact rows keep bi-temporal columns as
*index materialization* of what the frontmatter says, never as the record.

**R2 — Atomic notes index whole-note; chunking is for logs only.** A distilled note is a
paragraph — chunking it at ~400 tokens is machinery for a problem it doesn't have. The
retrieval unit, citation unit, and curation unit become the same object (one note),
which also makes recall metrics and usefulness scoring per-note instead of per-chunk.
Chunking applies only to daily logs and imported documents.

**R3 — One review inbox.** J7's Gardener review queue, J11's staging area, and the
airlock digest are the same surface, not three: everything awaiting a human — staged
untrusted writes, borderline promotions, contradiction reports, protected-core proposals
— is one ordered inbox, rendered once by J9, drained at the airlock, counted by the one
`◇n` glyph. The session-end airlock is also a G6 notification moment ("come back — 4
things to review") when the user is unfocused: the same designed moment, two doors.

**R4 — Bootstrap = MOC + pinned embeds.** With `MEMORY.md` as a links-only MOC, session
bootstrap resolves it by transcluding pinned/cured notes (embed resolution, budget-aware,
cured-first then most-useful) rather than injecting a prose file. The budget pressure
OpenClaw applies to one file becomes a ranked selection over notes — same mechanism as
retrieval, reused.

**R5 — J2 is separable.** The user-global config layer has no dependency on the memory
stack and unblocks D8–D10/D14 (MCP config); it can land with iteration-3's Track P
rather than waiting for workstream J.

**R6 — Ledger-derived state** (from the Lore analysis —
[`influencers/lore.md`](../influencers/lore.md)). Curing and usefulness state in note
frontmatter is a *materialization* of the append-only audit/event ledger (recalls,
corrections, re-attestations) — recomputable from events, never independently mutated
counters. Same relationship the index has to files. Gardener structured outputs also
adopt Lore's hallucinated-ID rejection: every referenced note/entity must appear in the
candidate set.

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

### J3 (3pt) — Memory store & layout (atomic-note vault)
The canonical record, per scope (workspace + user), as a **valid Obsidian vault** (J-D5):
budgeted `MEMORY.md` as the MOC/index layer (links, not content), `daily/YYYY-MM-DD.md`
episodic logs, **atomic notes** for distilled memories — one concept per file, unique
concept-oriented titles, bare `[[Name]]` wikilinks, frontmatter carrying provenance /
curing state / confidence / `aliases` / typed relations (quoted wikilinks in YAML),
curation audit file. Entities are notes (R1): file/module entity notes named by repo
path, `supersedes:`/`superseded_by:` typed link pairs carry supersession in-vault.
Ship no `.obsidian/`; gitignore it. Files are truth; git-able at workspace scope.
**Accept:** round-trip tests; over-budget bootstrap selects, never truncates files (R4);
vault-citizenship fixture (frontmatter parses, links resolve by Obsidian's rules,
unique-name invariant enforced); supersession link-pair fixture; layout documented in
`docs/memory.md`.
**Strategy:** `LIFT:openclaw` budgets/daily-log lifecycle; open Obsidian conventions
(`OWN` — no app code exists to lift); Matuschak evergreen method as spec.

### J4 (3pt) — Hybrid index & recall metrics
SQLite sidecar per scope: atomic notes index **whole-note** (R2 — note = retrieval =
citation = scoring unit); daily logs and imports chunk (~400 tokens, overlap); FTS5/BM25
lexical + embedding vectors (provider or local; content-hash cache), RRF fusion (K=60),
scope filter, debounced file-watcher reindex; the wikilink graph from J3's notes parses
into the same index (backlinks, aliases, dead links). Designed for the third leg (J12's
PPR list joins the same RRF) without rework. Index is disposable — rebuildable from
files, deleting it loses nothing, **including history** (R1). Ships with a **recall-metrics fixture** (the rosavera P0 gap): a probe corpus
with expected-hit assertions gating regressions, including multi-hop cases that only the
graph leg can win (baseline documented pre-J12).
**Accept:** hybrid beats lexical-only on the probe corpus; lexical-only mode passes its
own floor with no embedding provider; delete-index-and-rebuild property test; link index
round-trips (backlinks/orphans/unresolved).
**Strategy:** `ADAPT:rosavera` RRF pipeline (Jordan's own — free adapt);
`LIFT:openclaw` chunking/watcher/cache mechanics.

### J5 (2pt) — Recall surface & bootstrap injection
`memory_search` / `memory_get` (line-range read after a hit) as core tools; memory *writes*
are prompt-driven through the ordinary write/edit tools per conventions (no bespoke write
tool); bootstrap injection at session start resolves the `MEMORY.md` MOC by transcluding
pinned/cured notes, budget-aware, cured-first then most-useful (R4) — per-layer token
budgets.
**Accept:** E2E — mock agent stores a fact via ordinary edit, new session recalls it via
`memory_search`; bootstrap respects budgets and selection order (R4 fixture); sub-agent
sessions get the filtered bootstrap (see J6).
**Strategy:** `LIFT:openclaw` tool contracts + prompt-routing conventions.

### J6 (2pt) — Scope policy (fail-closed federation)
rosavera's policy layer translated to keywork's scopes: a validated session context
resolves allowed scopes; unvalidated or reduced contexts (sub-agents, external attach
clients, headless callers) fail closed to reduced scope; imported memory (other tools'
formats) is searchable, never bootstrap-injected. Designed so cross-workspace federation
(P2) is a new scope, not a redesign — and so an external MCP memory service (e.g. Lore,
a colleague's MIT team-knowledge archive) can mount via D8 as a **team scope** under the
same policy: searchable, never bootstrap-injected, provenance-tagged external.
**Accept:** policy matrix unit tests; sub-agent fixture cannot read user-scope memory;
unknown context ⇒ workspace-public only.
**Strategy:** `ADAPT:rosavera` fail-closed resolution.

### J7 (3pt) — The Gardener (unified curation)
One curation concept serving memories, skills, *and the graph*: score-gated promotion
from daily logs into atomic notes (confidence + source-trust gates, taint-gated against
untrusted-source content), merge/contradiction/supersession detection, usefulness-score
EMA with an anti-gaming per-session cap (**wired into J4's retrieval ranking as a prior,
not just collected**), human review queue for borderline cases, every sweep leaving an
audit entry. Graph duties (with J12): typed extraction against the closed ontology
(Zod-validated), entity/alias resolution, the supersession sweep (expire the old edge,
stamp `superseded_by`/`valid_to` in frontmatter — R1), per-entity summary refresh in the
markdown canon, and Obsidian-style **unlinked-mention densification** (title/alias
occurrences → proposed links). All human-facing output lands in the **one review inbox**
(R3). Runs on
session close/idle — keywork has no daemon; the engine's own lifecycle is the heartbeat
(Letta's sleep-time-compute pattern independently validates this placement). **Blast
radius: agent-created content only, never human-authored files.**
**Accept:** fixture sweep promotes/merges/flags exactly per thresholds; human-authored
file untouched by construction (test proves it); audit entry per sweep; review queue
surfaces borderline items; usefulness prior measurably affects ranking on the J4 probe
corpus.
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
scopes at a glance, entries rendered with provenance glyphs and **curing saturation**
(fresh = dim `~`-prefixed, cured = full brightness — the J-D4 garden), recent recalls,
Gardener activity, staged/`◇n` count — in the shared D14/notification visual vocabulary.
Obsidian-translated affordances over J4's link index: **backlinks panel** for the focused
note, **local graph as an indented 1–2-hop outline** (links out / links in — never a
global graph; community verdict says local is the magic), unlinked-mention suggestions,
`[[` fuzzy autocomplete over names + aliases, orphan/dead-link lint. The **one review
inbox** (R3) renders here — this pane is where the airlock digest lives. Proactive
recall, concretely: on file-open/pane-focus bus events, seed PPR from the focused
entity's path and quietly surface the top memories touching it — never interruptions.
(This is the repo-map join, previewed before F2 lands.)
**Accept:** probe workflow — recall event renders in pane with scope + provenance; curing
states visually distinct in theme tokens (both light/dark); backlinks/local-outline/
autocomplete probe-tested; review queue reachable by keyboard; zero-memory state is calm,
not empty-noisy.
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

### J11 (3pt) — Write gating (implements J-D4)
The four J-D4 layers as one artifact — mechanism and visual design together: provenance
metadata on the write path with structural staging for untrusted origins; the session
ledger with chips + one-key revert; the airlock digest at session end draining the **one
review inbox** (R3 — staged writes, borderline promotions, contradiction reports,
protected-core proposals in one ordered list; restart-safe; `◇n` status-line counter).
Protected-core proposals render as outstanding-PR badges. E-stream (E1/E2) adopts the same
vocabulary — one gating system, not two.
**Accept:** property test — no untrusted-origin write can become load-bearing without
passing the airlock; ledger revert round-trips; digest lists exactly the session's staged
items; protected-core file provably unwritable by the agent at every trust state;
curing state transitions covered by unit tests.
**Strategy:** `OWN` design (prior-art contracts: Hermes pending queue, OpenClaw taint
gates — `LIFT:hermes`/`LIFT:openclaw` where their code shapes fit).

### J12 (3pt) — Graph layer (bi-temporal entity graph + PPR leg)
The third retrieval leg (J-D5), **fully derived from the vault** (R1): entity rows
materialize atomic notes (filename = canonical name, frontmatter `aliases`), fact rows
materialize wikilinks + typed frontmatter relations, bi-temporal columns (world time
`valid_from`/`valid_to` — rosavera's schema — plus system time `created_at`/`expired_at`,
Graphiti's design) materialize the `supersedes`/`superseded_by` link pairs, and
`source_ref` anchors every fact to its note + heading (AriGraph's provenance idea). The
tables are index, never record — rebuild from files reproduces them exactly, history
included. Ontology: small, closed, typed — entities {file, module,
decision, convention, tool, dependency, person, error-pattern, task}, ~15 predicates
(`depends_on`, `supersedes`, `decided_for/against`, `applies_to`, …), Zod-validated.
Write path stays cheap and deterministic (path/package/tool linking, no LLM — the LLM
pass is J7's). Retrieval: query entities seed **Personalized PageRank run in-process**
(load active edges, 10–20 power iterations in TypeScript — never recursive SQL; HippoRAG's
pattern) as a third RRF list, then bounded 1-hop expansion attaching `supersedes`/
`contradicts` edges to every result. Contradiction invariant: two active edges with the
same (subject, predicate) and conflicting objects → Gardener report. **File/module
entities use canonical repo paths — the same entity space F2's repo map will join.**
**Accept:** multi-hop cases in the J4 probe corpus that hybrid-alone loses are won with
the PPR leg (measured against the pre-J12 baseline); supersession fixture — new
convention expires old edge, retrieval of the old convention always carries its
`supersedes` pointer; temporal query fixture ("what was true before <date>"); PPR
<100ms at 10k edges; contradiction invariant surfaces a seeded conflict.
**Strategy:** `LIFT:hipporag` PPR retrieval core (MIT, NOTICE); Graphiti bi-temporal
*design* (Apache-2.0 — carry license text in NOTICE if code is adapted);
`ADAPT:rosavera` `memory_fact` schema as the base.

## Sequencing & dependencies

```
J1 (workspace) ──► J3 (store) ──► J4 (index) ──► J5 (recall) ──► J6 (policy)
J2 (user config) ─┘                  │                │
B7 (compaction) ────► J8 (flush)     └─► J12 (graph) ─┼─► J7 (gardener) ──► J9 (pane)
D1 + D7 (skills) ────► J10 (self-healing) ────────────┘
J11 (gating, J-D4 resolved) underlies J7/J9/J10 — its write-path pieces land with J3,
its visual pieces with J9. F2 (repo map) later joins J12's entity space.
```

Wants iteration-3's Track P (workspace persistence) and Track T (B7 compaction) landed
first — workstream J is the natural **iteration-4 headliner**. ~29pt total.

## The experience (what this feels like)

**Session start.** `keywork` opens the workspace; bootstrap is silent and cheap — the MOC
resolves a handful of cured notes into context, and the memory pane (if docked) shows the
scopes and a calm garden: mostly bright settled notes, maybe one dim `~` from yesterday.
Nothing asks anything.

**During work.** You open `packages/tui/layout.ts`; the memory pane quietly surfaces
"split ratios decided 50/50 → superseded by [[ratio-resize-decision]]" — the agent knows,
and now you know it knows. The agent learns something ("tests run on Node, not Bun") and
a small `M+` chip appears in the ledger; you glance, it's right, you keep typing. A web
doc it read suggests a config change — that lands as a dim `◇` instead, untouchable until
you say so. A skill's command fails mid-run; the agent patches it, an `S±` chip appears;
you hit the chip, see a two-line diff, approve with a keystroke or just leave it —
it's already working and revertable.

**Session end.** The airlock: "keywork wants to remember 4 things and change 1 skill —
review / approve all / leave staged." Fifteen seconds, usually. If you've tabbed away,
that's the notification moment — one "come back, 4 to review," not four pings. Overnight
(next idle), the Gardener sweeps: merges a duplicate, notices "we use pnpm" contradicts
a cured note, queues that one question for tomorrow's inbox instead of guessing.

**Anytime.** Open the memory directory in Obsidian — it's a real vault: the decision
graph is wikilinks, supersession chains are visible links, daily notes are daily notes.
Fix a wrong memory in any editor; the index rebuilds on save. Delete the entire SQLite
index in anger; nothing is lost.

**The feel targets** (review bar for every J PR): bootstrap adds zero perceptible
latency; nothing modal ever appears mid-flow; every glyph (`●◐○ ~ ◇ M+ S±`) is one of
the shared D14/notification family and legible at a glance; the empty first-run state
is a quiet invitation ("keywork remembers what you teach it"), not a dashboard of zeros;
and the whole system stays explainable in one sentence — *the agent writes notes you can
read, they earn trust visibly, and nothing untrusted persists without you.*

**Honest risks to design against:** inbox rot if `◇n` is ignorable for weeks (mitigate:
the airlock's approve-all is genuinely safe *because* untrusted items are visually
distinct within it); pane noise if proactive recall fires too eagerly (mitigate: strict
relevance floor, per-session novelty — never resurface the same note twice); Gardener
LLM cost creeping (mitigate: sweep budgets ride A15's token accounting, visible in the
status line like everything else).

## Non-goals (v1)

- Cross-workspace federation (designed-for via J6's scope seam; built post-v1).
- Memory encryption at rest (rosavera's person-scope privacy weight doesn't apply to
  workspace/user coding scopes; revisit if scopes ever carry personal data).
- GEPA-style skill evolution (recorded in the Hermes dossier; not v1).
- A memory daemon — curation rides the engine lifecycle (session close/idle), no separate
  process.
