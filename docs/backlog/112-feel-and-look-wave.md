# Feel and Look Wave: Ledger + Scoping (2026-08-22)

> **Implementation ledger + scoping overlay.** Jordan's live-use feedback after the audit
> waves: arcs would not start from the playground, the `/connect` screen looked thin, and
> three ideas need vision before code (a cycle-arc key, pins for docked panes, a memory
> browser). Where this file speaks it wins; where silent, [`110`](110-arcs-on-screen.md)
> (arcs on screen), [`105`](105-inference-resolution.md) (`/connect` contract CD-01..CD-10),
> [`99`](99-workspace-and-modes.md) (PD11 materialization), [`98`](98-chroma-and-arcs.md)
> (PD8/PD9), [`100`](100-visual-craft.md) (PD14/PD16), [`95`](95-memory-and-skills.md) (J9)
> apply.
>
> **Standing guardrails unchanged:** Anthropic is API-key / Agent-SDK only, nothing before
> G1; Crush is never a source; the user commits.

## Landed 2026-08-22

### L1 · arcs would not initiate from a workspace (root cause + fix)

**What Jordan saw.** `/arc` in `C:\src\keywork-playground` answered "arcs need a trusted
workspace with memory · send a prompt or run keywork init first", prompts later, still the
same line.

**Root cause.** Arcs (and memory) sit behind two gates at once: the folder must be
**trusted** in `~/.keywork/trust.json`, and a **workspace declaration**
(`.keywork/workspace.json`) must exist at or above cwd. The playground had neither, and no
`.git`. Nothing in panes ever offered the path: trust only came from `keywork trust` /
`keywork init` in a shell, and PD11's lazy materialization ("memory wakes on your first
prompt") only fires when the folder is *already* trusted and anchored to a git root (or a
remembered anchor). So in an undecided, git-less folder the message's "send a prompt"
advice could never come true. A second gap sat behind it: `composeWorkspace` opened memory
once at launch, so even in a trusted git repo whose workspace materialized on the first
prompt, the memory pane, the close sweep and the arc airlock stayed dark until a relaunch.

**Fix (all `OWN`).**

- **Readiness vocabulary** (`tui/src/workspace-setup.ts`): `WorkspaceReadiness` =
  `ready · undeclared · undecided · refused`; `readinessNotice()` names the missing piece
  and the one command that fixes it; `setupPrompt()` is the confirm question and exists
  only for the two states `/init` can act on.
- **`/init` in panes** (alias `/trust`): a two-row confirm overlay (`trust <root>? keywork
  keeps workspace files and memory in .keywork` · `y sets it up · n cancels`); `y` trusts,
  writes the declaration + vault, then **reopens panes in place** through the same exit
  seam `/workspace` uses, so memory and arcs compose live. Refused folders are pointed at
  `keywork trust` and never re-trusted from inside the app. Failures land as a notice and
  keep the app open.
- **Truthful gate.** `/arc` checks readiness first and posts the precise notice instead of
  opening an empty picker; the CLI arc service phrases its refusal from the same readiness
  (`arcService({ unavailable })`). Boot posts the readiness notice once (cleared by the
  first key), so the wall is visible before anyone hits it.
- **Memory is lazy** (`cli/src/memory.ts` `MemoryAccess`, `Composition.memory()`): the
  vault is re-resolved until found, then memoized. A workspace that materializes mid-session
  now gets flush, close sweep, the arc airlock and the memory pane that same session; the
  memory pane exists in every trusted workspace (empty until the vault appears). Recall
  tools still join on the next agent build (per-agent tool lists are eager).
- **Relaunch loop** (`main.ts runPanes`): every reopen re-derives the command context
  (trust, workspace recall, inference) and drops `--fresh` after the first launch, so a
  reopen never wipes the layout again. `PanesSeams.switchWorkspace` → `reopen`;
  `PanesLaunch` carries the `TrustStore`; `workspaceSetupPort` (`cli/src/workspace-setup.ts`)
  reads anchors without writing them (anchors are remembered only on a confirmed set-up).

**Evidence:** `workspace-setup.test` (TUI: vocabulary, `/init` y/n/failed/ready/refused
through the AppProbe, `/arc` gate; CLI: readiness transitions, set-up effects, no write on
read), `compose.test` (lazy memory), `compose-panes.test` (memory pane in trusted
workspaces, readiness-phrased arc refusal). Untouched goldens (discovery, 5/5).

### L2 · `/connect` surface rework (CD-01..CD-10 unchanged)

- **Connections screen first** (when anything is saved; else straight to targets): one row per
  saved connection in aligned columns `name · host · facts`, facts dense when known (`in use`,
  `disabled`, credential, `responses` when not the default, `n models`, `verified MM-DD HH:MM`
  or `failed MM-DD HH:MM · reason`, `never verified`), plus `+ add a provider`. Panel widened
  to 96 columns (`panelFrame`), title ` connections `.
- **Targets screen** (`add a provider`): `OpenAI · api key · api.openai.com/v1`, `Ollama ·
  local · http://…`, `Custom · any OpenAI-compatible URL`; esc walks back to the add row.
