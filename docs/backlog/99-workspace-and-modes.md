# Workspace Anchoring, Modes & Arc Splits — Decision Overlay (2026-08-16)

> Authoritative overlay, 2026-08-16, from the design-ironing session with Jordan. Where
> this file speaks it wins; where silent, [`98`](98-chroma-and-arcs.md) →
> [`97`](97-product-direction.md) → [`96`](96-conversation-enrichment.md) /
> [`95`](95-memory-and-skills.md) / [`94`](94-file-browser-and-mouse.md) (each within its
> scope) → [`92`](92-iteration-3.md) → [`91`](91-progress-and-feedback.md) →
> [`90`](90-plan-review.md) → workstream files.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing
> before workstream G; Pi/OpenCode are MIT — adapt with attribution in `NOTICE`; Crush is
> FSL — never a source. The user commits; agents never `git commit`/`git push`.

## PD11 — Workspace materialization, anchoring & linking (Jordan, 2026-08-16)

Resolves 97's Q1–Q3/Q5 and the 98/PD10 monorepo shape. J16/J19 are unblocked.

1. **Lazy materialization on first durable act.** Nothing is written at launch; the
   workspace (declaration + vault) materializes on the first **message sent to an LLM**
   or the first **file saved within workspace scope** while open — and only in a
   **trusted** workspace (E6's prompt resolves first; untrusted stays inert per 95/P1).
   Explicit `keywork init` forces materialization.
2. **Anchor = git repo root, always.** Launching anywhere inside a repo anchors its
   root; an existing declaration found by walk-up still wins. No git → one quick
   interactive prompt (remembered). **Headless contexts never materialize a workspace**
   (fail-closed, J6 posture).
3. **Monorepo shape = root anchor + focus dirs + per-subpath MRU** (the A+C design).
   Named workspaces (98/PD10) may declare **focus dirs** (e.g. `packages/frontend`):
   retrieval, bootstrap, entity mapping, and the sessions overview bias to the focus
   subtree while the tool jail stays repo-wide. MRU is tracked **per launch subpath**,
   so `keywork` from a subdir auto-opens the workspace last used *from there*. Nested
   anchors (a `.keywork/` inside a subtree claiming its own workspace) are rejected —
   overlapping jails and split memory partitions are a semantics swamp; the in-repo
   team-vault need is served by `.keywork/workspaces/<slug>/` at the root.
4. **Linking is smooth.** `keywork link <dir>` (and `/link`) confirms once with a tight
   one-line prompt, then the dir is operative — jail widened, memory taint boundary
   extended. Dirs already listed in a **trusted** workspace's declaration operate
   without further prompts (E6 already refuses to read an untrusted clone's config, so
   a stranger's `contextDirs` can never self-grant).
5. **Migration is a clean switchover.** Sessions/snapshots/state re-key from cwd-hash
   to workspace identity with no compat shim (pre-release, no users). The engineering
   requirement that replaces the shim: a **versioned state layout** with one migration
   seam, so every future re-keying is cheap and testable.

## PD12 — Modes: Plan · Recall · Agent (Jordan, 2026-08-16)

Revises 98/97's PD3. The split-into-mode keys clause is **superseded** — splits belong
to arcs (PD13); modes flip in place.

1. **Three modes:** **Plan** (read-only toolset via the permission machinery, not
   prompt hope) · **Recall** (read-only + memory-search-first; memory corrections and
   prunes surface as **approval-gated proposals** through the staging/inbox machinery —
   never direct writes) · **Agent** (full capability behind the ordinary gate).
2. **shift+tab on the focused session cycles Plan → Recall → Agent.** No per-mode
   chords, no split-into-mode keys.
3. **Mode is per-session**, persisted, with this resolution chain:
   own mode (shift+tab) → inherit from split source → the arc's most recently used
   mode → config default (`.describe()`-justified; **ships as Agent** — the gate still
   asks before mutations). Mode changes are session entries (E5's rule); mode renders
   in pane chrome + status line.
4. **E5 is absorbed; E7 is the spec task for exactly this shape** (semantics of each
   mode's toolset/permission bundle, Recall's proposal flow, chrome presentation,
   config schema, keymap integration). Vision D2's placement rule stands: modes ship as
   blessed-extension surface or carry a written core justification.

## PD13 — Arc-aware splits (Jordan, 2026-08-16)

1. **Regular split** = new session **in the focused session's arc** (auto-named as
   today); an unbound source yields an unbound session — arcs never impose themselves.
2. **Split New Arc** = creates a fresh **auto-named** arc (suggestTitle-style,
   renameable via `/arc`) and binds **only the new session** — the source keeps its
   binding (or stays unbound); pulling the source in is an explicit `/arc switch`.
3. Binding metadata rides the session JSONL as entries (workspace identity + arc slug),
   surviving fork/clone/replay; forks inherit binding (98/PD9 unchanged).
4. Splits from sessionless panes (browser/tree/memory/mcp) land in the main tree
   unbound, mode from config default.

## Task deltas

- **J16 / J19 unblocked** — PD11 is their spec addendum; J19 additionally carries focus
  dirs + per-subpath MRU (extends 98/PD10). Same sizes.
- **E7 rescoped** to the PD12 shape (same size); its split-into-mode keymap-collision
  clause is void.
- **C37 shaped (Jordan, 2026-08-16):** one pane, two levels — the session-tree pane's
  top level becomes the workspace sessions overview; enter drills into the session's
  C13 entry tree, esc/backspace returns. Collapsed rows are minimal (title · relative
  age · live/idle density mark · arc tag; counts only on expand/focus). Enter over a
  row is **focus-or-open**: focuses the pane showing that session, else opens one in
  the main tree attached to it — the overview is the workspace switchboard. Builds on
  C36's push refresh; sequenced after it.
- **Wave record (2026-08-16):** D15 (W2), E7 spec + PR-verdict amendments (W6), and
  C44's pure half (ramp model + OKLCH math + schema, render wiring deferred behind
  C35) landed. C35 (W1) and C36+replay fixes (W3) launched on Jordan's go; C38 (W4)
  queued behind C35; C37 queued behind C36.

## Supersession record

- 97 Q1–Q3, Q5 — **resolved by PD11** (lazy/trusted materialization; git-root anchor,
  prompt when no git, headless never; join-enclosing via walk-up; clean re-key with a
  versioned layout).
- 98/PD10 monorepo selection — **refined by PD11.3** (focus dirs, per-subpath MRU,
  nested anchors rejected).
- 97/98 PD3 "split-into-mode keys" — **superseded by PD12/PD13**; mode taxonomy fixed
  as Plan · Recall · Agent (97 Q9 = per-session, Q10 = own vocabulary, resolved).
- 97 E7 task text — narrowed to the PD12 spec.
