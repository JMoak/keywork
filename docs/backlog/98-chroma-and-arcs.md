# Chromatic Depth & the Arc Cycle — Vision Pass 3 (2026-08-15)

> Authoritative overlay, 2026-08-15, from Jordan's third vision pass. Where this file
> speaks it wins; where silent, [`97`](97-product-direction.md) →
> [`96`](96-conversation-enrichment.md) / [`95`](95-memory-and-skills.md) /
> [`94`](94-file-browser-and-mouse.md) (each within its scope) → [`92`](92-iteration-3.md)
> → [`91`](91-progress-and-feedback.md) → [`90`](90-plan-review.md) → workstream files.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing
> before workstream G; Pi/OpenCode are MIT — adapt with attribution in `NOTICE`; Crush is
> FSL — never a source (no code, no design credits since 2026-08-10). The user commits;
> agents never `git commit`/`git push`.

## The two items, dispositioned

| # | Vision | Disposition |
|---|---|---|
| 1 | Template-driven gradient depth across pane borders; extended to denote grouping around a unit of work | **PD8** decided → tasks C44, C45; design-language chroma section |
| 2 | Formalize the memory pattern: layered capture that funds upward, layered search that is actually used, organization around work completion, multiple workspaces per directory | **PD9** + **PD10** decided → answers 97's Q4/Q6/Q7/Q8, delivers J15, tasks J17–J19, C46 |

## The term: arc (Jordan, 2026-08-15)

The unit of work inside a workspace is an **arc**. Considered: task (the most overloaded
word in the domain — backlog tasks, subagent tasks, J12's own ontology), story/work item
(Jira/ADO-hard, exactly the feel to avoid), work (on-brand but grammatically awkward).
Arc won on identity: short, zero process-tool baggage, a trajectory with a beginning and
an **end** — "close the arc" names the completion ritual naturally — and it pairs with
PD8 so the word is self-explaining on screen: *each arc claims an arc of the theme's
color ramp.* Vocabulary rules: lowercase in UI (`arc: dock-v2`), slug-addressed in files
and commands (`/arc`, `keywork arc`), and it replaces every "task group" phrasing from
PD4/J15. J12's closed ontology renames its `task` entity type to `arc` (J12 is unbuilt;
zero migration).

## PD8 — Chromatic depth (the gradient)

Design-language already reserved this seat: density is the first axis and carries
**state**; color was "the second axis, never the only one" with no systematic role
assigned. PD8 assigns it: **hue carries identity and depth — which pane among many,
which arc — and never state.** The binding design (full vocabulary in
[`../design-language.md`](../design-language.md)):

1. **The theme grows a ramp.** `Theme.ramp`: 2–6 ordered accent stops; keywork-night
   defaults to Tokyo Night natives, violet → blue → cyan (`#bb9af7 → #7aa2f7 →
   #7dcfff`). Interpolation happens in a perceptual space (OKLCH, own zero-dep math) so
   midpoints never go muddy. A one-stop ramp is exactly today's flat behavior — the
   ramp is the template's property, so themes drive the whole effect (the "foremost
   driven by the visual template" requirement).
2. **Ungrouped panes sweep the ramp by spawn rank.** Pane *i* of *n* live panes sits at
   `i/(n−1)` along the ramp — window 1 violet, window 12 cyan. One pane = ramp start =
   byte-identical to today. Positions recompute on open/close as a stepped transition
   (reduced-motion honored); hue is *identity*, so it travels with the pane through
   docks and moves, never re-derived from screen position.
3. **Focus is the pane's own hue, lifted.** `borderFocus` becomes derived — the focused
   pane renders its hue at focus luminance/saturation instead of one global accent —
   so the gradient survives focus changes. Non-color focus signals are unchanged and
   remain mandatory (color is never the only axis).
4. **Arcs claim anchors.** When arcs exist (J17), each arc takes an anchor hue on the
   ramp via golden-angle spread (arc *k* at `frac(k·0.618)` of the ramp) so successive
   arcs stay maximally separated; member panes render a micro-gradient around their
   arc's anchor; ungrouped panes keep the global sweep. Redundancy rule: every arc-hued
   surface also carries the arc's slug tag — under `NO_COLOR` the grouping stays
   legible as text.
