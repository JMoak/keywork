# The launch runway

> The working checklist for the M2 public bar: repo goes public at the demo, CI green, docs
> coherent, and the screencast is **zero-to-working in 60 seconds** (install → onboarding →
> first agent turn → first undo). The release mechanics live in [`release.md`](release.md);
> this doc is what remains between here and pressing the button. Written 2026-08-31 for
> Jordan plus an agent on a Linux machine (Linux is the primary platform of record).

## What already exists (do not rebuild)

- `scripts/install.sh` / `install.ps1`, five per-platform binaries built on their own
  runners, SHA256SUMS, npm fallback package: all landed (108/G3). `release.yml` refuses a
  tag that does not match the CLI manifest.
- The ritual: bump `packages/cli/package.json` version → tag `v<version>` → push the tag.
  The workflow times `install.sh` against the fresh release and prints the number.
- `keywork init` (trust + workspace + memory + arcs in one step), onboarding auto-fires
  when no provider resolves, `/undo` rides shadow-git checkpoints.

## The walk (Linux machine, fresh user account or container)

Run the 60 seconds honestly, with a stopwatch, and write down where it stalls:

1. **Install**: the one-liner from the README against the latest tag (or a local
   `scripts/release/build.ts` binary until the first tag exists). Time it.
2. **Onboarding**: `keywork` in a fresh git repo. The no-provider path should walk you to a
   working binding without leaving the TUI. Note every prompt that made you think.
3. **First turn**: one real prompt against a bound provider; watch the title, the gauge,
   the tool rows.
4. **First undo**: make the agent edit a file, `/undo`, confirm the file reverted.
5. **The relaunch check (112 flag, still unverified live)**: `keywork` in a fresh untrusted
   folder → `/init` → the in-process relaunch must land you in a trusted, working workspace
   without restarting the terminal. If it misbehaves, capture the exact behavior; the
   fallback design ("reopen keywork yourself, trust is saved") is pre-approved if needed.
6. Repeat 1 to 4 once more, timed end to end. That number is the screencast budget.

Report format: one line per step, timing, and any friction verbatim. File findings as
notes for the 113 ledger; do not fix drive-by in the same session unless it is a one-liner.

## Material for the screencast (C56)

- `bun run e2e` capture output (`artifacts/e2e/`) is deterministic and themed; the
  `tiling-tour`, `chrome-states`, and `memory-browser` sets are the current best stills.
- The screencast itself is recorded live, not synthesized: the walk above, one real-time
  minute. Practice runs count as the timing evidence.
- The README's adjacent screenshot: a real terminal at 120x32, seams chrome, three panes,
  one arc hue visible. Capture after the W9 masthead work lands so the poster state shows.
- **Poster candidate (checked 2026-10-07, 49 capture sets in `artifacts/e2e/`):** no current
  still meets all four points, because every e2e capture runs the mock provider with empty
  sessions and the `keywork e2e` status line. Nearest on geometry:
  `tiling-tour/02-three-panes` (120x32 yes, seams yes, four panes with the tree docked
  left and three sessions, no arc bound so no hue). Nearest on hue:
  `arcs/02-split-inherits-arc` (seams yes, `#dock-v2` chip and the purple arc hue on both
  session rows, but 160x40 and four panes). The poster is a live capture of the real app
  at 120x32 with one arc bound; the `arcs` scenario's first two steps are the recipe.

### README one-liner drafts (2026-10-07, for Jordan to wordsmith; none of these is in README.md)

Each line is true in the tree today: tiling panes, `/undo` on shadow-git checkpoints, the
pty-backed terminal pane on Linux and macOS, the memory vault, headless `keywork run`.

1. Split your terminal, run an agent in every pane, and take any turn back with `/undo`.
2. A tiling workspace for coding agents, with a real shell beside them and an undo key under
   every edit they make.
3. Agents in panes, a vault that remembers across sessions, and the same engine in CI as
   `keywork run`.

## Open items before the button

| item | state | owner |
|---|---|---|
| First tag (`v0.1.0`) | not cut; cut only after the walk passes | Jordan |
| `ubuntu-24.04-arm` and `macos-15-intel` runner labels | verified 2026-10-07 against the GitHub-hosted runner reference (docs.github.com): all five labels in `release.yml` (`ubuntu-latest`, `ubuntu-24.04-arm`, `windows-latest`, `macos-latest`, `macos-15-intel`) are documented hosted labels; the arm label is the standard free-for-public-repos runner, no `workflow` change needed; still unproven by a run until the first tag | done (label check); first-tag run pending |
| npm package name | checked 2026-10-07: `keywork` is taken (nirrius/keywork, a Cloudflare Workers library, AGPL-3.0, latest 8.1.19, active); `keywork-cli` is already Jordan's on the registry (`0.1.0-next.0` and `-next.1`, FSL-1.1-MIT, `bin: keywork`), which is the name `scripts/release/npm-manifest.ts` writes; no package exists under the `@keywork` scope and scope ownership cannot be checked without an account; `keywork-agent` is free. `docs/release.md` now says `keywork-cli` | done, unless Jordan wants a different name before `NPM_PUBLISH` flips |
| README one-liner | feel-led, Jordan wordsmiths; the draft slot is the first line under the title; three drafts above (2026-10-07) | Jordan |
| Poster screenshot | candidate checked 2026-10-07 (above): no e2e still meets all four spec points; live capture at 120x32 with one arc bound | Jordan, after the walk |
| Keys section: win32 note | landed 2026-09-02: the README keyboard bullet names the Windows Terminal reality and the `leader i` chord | done |
| Public-repo sweep | swept 2026-09-02 and again 2026-10-07: NOTICE current (Pi credited for ContextEditEntry and the 40 D1 to D3 hook vocabulary, OpenCode D5/D6 marked design only, the October memory and skills work is `OWN`), all 72 markdown files under `docs/` plus `README.md` resolve every relative link, prose check green, working tree and full history secret scans clean (hits are the documented EXAMPLE fixtures in the redaction, diagnostics, anthropic, run and bug-bundle tests plus `scripts/guardrail-patterns.json`) | done |

## The bar, restated

CI green (`check`, vitest, e2e, guardrails), the walk under 60 seconds on Linux, README
honest, and nothing in the repo you would not defend in public. When all rows above clear,
tag.