- **Editor**: heading row `label · endpoint` (built-ins show `get a key: <keyUrl>`, saved
  connections show what was observed last, custom explains the GET /models check), fields,
  then one hint `↑↓ move · ←→ toggle · enter verifies and saves · esc back`. `esc` returns to
  the list it came from at the same index (a second esc closes); the receipt's esc returns to
  the connections screen; after a removal the list comes back if anything remains.
- **Structure**: the model now owns the row list (`ConnectModel.rows()` → toned spans) and the
  view only paints (`view/overlays.ts connectRowView`); `editorHeaderRows()` keeps clicks
  honest past the heading; `currentProvider` hook marks the in-use connection.
- **Evidence:** `connect-model.test` rewritten (28 tests: screens, columns, facts, headings,
  navigation, verify/save, remove).

### L3 · C71 dock pins (landed 2026-08-23)

Built to the C71 design below and the decisions ledger (all `OWN`).

- **Primitive.** `DockState` carries `pins`, the count of leading pinned panes, so "pins are a
  prefix of the dock" holds by construction (`layout-arrangement.ts`: `isPinned`,
  `pinnedInDock`, `unpinnedInDock`, `arrivalIndex`; `reorderedInDock` moves within the pinned
  group or within the free group, never across). Arrivals (open-in-dock, push-into-dock, drag
  drop, dock-cycle) land below the pins; a pinned pane carried to the other dock arrives
  pinned at that dock's head (`Layout.landedInDock`); undocking sheds the pin; closing a
  pinned pane releases its slot; drop previews are honest about where a pane will land.
  Unpinning drops the pane to the head of the free group (the nearest place it can sit
  unpinned, which is "where it is" whenever it was the last pin).
