# Knowledge-Graph Memory: Systems Survey

> Research dossier for **keywork**, added 2026-08-10 for the workstream-J graph layer
> (J12). Question answered: what does a graph layer add over RRF hybrid retrieval, and
> what is the strongest local-first (SQLite/Bun/no-daemon) design?

**Status 2026-10-02.** The graph engines shipped maintenance releases only. The useful news is
adjacent: Mem0 and Letta Code changes, and four preprints that bear on drift checks, compaction
and whether memory helps at all (see "Since 2026-08-10"). keywork built the graph leg without
SQLite. New takes live in `docs/backlog/117-influence-sweep.md` (scope-first memory items,
SW17); the workstream is `docs/backlog/95-memory-and-skills.md` (J).

> **LICENSING (all verified against repo LICENSE files unless noted)**
> GraphRAG (microsoft) **MIT** · Graphiti (getzep) **Apache-2.0** · HippoRAG (OSU-NLP)
> **MIT** · LightRAG (HKUDS) **MIT** · Mem0 **Apache-2.0** · AriGraph **MIT** ·
> Letta/MemGPT **Apache-2.0** · Cognee Apache-2.0 (page-reported) · KuzuDB **MIT but
> archived Oct 2025** (Apple acqui-hire; live MIT fork: LadybugDB). No FSL landmines.
> Apache-2.0 adaptations additionally require carrying the Apache license text in
> `NOTICE`; MIT adaptations follow the existing NOTICE pattern.

## What the graph layer buys (evidence-ranked, for a coding agent)

1. **Temporal supersession, the killer feature.** Conventions/decisions get superseded
   constantly; serving stale ones is the classic memory failure. Graphiti's bi-temporal
   model (system time `created_at`/`expired_at` + world time `valid_at`/`invalid_at`;
   contradicting facts **invalidate** the old edge, never delete it) measured +38.4% on
   temporal reasoning vs full-context. rosavera's `memory_fact` table already has
   `valid_from`/`valid_to`; the design extends it rather than replacing it.
   **Landed** for supersession: J3 `supersedes`/`superseded_by` link pairs
   (`packages/engine/src/memory/store.ts`) and the superseded floor in `memory/search.ts`.
   **Open** for bi-temporal columns and the "what was true before <date>" query (J12);
   `memory/graph.ts` carries no time fields.
2. **Multi-hop recall.** Decision→module→file chains retrieve as disconnected pieces
   under BM25+embeddings. HippoRAG's entity-seeded **Personalized PageRank** over the
   graph: up to +20% multi-hop QA, single-step retrieval matching iterative methods at
   10–20× lower cost. Its core loop (query entities → PPR → rank memories) is ~50 lines
   in-process.
   **Landed:** J12, `MemoryGraph.rank` in `packages/engine/src/memory/graph.ts`. **Open:**
   the J4 probe corpus that would prove the multi-hop win does not exist yet (J4).
3. **Relationship queries** ("brief me on the TUI package"): entity-anchored 1-hop
   neighborhood assembly beats top-k retrieval for this shape.
   **Landed** in the engine: `MemoryGraph.outline` (1 or 2 hops) in `memory/graph.ts`.
   **Open** in the TUI: nothing outside tests calls it yet (J9).
4. **Contradiction detection as a graph invariant**: two *active* edges with the same
   (subject, predicate) and conflicting objects is trivially checkable; feeds the
   Gardener.
   **Landed** for explicit `contradicts` edges (`contradictionsOf` in `memory/graph.ts`) and
   Gardener pair verdicts (`memory/gardener.ts`). **Open** for the same-(subject, predicate)
   invariant check (J12).
