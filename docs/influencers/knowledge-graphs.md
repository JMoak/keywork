# Knowledge-Graph Memory — Systems Survey

> Research dossier for **keywork**, added 2026-08-10 for the workstream-J graph layer
> (J12). Question answered: what does a graph layer add over RRF hybrid retrieval, and
> what is the strongest local-first (SQLite/Bun/no-daemon) design?

> **LICENSING (all verified against repo LICENSE files unless noted)**
> GraphRAG (microsoft) **MIT** · Graphiti (getzep) **Apache-2.0** · HippoRAG (OSU-NLP)
> **MIT** · LightRAG (HKUDS) **MIT** · Mem0 **Apache-2.0** · AriGraph **MIT** ·
> Letta/MemGPT **Apache-2.0** · Cognee Apache-2.0 (page-reported) · KuzuDB **MIT but
> archived Oct 2025** (Apple acqui-hire; live MIT fork: LadybugDB). No FSL landmines.
> Apache-2.0 adaptations additionally require carrying the Apache license text in
> `NOTICE`; MIT adaptations follow the existing NOTICE pattern.

## What the graph layer buys (evidence-ranked, for a coding agent)

1. **Temporal supersession — the killer feature.** Conventions/decisions get superseded
   constantly; serving stale ones is the classic memory failure. Graphiti's bi-temporal
   model (system time `created_at`/`expired_at` + world time `valid_at`/`invalid_at`;
   contradicting facts **invalidate** the old edge, never delete it) measured +38.4% on
   temporal reasoning vs full-context. rosavera's `memory_fact` table already has
   `valid_from`/`valid_to` — the design extends it rather than replacing it.
2. **Multi-hop recall.** Decision→module→file chains retrieve as disconnected pieces
   under BM25+embeddings. HippoRAG's entity-seeded **Personalized PageRank** over the
   graph: up to +20% multi-hop QA, single-step retrieval matching iterative methods at
   10–20× lower cost. Its core loop (query entities → PPR → rank memories) is ~50 lines
   in-process.
3. **Relationship queries** ("brief me on the TUI package") — entity-anchored 1-hop
   neighborhood assembly beats top-k retrieval for this shape.
4. **Contradiction detection as a graph invariant** — two *active* edges with the same
   (subject, predicate) and conflicting objects is trivially checkable; feeds the
   Gardener.
5. Chat-companion wins that matter less here: social modeling, GraphRAG community/theme
   summaries (corpus-lake tooling; keywork's corpus is small curated markdown).

Corroborating data point: **Mem0 v3 removed its separate graph-DB module** in favor of a
lightweight built-in entity index fused as a third retrieval signal — a lightweight
entity leg captures most of the graph win for memory workloads.

## Design verdicts for keywork

- **Substrate:** entity-normalized SPO in SQLite. `entity(id, canonical_name, type,
  aliases)` + `memory_fact` with FK subject/object where they name things — that one
  normalization turns an SPO log into a traversable graph. No second database engine
  (Kuzu is dead; recursive CTEs + in-process traversal are comfortable to ~100k nodes).
- **PPR:** never in SQL (recursive CTEs enumerate paths, they don't fixed-point iterate).
  Load active edges into memory, 10–20 power iterations in TypeScript, sub-100ms at this
  scale — HippoRAG's own pattern, smaller.
- **Ontology: small, closed, typed** (Graphiti's custom-types lesson; schema-free
  extraction produces predicate sprawl that kills traversal). Entities: file,
  module/package, decision, convention, tool, dependency, person, error-pattern, task.
  Predicates ≈ 15 (`depends_on`, `supersedes`, `decided_for/against`, `applies_to`,
  `configures`, `caused_by`, `located_in`, `uses`, …), Zod-validated at extraction.
- **Extraction:** cheap deterministic linking at write time (file paths, package names,
  tool names — regex, no LLM); the LLM pass (typed extraction, alias resolution,
  supersession, contradiction sweep, per-entity summary refresh) runs in the Gardener —
  Letta's "sleep-time compute" is direct validation of this placement. Incremental
  always; GraphRAG's reindex-the-world batch model is the anti-pattern.
- **Provenance:** every fact keeps a `source_ref` to its markdown file + anchor
  (AriGraph's episodic-provenance idea) — graph and files-as-truth stay one system.
- **Fusion:** graph as a **third RRF leg** (FTS5 + vectors + PPR-ranked), then a bounded
  1-hop expansion that *always* attaches `supersedes`/`contradicts` edges to whatever is
  returned — the cheap rule that structurally prevents the stale-convention failure.
- **Only idea taken from GraphRAG:** hierarchical summaries — the Gardener maintains
  per-entity summary sections in the markdown canon. Skip Leiden/communities/map-reduce.

## Sources

GraphRAG: <https://arxiv.org/pdf/2404.16130> · Zep/Graphiti: <https://arxiv.org/abs/2501.13956>,
<https://github.com/getzep/graphiti> · HippoRAG: NeurIPS'24 + <https://arxiv.org/pdf/2502.14802>,
<https://github.com/osu-nlp-group/hipporag> · LightRAG: <https://github.com/HKUDS/LightRAG> ·
Mem0: <https://arxiv.org/html/2504.19413v1>, v3 migration docs · AriGraph:
<https://arxiv.org/abs/2407.04363> · Letta sleep-time: <https://www.letta.com/blog/sleep-time-compute/> ·
Kuzu archived: The Register 2025-10-14 · SQLite-as-graph practice write-ups.
