# OpenClaw (openclaw/openclaw)

> Research dossier for **keywork**, added 2026-08-10 for the memory workstream (backlog
> `95-memory-and-skills.md`). OpenClaw is the open-source personal AI assistant by Peter
> Steinberger (released as Clawdbot, Nov 2025 → Moltbot → OpenClaw, Jan 2026; now under the
> OpenClaw Foundation).

> **LICENSING**
> **MIT** — verified against the repo's `LICENSE` file ("Copyright (c) 2026 OpenClaw
> Foundation"). Code may be adapted **with attribution recorded in `NOTICE`**, same tier as
> Pi and OpenCode.

## Why keywork studies it: the memory system

The most-praised agent memory design in the field, and the praise is for properties keywork
already values: every memory is readable text, git-able, greppable, and fixable in an
editor — never an opaque embedding as the only copy.

### Files as truth, index as cache

- `MEMORY.md` — curated long-term layer with a hard token budget, injected at session
  bootstrap. Over budget ⇒ the **injected copy** truncates; the file on disk is never cut.
- `memory/YYYY-MM-DD.md` — append-only daily logs; indexed for search, not injected.
  Today + yesterday auto-load on new sessions (~48h episodic window).
- `USER.md` — optional profile layer with its own budget. `DREAMS.md` — audit trail of
  background consolidation.
- SQLite index (`sqlite-vec` + FTS5/BM25, hybrid score `0.7*vector + 0.3*text`, ~400-token
  chunks with 80-token overlap, debounced file-watcher reindex, chunk-hash embedding cache)
  lives **outside** the canonical files and is disposable — deleting it loses nothing.
  Degrades to keyword-only with no embedding provider.

### Mechanisms keywork adapts

1. **Pre-compaction silent flush** — before context compaction, a hidden turn prompts the
   agent to persist anything worth keeping to the daily file, with a null reply so the user
   sees nothing. The single most transferable mechanism; hooks straight into B7.
2. **Prune before compacting; storage ≠ context** — tool-result trimming affects only the
   model context; the session JSONL keeps full outputs. Cache-TTL-aware pruning aligned to
   provider prompt-cache windows.
3. **Prompt-driven memory writes** — no bespoke `memory_write` tool; ordinary write/edit
   tools guided by conventions in an instructions file. Recall via `memory_search` +
   `memory_get` (line-range reads after a hit).
4. **Dreaming** — score-gated, deduplicating, **taint-gated** (untrusted-source content
   excluded) background promotion into long-term memory, with an audit file.
5. **Hard small budgets as quality forcing functions** — ~200-line MEMORY.md, 48h episodic
   window, 15-message session snapshots.
6. **Scope discipline** — per-agent isolation (index keyed by agent + workspace); sub-agents
   get a filtered bootstrap (no memory files); imported memory from other tools lands in
   `memory/imports/<tool>/`, searchable but never bootstrap-injected.

### Known criticisms (carry as design constraints)

Plain-text memory at predictable paths is attractive to infostealers; prompt injection into
memory is unsolved (taint gating mitigates, doesn't eliminate). keywork's write-gating
design (J-series open question) exists to answer this.

## Sources

- <https://github.com/openclaw/openclaw> · LICENSE (raw, verified MIT)
- <https://docs.openclaw.ai/concepts/memory> (in-repo: `docs/concepts/memory.md`)
- <https://manthanguptaa.in/posts/clawdbot_memory/> — technical deep-dive
- <https://velvetshark.com/openclaw-memory-masterclass> — operational guidance
- <https://cenrax.substack.com/p/understanding-openclaw-architecture>
- <https://milvus.io/blog/we-extracted-openclaws-memory-system-and-opensourced-it-memsearch.md>
  — the retrieval core extracted as standalone OSS (`memsearch`)
