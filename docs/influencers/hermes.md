# Hermes Agent (NousResearch/hermes-agent)

> Research dossier for **keywork**, added 2026-08-10 for the memory & self-healing-skills
> workstream (backlog `95-memory-and-skills.md`). Hermes Agent is Nous Research's
> open-source self-improving personal agent (distinct from the Nous Hermes LLM family).

**Status 2026-10-02.** Upstream now requires approval for every write to `AGENTS.md`, skills
and memory, added a compaction recall eval harness and an advisory SKILL.md linter, and
published the Curator's real thresholds (see "Since 2026-08-10"). The skill mechanisms below
landed as J10; curator hygiene and the write guard are open in
`docs/backlog/117-influence-sweep.md`, and the workstream is
`docs/backlog/95-memory-and-skills.md` (J).

> **LICENSING**
> **MIT**, verified against the repo's `LICENSE` file ("Copyright (c) 2025 Nous
> Research"). Code may be adapted **with attribution recorded in `NOTICE`**, same tier as
> Pi and OpenCode. (Hermes is Python/Node; keywork adapts mechanisms and contracts, in
> TypeScript.)

## Why keywork studies it: self-healing skills

Hermes treats skills as the agent's procedural memory and makes them **"versioned by
reality"**: no scheduled audit decides staleness; execution does.

### Format

Skills are `SKILL.md` (agentskills.io standard, the same standard as keywork's D7) in
`~/.hermes/skills/<category>/<name>/` with YAML frontmatter (`name`, `description`,
`version`, `platforms`, required toolsets/config) plus optional `references/`, `scripts/`,
`templates/`. A hash manifest tracks bundled-skill origins.

### Mechanisms keywork adapts

1. **Execution-time self-patching**: when a skill's command fails or its documented
   behavior mismatches reality mid-run, the agent repairs the skill immediately via a
   surgical old-string/new-string patch (full rewrite as fallback), and the fix persists
   for future sessions.
   **Landed:** J10, `packages/engine/src/skills/tools.ts` (`skill_patch`, `skill_rewrite`)
   over `skills/library.ts`, with authorship enforced in `skills/authorship.ts`.
2. **Progressive disclosure loading**: list (metadata only) → view (full skill) → view
   (specific reference file); frontmatter hides skills whose required toolsets/platforms
   are absent. Convergent with keywork's D10 lazy-schema philosophy.
   **Landed** for list, view and reference: J10, `skills_list` and `skill_view` in
   `packages/engine/src/skills/tools.ts`. **Open** for `platforms`/toolset hiding (J10
   follow-up).
3. **Autonomous skill creation**: the agent writes a new skill after completing a complex
   task (5+ tool calls), after discovering a non-trivial workflow through errors, or after
   user corrections.
   **Landed:** J10, `skill_create` in `packages/engine/src/skills/tools.ts` over
   `skills/genesis.ts` (trusted project root only), plus the J27 `skills` level for bots
   (`packages/engine/src/memory/bots/skill-genesis.ts`).
4. **The Curator**: a slow background maintenance loop driven by telemetry
   (view/use/patch counts) that marks agent-created skills stale/archived over time and
   emits an auditable report each run. **Blast-radius invariant: it only ever touches
   agent-created skills, never human-authored or bundled ones.** keywork keeps this
   invariant verbatim.
   **Landed** for telemetry and review: J10 counts in `packages/engine/src/skills/telemetry.ts`
   feed `Gardener.sweep({ skills })` in `packages/engine/src/memory/gardener.ts`, which
   proposes `skill-review` items (churning, unused 30 days) on agent-authored skills only.
   **Open:** the archive folder, pin, dry run and actor ledger, as 117's curator hygiene
   (scope first).
5. **Staged writes**: optional `write_approval` mode stages agent skill-writes into a
   pending area with review/diff/approve/reject. In keywork this folds into the write-gating
   design (J-series open question) rather than being its own mechanism.
   **Open:** skill patch and rewrite are `mutates: true` and sit behind the ordinary ask
   gate today; the J11 `onChange` subscription (chip and one-key revert) is unbuilt, and
   SW7 (117) routes agent writes to skill directories and instruction files through the
   gate.
6. **Trust tiers + scanning** for hub-installed skills (builtin/official/trusted/community;
   `dangerous` verdicts unoverridable).
   **Superseded:** 117 declines marketplaces, registries and synced skill catalogs, so there
   is no hub to tier.

(Also of note: GEPA, human-initiated genetic-Pareto skill evolution over execution traces,
gated behind PR-style review. Out of scope for keywork v1; recorded for later.)

Caveat from the research pass: Curator scheduling specifics (7/30/90-day thresholds) came
from secondary sources; re-verify against the repo's `website/docs` at adaptation time.
Resolved 2026-10-02 from the raw curator doc on `main`: stale after 14 days, archive after
30, run every 168 hours with at least 2 hours idle (search snippets claiming 30/90 are
wrong).

## Since 2026-08-10

- **v2026.8.31:** writes to `AGENTS.md`, skills and memory stores always require approval
  (#81152); keywork: **open** as SW7. A compaction recall eval harness (#87326); keywork:
  **open** as the memory-off control in the J4 probe corpus (117 scope first; the J4 corpus
  itself is unbuilt). An advisory SKILL.md linter runs on create (#81896); keywork: **open**
  as SW16 Agent Skills conformance.
- **v2026.9.11:** a skills-only background review can no longer delete memory entries
  (#106310). keywork's Gardener skill review only emits proposals; memory writes in the
  same sweep follow the promotion and agent-only blast-radius rules in `gardener.ts`.
- **Curator doc (main):** stale after 14 days, archive after 30, runs every 168 hours with
  at least 2 hours idle. LLM consolidation is off by default. Supports `--dry-run`, `pin`,
  `restore` and `rollback`; the ledger `.curator_ledger.jsonl` records the actor; each run
  writes `REPORT.md`; the archive is a recoverable directory; skills made in the foreground
  by `/learn` (`created_by: learn`) are excluded from curation. keywork: **open** as 117's
  curator hygiene.

## Sources

- <https://github.com/NousResearch/hermes-agent> · LICENSE (raw, verified MIT)
- <https://hermes-agent.nousresearch.com/docs/> · in-repo `website/docs/user-guide/features/skills.md`
- <https://arapaholabs.com/blog/2026-06-01-hermes-skills-self-healing-dynamic-loading>
- <https://securityboulevard.com/2026/06/8-self-evolving-skills-hermes-agent-writes-on-its-own/>
- Adjacent prior art: Voyager (Wang et al., 2023) skill libraries · Reflexion (Shinn et
  al., 2023) · GEPA (arXiv 2507.19457) · <https://github.com/UniM0cha/self-improving-skills>
- <https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.31>
- <https://github.com/NousResearch/hermes-agent/releases> (v2026.9.11)
- <https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/features/curator.md>
