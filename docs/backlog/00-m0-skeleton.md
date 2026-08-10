# M0 — Repo Skeleton

> Serial; everything gates on this file being done. Decisions made here: **Bun workspaces
> without Turbo** (add Turbo only if task-graph pain appears), **Biome** for lint+format (one
> fast tool over eslint+prettier sprawl).

---

### M0.1 (2pt) — Monorepo scaffold
Bun workspaces with `packages/engine`, `packages/tui`, `packages/extensions`, `packages/cli`,
`packages/shared`; root `package.json` scripts (`check`, `test`, `build`); strict base
`tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) extended
per package; Vitest workspace config running per-package `*.test.ts`.
**Accept:** `bun install && bun run check && bun test` green on Windows with one placeholder
test per package; packages can import `@keywork/shared`.
**Strategy:** `LIFT:opencode` layout patterns (study `sst/opencode` root, don't copy configs
blind — no Turbo, no Effect).

### M0.2 (1pt) — Supply-chain hygiene
Exact-pin policy (no `^`/`~` in any `package.json`), committed lockfile, `.npmrc` with
`ignore-scripts=true`, a `bun run check:pins` script that fails on ranged versions.
**Accept:** check script catches a deliberately ranged dep in CI.
**Strategy:** `LIFT:pi` practices (their supply-chain README section).

### M0.3 (2pt) — Agent instructions & attribution policy
`AGENTS.md`: project conventions, the licensing map (Pi/OpenCode MIT-lift, Crush excluded),
the Anthropic API-key-only guardrail, pointer to `docs/`. `CLAUDE.md` shim containing
`@AGENTS.md`. `NOTICE` file seeded with Pi and OpenCode attribution blocks (MIT texts +
"portions adapted from" lines) — every future `LIFT` task appends here.
**Accept:** files exist; `AGENTS.md` states all three guardrails verbatim.
**Strategy:** `OWN`.

### M0.4 (1pt) — Lint & format
Biome configured (recommended rules + import sorting), `bun run lint` / `bun run format`,
pre-commit optional (no husky requirement — CI is the gate).
**Accept:** lint passes clean; a seeded violation fails.
**Strategy:** `OWN`.

### M0.5 (2pt) — CI
GitHub Actions: matrix `windows-latest` + `ubuntu-latest`; jobs: install (frozen lockfile),
`check:pins`, typecheck, Biome, Vitest. Badge in README.
**Accept:** green on both OSes on a PR; red on type error, lint error, or ranged pin.
**Strategy:** `OWN`.

### M0.6 (1pt) — Config foundation
`packages/shared`: the single typed config schema stub (settings + keybindings shape) with
schema validation (zod or TypeBox — pick one, document why) and loading order
(defaults → user `~/.keywork/` → project `.keywork/`). Includes the **option policy** comment
header: "every new option is a design failure until justified; justification lives in the
schema description" (D9).
**Accept:** config loads + validates + merges in a unit test; invalid config yields a
human-readable error.
**Strategy:** `OWN`; format ideas from `LIFT:opencode` (`opencode.json`) without its breadth.
