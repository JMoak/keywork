# Workstream B — Session Trees

> `packages/engine` (session module). Pi's JSONL tree format lifted wholesale (D4/D8) — the
> conversation is a tree, panes will be views onto its leaves, replay is the extension-state
> contract. Format compatibility with Pi's documented `session-format.md` is a feature.

---

### B1 (2pt) — JSONL tree store
Append-only JSONL session files implementing Pi's entry schema: entries with `id`/`parentId`,
session header, active-leaf pointer; atomic append; corruption tolerance (truncated final
line recovered, not fatal).
**Accept:** round-trip tests; a Pi-generated sample session file loads correctly
(compatibility fixture); torn-write recovery test.
**Strategy:** `LIFT:pi` documented format.

### B2 (2pt) — Session directory & lifecycle
Per-cwd session organization under `~/.keywork/sessions/` (hashed project path), create /
list / resume APIs, `--continue` (most recent) and `--resume <id>` CLI flags on `keywork run`.
**Accept:** E2E: run, exit, `--continue` restores full context via replay.
**Strategy:** `LIFT:pi` layout.

### B3 (2pt) — Replay engine
Reconstruct in-memory state (message list for the active path, metadata) by replaying entries
root→leaf; this is also the extension-state reconstruction contract (D-stream depends on it),
so replay emits the same bus events as live execution, flagged `replay: true`.
**Accept:** replayed session produces identical engine state to the live run that created it
(property test on random mock conversations).
**Strategy:** `LIFT:pi` replay contract.

### B4 (2pt) — Fork & clone
`fork` (new branch from any entry; active leaf moves), `clone` (copy path into a fresh
session file); parent linkage recorded per Pi format.
**Accept:** fork from mid-conversation diverges cleanly; both branches replay correctly;
Pi-format compatibility preserved.
**Strategy:** `LIFT:pi`.

### B5 (1pt) — Labels
Named markers on entries (`label <name>`), listed and jumpable; stored as Pi-format entries
so they survive replay.
**Accept:** label, fork-at-label, list round-trips.
**Strategy:** `LIFT:pi`.

### B6 (2pt) — Tree navigation data
Engine API producing the render-ready tree: branch points, labels, leaf summaries, active
path — consumed later by the session-tree pane (C13) and `/tree` command; includes
branch-switch summaries ("what happened on this branch") generated lazily.
**Accept:** unit tests on a fixture tree with 4 branches; summary generation invoked via mock
provider.
**Strategy:** `LIFT:pi` (`/tree` UX as spec).

### B7 (3pt) — Compaction
Auto-compaction near context limit + promptable `/compact [instructions]`: summarize the
active path into a compaction entry (Pi format), preserving pinned/labeled content; branch
aware — compacting one branch never mutates another.
**Accept:** long mock conversation auto-compacts under a configured limit and continues
coherently; custom-prompt compaction honored; other branches untouched.
**Strategy:** `LIFT:pi` promptable compaction.

### B8 (1pt) — Session stats
`/session`-style stats from the store: entry counts, branch count, token/cost totals (A15),
duration; exposed as engine API + headless JSON.
**Accept:** stats match a known fixture exactly.
**Strategy:** `LIFT:pi`.
