# keywork — Research Reference Set

This directory is the research foundation for **keywork**, a keyboard-first TypeScript
coding-agent harness (Bun + TypeScript + Vitest + OpenTUI) being designed by remixing the
best ideas from existing open-source coding agents. The docs below are *inputs to
vision-shaping*, not decisions: four dossiers on the tools and systems that most influence
keywork's taste, one survey of the wider permissively-licensed ecosystem, and two synthesis
documents that turn the research into comparisons, principles, and open questions. Read them
in the order given; later docs assume the earlier ones.

---

## Reading order

### Influencers — the primary studies

| # | Doc | What it covers |
|---|-----|----------------|
| 1 | [`influencers/pi.md`](influencers/pi.md) | Pi (earendil-works/pi, MIT): the minimal, self-extending harness — four built-in tools, ~30-hook TypeScript extension API, JSONL tree sessions, the anti-MCP argument, and a prioritized "what keywork should take" list. |
| 2 | [`influencers/opencode.md`](influencers/opencode.md) | OpenCode (sst/opencode, MIT): the most structurally relevant influence — same Bun/TS/OpenTUI stack. Headless-server "everything is a client" architecture, Plan/Build modes, permissions, and lift candidates. |
| 3 | [`influencers/crush.md`](influencers/crush.md) | Crush (charmbracelet/crush, FSL-1.1-MIT — **retired as a design source 2026-08-10**): research history only; formerly Crush-credited features are now original keywork designs. |
| 4 | [`influencers/omarchy-ux.md`](influencers/omarchy-ux.md) | Omarchy (DHH's Arch/Hyprland distro) as a pure *feel* reference: 12 attention-to-detail heuristics with TUI translations, anti-patterns to avoid, and a "keywork feel" manifesto. |
| 5 | [`influencers/openclaw.md`](influencers/openclaw.md) | OpenClaw (openclaw/openclaw, MIT — verified): the field's most-praised agent memory — files-as-truth/index-as-cache, budgeted bootstrap, pre-compaction silent flush, taint-gated dreaming. Added 2026-08-10 for workstream J. |
| 6 | [`influencers/hermes.md`](influencers/hermes.md) | Hermes Agent (NousResearch/hermes-agent, MIT — verified): self-healing skills "versioned by reality" — execution-time self-patching, Curator with agent-created-only blast radius, progressive disclosure. Added 2026-08-10 for workstream J. |
| 7 | [`influencers/rosavera.md`](influencers/rosavera.md) | rosavera (Jordan's private workspace — no license question): fail-closed scope federation, RRF hybrid retrieval, Gardener v2 curation, usefulness feedback; plus its two known gaps keywork fixes (recall metrics, proactive recall). |
| 8 | [`influencers/knowledge-graphs.md`](influencers/knowledge-graphs.md) | KG-memory systems survey (GraphRAG, Zep/Graphiti, HippoRAG, LightRAG, Mem0, AriGraph, Letta — all MIT/Apache-2.0, verified): what a graph layer buys a coding agent (temporal supersession, multi-hop PPR, contradiction invariants) and the local SQLite design verdicts. Added 2026-08-10 for J12. |
| 9 | [`influencers/obsidian.md`](influencers/obsidian.md) | Obsidian design DNA (app proprietary — conventions open; Dataview/Datacore/Breadcrumbs MIT, Juggl GPL ⚠): wikilinks, backlinks/unlinked mentions, frontmatter properties, evergreen atomic notes, local-graph-over-global; the vault-citizenship spec making keywork's memory a first-class vault. Added 2026-08-10 for J3/J9. |
| 10 | [`influencers/lore.md`](influencers/lore.md) | Lore (dmbch/lore, MIT — a colleague's team knowledge archive as MCP service): Subjective Logic opinions, per-oracle earned trust, attestation ledgers, temporal decay. Convergent on epistemics, inverted on architecture; keywork takes ledger-derived state (R6), hallucinated-ID rejection, and the team-scope-via-MCP federation seam. |

### Feature candidates — the wider ecosystem

| # | Doc | What it covers |
|---|-----|----------------|
| 5 | [`mit-feature-candidates.md`](mit-feature-candidates.md) | Survey beyond the big three — Aider, Codex CLI, Gemini CLI, Goose, Cline, Roo Code, Zed, OpenHands, Amp — as a 26-row table rated LIFT / REIMPLEMENT / WATCH with per-source license verification. |

### Synthesis — where the research points

| # | Doc | What it covers |
|---|-----|----------------|
| 6 | [`comparison.md`](comparison.md) | Pi vs OpenCode vs Crush head-to-head: philosophy comparison, an 18-row shared-features matrix (keywork's table-stakes baseline), per-tool adoption verdicts, and ten open questions (Q1–Q10) for vision-shaping. |
| 7 | [`ux-principles.md`](ux-principles.md) | keywork's UX & interaction principles: 13 named design principles, a *proposed* leader-key + palette keyboard model, a *proposed* five-pane window model, and a 14-item simplicity budget of refusals. Sections 2–3 are proposals, not decisions. |

---

## Ground rules

> **Licensing map — applies to every recommendation in this set.**
>
> - **Pi** ([earendil-works/pi](https://github.com/earendil-works/pi)) — **MIT**: code may be lifted with attribution.
> - **OpenCode** ([sst/opencode](https://github.com/sst/opencode)) — **MIT**: code may be lifted with attribution.
> - **Crush** ([charmbracelet/crush](https://github.com/charmbracelet/crush)) — **FSL-1.1-MIT**: **never a source — never copy, port, or closely paraphrase its source, and (since 2026-08-10) not a design source either.** Where a mechanic exists in an MIT tool, lift the MIT implementation; otherwise design from first principles.
> - **Anthropic access is API-key / Agent-SDK only.** Never integrate Anthropic subscription-OAuth, and never port any tool's Pro/Max login code paths. This is a hard ToS guardrail for the project.

---

## Decisions & plan (added after vision-shaping, 2026-08-09)

The open questions have been resolved and the plan written:

| Doc | What it covers |
|-----|----------------|
| [`vision.md`](vision.md) | Decision record D1–D10 resolving Q1–Q10: MCP in core (lazy schemas), minimal core + blessed default-on extensions, trust-ladder gate, three session layers, full code-intel stack phased, **native tiling with panes as bus clients** (the differentiator), in-process server-shaped bus, Pi JSONL persistence, one typed config, terminal-only v1. |
| [`tasks.md`](tasks.md) | The parallelized implementation breakdown: milestones M0–M3 + P2, six concurrent workstreams (engine, sessions, TUI/keyboard, extensions, trust, code-intel) with dependency gates and a per-task lift strategy (LIFT:pi / LIFT:opencode / LIFT:aider / OWN; the former REIMPL:crush tag is retired). |
| [`backlog/`](backlog/README.md) | The full 75-task backlog (153pt): every workstream broken into 1–3pt tasks with descriptions, acceptance criteria, and lift strategy, in execution order. |

The research docs above remain the evidentiary base; where a decision in `vision.md`
contradicts a research lean (e.g. MCP posture), the decision wins.
