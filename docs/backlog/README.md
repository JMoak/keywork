# keywork — Backlog Index

> The full task breakdown derived from [`../tasks.md`](../tasks.md) and [`../vision.md`](../vision.md).
> Tasks are sized 1–3 points where possible (a few are honestly bigger and say so) and listed
> **in execution order** within each file. Dependencies are intentionally not modeled here —
> order implies them loosely; the workstream files can be attacked in parallel.
>
> **Point scale:** 1pt ≈ one focused hour or two · 2pt ≈ a half-day · 3pt ≈ a full day.
> **Strategy tags:** `LIFT:pi` / `LIFT:opencode` / `LIFT:aider` = adapt MIT/Apache source with
> attribution (record in `NOTICE`) · `REIMPL:crush` = reimplement the idea, never the source ·
> `OWN` = original work.
>
> **Standing guardrails:** no Anthropic wiring of any kind before workstream G; API-key /
> Agent-SDK only, ever; no subscription-OAuth code paths ported from any source.

| File | Workstream | Tasks | Points |
|---|---|---|---|
| [`00-m0-skeleton.md`](00-m0-skeleton.md) | M0 — repo skeleton | 6 | 9 |
| [`10-engine.md`](10-engine.md) | A — engine core | 15 | 30 |
| [`20-sessions.md`](20-sessions.md) | B — session trees | 8 | 15 |
| [`30-tui.md`](30-tui.md) | C — TUI, keyboard, tiling | 18 | 37 |
| [`40-extensions.md`](40-extensions.md) | D — extensions, commands, MCP | 11 | 22 |
| [`50-trust.md`](50-trust.md) | E — trust & safety | 5 | 10 |
| [`60-code-intel.md`](60-code-intel.md) | F — code intelligence | 5 | 10 |
| [`70-anthropic.md`](70-anthropic.md) | G — Anthropic (late, gated) | 2 | 3 |
| [`80-p2-reach.md`](80-p2-reach.md) | P2 — server, attach, workspaces | 5 | 17 |

| [`90-plan-review.md`](90-plan-review.md) | **Authoritative overlay** — combined two-reviewer findings: 15 new tasks (E6 trust gate, C0 TUI harness, D0 slash registry, packaging/docs/onboarding, …), resequencing (guardrail CI grep → M0, undo → M1), resizing, corrected milestone map | 15 | +43 |

**Total: 90 tasks, ~196 points** (after review overlay).

**Milestone map — see `90-plan-review.md` (authoritative):**
**M1** = M0 · A1–A17 · B1–B8 · C0–C7, C12, C19, C20 · D0 · E3, E4 ·
**M2** = C8–C11, C13, C14, C15a, C16–C18, C21–C23 · D1–D11 · E1, E2, E5, E6 (exit gate:
one keywork feature built *using* keywork) · **M3** = F1–F5 · G1–G6 · C15b · **P2** post-v1.

**ID authority:** these backlog files are canonical; the coarser IDs in `../tasks.md` are
superseded narrative.
