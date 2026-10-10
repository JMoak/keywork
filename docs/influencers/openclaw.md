# OpenClaw (openclaw/openclaw)

> Research dossier for **keywork**, added 2026-08-10 for the memory workstream (backlog
> `95-memory-and-skills.md`). OpenClaw is the open-source personal AI assistant by Peter
> Steinberger (released as Clawdbot, Nov 2025 → Moltbot → OpenClaw, Jan 2026; now under the
> OpenClaw Foundation).

**Status 2026-10-02.** Upstream turned grounded dreaming on by default, added memory ownership
with `openclaw memory forget`, Skill Workshop history review, auto-applied learned skills, and
a bundled opt-in `memory-wiki` plugin (see "Since 2026-08-10"). Most mechanisms below have
landed in keywork. New takes live in `docs/backlog/117-influence-sweep.md` (SW7, SW8 and the
scope-first memory items); the workstream is `docs/backlog/95-memory-and-skills.md` (J).

> **LICENSING**
> **MIT**, verified against the repo's `LICENSE` file ("Copyright (c) 2026 OpenClaw
> Foundation"). Code may be adapted **with attribution recorded in `NOTICE`**, same tier as
> Pi and OpenCode. (2026-10-02: the GitHub API reports `NOASSERTION`; the `LICENSE` file
> still reads MIT.)

## Why keywork studies it: the memory system

The most-praised agent memory design in the field, and the praise is for properties keywork
already values: every memory is readable text, git-able, greppable, and fixable in an
editor, never an opaque embedding as the only copy.

### Files as truth, index as cache

- `MEMORY.md`: curated long-term layer with a hard token budget, injected at session
  bootstrap. Over budget ⇒ the **injected copy** truncates; the file on disk is never cut.
- `memory/YYYY-MM-DD.md`: append-only daily logs; indexed for search, not injected.
  Today + yesterday auto-load on new sessions (~48h episodic window).
- `USER.md`: optional profile layer with its own budget. `DREAMS.md`: audit trail of
  background consolidation.
- SQLite index (`sqlite-vec` + FTS5/BM25, hybrid score `0.7*vector + 0.3*text`, ~400-token
  chunks with 80-token overlap, debounced file-watcher reindex, chunk-hash embedding cache)
  lives **outside** the canonical files and is disposable; deleting it loses nothing.
  Degrades to keyword-only with no embedding provider.

### Mechanisms keywork adapts

1. **Pre-compaction silent flush**: before context compaction, a hidden turn prompts the
   agent to persist anything worth keeping to the daily file, with a null reply so the user
   sees nothing. The single most transferable mechanism; hooks straight into B7.
   **Landed:** J8, `packages/engine/src/memory/flush.ts` (`NO_REPLY` token, bot clause).
2. **Prune before compacting; storage ≠ context**: tool-result trimming affects only the
   model context; the session JSONL keeps full outputs. Cache-TTL-aware pruning aligned to
   provider prompt-cache windows.
   **Landed** for storage ≠ context: B7 trims tool results only inside the summary
   (`packages/engine/src/session/compaction.ts`) and A18 spills keep the JSONL whole
   (`session/spill.ts`). **Open** for cache-TTL-aware pruning: no backlog task owns it; the
   nearest is 117's cache-warming scope-first item.
3. **Prompt-driven memory writes**: no bespoke `memory_write` tool; ordinary write/edit
   tools guided by conventions in an instructions file. Recall via `memory_search` +
   `memory_get` (line-range reads after a hit).
   **Landed:** J5, `packages/engine/src/memory/recall-tools.ts`, with J13 citations in
   `memory/citations.ts`. **Open:** the guard that stops an agent's plain write from parsing
   as `provenance: user` is SW7 (117).
4. **Dreaming**: score-gated, deduplicating, **taint-gated** (untrusted-source content
   excluded) background promotion into long-term memory, with an audit file.
   **Landed:** J7 Gardener, `packages/engine/src/memory/gardener.ts` (confidence thresholds,
   `tainted-source` rejection, duplicate/supersede/contradiction pair verdicts, one audit line
   per sweep in `curation.md`). Upstream's newer pieces are **open** in 117 scope-first: the
   claim-specific drift check and forget by origin.
