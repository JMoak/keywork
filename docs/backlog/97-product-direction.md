# Product Direction — Feedback Overlay (2026-08-15)

> Authoritative overlay, 2026-08-15, from Jordan's second hands-on feedback pass. Where this
> file speaks it wins; where silent, [`96`](96-conversation-enrichment.md) / [`95`](95-memory-and-skills.md) /
> [`94`](94-file-browser-and-mouse.md) (each within its scope) → [`92`](92-iteration-3.md) →
> [`91`](91-progress-and-feedback.md) → [`90`](90-plan-review.md) → workstream files apply.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing before
> workstream G; Pi/OpenCode are MIT — adapt with attribution in `NOTICE`; Crush is FSL —
> never a source (no code, no design credits since 2026-08-10). The user commits; agents
> never `git commit`/`git push`.

## The eight items, dispositioned

| # | Feedback | Disposition |
|---|---|---|
| 1 | Panes must be the product; single-dialogue chat is near-useless as-is | **PD1** decided → task D15 |
| 2 | Two-dock system (left + right) with location cycling | **PD2** decided (supersedes 92 Track Q item 4) → task C38 |
| 3 | Plan/Execute/Agent-style permission modes, next-level, with direct split-into-mode keys | **PD3** direction → design task E7 (gates implementation) |
| 4 | Task groups as layered/subset memory spaces | **PD4** direction, deliberately design-gated → task J15 |
| 5 | Workspace anchors to the launch dir; linked folders envelop permissions + memory | **PD5** direction with open questions → task J16 |
| 6 | Sessions surface doesn't refresh; registers dupes; should be right-info-out-of-box | **PD6** decided (defects confirmed in code) → tasks C36, C37 |
| 7 | Visual glitching / overlapping outer frames as panes shrink | **PD7** decided (root cause found) → task C35 |
| 8 | Outline next steps + safe independent work streams | The **Work streams** section below |

## Direction decisions (Jordan, 2026-08-15)

### PD1 — Panes is the front door
Bare `keywork` in a TTY opens the tiled panes app; that is the product a person on any
machine with keywork on their PATH gets. Today `packages/cli/src/main.ts` defaults the
subcommand to `chat` — a plain readline REPL sharing no rendering with the TUI. The CLI
feature surface (`run`, `sessions`, `setup`, `trust`, headless/`--json`) remains first-class
for scripting and CI. `keywork chat` is **demoted, not yet deleted**: it stays as the
engine's manual smoke harness *only while it exercises paths panes cannot* (today: the
compaction trigger; panes has none — see 92 "TUI lifecycle" honest note). The moment panes
reaches lifecycle parity, chat's removal is the default outcome and keeping it needs a
written justification. Either way its ~190-line duplicated composition wiring goes now
(D15): one composition module both surfaces consume, so chat's marginal cost is near zero
while it lives. This is launch-critical — the "zero-to-working in 60 seconds" screencast
(README release posture) starts at bare `keywork`.