5. Chat-companion wins that matter less here: social modeling, GraphRAG community/theme
   summaries (corpus-lake tooling; keywork's corpus is small curated markdown).

Corroborating data point: **Mem0 v3 removed its separate graph-DB module** in favor of a
lightweight built-in entity index fused as a third retrieval signal; a lightweight
entity leg captures most of the graph win for memory workloads.

## Design verdicts for keywork

- **Substrate:** entity-normalized SPO in SQLite. `entity(id, canonical_name, type,
  aliases)` + `memory_fact` with FK subject/object where they name things; that one
  normalization turns an SPO log into a traversable graph. No second database engine
  (Kuzu is dead; recursive CTEs + in-process traversal are comfortable to ~100k nodes).
  **Superseded:** R1 made the graph fully derived from the vault, and the build went
  further: `MemoryGraph.fromNotes` in `packages/engine/src/memory/graph.ts` rebuilds it in
  memory per query with no SQLite at all.
- **PPR:** never in SQL (recursive CTEs enumerate paths, they don't fixed-point iterate).
  Load active edges into memory, 10–20 power iterations in TypeScript, sub-100ms at this
  scale: HippoRAG's own pattern, smaller.
  **Landed:** J12, `rank` in `memory/graph.ts` (damping 0.85, 15 iterations).
- **Ontology: small, closed, typed** (Graphiti's custom-types lesson; schema-free
  extraction produces predicate sprawl that kills traversal). Entities: file,
  module/package, decision, convention, tool, dependency, person, error-pattern, task.
  Predicates ≈ 15 (`depends_on`, `supersedes`, `decided_for/against`, `applies_to`,
  `configures`, `caused_by`, `located_in`, `uses`, …), Zod-validated at extraction.
  **Landed:** J12, `entityTypes` and 16 `predicates` as Zod enums in `memory/graph.ts`;
  unknown relations are reported as skipped.
- **Extraction:** cheap deterministic linking at write time (file paths, package names,
  tool names; regex, no LLM); the LLM pass (typed extraction, alias resolution,
  supersession, contradiction sweep, per-entity summary refresh) runs in the Gardener;
  Letta's "sleep-time compute" is direct validation of this placement. Incremental
  always; GraphRAG's reindex-the-world batch model is the anti-pattern.
  **Landed** for deterministic edges from wikilinks and typed frontmatter
  (`memory/graph.ts`, `memory/notes.ts`) and the Gardener's supersession and contradiction
  sweep (J7, `memory/gardener.ts`). **Open:** LLM typed extraction, alias resolution and
  summary refresh (J7/J12); regex auto-linking of paths and package names is unverified.
- **Provenance:** every fact keeps a `source_ref` to its markdown file + anchor
  (AriGraph's episodic-provenance idea), so graph and files-as-truth stay one system.
  **Landed** at note granularity: every edge's subject is the note it came from
  (`memory/graph.ts`). Heading anchors are **open** (J12).
- **Fusion:** graph as a **third RRF leg** (FTS5 + vectors + PPR-ranked), then a bounded
  1-hop expansion that *always* attaches `supersedes`/`contradicts` edges to whatever is
  returned: the cheap rule that structurally prevents the stale-convention failure.
  **Landed:** J4/J12, `packages/engine/src/memory/search.ts` fuses lexical, semantic and
  graph legs with RRF K=60 and attaches relations and contradictions to every hit.
- **Only idea taken from GraphRAG:** hierarchical summaries; the Gardener maintains
  per-entity summary sections in the markdown canon. Skip Leiden/communities/map-reduce.
  **Open:** J7 per-entity summary refresh; `gardener.ts` has no summary pass.

## Since 2026-08-10

- **Graph engines:** Graphiti 0.30.x (2026-09-01, 09-08) fixed Neo4j routing only. LightRAG
  1.5.7 shipped 2026-09-02. HippoRAG has no releases. Nothing new to take; Graphiti stays
  **declined** because it needs a graph server.
- **Mem0 plugins (Apache-2.0):** on 2026-09-09 Dream consolidation and pin were removed from
  the openclaw and pi plugins; on 2026-09-23 the tool descriptions stopped telling the agent
  to "search proactively". The Mem0 platform stays **declined**.
- **Letta Code (Apache-2.0) MemFS, git-backed memory:** v0.32.18 and v0.33.0 (2026-09-23)
  serialize writers to a memory checkout and run a background worker that repairs git
  conflicts after each turn; v0.33.3 removed the dedicated memory tools in favor of plain
  file tools, which matches J5's prompt-driven writes. The serialized-writer shape is context
  for J14. Letta Memory Palace stays **declined**.
- **Preprints (arXiv, not peer reviewed):**
  - 2608.22752 (2026-08-24), "Compaction Cliff": `/compact` keeps 53% of safety rules after
    one round and 10% after five. Supports SW17 (skill and instruction content survives
    compaction).
  - 2608.23067 (2026-08-24): injecting skills lowered Pass@2 by 1.3 to 4.2% and raised
    tokens 72 to 394%. A caution for J10 loading; no task.
  - 2609.23570 (2026-09-20), VibeMemBench: 11 of 12 memory system and solver pairings fail
    to beat memory-off on real repo tasks. Supports the memory-off control in the J4 probe
    corpus (117 scope first).
  - 2609.25130 (2026-09-20), "Impact Is Not Invalidation": asking whether a specific claim
    still holds given a diff gets 0.71 to 0.97 precision, against about 0.30 for asking
    whether the diff preserves behavior. Supports 117's claim-specific drift check.

## Sources

GraphRAG: <https://arxiv.org/pdf/2404.16130> · Zep/Graphiti: <https://arxiv.org/abs/2501.13956>,
<https://github.com/getzep/graphiti> · HippoRAG: NeurIPS'24 + <https://arxiv.org/pdf/2502.14802>,
<https://github.com/osu-nlp-group/hipporag> · LightRAG: <https://github.com/HKUDS/LightRAG> ·
Mem0: <https://arxiv.org/html/2504.19413v1>, v3 migration docs · AriGraph:
<https://arxiv.org/abs/2407.04363> · Letta sleep-time: <https://www.letta.com/blog/sleep-time-compute/> ·
Kuzu archived: The Register 2025-10-14 · SQLite-as-graph practice write-ups ·
Mem0 releases: <https://github.com/mem0ai/mem0/releases> · Letta Code releases:
<https://github.com/letta-ai/letta-code/releases> · preprints: arXiv 2608.22752,
2608.23067, 2609.23570, 2609.25130.