5. **Hard small budgets as quality forcing functions**: ~200-line MEMORY.md, 48h episodic
   window, 15-message session snapshots.
   **Landed** for the bootstrap budget: R4 whole-note selection in
   `packages/engine/src/memory/bootstrap.ts` (`selectWithinBudget`). **Open** for the 48h
   window: bootstrap does not auto-load today's and yesterday's daily logs, and no backlog
   task owns it.
6. **Scope discipline**: per-agent isolation (index keyed by agent + workspace); sub-agents
   get a filtered bootstrap (no memory files); imported memory from other tools lands in
   `memory/imports/<tool>/`, searchable but never bootstrap-injected.
   **Landed** for layer isolation: J26 bot layers and arc layers join ambient recall only
   when active (`packages/engine/src/memory/bots/recall.ts`, `memory/arcs/recall.ts`).
   **Open:** imported memory (J6; no imports directory exists in the tree) and the sub-agent
   bootstrap, parked with FR6.17 until sub-agents exist.

### Known criticisms (carry as design constraints)

Plain-text memory at predictable paths is attractive to infostealers; prompt injection into
memory is unsolved (taint gating mitigates, doesn't eliminate). keywork's write-gating
design (J-series open question) exists to answer this. Status 2026-10-02: the J11 kernel
(provenance stamps, structural staging, one-key revert) **landed** with J3 in
`packages/engine/src/memory/staging.ts` and `memory/store.ts`; the protected core and the
airlock pieces are **open** (J11, SW7), and neutralizing recalled text is **open** as SW8.

## Since 2026-08-10

- **v2026.8.1-beta.2 (2026-08-15):** memory filename search indexes paths separately from
  chunk bodies. Skill Workshop "history review" scans past sessions newest-first, stores only
  a SQLite cursor, and caps pending proposals at 3. keywork: **open** as 117's skill history
  review (scope first).
- **v2026.8.1 (2026-08-31):** grounded dreaming (model-backed consolidation) is on by
  default. Memory ownership lets a user inspect the sessions behind a memory, exclude
  sources, and run `openclaw memory forget`, which removes derived memory and keeps the
  transcripts. keywork: **open** as 117's forget by session origin. Automatic self-learning
  auto-applies scanner-approved Workshop skills while edits to user-authored skills stay
  pending; keywork **declined** auto-applying learned skills. Onboarding imports memory from
  Claude Code, Codex and Hermes, which bears on J6's imported-memory clause.
- **Dreaming docs:** the deep phase is gated by `minScore`, `minRecallCount` and
  `minUniqueQueries`; weights are relevance 0.30, frequency 0.24, query diversity 0.15,
  recency 0.15, consolidation 0.10, richness 0.06. The model returns operation decisions,
  `maxPriorEntryLossFraction: 0.25` caps how much of an existing entry one rewrite can drop,
  and snippets are re-read from the live daily files before writing. Reference input for J7
  tuning; no new task.
- **v2026.9.1 (2026-09-03):** `memory reset` rebuilds derived indexes. keywork keeps no
  persistent index to reset; search runs in memory over the vault.
- **v2026.9.3 (2026-09-08, breaking):** one writable Workshop skill collection per agent.
- **`memory-wiki` plugin (bundled, opt-in):** claims carry `evidence[]` frontmatter, with
  contradiction, claim-health and stale-page reports and an Obsidian render mode. keywork
  **declined** the schema because it duplicates J-D5 and J12.

## Sources

- <https://github.com/openclaw/openclaw> · LICENSE (raw, verified MIT)
- <https://docs.openclaw.ai/concepts/memory> (in-repo: `docs/concepts/memory.md`)
- <https://manthanguptaa.in/posts/clawdbot_memory/>: technical deep-dive
- <https://velvetshark.com/openclaw-memory-masterclass>: operational guidance
- <https://cenrax.substack.com/p/understanding-openclaw-architecture>
- <https://milvus.io/blog/we-extracted-openclaws-memory-system-and-opensourced-it-memsearch.md>:
  the retrieval core extracted as standalone OSS (`memsearch`)
- <https://github.com/openclaw/openclaw/releases> (v2026.8.1-beta.2 to v2026.9.3)
- <https://docs.openclaw.ai/concepts/dreaming>
- <https://docs.openclaw.ai/concepts/memory-provenance>
- <https://docs.openclaw.ai/plugins/memory-wiki>
