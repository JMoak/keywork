# Plan Review — Combined Findings & Accepted Changes

> Two independent reviews (primary + adversarial second reviewer), 2026-08-09. This file is an
> **authoritative overlay** on the workstream files: where it adds, resizes, or resequences a
> task, this file wins. Integrate physically into the workstream files at next planning pass.

## Verdict (shared by both reviews)

The decision trail (D1–D10 → tasks → backlog) and licensing discipline are strong; the
mock-provider/headless-first testing posture is right. Weaknesses cluster in four places:
**product edges** (install, onboarding, docs, pickers, slash plumbing), **hostile-repo
security** (the single most dangerous omission), **assumed-not-built infrastructure** (TUI
E2E harness, guardrail CI timing), and **self-consistency** (ID schemes, milestone map).
Nothing requires rethinking the vision.

## Structural fixes (applied now)

1. **Canonical IDs:** the backlog files are the single ID authority. `tasks.md`'s coarser
   IDs are superseded — treat its tables as narrative, not addresses.
2. **Milestone map corrected** (replaces the one in `README.md`):
   - **M1 (core loop):** M0 · A1–A17 · B1–B8 · C0–C7, C12, C19, C20 · D0 · E3, E4
   - **M2 (identity demo):** C8–C11, C13, C14, C15a, C16–C18, C21–C23 · D1–D11 · E1, E2, E5, E6
   - **M3 (depth):** F1–F5 · G1–G6 · C15b
   - **M2 exit gate:** at least one keywork feature has been built *using keywork* (dogfood
     proof of the self-extension loop).

## New tasks (critical first)

### Critical
- **E6 (3pt) — Workspace trust gate.** Project-local extensions, `` !`cmd` `` command
  interpolation, and project-config permission-widening are **inert until the user trusts the
  directory** (persisted per-path, one-time overlay). Closes the clone-a-malicious-repo RCE
  hole created by D1/D5/M0.6+E1. *Accept:* hostile fixture repo produces zero code execution
  and zero permission widening until trust granted; trust activates everything; revocable.
- **C0 (3pt) — TUI E2E test harness spike.** Pick and prove the mechanism (PTY spawn + frame
  snapshot or OpenTUI test renderer) that ~15 later acceptance criteria silently assume;
  includes a 4-pane + streaming-conversation perf probe (the ux-principles early-prototype
  warning). *Accept:* keystroke-driven snapshot test of the C1 shell green on Windows + Linux CI.
- **C15 split (was 3pt, dishonest):** **C15a (2pt)** — ConPTY/OpenTUI go/no-go spike +
  fallback read-only agent-bash scrollback pane (this is the M2 demo version); **C15b (8pt,
  M3)** — full interactive embedded terminal, only if the spike says go.

### Important
- **D0 (2pt) — Command registry & slash dispatch.** One registry for built-ins (`/compact`,
  `/undo`, `/tree`, `/model`, `/reload`, `/session`, `/fork`), markdown commands, and
  extension-registered commands; feeds `/` completion, palette, headless. *Accept:* built-in
  and fixture markdown command resolve via both surfaces through one registration path.
- **A16 (2pt) — Provider resilience.** Error taxonomy (retryable / fatal / overflow), bounded
  backoff retries, hard context-overflow → B7 compaction handoff, mid-stream disconnect
  recovery, all typed events. *Accept:* fault-injection tests per class.
- **A17 (1pt) — Diagnostics logging.** `--debug` structured JSONL log session-adjacent.
- **C19 (2pt) — First-run experience.** Empty `~/.keywork/`: welcome surface teaching the five
  keys that matter + guided provider-key setup. *Accept:* E2E from nothing to working prompt.
- **C20 (2pt) — Model picker.** Fuzzy overlay, cost hints, `/model` + chord, mid-session
  switch preserving context (table-stakes row with no home until now).
- **C21 (2pt) — `@file` mention + image paste** in the input editor (fuzzy picker → A1 parts).
- **C22 (1pt) — Deep-link code references** (OSC 8 `file:line` → `$EDITOR` at line).
- **C23 (1pt) — Default keymap spec.** The actual taste decision: the shipped bindings, as a
  reviewed doc mapping every default onto ux-principles (frequency-tiered, leader grammar).
- **G3 (3pt) — Packaging & release pipeline.** Tagged release → installable artifacts
  (Win/Linux/macOS; `bun build --compile` evaluated); ships desktop entries per the 80-doc
  external-surface posture — Windows Terminal profile fragment, `.desktop` file, macOS
  `.app` shim, each launching the TUI in a well-configured terminal. *Accept:* fresh
  machine installs and runs.
- **G4 (1pt) — Version & update check** (non-nagging).
- **G5 (3pt) — User & extension-author docs.** Quickstart; config reference **generated from
  the M0.6 schema descriptions** (the option-policy justifications become the docs);
  extension guide using D2 fixtures. *Accept:* stranger reaches first prompt, author reaches
  hello-world extension, from docs alone.
- **G6 (1pt) — Minimal notifications** pulled from P2 into M3 (bell/OSC only): fire on
  ask-gate prompts + turn completion when unfocused — matters most the day the gate ships.

## Resequencing (0pt, high value)

- **Guardrail CI grep moves to M0.5** (was G2/M3): deny-list for subscription-OAuth endpoints
  and Claude-Code-imitating headers active *before* A1/A14 lift from OpenCode's provider
  layer — the two highest-contamination-risk tasks. G2 re-runs and extends it.
- **E3/E4 (snapshots + undo) move to M1** (deps are A10/A12 only): the rawest dogfooding
  period must not be the least protected. Plus: A6 gains an interim hardcoded
  ask-before-bash/write flag until E1 lands.
- **A1 acceptance extended:** hand-written Anthropic-*shaped* paper fixtures (thinking blocks,
  cache-token usage) must round-trip the neutral format losslessly — validates neutrality two
  milestones before G1 wires anything (reading public API docs violates no guardrail).

## Resizing (honesty pass)

C2 → 4pt · C12 → 6pt (split render vs. interaction at execution time) · D2 → 5pt (taxonomy
design vs. implementation) · F2 → 5pt. Standing rule: **no task whose acceptance includes
"E2E + perf budget" may be under 3pt.**

## Acceptance-criteria fixes

- C2 perf budget: relative baseline (ratio vs. single-pane render on same runner), not
  absolute ms on shared CI.
- A7: pin Pi's reference token count in-repo as a fixture; don't track a moving target.
- C16 absorbs accessibility: `NO_COLOR`, reduced-motion honored; C17 keeps contrast checks.
- B6/C5: in-TUI session list/switch is explicitly palette-reachable (fuzzy, per P8).
- The former `REIMPL:crush` tag is retired (2026-08-10 decision): Crush is not a design
  source, and every task that carried the tag is now `OWN`, designed from first principles.
  The FSL rule stands regardless — Crush source is never consulted.

## Revised totals

**90 tasks, ~196 points** (was 75/153). The delta is honesty, not scope creep: ~27pt of
genuinely missing product edges, +9pt of resizing, +7pt from pricing the terminal pane truthfully.