### PD2 — Two docks, one cycle
Supersedes 92 Track Q item 4 (the affirmed single-column dock): the deferred
dock-identity work is now scheduled. The layout grows **two independent docks** (left and
right edges), each a full-height stack with its own ratio and order; a pane's location
**cycles** through `main → left dock → right dock → main` with one repeatable key, while
the existing direct verbs (`leader d`/`D`) keep meaning dock-left/dock-right. D14's
auto-dock-right MCP pane and C31's browse-docked behavior become natural residents of
their respective sides. Workspace-state persists both docks (version bump + v1 migration:
the single dock becomes that side's dock, other side empty).

### PD3 — Modes: permission packages you can split straight into
keywork will have named **modes** in the Plan/Execute/Agent family, but built as the
next-level version of the idea, not a copy: a mode is a *declarative bundle* — agent
(D6) + permission preset/matrix (E1/E2) + toolset (I12's read-only definitions) + model
role (J-D8) — and it attaches **per pane**, not globally. A tiler is the one place
per-pane modes are genuinely more powerful than a global toggle: plan in one pane while
an executor runs in another. Direct **split-into-mode keys** (e.g. leader chords that
split and land in a named mode) make the permission set a first-class spatial act. Mode
is visible in the pane chrome and status line (C18/E2 vocabulary); switching modes is a
session entry (E5's rule). J-D7 stands: this is tool-permission surface only — memory
validity machinery stays separate. E5 (Plan/Build + Tab) is hereby the *floor*, not the
spec; E7 designs the real thing before any implementation task is sized.

### PD4 — Task groups: layered memory subsets (design-gated)
Within a workspace, work should be groupable into **tasks** that carry their own layered
memory subset — bootstrap and recall see workspace scope *plus* the active task's layer;
task-local notes don't pollute the workspace-wide garden until promoted. This is
deliberately design-first (J15): it touches scope policy (J6 fail-closed), bootstrap
budgets (R4), the vault layout (J3), and the airlock — the cost of a wrong cut is high.
No implementation before the J15 design is reviewed and its open questions (below) are
answered.

### PD5 — The workspace anchors where `keywork` runs
The directory `keywork` launches from is the workspace anchor (nearest enclosing
declaration still wins, git-style — launching in a subdir joins the enclosing workspace).
Additional folders can be **linked** into the workspace and are thereby enveloped into
tool permissions (the confinement jail) and memory scope. Reality check from the code:
`contextDirs` already exists in `workspaceDeclarationSchema` but is **inert** — nothing
creates `.keywork/workspace.json` (no `keywork init`, no auto-create), `confinedPath()`
is cwd-only, and the entire memory stack silently disables itself when no declaration
exists (`resolveVaultPath` → `undefined` → `openWorkspaceMemory` → `undefined`). The
"auto-create" Jordan observed is only the machine-local layout state
(`~/.keywork/workspaces/<hash>.json`). J16 makes the declared workspace real; its open
questions (below) are raised for refinement before the auto-materialization behavior is
locked.

### PD6 — Sessions must be live and honest
The session-tree pane refreshes only in its constructor, on `r`, and after a relabel —
a running conversation's entries never appear until manual refresh. And "duplicate
sessions" are real, with identified mechanisms: every conversation-pane open with a
provider configured and no resume/restore attachment mints a session file on disk
immediately (`startFreshSession`, `app.ts:443`) so splitting conversation panes litters
`~/.keywork/sessions/` with empty JSONL files; `main.ts` re-implements `SessionPort`
inline (diverging from the tested `sessions.ts:62` export — the inline copy exists to
feed the `afterTurn` flush lookup and checkpoint tags, so unification needs an attach
seam, not deletion alone) and its `stores`/`flushes` maps are never pruned on pane
close; the fork path can orphan eagerly-opened attachments.
Decision: session surfaces refresh **push-based off the bus** (the MCP pane's
`subscribe` port is the precedent), session files materialize **lazily on first entry**,
the duplicate wiring unifies, and the sessions overview grows into the
right-info-out-of-the-box surface (C37) rather than a debug listing.

### PD7 — One geometry, drawn and reported
The overlap glitch has a structural cause, not a cosmetic one: `Layout.rects()` honors
split ratios but `buildBody`/`treeView` render with even-split flexbox
(`flexGrow: 1, flexBasis: 0` — `node.ratio` never reaches the renderer), so reported
pane sizes, mouse hit-testing (`paneUnder`), and drawn borders disagree the moment any
ratio ≠ 0.5 or minimums bind. Under pressure `divideExtent`'s final `[1, total-1]`
clamp silently abandons min-size guarantees, while every pane floors its content
(`Math.max(10, width - 4)`, `padEnd(width)`) at sizes the drawn box may not have —
content escapes the frame. Chrome row/column constants are also unreconciled across
files (borders + padding cost 4 columns and 2 rows — the title renders inside the top
border — while panes subtract 3 rows; whether that spare row is deliberate headroom is
undecided and must be adjudicated, not assumed). Decision: **the layout tree's rects
are the single source of geometric truth** — the renderer draws exactly them (explicit
sizes, not flex weights), pane content never exceeds its rect, and min-size handling is
honest (refuse the split, or overflow-mark the pane — never silently overlap). This
also closes H4's flagged "~1-cell chrome offset" and makes mouse hit-testing exact.

## New tasks

IDs continue existing schemes; same point scale as the workstream files.

### C35 (2pt) — Geometry unification (implements PD7)
Render the layout from `Layout.rects()` directly: explicit width/height per box (dock
already works this way — extend that discipline to the main tree), ratios honored on
screen, one chrome-cost constant shared by `layout.ts` minimums and every pane's content
math (`pane-chrome.ts` exports it; audit the hand-subtracted row constants — 3 vs the
chrome's 2 — and unify, deciding explicitly whether the spare row stays). Min-size
handling becomes honest: a split that cannot satisfy minimums is refused with a status
notice (or the pane renders an explicit overflow mark), never a silent `[1, total-1]`
clamp. Content clamps (`Math.max(10, …)`, `padEnd(width)`) are removed or bounded by the
actual rect.
**Accept:** property test extended to chrome-level geometry — for any open/close/resize/
dock sequence, drawn boxes are gapless, overlap-free, and every pane's content lines fit
inside its rect; resize verbs visibly move borders; `paneUnder` agrees with drawn
geometry at every ratio; the many-small-panes fixture that reproduces today's overlap
renders clean.
**Strategy:** `OWN` (C8/H1 companion).

### C36 (2pt) — Live sessions: push refresh + duplicate hygiene (implements PD6, part 1)
Session surfaces subscribe instead of polling nothing: a `subscribe` seam on the
session-tree port (bus-driven — entry appended/label/fork/compaction ⇒ pane refresh,
MCP-pane precedent), debounced per frame. Session files materialize lazily — a pane
opened but never used writes nothing to disk; first entry creates the JSONL. Unify on
the exported `sessionPort` (`sessions.ts:62`) via an attach seam that preserves what the
inline `main.ts` copy exists for (the `afterTurn` flush lookup and checkpoint-tag
injection), then delete the inline re-implementation; `stores`/`flushes` prune on
`onPaneClosed`; fork attachments that are never consumed get disposed. Sweep:
`keywork sessions list` gains a one-shot GC of existing empty session files (prompted,
not silent).
**Accept:** entries appear in the tree pane within a frame of the bus event with no `r`;
splitting 5 conversation panes and quitting creates zero empty session files;
close/reopen cycles leak no store map entries (probe-assertable); fork-then-never-open
leaves no orphan; the memory flush still resolves its store after unification (test).
**Strategy:** `OWN` on A4 bus + Track T APIs.

### C37 (2pt) — Sessions overview, right-info-out-of-the-box (implements PD6, part 2)
The sessions surface grows from a debug tree into the glanceable overview: sessions of
this workspace listed with title, relative age, entry/branch counts, live/idle density
mark (design-language ramp), the focused pane's session highlighted; expand a session
in place into its C13 entry tree. Zero-state is calm. Riding C36's subscription so it is
live by construction.
**Accept:** probe workflow — create/fork/close sessions across panes and the overview
tracks with no manual refresh and no duplicate rows; info set matches this spec exactly
(nothing more — every column justified or absent); zero-state fixture.
**Strategy:** `OWN` presentation over Track T data.

### C38 (3pt) — Two-dock engine + location cycling (implements PD2)
`layout.ts`: `DockState` becomes per-side (left and right, each `{panes, ratio}`,
independent); geometry stacks `[leftDock, main, rightDock]`; existing verbs keep their
meaning (`leader d`/`D` = dock left/right), one new repeatable **cycle verb** moves the
focused pane `main → left → right → main`; in-dock navigation/reorder work on both
sides; `/dock-*` commands and palette rows grow the right-side variants. Persistence
migrates at both layers — `Layout.toJSON/parse` (dock shape lives here) and
workspace-state version 2 — with v1 migration (single dock → its side, other empty). C8
invariants and the C27 property suite extend to both docks.
**Accept:** property tests — any sequence of open/close/dock/cycle/resize across both
docks stays gapless and overlap-free (on C35's drawn-geometry bar); cycle round-trips;
v1 state files migrate losslessly; when a pane has no prior home, D14's MCP pane
defaults to the right dock and browse to the left (today's `?? side` fallbacks become
real per-side defaults).
**Strategy:** `OWN` (C27/C28 successor).

### D15 (2pt) — The front door (implements PD1)
Bare `keywork` in a TTY runs panes; non-TTY prints usage pointing at `run`/`--json`.
Extract the duplicated composition wiring (agent factory, memory, MCP, presets, session
ports — today ~190 inline lines in `main.ts` for panes, re-done separately in `chat.ts`)
into one shared composition module both consume. `keywork chat` remains as the explicit
engine smoke harness, dropped from the usage synopsis's lead position and marked as
such; record the parity condition (panes compaction trigger) whose arrival re-opens the
remove-chat decision.
**Accept:** `keywork` with no args in a TTY boots panes (existing onboarding auto-fire
intact); `keywork chat` still works and shares composition (a provider wired once
reaches both); non-TTY bare invocation exits **non-zero** with helpful usage (a bare
`keywork` in CI must fail loudly, matching the unknown-command convention); usage text
updated; no behavior change to `run`/`sessions`/`setup`/`trust`.
**Strategy:** `OWN`.

### E7 (2pt) — Modes design (implements PD3; gates implementation)
The design document for keywork modes: enumerate the bundle axes (agent, permission
matrix/preset, toolset, model role), per-pane attachment semantics (what a fork/split
inherits), the split-into-mode key grammar (leader chords; collision review against the
C3 keymap), chrome/status-line presentation (E2/C18/design-language vocabulary),
session-entry recording, and the config schema (D9 — every option `.describe()`
justified). Vision D2 binds Plan/Build-style modes to **default-on blessed extensions**;
the spec must either honor that placement or carry the written justification for any
core residency. Deliverable is a reviewed spec in `docs/` plus sized implementation
tasks; E5 is absorbed as the minimal case. No implementation before the spec is
approved.
**Accept:** spec answers the open questions below or records Jordan's decisions; sized
follow-on tasks land in this file's scheme; keymap collisions resolved on paper.
**Strategy:** `OWN` (OpenCode/Pi mode surveys as prior art only).

### J15 (2pt) — Task-group memory design (implements PD4; gates implementation)
Design-only: task groups as layered memory subsets within the workspace scope. Must
resolve: representation (sub-vault directory vs frontmatter tag layer), scope policy
integration (J6 fail-closed — does task scope *filter* recall or *bias* it), bootstrap
layering and budget split (R4), lifecycle (create/switch/archive; user-commanded vs
agent-proposed through the inbox), session binding (does a session belong to at most one
task), promotion path from task layer to workspace layer (Gardener/airlock
integration), and Obsidian-citizenship of whatever layout is chosen. Deliverable: a
J-series design section (95-style) with binding decisions and sized tasks.
**Accept:** reviewed design answering the open questions below; explicit non-goals; no
code.
**Strategy:** `OWN` over the J-D1…J-D7 frame.

### J16 (3pt) — Workspace anchoring & linked folders (implements PD5)
Make the declared workspace real, honoring the open-question answers below. Working
recommendation pending those answers: **lazy materialization** — bare `keywork` treats
the launch dir (or nearest declaration) as the workspace anchor without writing
anything; `.keywork/workspace.json` (+ vault) is created on the first act that needs
durability (first memory write, first link, or explicit `keywork init`), and creation in
a trusted workspace only (P1: untrusted ⇒ memory inert). `keywork link <dir>` / `/link`
appends to `contextDirs`; linked dirs actually take effect: `confinedPath()` widens to
root + linked dirs, memory taint boundary (95/P2) treats them as inside-workspace, and
the sessions/snapshots keying migrates from raw cwd-hash to `workspaceIdentity` (the
Track P seam built for exactly this), with the undeclared-cwd fallback byte-stable.
**Accept:** launch → link → agent reads/writes in the linked dir without escape errors
while non-linked siblings still confine; memory bootstrap/recall see linked-dir entity
paths; undeclared cwd behaves exactly as today until first durable act; declared
identity keys sessions/snapshots/state with a documented migration; untrusted workspace
never auto-creates a vault.
**Strategy:** `OWN` on J1's landed seam.

## Addendum (2026-08-15) — E2E screen-capture harness (C39–C43)

Scoped at Jordan's request before the work above goes deep; design of record in
[`../research/e2e-screen-capture.md`](../research/e2e-screen-capture.md). Verified
foundation: `@opentui/core@0.5.1` ships a headless test renderer with
`captureCharFrame()`/`captureSpans()` (proven working under Bun, no TTY); `runApp` needs
only a renderer-injection seam and an exit seam; offline runs ride the already-injectable
`agentFactory` + `MockProvider` (no server, no config change); rendering capture runs as
a standalone Bun tier (`scripts/e2e-capture.ts`, the forensic-harness precedent) because
OpenTUI's native core is `bun:ffi`-only while vitest runs under Node.
`keywork-playground` is the live tier-2 target (its real state already reproduces the
PD6 empty-session litter).

- **C39 (1pt)** — `runApp` seams: injectable renderer factory + exit seam; zero behavior
  change without injection.
- **C40 (3pt)** — capture harness core: scenario runner, mock-port composition, char +
  span capture, zero-dep SVG writer, artifacts (+ `.gitignore` entry), masking; S2/S3
  proving scenarios.
- **C41 (2pt)** — scenario pack S1/S4/S5/S6 with opt-in masked goldens; S6's captures
  serve as supporting before/after evidence for C35/C36.
- **C42 — dropped (Jordan, 2026-08-15):** no CI job — too heavy for the pipeline. The
  harness is a local/dev tool (`bun run e2e`); goldens gate at the developer's hand, not
  in CI. Revisit only if drift actually bites.
- **C43 (1pt)** — live playground mode (`--cwd`/`--live` with safety rails; never CI).

Ordering: C39 → C40 → {C41, C43}. This is **work stream W0** — it precedes and
serves W1/W3 (their acceptance cites S6's captures) and only C39 touches product code.

## Open design questions (answers wanted before the gated pieces build)

> **2026-08-15, vision pass 3:** Q4 is answered (reversed) and Q6–Q8 are answered by
> [`98-chroma-and-arcs.md`](98-chroma-and-arcs.md), which also delivers J15 and names
> the work unit **arc**. Q1–Q3, Q5, Q9–Q10 remain open below.

**Workspace anchoring (J16):**
1. Materialization: silently auto-create `.keywork/` on every launch, or lazily on first
   durable act / explicit `keywork init`? (Recommendation: lazy — auto-creating dotdirs
   in every directory keywork ever runs in is litter, and vault creation must respect
   the trust gate anyway.)
2. Must a linked folder be independently trusted (E6 nearest-ancestor) before it widens
   the confinement jail, or does linking itself constitute the grant? (Recommendation:
   linking grants scope; trust gates activation — untrusted linked dir stays inert.)
3. Launching in a subdir of a declared workspace: join the enclosing workspace
   (git-style, current behavior) or anchor a new workspace at the subdir? (Recommendation:
   join; `keywork init` forces a new anchor when wanted.)
4. ~~Is "most recent workspace used in this directory" a real requirement — i.e. can
   multiple workspaces overlap one directory — or is one-workspace-per-root enough for
   v1?~~ **Answered 2026-08-15 (98/PD10, recommendation reversed): multiple workspaces
   per root is v1** — compat layout, per-slug identity, per-root MRU; tasks J19/C46.
5. Sessions/snapshots migration: move existing cwd-hash-keyed data to workspace identity,
   or leave old data behind the fallback key? (Recommendation: migrate-on-open with the
   fallback read path kept one release.)

**Task groups (J15) — all answered 2026-08-15 by 98/PD9 (the unit is named "arc"):**
6. ~~Sub-vault directories or a tag/frontmatter layer?~~ **Sub-vaults**
   (`.keywork/memory/arcs/<slug>/` with own MOC); distillation writes *new* workspace
   notes with `distilled_from:` links, so there is no move-on-promote churn.
7. ~~Filter, add, or both?~~ **Adds, never hides** — the active arc's layer is a boosted
   stratum atop workspace + user scope; other live arcs excluded from ambient recall but
   explicitly searchable.
8. ~~Lifecycle & binding?~~ **User-commanded** create/switch/complete/abandon; the agent
   may *propose* via the review inbox; a session binds to at most one arc; forks inherit.

**Modes (E7):**
9. Per-pane modes (recommended — the tiler's edge) vs global mode with per-pane
   overrides: confirm the per-pane bet.
10. Mode taxonomy: adopt Plan/Execute/Agent naming or keywork's own vocabulary bound to
    the E2 preset words? (One vocabulary across preset + mode surfaces beats two.)

## Work streams (safe parallelism)

Six streams, disjoint enough to run concurrently; the one real file collision is called
out. Every stream lands with probe/property tests per house rule; `bun run check && bun
test` green is the merge gate.

| Stream | Tasks | Files (owner) | Depends on |
|---|---|---|---|
| **W0 — Screen-capture harness** | C39 → C40 → C41/C43 (C42 dropped: no CI job) | `tui/app.ts` (seams only), new `scripts/e2e-capture.ts` + scenario files | nothing — C39 lands before W1 touches `app.ts` |
| **W1 — Geometry truth** | C35 | `tui/layout.ts` (render seam), `tui/app.ts` `buildBody`/`treeView`, `pane-chrome.ts`, per-pane view sizing | C39 (same file, tiny) — then **first in the tui package** |
| **W2 — Front door** | D15 | `cli/main.ts`, `cli/chat.ts`, new `cli/compose.ts` | nothing |
| **W3 — Live sessions** | C36 → C37 | `tui/session-tree-*`, `cli/sessions.ts`, `engine/session/store.ts` (lazy-create), `cli/main.ts` session wiring (small, coordinate with W2) | nothing (C37 after C36) |
| **W4 — Dock v2** | C38 | `tui/layout.ts` dock section, `app-core.ts` verbs, `workspace-state.ts` | **after W1** — same files, and its acceptance is stated on W1's drawn-geometry bar |
| **W5 — Workspace anchor** | J16 | `shared/config/workspace.ts`, `engine/tools/confine.ts`, `cli/paths.ts`, new link command | Q1–Q5 answered |
| **W6 — Design docs** | E7, J15 | `docs/` only | Q6–Q10 input |

Sequencing in one line: **W0's C39 lands first (one tiny PR), then W0 + W1 + W2 + W3 +
W6 run in parallel; W4 follows W1; W5 follows its answers.** The overlap/dupe defects
(W1, W3) are dogfooding-quality issues and outrank new capability — and W0 hands them
their before/after evidence; W2 is small and launch-critical; W4 is the identity
upgrade; W5/W6 convert direction into buildable specs.

## Supersession record

- 92 Track Q item 4 (the affirmed-not-changed single-column dock, per-pane dual docks
  deferred to the dock-identity work) — **superseded by PD2/C38**: the dock-identity
  work is scheduled.
- E5's scope ("Plan/Build agents & Tab switch") — **absorbed as the floor of E7**; E5 is
  not built standalone.
- 91's unplanned-extras note ("`keywork chat` v2 … kept as the engine's manual smoke
  harness") — **affirmed and narrowed by PD1**: kept only until panes lifecycle parity,
  then remove-by-default.
- 94's H4 chrome-offset flag — **folded into C35** (the offset is one symptom of the
  PD7 mismatch).
- J15 and Q4/Q6–Q8 — **delivered/answered by [`98-chroma-and-arcs.md`](98-chroma-and-arcs.md)**
  (2026-08-15 vision pass 3: arcs, the funding ladder, workspace multiplicity, gradient
  chrome).
