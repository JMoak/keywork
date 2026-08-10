# keywork — Agent Instructions

keywork is a keyboard-first coding-agent harness: Bun + TypeScript + Vitest + OpenTUI.
`docs/README.md` indexes the research, `docs/vision.md` holds the binding decisions (D1–D10),
and `docs/backlog/` is the canonical task list (`90-plan-review.md` is an authoritative
overlay).

## Hard guardrails (never violate)

1. **Anthropic is API-key / Agent-SDK only.** No subscription-OAuth of any kind, no
   Claude-Code client impersonation, no ported login flows from OpenCode/Pi or anywhere else.
   `scripts/check-guardrails.ts` enforces this in CI; never weaken it to make code pass.
   No Anthropic provider wiring at all before backlog task G1.
2. **Licensing:** Pi (`earendil-works/pi`) and OpenCode (`sst/opencode`) are MIT — code may be
   adapted **with attribution recorded in `NOTICE`**. Crush (`charmbracelet/crush`) is
   FSL-1.1-MIT and is **not a source for keywork at all**: never copy, port, or closely
   paraphrase its source, and (2026-08-10 decision) its formerly-credited ideas are retired —
   the `REIMPL:crush` tag no longer exists; design those features from first principles as
   `OWN` work rather than from Crush.
3. **Git:** the user commits; agents never run `git commit` or `git push` unless explicitly
   asked in the current conversation.

## Code style — the perspective

Write with recent-MIT-grad hunger and craft: the cleanest, most elegant code you can produce,
organized top-down so it reads naturally **without comments**. If code seems to need a
comment, restructure or rename until it doesn't. The only acceptable comments state genuinely
irreducible constraints (a ToS rule, a protocol quirk) — never narration, never justification
of a change. Small well-named functions; public surface at the top of the file, helpers below;
descriptive names over documentation. Pass this section verbatim to any subagent writing
keywork code — the perspective is key.

## Conventions

- Strict TypeScript everywhere; no `any` without a written reason in the PR description.
- Every behavior lands with tests; acceptance criteria in `docs/backlog/` are the bar.
- Exact-pinned dependencies only (`scripts/check-pins.ts` enforces).
- New config options require a `.describe()` justification in the schema (vision D9).
- `bun run check && bun test` must be green before any task is called done.
