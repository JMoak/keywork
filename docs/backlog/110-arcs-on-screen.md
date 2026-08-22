# Arcs On Screen — Stream 5 Ledger (2026-08-21)

> **Implementation overlay + ledger** for stream 5, the lane named as the runner-up in
> [`108-survivability-and-launch-rail.md`](108-survivability-and-launch-rail.md) ("arcs/workspaces
> nodes — the lane after this one"). Cites C45/C46/J17/J19 (`98-chroma-and-arcs.md`), PD11/PD13
> (`99-workspace-and-modes.md`), FR2.5/FR2.6/FR3.9 (`101-feedback-round-4.md`), PD19 title bar
> (`104-the-page.md`). Where this file and those records disagree, they win; this file adds the how
> and the landed state.
>
> **Standing guardrails unchanged:** Anthropic is API-key / Agent-SDK only and still has no
> provider wiring before G1; Crush is not a source; the user commits.

## Why this stream, in one paragraph

Everything arcs meant since vision pass 3 lived below the surface: the arc kernel (J17 + J18)
shipped in the engine, the chroma math knew how to give an arc a hue, PD13 decided what a split
inherits, and the sessions overview had an `arc` column that nothing ever filled. No pane could be
bound, no border carried an arc, no picker existed, and a workspace root could hold exactly one
memory. This stream makes the *when* axis visible and drivable from panes and gives a root more
than one workspace, so dogfooding can actually group work the way the product says it does.

## Tasks (sized; all `OWN`)

| Task | Pts | Decisions | Landed |
|---|---:|---|---|
| **S5-T1 — arc binding as a session entry** · `arc_binding` joins the entry union (`{ arc?: string }`, absent arc = released); `SessionStore.appendArcBinding` / `arcBinding()` (last binding on the active path, so a branch before the binding honestly reverts it and `clone` carries it into forks); tree rows and `keywork sessions tree` render `arc → slug` / `arc released`. | 1 | PD9 lifecycle (entries per E5's rule), PD13.3 | ✅ 2026-08-21 |
| **S5-T2 — the arc service (CLI) and the memory payoff** · `cli/src/arcs.ts` `arcService`: lazy `ArcRegistry` over the resolved vault (a workspace materialized mid-session starts working without a relaunch), live `ArcBindings` seeded from every attached store and cleared on release, `ArcsPort` for the TUI (`list` with bound-session counts, `create`, `close`, `abandon`, `subscribe`), `layerStoreFor(sessionId)` so a bound session's **flush lands in the arc layer** (`MemoryFlush.dailyStore` seam), and `searcher(...)` so a bound session's **recall adds the arc stratum** through `ArcRecall.searchAmbient` (unbound sessions search byte-for-byte as before). `close` runs the airlock's clean door: `prepareClose(force)` → `completeClose` when nothing needs triage; otherwise the digest is already in the one inbox and the notice says so. `SessionAttachment.arc` / `bindArc`, `SessionPortSeams.onArcBound`, `boundSessionCounts(dir)`. Engine: `MemoryRecall.search` widened to a `MemorySearcher` interface so the arc-aware adapter composes without a class. | 3 | PD9 ladder (arc layer funds flush + recall), J17 deferred seams, J18 fourth door | ✅ 2026-08-21 |
| **S5-T3 — `/arc` in panes** · `tui/src/arcs.ts` (port types, `arcOrdinalsOf` creation-order ordinals, `arcInk`, `arcTag`, `suggestArcSlug`), `tui/src/arc-picker.ts` (rows: release · active newest-first · a **create row when the query is an unclaimed valid slug** · archived dimmed; starts on the bound arc), `picker-keys.ts` (one key reducer shared with the model picker). AppCore grammar: `/arc` picker · `/arc <slug>` switch (archived and unknown slugs answer with the next action) · `/arc new [slug]` (auto-name from the pane title, else `arc-N`) · `/arc none` · `/arc close [slug]` · `/arc abandon <slug>`. PD13 splits: `split` inherits the source pane's arc, new `split-arc` (`ctrl+k shift+s`) mints a fresh arc bound only to the new pane; splits from sessionless panes stay unbound; forks inherit through the store. | 2 | C46 (arc half), PD13.1/13.2/13.4, PD19 | ✅ 2026-08-21 |
| **S5-T4 — arc hue end to end (C45)** · pane borders: `rampPositions(ids, arcOf)` now fed from each conversation pane's arc ordinal, so members micro-gradient around their arc's golden-angle anchor and ungrouped panes keep the sweep; the same hue inks the `#slug` tag on sessions-overview rows, the status-line chip (`preset · #dock-v2 · 3 panes …`, focused conversation's arc), the arcs node labels, and the picker rows. Title bar: `#slug` after the name at broadsheet only, shed before the mode word, never crushing the name (the border hue already carries identity below broadsheet). Ordinals are creation order, so a hue never moves once claimed. | 2 | PD8.4/8.5, C45, PD19 | ✅ 2026-08-21 |
| **S5-T5 — the arcs node (FR2.5)** · `tui/src/arcs-pane-model.ts` + `arcs-pane.ts`: two levels — arcs grouped `active (recent first) · no arc · archived (dimmed)` with `mark slug · n sessions · age` (cursored row adds the summed known cost, `+ unpriced` when partial; mark = busy › attached › idle across members), enter drills to the member sessions (focus-or-open, the overview's switchboard contract), esc returns; `n` names a new arc inline with slug validation, `c` closes through the airlock, `A` abandons, `r` refreshes; per-entity tray (FR3.9) presses the pane's own keys; `/arcs` + `ctrl+k a`; descriptor `{ kind: "arcs", arc? }` revives drilled; live refresh on session and arc changes. | 3 | FR2.5, FR2.7 grammar (liveness marks colored, arc tags in arc chroma), FR3.9, C37 shape | ✅ 2026-08-21 |
| **S5-T6 — workspace multiplicity (J19) + `/workspace`** · shared: `.keywork/workspaces/<slug>/{workspace.json, memory/}` with the same declaration schema; `openWorkspace(cwd, slug)` anchors named workspaces at the resolved root (declaration → git → launch), `listWorkspaces(root)` (default slot first, declared or not), `writeNamedWorkspaceDeclaration`; one slug grammar (`shared/config/slug.ts`) now shared by arcs and workspaces. CLI: `workspaceIdentity(cwd, slug)` = `sha256("workspace:"+root+":"+slug)` (default byte-stable), `defaultSessionDir`/`snapshotGitDir` partition per slug, per-launch-subpath MRU in `~/.keywork/workspace-mru.json`, `keywork workspace list|new|use|rm` (rm of a non-empty vault demands the confirmed destructive form; headless refuses), `--workspace <slug>` on panes/sessions, MRU recall with honest fallback warnings. TUI: `/workspace [slug | new <slug> | default]` picker (`workspace-picker.ts`); choosing records the MRU and **relaunches panes in-process** (`main.ts` loops `launchPanes` through the `exit` seam; the renderer is destroyed and rebuilt, the whole composition re-keys through the identity seam). | 3 | PD10, PD11.3 (per-subpath MRU), C46 (workspace half), J19 | ✅ 2026-08-21 (see the relaunch caveat below) |

**Acceptance evidence:** `scripts/e2e` scenario `arcs` (160×40, declared workspace): `/arc new dock-v2`
posts `arc → dock-v2 · new` and the title reads `session-1 #dock-v2`; a split inherits (both
overview rows tagged, status chip `· #dock-v2 ·`); `/arcs` docks the node with `dock-v2 · 2 sessions`
under ` arcs · 1 arc `; `ctrl+k shift+s` mints `arc-2` bound only to the new pane; the `/arc` picker
lists `no arc · release this session / arc-2 · 1 session · current / dock-v2 · 2 sessions`;
`/arc none` drops the chip; `/arc close dock-v2` posts `arc dock-v2 closed · delivered 0 notes · 2
sessions released` and the node shows `dock-v2 · archived`. Captures in `artifacts/e2e/arcs/`
(01–07). Unit coverage: `store-arc.test` (engine); `arcs.test`, `arc-picker.test`,
`arcs-pane-model.test`, `workspace-picker.test`, `title-bar.test` (arc zone), `command-coverage`
(TUI); `arcs.test` (service: availability, lifecycle, airlock clean/pending/abandon, flush layer,
arc-aware recall), `sessions.test` (binding round-trip), `workspaces.test`, `paths.test` (named
identity) (CLI); `workspace.test` + `slug.test` (shared). Discovery goldens regenerated for the two
new palette/help rows; `arc-commands.test` drives the whole `/arc` grammar and the picker
through the AppProbe; `app.test` covers split-origin seeding. Gate at landing: check + pins +
guardrails + biome clean, 2052 tests / 151 files, 11/11 e2e.

## Deviations of record (flag for Jordan)

- **`/arc close` is the airlock's clean door only.** When an arc has distillation candidates or
  open questions, close stops honestly: the digest is opened into the one inbox (visible in the
  memory pane) and the notice says what is waiting; `completeClose` with real triage decisions is
  J18's review surface (options-first by the 98 rules). Live bound sessions are reported as
  "didn't flush" rather than force-flushed — wiring the J8 flush into the ack sweep wants the
  airlock surface's ceremony, not a silent flush from a slash command.
- **Arcs have no rename.** The registry has none, and renaming would orphan every persisted
  `arc_binding` entry; the picker's create row makes a fresh slug cheap instead.
- **`/workspace` relaunches in-process** through the panes `exit` seam (full teardown, fresh
  renderer, whole composition re-keyed). The e2e harness reboots the same way, but the real
  terminal path (destroy → `createCliRenderer` again) needs one live run on Windows Terminal and
  one on Linux before it's called proven; fallback if it misbehaves is a notice asking for a
  relaunch with the MRU already recorded.
- **Named workspaces are explicit.** `keywork workspace new` / `/workspace new` materialize them;
  lazy first-durable-act materialization (PD11.1) stays default-workspace only. `keywork run` and
  `keywork chat` don't take `--workspace` yet; they use the default workspace.
- **The workspaces *node* (FR2.6) is not built**; the picker covers browse/select/create and the
  CLI covers prune. Focus dirs (PD11.3) are not yet a declaration field.
- **Arc cost in the node sums known session costs** (`+ unpriced` when any member is unpriced)
  rather than going through `groupCosts`; same arithmetic, read off the overview items the node
  already holds.

## Follow-ups (not in this stream)

- J18 digest surface (triage resolve/carry/drop, force-complete with flush) so `/arc close` can
  finish arcs that carry notes.
- Memory-pane arc layer header in arc hue (the last C45 surface; the pane has no layer grouping yet).
- Arc jump rows in quick open (`jump: true` source over the arcs node).
- FR2.6 workspaces node + focus dirs; `--workspace` for `run`/`chat`.
- J21 arc briefing on bind (spec-first per Jordan).