5. **One hue per arc, everywhere.** The arc's anchor hue is its cross-surface identity:
   member pane borders, its row in the sessions overview (C37), its layer header in the
   memory pane (J9), its status-line chip. Clustering becomes visible even when a
   two-dock layout interleaves arcs spatially.

## PD9 — The funding ladder & the arc cycle

The memory pattern, formalized. Everything below composes landed machinery (J3 vault,
J-D4 provenance/staging, J4 search, J7 Gardener kernel, J8 flush, P3 inbox) — the arc
layer is a new rung, not a new system.

### The funding ladder (capture)

Four layers; each captures cheaply and **funds** the next; promotion is always explicit,
audited, and one-key revertable:

1. **Session ledger** — instant, optimistic, chip-rendered (J-D4 layer 2). Unchanged.
2. **Arc layer** — the shared space every session bound to the arc writes into and
   recalls from: flush (J8) and daily-log promotion land here while an arc is active,
   so parallel windows on the same arc fund each other mid-flight. Provenance, taint,
   staging, and redaction rules apply per-line exactly as at workspace scope.
3. **Workspace vault** — evergreen atomic notes. While an arc is active its knowledge
   stays in the arc layer; **distillation at arc close is the only door upward** (plus
   the ordinary non-arc path for sessions bound to no arc, which behave exactly as
   today).
4. **User global** — rare, explicit, unchanged (J-D1).