- **Surface.** `/pin` toggles on `leader p` (chainable, so `ctrl+k j p` walks to a pane and
  pins it), `/unpin` spelled out; main-area panes answer `pins are for docked panes · dock it
  first`. The palette's leader spelling moved to `leader i` and leads the help row
  (`ctrl+shift+p` stays as the second chord). Mark: `▪` (tier 1+) / `*` (tier 0) first in
  the title through `paneChrome` for every pane kind (`PaneContext.pinMark`, resolved in
  `view/frame.ts` from the session's glyph support).
- **Initial workspace is declared** (`initial-workspace.ts`: conversation, session tree, MCP,
  all unpinned); `AppCoreOptions.initialWorkspace` overrides it, which is the seam a future
  config option plugs into (needs its `.describe()` per D9; not added yet).
- **Persistence.** `pins` rides the dock state; parse defaults absent to 0 and clamps to the
  pane count; v1 states migrate with `pins: 0`; `PaneSnapshot.pinned` for probes.
- **Evidence.** `layout.test` "Layout pins" (ordering, no-ops, group moves, arrivals, carry
  across docks, close, round-trip + clamps), `workflows.test` (chord, commands, notice,
  restore at the head, declared initial workspace, `leader i`), `layout-state.test` /
  `workspace-state.test` migrations updated for the new field; e2e `tiling-tour` gains
  `browser-pinned` / `browser-unpinned` captures with the mark; discovery `help-overlay`
  golden re-recorded (one new row, palette row now `ctrl+k i`). Gate: `bun run check` clean,
  vitest 205 files / 2787 + 1 skipped, native `bun test` 2787 / 0 (one shell-session timing
  flake under full load, green in isolation), `bun run e2e` 11/11.

### L4 · C70 part 1, the arc pane as a docked node (landed 2026-08-23)

The first half of the C70 design below: the pane, its rows, its arrival and its slot. The
fold primitive (`space` / `a`, held members, the "folded and waiting" row) is part 2 and is not
built. All `OWN`.

- **Pane kind `arc`** (`arc-pane.ts`, `PaneDescriptor { kind: "arc"; arc }`, id prefix `arc-`,
  factory `createArcPane`): title `#slug · n sessions`, body = the arc's member sessions as
  rows **in creation order** (`SessionOverviewItem.createdAt` from the CLI port,
  `SessionsOverviewModel` seam `order: "created"`), each `stamp title · state word · age` where
  the stamp is the liveness mark and the word is `working` / `idle` / `closed` (busy / open in a
  pane / no pane). `enter` focuses an open member or attaches and opens a closed one (the
  shared `focusOrOpenSession`, which the arcs node and the session tree now use too); `r`
  refreshes; `/` opens the tray; escape is not a way out, an arc pane stays an arc pane.
  Refreshes ride the session feed; persisted as `{ kind: "arc", arc }` and restored by slug.
- **Half-height slot.** `PaneKindSpec.dockWeight` (arc pane `0.5`); `Layout({ dockWeight })`
  feeds `dockSlotRects`, which shares a dock's rows by weight and falls back to even slots the
  moment a weighted slot would drop under the minimum height; drop previews use the same
  geometry. Pins and weights compose.
- **Arrival.** `/arc open [slug]` opens (or focuses) the arc's pane; the **first arc a workspace
  ever lists** introduces its pane without stealing focus (`firstArcIntroducer` over the arc
  index's listings: 0 → 1 arcs, once). Where it lands: beside the arcs node if one is docked,
  else in a dock that already exists (left first), else right. The "else right" in the design
  below was refined after the e2e showed a new third-of-screen dock column evicting panes; a
  small node joins an existing column.
- **Evidence.** `arc-pane.test` (order, state words, enter focus/open, tray, feed refresh,
  dispose, empty title), `arc-commands.test` "arc panes" (`/arc open` docks and focuses,
  refusals, joins an existing dock, beside the arcs node, introduction keeps focus, half slot
  27 / 13, restore), `arc-index.test` (`firstArcIntroducer`), `layout.test` "Layout dock
  weights" (27 / 13 rows, honest drop preview, even fallback), `layout-scene.test`
  (`dockSlotRects`), `workspace-state.test` (arc descriptor), `pane-kinds.test` (factory table);
  e2e `arcs` extended (first arc introduces its pane into the tree's dock with the state word,
  second arc does not, `/arc open arc-2` lands beside the arcs node; captures `arc-bound`,
  `split-new-arc`, `arc-pane-opened`). Gate: `bun run check` clean, vitest 206 files / 2806 + 1
  skipped, native `bun test` 2806 / 0, `bun run e2e` 11/11 with goldens verified unchanged.

### L5 · C70 part 2, the fold primitive (landed 2026-08-23)

The second half of C70: members fold into the arc pane and come back, sessions stay live
throughout. All `OWN`. The primitive is general (held panes), the arc pane is its first handle.

- **Held panes** (`AppCore.holdPane / showPane / paneHeld / heldPanes`, reachable from panes
  through `PaneIntents.holdPane / showPane / paneHeld`): a held pane stays in `core.panes`
  (agent, attachment, presence, lifecycle all alive) and leaves the layout. `showPane(id,
  near)` re-attaches beside the most recently focused on-screen member of `near`, else the
  first on-screen member, else at the main edge nearest the dock that holds any of `near`
  (the arc pane passes its members plus itself); `showPane(id)` with no cluster opens like a
  fresh pane in the main area. Showing never steals focus; `focusPane` on a held pane shows it
  first (so the session tree's `enter` still reaches a folded member); `holdPane` refuses the
  last on-screen pane; closing the last on-screen pane brings held panes back rather than
  quitting. `Layout` gained a focus trail (`recentlyFocused`, most recent first, pruned on
  close, reset by `load`), `open(id, screen, beside)` (anchor defaults to focus; an unknown
  anchor falls back to focus) and `openAtEdge(id, side, screen)`.
- **Persistence.** `WorkspaceState.held: WorkspacePane[]` beside `panes` (version stays 2;
  a state without `held` reads as holding nothing; held ids may not collide with layout ids or
  each other). `loadRestorePlan` escrows held sessions too and drops held panes whose session is
  gone; `restoreFrom` revives held entries straight into the held set. The design's
  `{ arc, folded }` descriptor is therefore unnecessary: fold state is derived from which
  member panes are held, so the arc pane and the tree can never disagree about it.
- **Presence learns `waiting`.** `PaneSessionIndex.bind(paneId, sessionId, { busy, waiting })`,
  `SessionPresence.waiting`, `SessionLiveness` gains `"waiting"` (`█`, ahead of busy) read
  from `ConversationPane.awaitingYou()` (a pending ask). The tree, arcs node and arc pane all
  see it.
- **Arc pane** (`arc-pane.ts`): `space` folds / unfolds the cursor member, `a` folds every
  shown member or, when none is shown, unfolds them all; `enter` unfolds first, then focuses;
  `space` on a closed member only explains itself. Rows: `MemberPlacement` = shown / folded /
  closed; a resting folded member reads `░ title · folded · age` dim; a waiting member reads
  `█ title · needs you · age` with stamp and word in the arc hue (`arcOrdinal` seam), folded or
  not; title carries `· n folded` and wears the `█` stamp while a folded member waits (` █
  #slug · 2 sessions · 2 folded `). Tray lists fold and fold all. Unfolded tiles rise in: the
  core calls `Pane.revealed?()`, and `ConversationPane` ramps its border from `theme.border`
  to its hue over `quick` (PD16 ink only; settled on dispose).
- **Evidence.** `arc-pane.test` "ArcPane folds" (space, a both ways, folded and waiting, enter
  unfolds then focuses, closed member notice), `layout.test` "Layout focus trail and placed
  opens", `workflows.test` "held panes" (hold / show beside the cluster's recent focus, edge
  toward the cluster's dock, focus on held, last-pane close guard, persist and restore held),
  `workspace-state.test` (held capture, parse defaults and refusals), `restore-plan.test` (held
  escrow and drop), `sessions-overview-model.test` (waiting liveness); new e2e scenario
  `arc-fold` at 160×40 (captures `member-folded`, `all-folded-one-waiting` with the arc
  collapsed into the dock and the pane stamp up, `all-unfolded` clustered from the edge,
  `enter-unfolds-and-focuses`, `relaunched-fold-restored`). Gate: `bun run check` clean, vitest
  206 files / 2823 + 1 skipped, native `bun test` 2823 / 0, `bun run e2e` 12/12 with goldens
  verified unchanged.

### L6 · C72, the memory browser: skeleton + ledger lens (landed 2026-08-23)

The J9 memory pane became the browser: three lenses over one list, switched in place, plus the
question box. All `OWN`. Same pane kind, `/memory` and `leader m` unchanged; the descriptor
grew `lens`, `note`, `query` and the workspace revives all three.

- **Garden lens (default).** State line `5 notes · 3 curing · ░1 · 1 conflict · swept 1d` with
  the `? ask` hint flush right (facts drop from the tail, whole facts at a time, so the hint
  survives narrowing). Layers in the order the focused session sees them: its arc layer first
  (header `#slug · n notes · airlock ░k` in the arc hue; arc-distillation / arc-question cards
  render under it), then workspace (`workspace · n notes · inbox ░k`, inbox cards), then other
  active arcs. A layer that injects shows **the prompt cut**: `in prompt · 127 of 4.1k tokens`
  above the notes the bootstrap actually carries (in bootstrap order), `by search only` above
  the rest (most useful first, superseded last and dim with `→ successor`). Rows
  `curing provenance title · pinned · age · n×` (recalls since the last sweep). Curing is a
  real ladder now (`curingStage` in `cli/memory.ts`): user-stated or pinned `█ settled`,
  usefulness ≥ 0.5 `█`, recalled `▓ cured`, promoted-with-confidence `▒ curing`, raw `░ fresh`.
  Keys: `enter` drill, `i` inbox, `g` notes, `a`/`d`, `o` open the note's file, `u` revert the
  cursored note's newest write this run (C72-d), `tab`/`l` ledger, `?` ask, `r`.
- **The question box (`?`, C72-b).** A toggle that replaces the state line with
  `? dock▌ · lexical` (disclosure: `lexical`, `hybrid · <embeddings>`, `lexical · <embeddings>
  down`), asking per keystroke (frame-coalesced, stale outcomes dropped) through the *same*
  retrieval the agent gets: `MemorySearch`, or `ArcRecall.searchAmbient` when the focused
  session is arc-bound. Each hit is two rows: the note row (arc-layer hits wear `#slug` in the
  arc hue) and a why-line `lexical #1 · graph #3 · #dock-v2 ×2 · superseded` built from the new
  per-leg `SearchHit.ranks`, the arc boost and the superseded floor. `enter` opens the note lens,
  `esc` back keeps the question, `esc` again closes it. Decision taken here: the box *is* the
  pane's filter (title weight ×3 makes a plain title query rank first), so there is no second
  fuzzy-filter line; Jordan can overrule.
- **Note lens (`enter`).** Every row hangs from a two-cell rail (PD18). Title `▓█ Dock Rule`,
  fact strip `agent · cured · in prompt · pinned · 2d · recalled 7× · #slug`, relations strip
  `supersedes X · superseded by Y · from #slug · delivered 3d ago`, the body through
  `renderMarkdown` at the page measure (headings, bullets, code, fences), then the walkable
  outline: `links out` (1–2 hops), `links in`, typed relations from the graph as `→ depends on`
  / `← depends on` groups (mirrored pairs like supersedes / superseded by fold into one), and
  `staged` cards that target the note (`a`/`d` there). The cursor walks body lines with a `▌`
  rail mark instead of inversion (blank lines skipped); outline rows invert as usual. `esc`/`h`
  back to the garden on the same note, `tab`/`l` ledger filtered to the note, `o` file, `u`
  revert.
- **Ledger lens (`tab`/`l`, C72-a v1).** One feed, newest first: this run's store ops (`create`
  / `edit` / `approve` / `discard` / `revert` / `stage`, with the touched note names, revertable
  by id) and the persisted `curation.md` audit (`gardener sweep · promoted 1, …`, `approved ·
  note → X`, `arc X closed · …`). `u` on an op row reverts that entry (`reverted · the previous
  text is back` / `couldn't revert · the file changed since that write`); audit rows explain
  they can't. Filtered to a note when entered from the note lens; `esc` returns there.
- **Seams.** `MemoryPanePort` gains `revert(ledgerId)` and `query(text, arc?)`; the CLI port
  (`memoryPanePort(memory, arcs.registry)`) loads layers (workspace prompt budget + arc
  stores), per-note `file`, `relations` (graph edges), `recalls` (`Gardener.recallsSinceSweep`),
  `ledger` (`store.ledger()` + new `store.readAudit()` over `memory/audit.ts`), `gardener.sweptAt`
  from the last sweep audit line. `MemoryPaneFactory` now receives intents, the focused session
  and the revival; `app.ts` passes `focusedArc` and `arcOrdinal`. `markdown-ink.ts` holds the
  span-to-ink mapping the conversation pane used to own. `RowPaint.selected?` lets a list paint
  its own cursor.
- **Engine.** `SearchHit.ranks` (1-based rank inside each leg that found the note); `ArcRecall`
  re-applies the superseded floor after merging strata (the browser exposed this: a superseded
  workspace note outranked its successor whenever an arc was bound; `recall.test` covers it);
  `ArcRecall.boost` is public; `Gardener.recallsSinceSweep()`; `MemoryStore.readAudit()`.
- **Evidence.** `memory-rows.test` (state line, prompt cut, focused-arc-first with airlock
  cards, calm states, question rows with why-lines, note lens stack, mirrored relations, ledger
  feed and filter), `memory-pane-model.test` (lens keys, question box typing and stale
  outcomes, outline hop, ledger filter and back, `u`/`o` routing, persistence snapshot and
  restore, cursor property over random ops), `memory-pane.test` (port routing, ask with focused
  arc, revert notices, descriptor, revival, rail painting), `cli/memory.test` (layers and budget,
  ledger + audit, recalls and relations, query ranks, revert), `workspace-state` memory
  descriptor, engine `audit.test`, `search.test` ranks, `gardener.test`, `recall.test` floor.
  New e2e `memory-browser` at 160×40 over a seeded vault (notes, MOC, daily, audit, a staged
  write, a contradiction card, an active arc with a note): captures `garden`, `ask`, `note`,
  `hop`, `hop-outline`, `ledger-revert`, `relaunched-note-lens`. Gate: `bun run check` clean,
  vitest 207 files / 2839 + 1 skipped, native `bun test` 2839 / 0, `bun run e2e` 13/13 with
  goldens verified unchanged.
- **Left for the next pass.** C47 heat candidates through the C40 harness for Jordan's pick
  (C72-c, explicitly after this skeleton); J13 recall / citation rows when those events get a
  persisted home; arc-store staging (stragglers) is not shown yet; the airlock cards are still
  cleared by `a`/`d` like any inbox card (J18's triage surface is the real home); `user` layer
  is modelled (`MemoryLayerKind`) but no store feeds it.

### L7 · C50 part 1, seams: one hairline per split (landed 2026-08-25)

Jordan's read of the frame: the outer app border plus a rounded border per pane made every
internal edge two lines thick and cost four columns and two rows per pane. Decision: the
outer frame is gone (the terminal edge is the frame), and `chromeWeight` grew a third value,
`seams`, which `keywork-night` now wears; `regular` still renders the boxed look byte for
byte, so the flavor gallery (C49) keeps both. All `OWN`.

- **Geometry.** Layout rects stay the truth. In `seams` a pane keeps a one-cell right edge
  and bottom edge only where a neighbour exists (`innerRect`), and `view/seams.ts` draws
  those cells once per split with junctions computed from the tiling (`├ ┤ ┬ ┴ ┼`, lines run
  off the screen edge). A perfect tiling never produces a corner glyph, so the rounded turns
  in the table exist only for robustness. Tier 0 degrades to `| - +`.
- **Ink.** A seam cell touching the focused pane wears that pane's focus-lifted arc hue; any
  other cell wears its owner's resting hue (the pane on its left or above); the empty main
  region between docks wears `border`.
- **Pane chrome.** No border; a one-row header carries the trimmed title (pin mark first) in
  the pane's hue when focused and `textMid` otherwise; one cell of padding each side. Chrome
  cost is two columns and one row against boxed's four and two; `paneContentWidth/Height`
  now take the context so every pane sizes for the weight it is drawn in, and the geometry
  harness runs every pane at every size in both weights.
- **Typography.** `wrap` breaks at the last space that fits and never opens a line with one;
  user transcript lines wrap under a hanging `› ` so the prompt mark stays on one edge.
- **Not touched.** Gap cells, the borderless luminance-focus mode, tier-gated corners in the
  boxed weight, and the prose gutter (C52) all stay as scoped in C50/C52.
- **Outer ring (Jordan, 2026-08-25 afternoon, revised evening).** With no outer frame a lone
  pane had no focus cue and a focused pane lost its outline on the viewport side. The `seams`
  weight now draws a true outermost border (`frameInset` reserves the cell): rounded corners,
  `border` ink at rest and `accent` while the leader is armed (the old navigation-mode cue on
  the real edge), with seams joining it through `┬ ┴ ├ ┤`. The focused pane's outline band
  (its own right and bottom seam, the seam or ring one cell outside its top and left, the
  ring outside its right and bottom when it sits on the field edge) lights in its focus hue;
  the band is geometric, so nothing past a corner ever lights. A first cut lit any seam cell
  whose 3×3 neighbourhood touched the focused pane, which overshot by one cell past corners.
  Mouse and overlay coordinates shift by the inset; `regular` has no ring.
- **Armed ring (Jordan, 2026-08-25 night).** `borderFocus`, `accent` and `ramp[0]` are the
  same purple, so once the ring doubled as the focus outline the armed cue vanished for any
  pane at ramp position 0 (a lone pane, a zoomed pane): its outline was already accent and
  arming changed nothing. While the leader is armed the ring now wins over the outline
  (`accent` ink) and draws in heavy strokes (`┏ ━ ┓ ┃`, seams joining through `┯ ┷ ┠ ┨`;
  tier 0 thickens horizontals to `=`), so nav mode reads on the real edge whatever hue the
  focused pane wears; `seams.ts` carries a `SeamStroke` beside `SeamInk` and a weighted glyph
  table. At rest nothing changed: the focused outline still lights the ring on its edges.
- **Stroke masthead.** `stroke-face.ts` rasterizes each letter from a few polylines on a
  7-unit grid with a square brush at scale 1, 2, or 3 (4, 7, or 11 rows) into `█ ▀ ▄`, giving
  the moak.dev letterforms (arched M, rounded bowls, 3-cell strokes) without a hand-drawn
  font. `headline` prefers, among block faces, the setting with the most words and breaks
  ties toward the larger brush; caps stays the fallback. Masthead rows fade from the pane's
  arc hue to `text`.
- **Flicker at tiny sizes (scoped, not fixed).** Twelve consecutive captures at 34×7 on the
  test renderer are byte-identical, so the header row is stable in keywork's own frames; the
  flicker is the terminal repainting during full-row rewrites. Candidates if it persists:
  confirm OpenTUI emits synchronized-output brackets (mode 2026) under WT_SESSION, and lower
  repaint pressure by skipping `render()` on pointer moves that change nothing.
- **The live header (Jordan, 2026-08-25 evening).** Spend is off by default: `/show-costs`
  (aliases `costs`, `hide-costs`) toggles `AppCore.costsShown`, which reaches panes as
  `PaneContext.costs`. The header's tail is now `liveStatus`, segments that appear only when
  they say something: the running tool's name with the turn's elapsed time (`bash · 14s`,
  `thinking · 3s`; a one-second unref'd clock ticks only while busy), `needs you` on a
  pending ask, `n queued`, the context gauge once `used` reaches half the flush reserve
  (cockpit instruments always show it), spend when toggled on, and `failed` for an unseen
  failure. `TranscriptFeed` learned `activeTool()` and `turnElapsedMs()` to feed it.



## Scoping (options-first, per the 98/100 rules; nothing below is built)

### C70 · the arc pane · 3pt + 1pt captures · `OWN` (design final 2026-08-22, three rounds) · landed 2026-08-23 in two parts (L4 and L5 above)

**Jordan's ask.** "A 'cycle Arc' key in the navigation that's not a high priority key that
fits. That would move all sessions as a grouped sick looking entity that keeps their
uniqueness for selection intact as well." Refined over three rounds into: an arc is a pane.

**Design: the arc pane is a compact docked controller for one arc.** Member sessions stay
tiles in the main area exactly as today. The arc pane is a pane like any other (tiles, docks,
zooms, pins under C71) whose title is the arc's name and whose body is one row per member
session **in creation order** (derived from the arc's bindings, never stored). From it the
group is folded and unfolded as a whole or one member at a time. A folded member's tile
leaves the main tree; the session stays live (held, as restore and `/init` reopen already
hold attachments), its row keeps reporting. Unfolding brings the tile back. "All folded" is
the arc collapsed into the dock: the grouped entity at rest. No global "stage" or filter;
the fold is the primitive, the pane is the handle.

- **Rows.** `stamp · title · state word · age`, e.g. `▓ fix auth redirect · working 2m`.
  The stamp cell is the member's lifecycle stamp through the same resolver the title bar
  uses (C64 `LifecycleState`: working fills, needs-you `█`, idle blank, finished-unseen,
  failed), so rows and titles never disagree. A folded member's row is dim with a `░` fold
  mark in the stamp cell while idle. **Folded and waiting** (Jordan: stay folded, a classy
  indicator): the stamp rises ░→▒→▓→█ in the arc hue at quick tempo (C53), the state word
  reads `needs you`, and the arc pane's own lifecycle becomes needs-you (stamp now, inverted
  label and saturation lift when C69 lands), so the dock tells you without pulling the tile
  up. Later candidates for the row (turn count, cost, changed files) are 102's call.
- **Pane-local keys** (letters, like the memory pane; no new leader chords): `enter` focuses
  the member's tile, unfolding it first if folded (if already shown: just focus; unzoom if
  the main area is zoomed on another pane). `space` folds / unfolds the row's member.
  `a` toggles all: if any member is shown, fold all; else unfold all. `r` refreshes.
  `leader z` on the arc pane zooms the rows to the main area (the whole-arc view).
- **Fold geometry.** Unfolding re-attaches beside the arc's most recently focused visible
  member so the group stays clustered; if none is visible, at the main area's edge
  (`attachAtEdge`). Folding removes the leaf and siblings take the room (the dwindle layout
  already does this). Motion (PD16, ink only): incoming tiles' borders rise ░→▒→▓→█ in the
  arc hue over `quick`, outgoing snap away, any key settles.
- **Half-height node.** Dock slots are equal today (`stackSlotRect`); each pane kind declares
  a dock weight (session tree 1, arcs node 1, MCP 1, arc pane ½) and the stack sums weights.
  A kind property, nothing persisted, no user-facing setting.
- **Creation and lifetime.** `split-arc` / `/arc new` binds the new tile in main and focus
  lands on it (C70-b). **The first arc created in a workspace** auto-docks its arc pane (same
  dock as the arcs node if open, else right; below pins per C71); later arcs open theirs from
  the arcs node row or `/arc open <slug>` (Jordan: first time per workspace, to keep docks
  calm). `split` inside an arc adds a tile and a row (PD13 inherit). Closing the arc pane
  leaves the arc untouched; `/arc close` / abandon removes the pane. Unbound sessions are
  plain session panes and dock as today; there is no "no arc" group (C70-c). No status-chip
  readout; the title carries the arc name and, when any member is folded, `· n folded` in
  the facts zone (C70-d).
- **Persistence.** Arc-pane descriptor `{ arc, folded: sessionId[] }`; folded members
  restore held, not tiled; `WorkspaceState.introduced` records that the arc pane has been
  auto-docked once. Restore drops folds whose sessions no longer exist.
- **Later, built on the primitive (parked).** A "cycle arc" leader chord as "fold every other
  arc, unfold this one"; the in-pane session view as a third level; main-area pins (C71-c).
- **Acceptance.** e2e `arcs` scenario extension at 160×40: create the first arc (pane appears
  docked at weight ½, below pins), `space` folds one (tile gone, row dim `░`), `a` folds all,
  `a` unfolds all (rise captured), a folded member needs you (row `█` + `needs you`, pane
  stamp needs-you, tile stays folded), `enter` on it unfolds and focuses, second arc does
  not auto-dock and `/arc open` does, relaunch restores folds; tier-0 capture reads every
  state from density alone. Unit: fold / unfold / toggle-all invariants, re-attach placement,
  weighted `stackSlotRect`, descriptor round-trip, `introduced` once per workspace.

### C71 · pins for docked panes · 2pt · `OWN` · landed 2026-08-23 (ledger in L3 above)

**Jordan's ask.** "We should be able to `pin` things that are docked, giving them a
priority position relative to their pins."

**Design.** A pin is a *priority slot* inside a dock column. Pinned panes sit at the head of
their dock in pin order; unpinned panes follow in their manual order. `shift+j/k` on a
pinned pane reorders it among pins only (it never drops below an unpinned pane); on an
unpinned pane it reorders among the unpinned. Unpinning leaves the pane where it is and
frees it. `dock-cycle` to the other dock carries the pin (it is pinned at that dock's head
too). Arriving panes (summons, auto-docked nodes) always land below the pins, so a pinned
tree or arcs node never gets shoved.

- **Keys and commands.** `/pin` toggles the focused docked pane (`/unpin` spelled out too);
  chord candidate `leader i` (free letter, "p" is the palette and shift-variants mean "the
  stronger same action" in this keymap, so `shift+p` is out). Main-area panes answer "pins
  are for docked panes · dock it first" for now.
- **Mark.** Pinned panes lead their title with `▪` (tier-1) / `*` (tier-0), dim, before the
  name; no color (pins are layout, not state). Title-bar zone order puts it first and it
  never sheds (one cell).
- **Persistence.** Dock entries in `WorkspaceState` carry `pinned: true`; restore keeps
  head-of-dock order.
- **Open decisions (Jordan).** Chord choice; whether the default fresh-start tree/MCP panes
  ship pinned (recommended: no, pins are a human statement); whether main-area pins mean
  "never pushed by `move`" later.
- **Acceptance.** `layout.test`: pin/unpin ordering invariants, J/K within groups, arrival
  below pins, dock-cycle carry, restore; an e2e capture in `tiling-tour` showing the mark.

### C72 · the memory browser · 3pt skeleton + 2pt ledger lens · `OWN` · landed 2026-08-23 (L6 above; heat candidates still to come per C72-c)

**Jordan's ask.** "Eventually we want to envision a memory browser/interactive element for
understanding the state of the memory without directly reading the files … the best
next-level thing we could do there."

**What "state of memory" means here.** What does keywork believe right now, how cured is
each belief, where did it come from, what superseded what, what is in flux (staged,
contradicted, waiting at an airlock), and what happened to it lately. J9's pane shows notes
+ inbox + backlinks; the browser turns it into three lenses over one list, switched in place
(the arcs node's two-level pattern, extended), with one genuinely new element at the top.

1. **Garden lens (default).** Header = the state line: `42 notes · 3 curing · 2 staged · 1
   contradiction · swept 12m ago`. Rows `curing · provenance · title · age · recalls`,
   grouped by layer: the focused session's **arc layer first** (header in the arc hue, the
   airlock digest lives here when `/arc close` is waiting, which gives J18 its review
   surface), then workspace, then user global. Typing filters fuzzily like every picker;
   `tab` cycles lenses.
2. **Note lens (`enter`).** The note rendered in place with PD18 page typography, topped by
   a fact strip `▓ agent · cured · supersedes "Old Rule" · delivered from #dock-v2 ·
   recalled 7× · last 2d`, then the **local outline** (1–2 hops: links out, backlinks,
   supersedes / superseded-by, consolidates), every row enterable, so the graph is browsed
   by walking and never drawn whole (the community verdict in 95 stands). `o` opens the file
   in a file pane (the escape hatch, never the default), `u` reverts the last agent edit
   (the one-key revert J-D4 promised), `a`/`d` act on a staged item.
3. **Ledger lens (`l`).** The append-only event ledger as a feed: `2d ago ▓ flush wrote
   "Dock Rule" · 3h ago session-4 recalled "Dock Rule" · 12m ago gardener proposed merge …`,
   filterable by note; the R6 rule made visible (frontmatter is a materialization of this).

**The next-level element: the "what do you know about …" box.** At the top of the garden
lens, typing `?` opens a query line that runs the *same* hybrid retrieval the agent uses
(`MemorySearch`, RRF, with the J4 disclosure `lexical / hybrid / lexical-degraded`) and lists
the ranked hits with a why-line per hit (lexical rank · vector rank · arc boost). The human
sees memory exactly the way the model will, which is the one thing reading files can never
give. `enter` on a hit opens the note lens. This is also where J13 citations and the C47
heat rendering (options-first, Jordan picks from rendered candidates) land without a new
surface.

- **Keys.** `/memory` + `leader m` unchanged; `tab` lenses, `enter`/`esc` drill/back, `?`
  query, `o` open file, `u` revert, `a`/`d` approve/discard, `l` ledger, `r` refresh.
- **Persistence.** Descriptor revives lens + note + query.
- **Open decisions (Jordan).** Whether the ledger lens is v1 or follows J13; `?` versus a
  permanent query line; heat rendering candidates (C47) rendered through the C40 harness for
  the pick.
- **Acceptance.** Unit on the lens model (grouping, filters, outline hops, query wiring with
  disclosure), an e2e `memory-browser` scenario with a seeded vault (garden → note → outline
  hop → query hits → ledger), tier-0 capture as the monochrome fixture.

## Decisions (Jordan, 2026-08-22, evening)

The open decisions above, answered. Where an answer changes a design, the section above is
superseded by the note here until the section is rewritten.

- **C70 reframed: an arc is a pane, not a visibility mask.** The original stage-as-filter
  design was withdrawn and the section above now holds the final design after three rounds:
  a compact docked arc pane, rows in creation order, fold / unfold per member and for all,
  folded members held live, first arc per workspace auto-docks, `a` toggles all
  (fold-if-any-shown), a folded member that needs you stays folded and the row stamp +
  state word + pane lifecycle say so, `enter` just focuses. C70-a resolved as pane-local
  keys, no new leader chords. C70-b jump, C70-c no "no arc" group, C70-d no chip.
- **C71-a:** `/pin` lives on `leader p`. `leader p` is today a secondary chord for the command
  palette (primary `ctrl+shift+p`, and `ctrl+p` then `>`); the palette's leader fallback moves
  to `leader i` (decided) and the help overlay follows. Jordan notes the `>` mode prefix in
  quick-open reads a little odd; assessment below under flags.
- **C71-b:** fresh-start tree and MCP panes ship unpinned. `seedDefaultWorkspace` becomes a
  declarative initial-workspace spec (kinds, docks, pins) so the initial state is defined in
  one obvious place and can become user-configurable (a config option with its `.describe()`
  justification per D9) without touching layout code.
- **C71-c:** the main-area pin semantic is reserved (not built); its meaning is decided when
  C70's arc panes make it concrete.
- **C72-a:** the ledger lens is v1, over what is persisted today (store ledger ops +
  `curation.md`); J13 recall/citation rows join when those events get a persisted home. The
  browser plan merges with C47 (heat) and J13's rendering into one "next level viewer" plan
  that reflects the memory system as a whole, rather than three surfaces.
- **C72-b:** `?` opens the query line (a toggle, not a permanent line); the hint that
  advertises it is part of the design and must look right.
- **C72-c:** heat candidates (C47) render as the last step inside the merged C72 plan, through
  the C40 harness for Jordan's pick, after the lens skeleton lands.
- **C72-d:** `u` reverts the selected note's last ledger entry (never the vault's last op).

## Flags for Jordan

- `/init`'s reopen rides the same in-process relaunch `/workspace` uses (destroy renderer,
  compose again). 110 flagged it unverified on a live terminal; `/init` is now the first
  everyday path through it, so one live run on Windows Terminal decides whether the fallback
  ("reopen keywork yourself, trust is saved") is needed.
- Memory pane is offered in every trusted workspace now, empty until the vault exists; if
  that reads as clutter in the discovery goldens later, gate it on readiness instead.
- `/connect` cannot do the ChatGPT subscription sign-in (browser/device flow); the terminal
  `keywork connect` still can. The targets screen does not mention it yet.
- **`ctrl+shift+p` on Windows Terminal.** Windows Terminal binds it by default to its own
  command palette and consumes it before the app sees input; there is no per-app scope, so
  the only remedy is unbinding it in the terminal's `settings.json` (`{ "id": null, "keys":
  "ctrl+shift+p" }` in `keybindings`; done on Jordan's machine 2026-08-22). Even unbound, the
  legacy console path cannot tell `ctrl+shift+p` from `ctrl+p` without the kitty keyboard
  protocol, so on win32 the help overlay should lead with `leader i` (rides C71) and the
  README's keys section should say so. Decision: not worth fighting beyond that.
- **Help overlay height (landed 2026-08-25).** The hotkeys overlay no longer runs off the
  screen: `panelFrame` clamps every help-framed panel to the screen height with a row to
  spare above and below, and `HelpOverlay` pages the action list inside that room
  (`up`/`down` one row, `pageup`/`pagedown` a page, the wheel too; clamped at both ends).
  The footer says what is hidden (`↑↓ scroll · 4 below · esc closes`) and stays `esc closes`
  when everything fits. The discovery goldens were recaptured, which also brought them up to
  the seams chrome they had drifted from since 2cb1891.
- **Pin mark ink.** Closed 2026-08-30: C69's span-composed title row landed (113 W2) and the
  `▪` mark renders in `textDim`.
- **The `>` prefix in quick-open.** `ctrl+p` opens quick-open (jump to a pane); typing `>`
  flips it to commands (`overlays/palette.ts paletteModeOf`). That is VS Code's convention
  verbatim, and it is the only place in keywork where `>` means anything; everywhere else a
  command is spelled `/name` (the prompt editor's slash commands, the help overlay's
  examples, the docs). Options: (a) keep `>` (familiar to VS Code hands, zero change);
  (b) make `/` the commands prefix in quick-open, matching keywork's own vocabulary, so
  `ctrl+p /spl` and typing `/spl` in a prompt are the same gesture, with `>` kept as a
  silent alias so nobody's muscle memory breaks; (c) drop the prefix and let quick-open
  fuzzy over panes and commands together, commands marked by a `/` glyph in the row.
  Recommendation: (b), one-line change plus the help text, and it rides C71 since that task
  already touches the palette chord. Not decided.
