# keywork: Agent Instructions

keywork is a keyboard-first coding-agent harness: Bun + TypeScript + Vitest + OpenTUI.
`docs/README.md` indexes the research, `docs/vision.md` holds the binding decisions (D1–D10),
and `docs/backlog/` is the canonical task list (`docs/backlog/README.md` indexes the overlays
and says which one owns each topic; superseded overlays live in `docs/backlog/archive/`).

## Hard guardrails (never violate)

1. **Anthropic is API-key / Agent-SDK only.** No subscription-OAuth of any kind, no
   Claude-Code client impersonation, no ported login flows from OpenCode/Pi or anywhere else.
   `scripts/check-guardrails.ts` enforces this in CI; never weaken it to make code pass.
   The Anthropic provider (G1, `engine/src/providers/anthropic.ts`) speaks the public Messages
   API with an API key in `x-api-key` and nothing else; `docs/compliance/anthropic-review.md`
   is the checklist every change to it re-runs.
2. **Licensing:** Pi (`earendil-works/pi`) and OpenCode (`sst/opencode`) are MIT; code may be
   adapted **with attribution recorded in `NOTICE`**. Crush (`charmbracelet/crush`) is
   FSL-1.1-MIT and is **not a source for keywork at all**: never copy, port, or closely
   paraphrase its source, and (2026-08-10 decision) its formerly-credited ideas are retired:
   the `REIMPL:crush` tag no longer exists. Design those features from first principles as
   `OWN` work rather than from Crush.
3. **Git:** the user commits; agents never run `git commit` or `git push` unless explicitly
   asked in the current conversation.

## Code style: the perspective

Write with recent-MIT-grad hunger and craft: the cleanest, most elegant code you can produce,
organized top-down so it reads naturally **without comments**. If code seems to need a
comment, restructure or rename until it doesn't. The only acceptable comments state genuinely
irreducible constraints (a ToS rule, a protocol quirk): never narration, never justification
of a change. Small well-named functions. Public surface at the top of the file, helpers below,
with descriptive names doing the work documentation would. Pass this section verbatim to any
subagent writing keywork code; the perspective is the point.

## Conventions

- Strict TypeScript everywhere; no `any` without a written reason in the PR description.
- Every behavior lands with tests; acceptance criteria in `docs/backlog/` are the bar.
- Exact-pinned dependencies only (`scripts/check-pins.ts` enforces).
- New config options require a `.describe()` justification in the schema (vision D9).
- Run focused tests and relevant static checks for the changed behavior locally. CI owns
  the full `bun run check && bun run test` gate; do not repeat the full suite locally unless
  a failure or the change's risk warrants it. Report local results and CI status separately.
  `bun run test` uses Vitest; bare `bun test` is Bun's own runner and is not the gate.

## Development and release flow

- Optimize for frequent, independent releases through published dependencies. Exact pins
  and lockfiles provide reproducibility; automate their advancement rather than adding
  sibling-checkout requirements or coordinating every product release.
- Separate artifact identity from client compatibility. Verify exact binary versions and
  checksums, but use the supported protocol contract for clients that opt into compatible
  admission. Preserve legacy clients' exact requirements until they update. A different
  engine release alone is not a breaking client change. Contract changes and persistent
  state migrations need an explicit compatibility and recovery decision.
- Runtime compatibility capability `1` also promises compatible lifecycle commands and
  shared configuration formats for supported bootstraps. Older bootstraps can still perform
  lifecycle writes; preserve fields they do not own. A breaking internal format needs an
  explicit capability transition or delegation to the selected engine, even if HTTP is unchanged.
- Keep one active owner of shared engine state. Reuse a compatible verified runtime, never
  force an older bundled engine over a newer installed engine, and defer replacement while
  the runtime is running. Activate newer engines only after an explicit stop, under ownership
  protection. Never bypass ownership or delete state to make an upgrade succeed.
- Keep release metadata with its producing package. Avoid duplicate manually maintained
  pins, downstream release gates, and new cross-repository services or credentials without
  a demonstrated requirement. Required artifacts must be public before consumers discover
  metadata referring to them.
- Distinguish publication, dependency adoption, and runtime activation in status reports.
  A published version does not prove that a consumer or a running machine has adopted it.