Organization is automatic *around completion* (the vision's requirement): continuous
capture is cheap and local; the expensive organizing act — evergreen distillation into
the workspace garden — happens once, at the moment the work is delivered, when the
Gardener has the whole arc to look at.

### Layered search (recall)

One retrieval pipeline (J4 RRF, later J12's leg), run over all layers visible to the
session, every result tagged with its layer. Semantics (answers 97 Q7): **the active
arc's layer adds a boosted stratum on top of workspace + user scope; nothing is hidden.**
Other arcs' live layers are excluded from ambient recall by default (that is the
"subset" point) but remain explicitly searchable; archived arcs are excluded — their
distilled notes carry the knowledge forward. Bootstrap (R4) transcludes the active arc's
MOC inside an adaptive budget slice alongside the workspace MOC. "Actually used by the
agents" is a measured property, not a hope: J13's citation events record their source
layer, and the per-layer recall/citation readout is the dogfooding gauge for prompt and
budget tuning.

### Representation (answers 97 Q6)

Sub-vault directories: `.keywork/memory/arcs/<slug>/` with its own `MOC.md` and daily
logs — Obsidian citizenship and R1 file-truth stay clean, and the sync story (F1
per-host files) applies unchanged inside the arc dir. **The arc's MOC note is the arc's
graph entity** (R1: notes are nodes) — distilled notes link back to it, so "which arc
taught us this" is an ordinary provenance hop forever. Distillation writes **new**
workspace notes carrying `distilled_from: "[[arcs/<slug>/MOC]]"` and a `delivered:`
timestamp (bi-temporal `valid_from` = delivery time, J12's columns); nothing moves, so
there is no move-on-promote churn and the arc dir remains the honest historical record.

### Lifecycle & binding (answers 97 Q8)

Create/switch/complete/abandon are **user-commanded**; the agent may *propose* any of
them through the one review inbox (R3), never execute them. A session binds to at most
one arc at a time; binding and switches are session entries (E5's rule); forks inherit
the binding. Sessions bound to no arc write to the workspace path exactly as today —
arcs are opt-in depth, not a mandatory ceremony.

### The arc airlock (completion)

Closing an arc is the **fourth door on the one inbox** (extends 95/P3's three):

1. **Acknowledgement sweep** — every live session bound to the arc runs its silent
   flush (J8's mechanism, reused) and surfaces one ack chip; the arc renders a
   "closing" density mark while the set drains. Non-blocking throughout, P3 spirit:
   close is offered, never modal, and the user can force-complete past a wedged
   session.
2. **Distillation** — a Gardener sweep (J7 kernel) scoped to the arc layer distills its
   staged items, daily logs, and notes into candidate workspace atomic notes —
   merge/supersession detection against the existing garden included, hallucinated-ID
   rejection per R6.
3. **The digest** — one airlock review listing the candidates with per-session origin
   and provenance glyphs: review / approve all / leave staged. A G6 notification
   moment when unfocused, same formula (a keystroke is wanted).
4. **Archive** — approved notes land in the workspace vault stamped `delivered:`; the
   arc dir archives in place (frontmatter status, dimmed in every surface, out of
   default recall). Stragglers — a crashed session's staged items surfacing after
   archive — route to the workspace inbox rather than reopening the arc. Abandon
   prunes without distillation but **never deletes**: the archived layer stays
   explicitly searchable, files-as-truth.

Delivery time is the organizing datum: the workspace daily log records
`arc <slug> delivered — distilled n notes`, and the distilled notes' `delivered:`
timestamps make "what did we learn the week we shipped X" an ordinary temporal query.

## PD10 — Workspace multiplicity (reverses 97 Q4)

Jordan's call: multiple workspaces per directory is a **real v1 requirement** — create,
browse, select, and remove/prune workspaces from within one root (different working
sets and separate memory over the same code: a "frontend revamp" workspace need not
share a garden with "infra"). The 97 Q4 recommendation ("one per root") is reversed.
Design, compat-first:

- **Layout:** today's single declaration (`.keywork/workspace.json` + `.keywork/memory/`)
  *is* the root's **default workspace** — byte-stable, zero migration, teams already
  sharing it are untouched. Additional named workspaces live at
  `.keywork/workspaces/<slug>/{workspace.json, memory/}`, same schema, each with its own
  vault, context dirs, and arcs.
- **Identity:** the default workspace keeps its landed key
  (`sha256("workspace:" + root)`); named workspaces key
  `sha256("workspace:" + root + ":" + slug)` — sessions, snapshots, layout state, and
  trust all partition per workspace through the existing `workspaceIdentity` seam.
- **Selection:** launch opens the root's most-recently-used workspace (machine-local MRU
  in `~/.keywork`, per root); explicit selection via `keywork workspace use <slug>` /
  the C46 picker. One workspace per app instance.
- **Pruning:** removal is explicit and vault-respecting — a workspace with a non-empty
  vault is never silently deleted; prune archives or requires the confirmed
  destructive form.
- **J16 interplay:** anchoring and linked folders (J16) are per-workspace — each
  declaration carries its own `contextDirs`, so linking a folder into one workspace
  never widens another's jail or taint boundary.

## New tasks

IDs continue existing schemes; same point scale. **J15 (97) is delivered by this
overlay** — its open questions are answered above; no separate design doc remains.

### C44 (2pt) — Gradient chrome (implements PD8, base)
`Theme.ramp` (ordered stops, keywork-night default violet→blue→cyan; one stop ≡ flat),
OKLCH interpolation (own math, zero deps), spawn-rank sweep across live panes, derived
focus lift replacing the single `borderFocus` accent, stepped transitions honoring
reduced-motion. Theme config validation (WP-4's `#rrggbb` rule) extends to the ramp
array; the option carries its `.describe()` justification (D9).
**Accept:** e2e-capture (C40 harness) fixtures — 12-pane spawn shows a monotonic sweep;
single-pane frame byte-identical to today's; focus remains legible in a monochrome
capture; ramp override via theme config round-trips; close-a-pane transition is stepped;
hue follows a pane through dock moves.
**Strategy:** `OWN`. Sequenced after C35 (same `app.ts`/`pane-chrome.ts` territory —
geometry truth first).

### C45 (2pt) — Arc hue across surfaces (implements PD8, grouping)
Golden-angle anchor assignment per arc; member-pane micro-gradient; arc slug tag in pane
chrome (the non-color redundancy); the same anchor hue on sessions-overview rows (C37),
memory-pane arc layer header (J9), and the status-line arc chip.
**Accept:** capture fixture with two arcs plus ungrouped panes — members share their
anchor, ungrouped panes keep the global sweep, tags render; `NO_COLOR` capture keeps
grouping legible via tags alone; overview rows carry arc hue + tag.
**Strategy:** `OWN`. Gated on J17 + C44.

### C46 (2pt) — Workspace & arc pickers (implements PD10 + PD9 surfaces)
The TUI browse/select/create/prune surfaces: `/workspace` lists the root's workspaces
(MRU order, name, vault size, last-used) with create/switch/prune; `/arc` lists arcs
(active first, closing/archived dimmed per design-language) with new/switch/close.
Switching workspace = clean app-state swap through the identity seam; both pickers ride
the palette/overlay patterns already landed.
**Accept:** probe workflows — create → switch → prune round-trips for both; prune of a
non-empty vault demands the confirmed destructive form; zero-state is a calm invitation;
picker rows carry the design-language marks (and arc anchor hues once C45 lands).
**Strategy:** `OWN`. After J19 (workspaces) / J17 (arcs).

### J17 (3pt) — Arc memory layer (implements PD9, store + scope)
`arcs/<slug>/` sub-vaults (own MOC + daily; lazily created on first write), arc-layer
scope in J6's policy (active arc adds and boosts, never hides; other live arcs excluded
from ambient recall, explicitly searchable; archived arcs excluded), bootstrap slice for
the arc MOC (adaptive % per J-D8 tunables, absolute readout per `/policy`), session
binding as session entries with fork inheritance, `/arc new|switch` minimal commands.
Provenance/taint/staging/redaction apply per-line inside arc layers exactly as at
workspace scope; the arc MOC note doubles as the arc's graph entity. **Open questions
are a first-class note type** (addendum idea 5): unresolved decisions live as
staged-by-design notes in the arc layer, created by the user or derived by the flush —
never generatively multiplied (hard per-arc cap in policy; over-cap creation demands an
explicit merge or drop of an existing one), so the type stays a working surface, not a
backlog simulator.
**Accept:** two sessions bound to one arc recall each other's arc-layer writes; an
unbound session behaves byte-for-byte as today; other-arc layer invisible to ambient
recall yet explicitly searchable; bootstrap respects the split budget; binding entries
survive fork/replay; J13 citation events carry the source layer; open-question cap
enforced with the merge-or-drop path exercised in a fixture.
**Strategy:** `OWN` over the J-D1…J-D7 frame; rides landed J3/J4/J6 seams.

### J18 (3pt) — The arc airlock (implements PD9, completion; grown by the addendum — split at implementation if it proves bigger)
Close/abandon lifecycle: acknowledgement sweep across live bound sessions (J8 flush
reused; force-complete override), arc-scoped Gardener distillation (J7 kernel; R6
hallucinated-ID rejection; merge/supersession against the existing garden), the digest
as the inbox's fourth door (G6 notification moment when unfocused), archive-in-place
with `delivered:`/`distilled_from:` stamping and the workspace daily-log delivery line;
straggler staged items route to the workspace inbox. Three addendum absorptions:
**the eligibility rubric** (idea 6) — a deterministic bar for arc→workspace promotion
(cited at least once per J13, uncontradicted, survived to close; F2's
usefulness-feeds-curation rule given concrete teeth) with below-bar items staying
archived-searchable and rendered collapsed in the digest; **the delivery record**
(idea 4) — distillation writes one workspace-layer cover-sheet note per arc (entities
touched, checkpoint range, test delta, contributing sessions) that links *down* to the
arc MOC while entity notes link to it — the apex artifact of the door, pyramid-placed
(the arc MOC itself stays in the archived arc layer); **the open-questions category**
(idea 5) — the digest triages the arc's open-question notes as resolve / carry forward /
drop, carried questions re-staging into the successor layer only by that explicit
choice. Kernel-first per the J-D7 escape hatch: distillation mechanism before ritual
polish.
**Accept:** fixture — two live sessions, close arc → both flush, digest lists candidates
with per-session origin, approve → distilled notes carry `delivered:` +
`distilled_from:` and win temporal queries from delivery time; below-rubric item stays
archived and out of the workspace vault; delivery record links round-trip (record →
arc MOC, entity note → record); open-question triage exercises all three outcomes and
nothing carries forward implicitly; archived arc leaves default recall; crashed-session
straggler lands in the workspace inbox; abandon prunes without deleting (files remain,
searchable); audit entry per close.
**Strategy:** `OWN`; composes J7/J8/J11/P3 machinery. After J17.

### J19 (3pt) — Workspace multiplicity (implements PD10)
The compat layout (`.keywork/workspaces/<slug>/`), per-slug identity through
`workspaceIdentity`, machine-local per-root MRU, `keywork workspace
list|new|use|rm|prune` CLI with the vault-respecting prune rule, and the openWorkspace
walk-up extended to select among a root's workspaces (nearest root still wins; slug
selects within it).
**Accept:** default workspace byte-stable (today's layout, key, and behavior untouched —
regression-tested); named workspaces partition sessions/snapshots/state/trust; MRU
round-trips across launches; prune of a non-empty vault requires the confirmed
destructive form and never runs silently; `contextDirs` scoping stays per-workspace.
**Strategy:** `OWN` on J1's landed seam. Coordinate with J16 (same files, W5) — J16's
anchoring answers (97 Q1–Q3, Q5) stand unmodified.

## Sequencing

```
C35 (geometry, W1) ──► C44 ──► C45 ◄── J17 ──► J18 ──► J23 · J24 (needs archived arcs)
J16 (anchoring, W5) ──► J19 ──► C46 ◄── J17 ──► J21
J20 · J22 — independent (landed kernel only) · C47 after J9-pane + C45 · J25 gated (see task)
```

C44 joins the tui train after W1 (same files). J17 needs only landed machinery plus
J16/J19's identity seams to the extent it binds sessions per workspace — it can start
once J16 lands. The arc cycle (J17→J18) is the iteration headliner after the 97 work
streams; PD8 base (C44) is a small independent beautifier that can ride any tui lull;
the addendum's signal-capture and point-of-action tasks (J20, J22) need nothing new and
can ride any engine lull.

## Supersession record

- 97 Q4 recommendation ("one per root") — **reversed by PD10**: multiple workspaces per
  root is v1; J16's other recommendations (Q1–Q3, Q5) stand.
- 97 Q6/Q7/Q8 — **answered by PD9** (sub-vault dirs; adds-never-hides; user-commanded
  lifecycle, agent proposes via inbox, one arc per session, forks inherit).
- **J15 — delivered by this overlay** (the design it gated on is decided here); no
  standalone design doc.
- PD4/J15's "task group" vocabulary — **superseded by "arc"** everywhere; J12's
  ontology `task` entity type renames to `arc` (unbuilt, zero migration).
- design-language.md gains the chroma section (hue = identity/depth, never state) —
  same document remains the vocabulary of record.

## Addendum (2026-08-16) — the workflow round: fifteen ideas, dispositioned

> Jordan reviewed fifteen memory-workflow ideas generated against the PD9 frame; **all
> fifteen adopted in principle**, each with a recorded nuance. This addendum is the
> record of what was absorbed where. It amends tasks in this file in place (J17, J18 —
> already updated above) and, per the overlay convention, amends 95's J8/J9/J10/J13
> from here without editing that file.

### Placement — every idea on the ladder

The funding ladder is a pyramid in profile — a wide, cheap, automatic capture base
narrowing to a small durable apex, every boundary a door. The fifteen ideas sit on it
like this; the recurring shape is *catch a signal the system already emits, at the
layer where it is cheapest*:

| Operation | Layer(s) | Ideas |
|---|---|---|
| Capture | session → arc/workspace daily | 1 backtracks · 2 ask-gates · 3 checkpoint anchors |
| Staging | arc layer | 5 open questions |
| Distillation (the door) | arc → workspace | 4 delivery record · 6 eligibility rubric |
| Recall & bootstrap | arc · workspace | 7 arc briefing · 8 point-of-action · 9 return delta |
| Curation | archives → workspace · user global | 10 meta-distillation · 11 skill genesis · 12 re-attestation |
| Display | pane · status line | 6 heat rendering · 13 memory pulse · 14 garden epochs |
| Federation (post-v1) | workspace → team | 15 doors outward / arc handoff — **discussion open (Q11–Q13)** |

### Dispositions and design notes

**1 — Backtrack capture (adopted).** Esc-Esc backtrack→fork events (V2.2, landed) are
free "we abandoned this approach" signals. J8's flush prompt gains a backtrack clause —
when the session backtracked, the flush explicitly asks what was tried and why it was
wrong, landing in the active arc's daily log (workspace daily when unbound), provenance
agent-inferred. Amends 95/J8 from here; mechanism in J20.

**2 — Ask-gate decision capture (adopted).** Every answered y/a/n is a user-stated
datum — `█` provenance for free. J20 records ask events (tool shape + answer) in the
session ledger; repeated same-shape approvals become a Gardener *proposal*: a
preference note (memory fact), and separately an inbox proposal toward the E-stream
permission surface. The J-D7 wall holds: memory records the preference as fact; the
permission rule is only ever a human-applied proposal — the trust systems stay
separate.

**3 — Checkpoint-anchored facts (adopted; discussion recorded per Jordan's ask).**
Notes carry the checkpoint/turn tag (V2.13, landed) that taught them. The discussion
finding: **shadow-git checkpoint ids are machine-local** (`~/.keywork/snapshots/`), so
under F1 sync a bare id is meaningless on the other machine. The anchor is therefore a
tuple — ISO timestamp (always durable) + real repo commit sha when HEAD is known
(portable) + host-qualified checkpoint id (local convenience) — degrading gracefully
left to right. Payoff beyond provenance: a cheap staleness heuristic (entity file
churned heavily since the note's anchor ⇒ re-attestation flag) that reads history
instead of guessing from age. In J20; the heuristic itself lands with J7 sweeps.

**4 — Delivery record (adopted; pyramid placement per Jordan's nuance).** Absorbed
into J18: the record is a **workspace-layer** cover-sheet note (the apex artifact of
the door), linking *down* to the archived arc MOC; entity notes link to the record.
Nothing about the arc layer moves up wholesale — the record is distilled, dated,
entity-linked, and pre-funds the F2 repo-map join.

**5 — Open questions (adopted with care, per Jordan).** Absorbed into J17 (the note
type, with a hard per-arc cap and merge-or-drop over-cap behavior — the type must stay
a working surface, never a backlog simulator) and J18 (digest triage: resolve / carry
forward / drop; nothing carries forward implicitly). The carefulness is structural,
not tonal: bounded count, explicit-only carry, drop is a first-class outcome.

**6 — Eligibility rubric + heat (adopted; "make it pretty" per Jordan).** Mechanism
absorbed into J18 (deterministic bar: cited ≥ once per J13, uncontradicted, survived
to close). Presentation: **the garden gains temperature** — a note's approach to
distillation-eligibility renders as *heat*, carried by the density ramp (state is
density's job) and *reinforced* by saturation/luminance lift within the note's arc
anchor hue. The chroma rule survives intact: hue never acquires a state meaning;
saturation of an identity hue may reinforce what density already says
(design-language amended). Rendered options in C47.

**7 — Arc briefing (adopted; design-perfection gate per Jordan).** Its own task (J21),
**spec-first**: the briefing composition (arc MOC + sibling-session fundings since
last look + open questions + staged count), budget behavior (R4 selection scoped to
the arc), and rendering are written and approved before implementation. This is the
payoff moment of the shared arc layer; it must feel inevitable, not assembled.

**8 — Point-of-action recall (adopted; directions enumerated for joint expansion per
Jordan).** Its own task (J22), with the direction space recorded as decisions to make
together at build time: **(a) injection point** — prepend to the tool result vs a
pre-tool system reminder vs static entity context in the tool description
(recommendation: pre-tool reminder — visible in the JSONL, honest in replay, cheap);
**(b) trigger scope** — mutating calls only vs every file touch (recommendation:
mutating-only first; widen on measured citation lift); **(c) noise control** — once
per entity per session, strict relevance floor, hard token cap (all three,
non-negotiable). Deterministic path-join against entity notes, no LLM in the loop;
J13's layer-tagged citations are the success gauge.

**9 — Return delta digest (adopted).** Its own small task (J23): reopening a
workspace after a configurable gap prepends "since you were here" to bootstrap — arcs
delivered, notes superseded — a query over `delivered:`/bi-temporal stamps, not a new
mechanism. After J18.

**10 — Cross-arc meta-distillation (adopted; corpus-fit mandate per Jordan).** Its
own task (J24). Fitting the corpus perfectly means: the closed ontology gains one
predicate — **`consolidates:`** (with `consolidated_by:` back-links) — distinct from
supersession because the per-arc lessons are not *wrong*, merely aggregated; they
remain valid recall targets and keep their ranking (no superseded floor). The
consolidated note cites the evidence arc MOCs; the Gardener may propose true
supersession only when consolidation genuinely replaces. Threshold: same lesson in
≥3 arcs; proposal-only through the inbox; hallucinated-ID rejection applies (R6).

**11 — Skill genesis at arc close (adopted; never overbearing, per Jordan).** Amends
95/J10 from here: arc completion becomes J10's trigger moment, gated hard — the
delivery record must show the same command sequence **recurring (≥2 distinct
occurrences in memory evidence)** before a proposal fires, **one proposal per pattern
ever** (proposal fingerprints remembered; a declined pattern is never re-proposed),
inbox-only.

**12 — Re-attestation for user globals (adopted; calculated implementation per
Jordan).** Task J25, deliberately gated: no cards until the global layer has real age
(entries ≥ 90 days old *and* a minimum layer size, thresholds in policy), then at
most one quiet count-bounded inbox card per airlock. Ask-never-fade is the
granted-trust position (Lore's decay rejected): facts don't lose authority by aging —
they get re-attested or superseded, explicitly. Instrumented from day one (F3's
latency ethos applies).

**13 — Memory pulse (adopted; same caution as 12).** Amends 95/J13 from here: a
citation event renders a one-frame density blip in the status line — ambient proof a
recall shaped the turn. Ships instrumented and bounded: reduced-motion degrades to a
static mark, a `.describe()`-justified off-switch exists, and the acceptance bar is
"measured non-distracting" (no more than one blip per turn, never during typing).

**14 — Garden epochs (adopted; Jordan crafts the UI from options).** In C47 with the
heat rendering: the memory pane gains filter-by-delivering-arc/date over
`distilled_from:` links. **C47 is options-first by construction**: it delivers 2–3
rendered candidate designs through the C40 capture harness (real frames, both
themes, NO_COLOR) for Jordan's pick *before* any design lands — the task is not done
when code works; it is done when Jordan has chosen from real renderings.

**15 — Federation doors & arc handoff (direction affirmed; tradeoffs deliberately
open).** No task. The philosophy questions are queued, continuing 97's numbering:

11. **Doors outward:** is "only delivered notes ever leave the workspace" the right
    invariant, or do teams legitimately want to share live arc layers (pairing on one
    arc across machines)? The strict door is safer and simpler; the live share is P2's
    shared-workspace instinct applied to memory. Where is the line?
12. **Handoff trust:** an imported arc bundle is untrusted provenance by policy — but
    a *teammate's* bundle carries human judgment. Is there a grantable
    "trusted-colleague import" class in J-D6's config plane, or does everything
    re-earn its way through staging?
13. **Reciprocity:** if a team scope (Lore mount) is searchable-never-injected, do we
    ever *contribute* back automatically at arc close (delivery records as team
    knowledge), or is outbound always a human act? (The conservative answer — human
    act — is also the J-D6-consistent one; the question is whether it scales.)

### Addendum tasks

### J20 (2pt) — Signal capture pack (ideas 1–3)
Backtrack events → flush clause + arc daily-log capture; ask-gate decision ledger
(tool shape + answer) with the Gardener preference-proposal path (J-D7 wall: memory
fact + separate human-applied permission proposal); checkpoint anchors in note
frontmatter as the (timestamp, commit sha?, host-qualified checkpoint id) tuple.
**Accept:** backtracked-session flush persists the abandoned approach with
agent-inferred provenance; three same-shape approvals yield exactly one preference
proposal in the inbox and zero direct permission changes; anchor tuple survives a
simulated foreign-machine read (timestamp + sha usable, checkpoint id ignored);
unbound sessions capture to workspace daily.
**Strategy:** `OWN`; composes V2.2, V2.13, J8, J7 — no new machinery.

### J21 (2pt) — The arc briefing (idea 7; spec-first)
On session bind or `/arc switch`: composition per the design note above. The spec
(content, budget, rendering) is written and approved before implementation — the
perfection gate is the point.
**Accept:** approved spec precedes code; briefing renders within the R4 budget slice;
sibling-session fundings since last-look are correct across a two-session fixture;
open questions and staged count present; zero briefing for unbound sessions.
**Strategy:** `OWN`; after J17.

### J22 (2pt) — Point-of-action recall (idea 8)
Deterministic entity-note lookup at the mutating-tool boundary per the direction
notes above; the three (a)/(b)/(c) decisions confirmed with Jordan at build start.
**Accept:** agent touching an entity-noted file receives its conventions before the
mutation, once per entity per session, under the token cap; no-entity paths add zero
overhead; citation events show the injected layer; JSONL replay shows the injection
honestly.
**Strategy:** `OWN`; landed kernel only (entity notes, J5 tools, J13 events).

### J23 (1pt) — Return delta digest (idea 9)
"Since you were here" bootstrap prelude after a configurable absence gap: arcs
delivered, notes superseded — a stamped-history query.
**Accept:** reopening after the gap renders the delta within its budget; same-day
reopen renders nothing; fixture with two delivered arcs and one supersession lists
exactly three lines.
**Strategy:** `OWN`; after J18.

### J24 (2pt) — Cross-arc meta-distillation (idea 10)
The Gardener sweep over archived arc layers per the corpus-fit note: `consolidates:`/
`consolidated_by:` predicate pair, ≥3-arc threshold, proposal-only, R6 validation.
**Accept:** fixture with the same lesson in three archived arcs yields one
consolidation proposal citing all three MOCs; two arcs yields none; consolidated
per-arc notes keep their rank (no superseded floor); declined proposal never
re-fires.
**Strategy:** `OWN`; after J18 + real archived arcs (dogfooding-gated).

### J25 (1pt) — Global re-attestation (idea 12; gated)
Per the design note: age + layer-size gates in policy, one count-bounded card per
airlock, ask-never-fade, instrumented.
**Accept:** no card before both gates pass (fixture at the boundaries); at most one
card per airlock regardless of eligible count; keep / supersede / drop all
round-trip; instrumentation records card → keystroke latency.
**Strategy:** `OWN`; build last in the J series.

### C47 (2pt) — Garden heat & epochs (ideas 6 + 14; options-first)
The memory pane's heat rendering (density-carried, hue-saturation-reinforced) and
epoch filtering — delivered as 2–3 rendered candidates via the C40 harness for
Jordan's pick before landing.
**Accept:** chosen design lands only after Jordan picks from real captures (both
themes + NO_COLOR); heat orders visibly by rubric distance; epoch filter by arc and
by date range; monochrome capture keeps heat legible (density alone suffices).
**Strategy:** `OWN`; after J9 pane + C45.

### Addendum supersession record

- J17/J18 task bodies above — **amended in place** (open questions; rubric, delivery
  record, digest triage).
- 95's J8 (flush) — **gains the backtrack clause**; 95's J10 (skills) — **gains the
  arc-close trigger with the ≥2-recurrence / one-proposal-ever gates**; 95's J13
  (citations) — **gains the status-line pulse**; 95's J9 (pane) — heat/epoch
  presentation is delivered by C47. All amended from here per the overlay convention.
- design-language chroma rules — **one clarification added**: saturation/luminance of
  an identity hue may reinforce a density-carried state; hue itself never carries
  state.
- Open questions Q11–Q13 (federation doors, handoff trust, reciprocity) — **queued for
  discussion**, continuing 97's numbering; idea 15 builds nothing until they're
  answered.
