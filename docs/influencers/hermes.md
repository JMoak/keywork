# Hermes Agent (NousResearch/hermes-agent)

> Research dossier for **keywork**, added 2026-08-10 for the memory & self-healing-skills
> workstream (backlog `95-memory-and-skills.md`). Hermes Agent is Nous Research's
> open-source self-improving personal agent (distinct from the Nous Hermes LLM family).

> **LICENSING**
> **MIT** — verified against the repo's `LICENSE` file ("Copyright (c) 2025 Nous
> Research"). Code may be adapted **with attribution recorded in `NOTICE`**, same tier as
> Pi and OpenCode. (Hermes is Python/Node — keywork adapts mechanisms and contracts, in
> TypeScript.)

## Why keywork studies it: self-healing skills

Hermes treats skills as the agent's procedural memory and makes them **"versioned by
reality"** — no scheduled audit decides staleness; execution does.

### Format

Skills are `SKILL.md` (agentskills.io standard — same standard as keywork's D7) in
`~/.hermes/skills/<category>/<name>/` with YAML frontmatter (`name`, `description`,
`version`, `platforms`, required toolsets/config) plus optional `references/`, `scripts/`,
`templates/`. A hash manifest tracks bundled-skill origins.

### Mechanisms keywork adapts

1. **Execution-time self-patching** — when a skill's command fails or its documented
   behavior mismatches reality mid-run, the agent repairs the skill immediately via a
   surgical old-string/new-string patch (full rewrite as fallback), and the fix persists
   for future sessions.
2. **Progressive disclosure loading** — list (metadata only) → view (full skill) → view
   (specific reference file); frontmatter hides skills whose required toolsets/platforms
   are absent. Convergent with keywork's D10 lazy-schema philosophy.
3. **Autonomous skill creation** — the agent writes a new skill after completing a complex
   task (5+ tool calls), after discovering a non-trivial workflow through errors, or after
   user corrections.
4. **The Curator** — a slow background maintenance loop driven by telemetry
   (view/use/patch counts) that marks agent-created skills stale/archived over time and
   emits an auditable report each run. **Blast-radius invariant: it only ever touches
   agent-created skills — never human-authored or bundled ones.** keywork keeps this
   invariant verbatim.
5. **Staged writes** — optional `write_approval` mode stages agent skill-writes into a
   pending area with review/diff/approve/reject. In keywork this folds into the write-gating
   design (J-series open question) rather than being its own mechanism.
6. **Trust tiers + scanning** for hub-installed skills (builtin/official/trusted/community;
   `dangerous` verdicts unoverridable).

(Also of note: GEPA — human-initiated genetic-Pareto skill evolution over execution traces,
gated behind PR-style review. Out of scope for keywork v1; recorded for later.)

Caveat from the research pass: Curator scheduling specifics (7/30/90-day thresholds) came
from secondary sources — re-verify against the repo's `website/docs` at adaptation time.

## Sources

- <https://github.com/NousResearch/hermes-agent> · LICENSE (raw, verified MIT)
- <https://hermes-agent.nousresearch.com/docs/> · in-repo `website/docs/user-guide/features/skills.md`
- <https://arapaholabs.com/blog/2026-06-01-hermes-skills-self-healing-dynamic-loading>
- <https://securityboulevard.com/2026/06/8-self-evolving-skills-hermes-agent-writes-on-its-own/>
- Adjacent prior art: Voyager (Wang et al., 2023) skill libraries · Reflexion (Shinn et
  al., 2023) · GEPA (arXiv 2507.19457) · <https://github.com/UniM0cha/self-improving-skills>
