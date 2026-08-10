# Lore (dmbch/lore)

> Research dossier for **keywork**, added 2026-08-10 during workstream-J planning. Lore is
> a shared knowledge archive for teams working with AI ("centaurs"), by a colleague of
> Jordan's — a dockerized MCP service where humans and models jointly build collective
> memory. Python, hexagonal (5 layers), Postgres/pgvector in production, SQLite/sqlite-vec
> in dev, LiteLLM inference, OIDC identity.

> **LICENSING**
> **MIT** — adaptable with attribution in `NOTICE`. (Project accepts issues, not PRs.)

## The epistemic model (its distinctive contribution)

- **Claims/hypotheses + attestations**: knowledge is hypotheses; every judgment about one
  is an **append-only attestation** by an **oracle** (a human or model identity). All
  credibility state is *derived* from the attestation ledger on read — window functions
  over history, nothing mutated.
- **Subjective Logic opinions**: credibility is a triple — belief, disbelief,
  **uncertainty** — not a scalar; fused across oracles via trust-discounted ECBF.
- **Trust is earned per oracle**: `t_oracle` accrues by "aligning with where the herd
  lands over time"; contributions are discounted by it. Being early-and-right outweighs
  agreeing with a settled answer.
- **Temporal decay**: attestations fade past a half-life (default 90d) unless
  re-attested; oracle track records decay on their own half-life. Stale claims fade
  rather than persisting as false confidence.
- **Maturity**: `M = N_O / (N_O + K)` — confidence discount lifts only after multiple
  *distinct* oracles attest.
- **Provenance-first**: every consult is stored before processing; "orphan request rows
  are evidence, not garbage."
- **Write path**: Interpreter (fast model) normalizes → two-lane hybrid retrieval
  (vector + FTS, RRF) → Archivist (reasoning model) classifies corroborates / contributes
  / contradicts → validator rejects hallucinated IDs → transactional record.

## Alignment with workstream J

**Convergent (mutual validation):** hybrid two-lane retrieval fused by RRF; provenance
stored before anything else; trust as something earned and visible; time as a first-class
epistemic dimension; contradiction as a tracked relation, not an overwrite.

**Inverted (deliberately not our shape):** Lore is a *service* — daemon, OIDC, the
database **is** the record, store is opaque to humans. keywork is local-first, no-daemon,
markdown-files-as-truth with a disposable index (J-D5/R1). Lore puts LLM calls in the
synchronous write path (Interpreter+Archivist per consult); keywork's write path is
deterministic and the LLM pass lives in the Gardener. Lore has no graph/supersession
semantics — decay makes stale claims *fade*, keywork's `supersedes` edge says *what
replaced them*; complementary, not equivalent. Lore's problem is multi-user consensus;
J v1 is single-user workspace memory.

## What keywork takes

1. **Ledger-derived state (adopted as refinement R6)**: curing/usefulness state in note
   frontmatter is a *materialization* of the append-only audit/event ledger (recalls,
   corrections, re-attestations), recomputable — never independently mutated counters.
2. **Uncertainty as its own axis (consider, not committed)**: Gardener promotion gates
   could carry (belief, uncertainty) rather than one confidence scalar — "confidently
   wrong" and "unknown" stop looking alike. Adopt only if the math earns its keep in J7.
3. **Hallucinated-ID rejection**: Gardener structured outputs validate every referenced
   note/entity against the candidate set (Lore's `ArchivistResolutionError` pattern).
4. **The federation seam (the real prize)**: Lore is an MCP server — keywork's D8 MCP
   host can mount it as an additional **team scope** under J6's fail-closed policy:
   searchable, never bootstrap-injected, provenance-tagged as external. Team memory
   without keywork building multi-user consensus; per-oracle trust becomes relevant
   exactly at the P2 shared-workspace rung.

## Sources

- <https://github.com/dmbch/lore> (README; MIT)
- `docs/architecture.md` in-repo (five layers, personas, attestation ledger, ECBF fusion)
