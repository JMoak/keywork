# rosavera (Jordan's private agent workspace)

> Internal reference for **keywork**, added 2026-08-10 for the memory workstream (backlog
> `95-memory-and-skills.md`). rosavera lives at `C:\src\rosavera` (private repo,
> `Rosavera-I/rosavera`). It is **Jordan's own work** — no third-party license applies;
> keywork may adapt its designs and code freely, no `NOTICE` entry required. Key sources
> inside it: `scripts/memory/README.md`, `MEMORY_SYSTEM_ANALYSIS.md` (2026-07-11),
> `architecture/memory-system-improvements.md`.

## Why keywork studies it: scope federation and curation depth

An OpenClaw-style personal-agent workspace with a hand-built Python memory pipeline whose
distinctive move is **privacy-scope federation**: one retrieval query fans out across
separate memory scopes and merges results, with a **fail-closed policy layer** deciding
which scopes the current session context may touch.

### Mechanisms keywork adapts (translated from person/group scopes to workspace/user scopes)

1. **Fail-closed scope resolution** — allowed/denied scopes resolve from a validated
   session context; unvalidated context ⇒ most-public scope only; cross-scope reads that
   policy doesn't explicitly allow never happen. Explicit access levels rather than
   implicit reachability.
2. **Hybrid retrieval with Reciprocal Rank Fusion (K=60)** — lexical hits (topic store)
   and semantic hits (vector store) merged by RRF, then ACL-filtered. keywork's J-series
   retrieval design leads with this.
3. **Gardener v2 curation** — merge detection (0.92 cosine), contradiction detection via
   negation markers (0.82), supersession detection, inbox→curated promotion gated on
   confidence (≥0.72) and source trust (≥0.65), **human review queue for borderline
   (0.85–0.92) cases**.
4. **Usefulness feedback loop** — session-close transcript analysis updates per-memory
   `usefulness_score` via EMA, with an anti-gaming cap on per-session delta (0.12).
5. **Markdown canon + SQLite sidecars** — daily logs + distilled `MEMORY.md` + dated
   timeline index as the record; `vectors.db` (Ollama mxbai-embed-large, 512-token chunks)
   and `topic_memory.db` (topic records, ACL tables, subject–predicate–object fact table
   with confidence and temporal validity) as derived stores.
6. **Distillation pipeline** — periodic 7-day rollups into scope-appropriate snapshots.

### Known gaps (fix in keywork from day one — Jordan's own 2026-07 analysis)

- **No recall metrics** — a `recall_probe.py` baseline was the flagged P0 and never landed.
  keywork's index task ships a recall-metrics fixture with the first implementation.
- **No proactive recall triggers** — retrieval is query-time only; nothing surfaces a
  relevant memory unprompted. keywork's memory pane + bus give this a natural home.

(rosavera also age-encrypts private-scope memories with tmpfs-only decryption; keywork's
workspace/user scopes don't carry person-level privacy weight, so encryption is noted but
not planned for v1.)
