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

## Open items before the button

| item | state | owner |
|---|---|---|
| First tag (`v0.1.0`) | not cut; cut only after the walk passes | Jordan |
| `ubuntu-24.04-arm` and `macos-15-intel` runner labels | assumed in `release.yml`, unverified against the repo's runner set | whoever runs the first tag |
| npm package name | `keywork` availability on the registry unchecked; decide name before `NPM_PUBLISH` flips | Jordan |
| README one-liner | feel-led, Jordan wordsmiths; the draft slot is the first line under the title | Jordan |
| Keys section: win32 note | landed 2026-09-02: the README keyboard bullet names the Windows Terminal reality and the `leader i` chord | done |
| Public-repo sweep | swept 2026-09-02: NOTICE reviewed current, every local doc link resolves, prose check green, tree and history secret scans clean (only the redaction test's documented EXAMPLE fixtures) | done |

## The bar, restated

CI green (`check`, vitest, e2e, guardrails), the walk under 60 seconds on Linux, README
honest, and nothing in the repo you would not defend in public. When all rows above clear,
tag.
