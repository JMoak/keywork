# File Browser & Calculated Mouse: Design Lanes

> Planning overlay, 2026-08-10. Where this file speaks for its two lanes it wins; elsewhere
> [`92-iteration-3.md`](archive/92-iteration-3.md) → 91 → 90 → workstream files apply (those
> three are archived under `archive/`). IDs continue the C-series (browser is TUI work) and
> open the **H-series** (pointer input).
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing before
> workstream G; Pi/OpenCode are MIT, adapt with attribution in `NOTICE`; Crush is FSL and
> never a source (no code, no design credits since 2026-08-10). Hyprland is referenced for
> *interaction semantics only*; no source consulted or ported. The user commits; agents never
> `git commit`/`git push`.

## Ledger (2026-08-10, 200 tests / 20 files green)

| ID | Status | Landed as |
|---|---|---|
| C29 | **done** | `BrowserModel` + 19 unit tests; lazy per-dir reads, path-anchored cursor, `/`-initiated filter over `fuzzyScore`, property test on cursor visibility. |
| C30 | **done** | `BrowserPane`; `/browse [dir]` (alias `/files`), `leader f` summon-or-focus, files open via `PaneIntents` into the main area. |
| C31 | **done** | `/browse` opens docked (existing dock side, else left); expansion state deliberately not persisted. |
| C32 | **done** | `PaneIntents` (`openFile`/`focusPane`) on `AppCore`, injected into browser factory; `/open <dir>` redirects to the browser via injectable `isDirectory`. |
| C33 | **done** | `gitignore.ts` (`OWN` matcher: nested `.gitignore` files, negation, directory-only, anchored, `**`, classes, escapes) drives `BrowserRow.ignored`, painted `textDim` while staying navigable and openable; `file-index.ts` (`FileIndex`, bounded to 2000 entries / depth 8 over the same `BrowserDisk`, skips `.git` and ignored dirs) feeds `fileJumpSource` into the palette's go mode through `PaneIntents.openFile`, gated by `fileJumpsAllowed(readiness)`; `debounce.ts` (`Debounce` over an injectable `DebounceTiming`) reloads the browser 150 ms after the last `watchDirectory` event on any loaded directory. Closed out 2026-09-06, see below. |
| H1, H2, H3 | **done** | `AppCore.handleMouse` spine + `pointer.ts`; overlay frames as shared pure functions; split-node `ratio` with min-size clamping, `leader shift+./,` resize verbs, `grow`/`shrink` commands; probe `click`/`hover`/`scroll`. |
| H5 | **done** | Delivered as FR1.1 (2026-08-16, [`101`](101-feedback-round-4.md)): title-row grab, ghost-rect drop previews, `Layout.dropTargetAt`/`applyDrop` sharing the keyboard verbs' primitives. |
| H4 | **done** | Dock boundary columns drag-resize (`dockHandleAt`/`dragDockEdge`, FR round 4); interior split borders drag-resize through `Layout.splitHandleAt`/`dragSplitHandle` (a `SplitHandle` path of `first`/`second` steps into the main tree, nested splits included) and `PanePointer.routeSplitResize`, which claims the grip on `down`, retiles live on `drag`, and releases on `up` or `drag-end`; ratios land on the same `steppedRatio` lattice the keyboard `grow`/`shrink` verbs use. Closed out 2026-09-06, see below. |
| H6 | open | Folds into Track L's terminal pass; `pointer: "on" \| "off"` config option not yet built. |

**Improvement pass (2026-08-10, two-pronged review → applied, 207 tests / 20 files green).**
Algo/correctness: stale-read guard on refreshed directory reads (claim-token settle);
revision-cached `rows()` (no more full-tree walks per keystroke); locale-total sort
comparator; wheel-delta clamp (`maxScrollSteps`) + sanitized pointer deltas; degenerate-rect
handling at tiny screens; all-docked opens land in the empty main tree; 20 MB file-size cap
before read; palette matches snapshotted per query so Enter always runs the row the user saw.
Craft: one declarative action table drives bindings/help/sticky/dispatch/commands; shared
`pane-chrome.ts` + `clamp.ts`; `Pane.settled?()` probe seam (casts deleted); overlay state as
a discriminated union; factory types derived `AppCoreOptions` → `AppProbeOptions`; `index.ts`
trimmed to the real public surface; `Layout.dock()` exposes `ratio`. Deferred (reviewed, not
defects): incremental filtering, notify batching/render coalescing (C2's perf-budget work).

**C33 closed out (2026-09-06).** The browser now takes a `BrowserDisk` seam
(`readDirectory`, optional `readIgnoreFile`, optional `watchDirectory`) instead of a bare
reader; `realBrowserDisk` is the fs-backed default and `browserDiskOf` still accepts a plain
reader so existing call sites and tests keep their shape. Ignore rules load per directory
as each `.gitignore` is discovered, scoped to that directory, deeper files winning, and an
ignored ancestor ignores everything under it (negations included, as git does). The palette
index walks breadth-first, directories first, and is lazy: nothing is read until the first
palette search, and nothing at all while the workspace readiness is `undecided` or
`refused`. Evidence: `gitignore.test.ts` (pattern semantics, nested files, three
property-style rounds over random paths), `debounce.test.ts` ("fires once after the quiet
period following a burst", "arms one timer per burst"), `browser-model.test.ts` ("marks
matching entries ignored without hiding them", "keeps ignored entries navigable and
openable", "watches each loaded directory and reloads once after a burst settles", "keeps
the cursor row across a watch-triggered reload"), `browser-pane.test.ts` ("paints .gitignore
matches dim while leaving them openable"), `file-index.test.ts` ("caps the entry count at
the pinned limit", "stops descending past the depth limit", "fuzzy-matches a typed path in
go mode and enter opens the file pane"). Crossings: `app.ts` gained one `FileIndex` over
`process.cwd()` registered as a palette source and disposed on exit; `app-core.ts`, `layout.ts`
and `pointer.ts` untouched. Pi's ignore handling was not lifted: it leans on the `ignore`
npm package, which would be a new dependency, so the matcher is `OWN` and `NOTICE` is
unchanged.

**C33 follow-up (2026-09-07).** `FileIndex` now watches every directory its walk read
through the same `BrowserDisk.watchDirectory` seam and re-walks 150 ms after the last change
(`Debounce` over an injected `DebounceTiming`), so a file created after launch is jumpable
without a restart; a change landing mid-walk queues exactly one more walk, and watchers for
directories the next walk no longer reaches are closed. `app.ts` needs no change, it already
hands the index `realBrowserDisk`. Evidence: `file-index.test.ts` ("re-walks once after a
burst of watcher events settles", "queues one more walk when a change lands mid-walk",
"drops watchers on directories that vanished and closes them all on dispose").

Assumptions Jordan may reverse:
- Matching is case-sensitive and reads only `.gitignore` files at or below the browser root
  (no `.git/info/exclude`, no global excludes, no parent-of-root ignore files).
- The palette index builds once per run; `FileIndex.refresh()` exists but nothing calls it
  yet, so files created after the first palette search wait for a restart to become jumpable.
- File jump commands are named by their root-relative path, so `/src/app.ts` typed in
  command mode also opens the file; registered commands still win a name clash.
- The index skips `.git` and gitignored entries but keeps other dotfiles, and lists at most
  2000 files eight directories deep.
- Watch events reload the whole loaded tree (same path as `r`), one fs watcher per loaded
  directory, closed on refresh and dispose.

## State of mouse input (2026-08-16)

The whole-app picture, taken after FR round 4 landed drag-drop. One spine, no view-layer
event soup: OpenTUI's `onMouse` → `pointerEventOf` (action whitelist, sanitized wheel
deltas) → frame-chrome offset subtraction → `AppCore.handleMouse` behind the crash-contain
guard. Every gesture resolves to an existing keyboard action ("mouse as garnish" holds).

**Live-delivery regression found and fixed (2026-08-16).** OpenTUI dispatches mouse
through a hit grid of renderable ids resolved against the live-renderable map, a
retained-mode contract. keywork paints immediate-mode: every frame destroys the whole
tree (`discardFrame`) and builds a fresh one, so after any queued repaint the grid held
destroyed ids, the lookup missed, and OpenTUI dropped the event before anything keywork
owns could see it. Because `app.ts` queues a repaint on every input event, including
mouse-move, which streams while the pointer approaches a click target, live mouse was
dead-on-arrival everywhere; probe tests never caught it because they drive `AppCore`
directly, below the adapter. The fix is the **pointer plane**: one persistent transparent
full-screen renderable (`pointerPlaneId`, top zIndex, exempt from `discardFrame`) that
always renders last, so every hit-grid cell permanently resolves to a live renderable
that bubbles to `root.onMouse`. Delivery no longer depends on the frame tree at all,
which is the honest shape of keywork's doctrine, since all routing already lives in
`AppCore`. Plain mouse-move events now also skip the frame rebuild unless an overlay or
drag needs them (`mouseRepaints`). Regression net: the e2e stage grew real mouse verbs
(`click`/`scroll`/`drag` via OpenTUI's mock mouse) and the `pointer-tour` scenario proves
click-to-focus survives rebuilds, wheel scrollback, and dock-boundary drag through the
real renderer pipeline.

**Routing precedence inside `AppCore.handleMouse`:**
1. Palette open → hover moves the selection, click runs the row, outside-click dismisses.
2. Help open → outside-click dismisses.
3. Any other overlay (preset picker/confirm) → any `down` dismisses; no row semantics yet.
4. Dock-edge resize → `down` on a boundary column claims the drag (`dockHandleAt`),
   `drag` retiles live (`dragDockEdge`), `up` releases.
5. Pane drag → `down` on a title row arms it; first `drag` lifts and renders the ghost
   rect from `dropTargetAt` (fits-checked: impossible drop = no preview); `up` commits
   through `applyDrop`, which reuses the keyboard `move`/insert primitives.
6. Pane hit → `down` focuses; the event forwards to `pane.handleMouse` in local
   coordinates; an unclaimed `scroll` degrades to arrow-key presses (`scrollByKeys`,
   `wheelSteps` clamped at 10) so hover-scroll works on every pane for free.

**Per-surface coverage:**

| Surface | Click | Wheel | Gaps |
|---|---|---|---|
| Conversation | none | scrolls transcript | ask row, diff window, and slash tray are not clickable (deliberate so far) |
| Session tree | activates (overview) / selects (entries) | key-fallback | no hover highlight |
| MCP node | **none** | key-fallback | rows not clickable; below the sessions-node bar (FR2.4 territory) |
| Browser | none | key-fallback | rows not click-activatable |
| File / memory | none | key-fallback scroll | none |
| Pane trays (FR3.9) | **none** | none | tray rows should adopt the H2 hover/click grammar |
| Palette / help | H2 grammar done | none | none |

**Probe parity:** `probe.click/hover/drag/scroll` cover every gesture headless; the layout
fuzz walk includes a random drag-drop branch holding the exact-tiling invariant.

**Next rungs, in order:**

1. **Hover grammar (design first, Jordan's call).** One hover mark, distinct from the
   inverted-accent selection bar so the two never overlap: hover proposes, selection
   holds. Candidate treatments to render as C40-style options: dim accent `▸` in the
   marker column, underline, or a soft background a step above the pane ground. Rules:
   one hovered row per screen, hover never moves the keyboard cursor, mouse-leave clears,
   `move` events repaint only the affected rows (extend `mouseRepaints`).
2. **Row-click parity + scroll circumstances.** MCP node, browser rows, and FR3.9 tray
   rows adopt the sessions-node treatment (click = the row's enter-equivalent); wheel
   stays hover-routed (scroll under the pointer, never a focus change), with the
   key-fallback reserved for panes with no scroll model of their own. Session-tree
   advanced behaviors (click drills, click-and-drag reorder, per-row affordances) ride
   on the same grammar afterward.
3. ~~**H4 interior split borders**: extend the dock-edge drag mechanism; the geometry
   blocker is gone.~~ Done 2026-09-06, see the H4 closeout below.
4. **H6 terminal-reality pass** with Track L (`pointer: "off"` escape hatch, SGR
   validation on Windows Terminal/kitty/alacritty/ghostty/tmux).

**H4 closeout (2026-09-06, uncommitted).** The interior grip was already in the tree from the
sweep that landed `splitHandleAt`, `dragSplitHandle`, and `routeSplitResize`; this pass audited
it against the H4 acceptance line and filled the evidence gaps. The grip is one cell wide on a
column seam (the row above the lower pane, leaving that pane's title row to the pane-drag
gesture) and two cells on a row seam (both border columns); hit-testing walks the main tree with
raw `layout.rects` geometry, and a zoomed scene returns no handle. The dock edge keeps
`dockHandleAt`/`dragDockEdge`: unifying the two would have traded two fifteen-line routines for
a discriminated handle type and saved nothing. Evidence: `layout.test.ts` "holds the tiling
invariant and the min-size floor at every dragged position on a nested seam" (every y on a
120x40 screen), "zooms and unzooms byte-identically over a dragged ratio", "round-trips a
dragged ratio through the persisted layout state"; `workflows-layout.test.ts` "drags a nested
horizontal seam live, commits on release, and stays gapless at every position", "drags the
outer vertical seam without stealing focus from the pane under it", "persists a dragged ratio
through the workspace file and survives zoom unchanged" (probe drives `AppCore.handleMouse`,
restores from `workspaceState()`); `pointer-routing.test.ts` "commits a seam drag on drag-end
just as on up, then hands the next press back to the panes". Lane gate: the three TUI files
and the two CLI files this lane touched ran 164 and 70 tests green; biome clean on every touched
file; `tsc --build` clean on them (the eight remaining errors sit in other lanes' in-progress
`compose.ts`, `browser-model.test.ts`, and `browser-pane.ts`).

Assumptions Jordan may reverse:

1. No cursor-style hint. OpenTUI 0.5.1 has `MousePointerStyle` on `renderer.setCursorStyle`,
   but `app.ts` exposes no pointer-style seam and applies the same style to the whole pointer
   plane, so a hint would mean a per-move `setCursorStyle` call from the adapter. Skipped for
   now; it is a small adapter change if wanted.
2. The dock edge and the interior seams stay two mechanisms (see above).
3. A column seam's grip is one cell (the border row) so the lower pane's title row keeps the
   H5 pane-drag gesture; a row seam's grip is two cells.

## Why now

`FilePane`/`FileModel` landed with `/open <path>` (C11 partial). The natural next rung is
opening *directories*: a browser pane that feeds file panes. Simultaneously the product
bar has been raised: keywork should feel like **terminal-video-game-grade software**
(instant, spatial, legible), which means light, deliberate pointer support for the moments
where a pointer is honestly the best instrument (overlay row selection, pane focus, border
drag). Both lanes ride the same architectural spine: pure models + `AppCore` routing +
probe-harness determinism.

## Principle check (before any code)

[`ux-principles.md`](../ux-principles.md) P1 and the §4 refusal *"No mouse-required or
mouse-first features; mouse support may exist as garnish only"* remain binding and are
**not** revised by this document. Everything in lane H maps 1:1 onto an existing keyboard
action; the mouse adds a second door, never a new room. Review question on every H PR:
*"delete the mouse handler: is any capability lost?"* The answer must be no.

---

## Lane C-FB: Directory / file browser

### The shape

One new pure model + one thin pane, mirroring the `FileModel`/`FilePane` and
`ConversationModel`/`ConversationPane` pattern exactly:

- **`BrowserModel`**: a lazily-expanded directory tree: cursor row, expand/collapse state,
  dirs-first + alpha ordering, hidden-file toggle, type-to-filter. Pure state machine over
  an injected `readDirectory(path) → Entry[]` so tests never touch the real fs unless they
  want to. Windowed rendering via the `visibleLines(rows)` idiom: no full-tree realization,
  no recursive scans, expansion reads one directory at a time.
- **`BrowserPane`**: renders the model; selection bar, `▸/▾` affordances, dim-styled
  hidden entries, count-in-title (` · 42 entries`), same rounded-border chrome as every pane.

Ranger-style Miller columns are rejected: the tiler *is* the second column; Enter opens a
real `FilePane` next to you. One browser abstraction, zero bespoke layout.

### Keyboard grammar (P2-conformant, guessable)

| Key | Action |
|---|---|
| `j/k` / arrows | move cursor |
| `h` / `l` | collapse / expand (on a dir), `l`/`Enter` on a file → open `FilePane` |
| `Enter` | expand dir · open file |
| `.` | toggle hidden files |
| type-to-filter | narrows visible entries; `Esc` clears |
| `r` | re-read from disk |

### Tasks

#### C29 (2pt): `BrowserModel`
Pure tree model as above. Filter is a subsequence match over the visible (expanded) set,
consistent with the palette's matcher. Cursor survives refresh and collapse (clamps to
nearest surviving row).
**Accept:** unit tests for expansion laziness (a dir is read exactly once until refresh),
cursor clamping, filter, hidden toggle; property test: any op sequence keeps cursor on a
visible row.
**Strategy:** `OWN`.

#### C30 (2pt): `BrowserPane` + `/browse [dir]` + summon
Pane over the model; `/browse` (default cwd) opens it; summon chord (`leader f`) focuses an
existing browser instead of duplicating; this lands the C11 "summon-per-type" gap for its
first type. Opening a file routes through a **`PaneIntents`** surface (see C32).
**Accept:** probe workflow: `/browse`, navigate, Enter on a file yields a focused
`FilePane`; summon-or-focus tested; `/open <dir>` redirects to the browser instead of
failing with `EISDIR`.
**Strategy:** `OWN`.

#### C31 (1pt): Dock-native default
The browser's natural home is the dock: `/browse` opens docked-left by default (undock verb
already returns it to the main tree). Workspace persistence (Track P) records browser panes
like any other: type + root path.
**Accept:** probe workflow: browse → restart-shaped snapshot round-trip keeps dock side,
root, and expansion state is *not* persisted (fresh read on restore, by design).
**Strategy:** `OWN` on the dock engine.

#### C32 (1pt): `PaneIntents`
Small capability object passed to pane factories: `openFile(path)`, `focusPane(id)`, the
sanctioned way any pane asks the app to open another pane. Replaces the current
private-method reach and is the seam the session-tree pane (C13) and diff pane (C14) will
need anyway.
**Accept:** browser and `/open` both route through it; a toy pane in tests opens a file
pane without touching `AppCore` internals.
**Strategy:** `OWN`.

#### C33 (2pt): Repo-aware polish *(second pass; not blocking)*
`.gitignore`-aware dimming (not hiding) via a fast ignore matcher; palette "files" section
(the C26 gap) fuzzy-jumping over a bounded index built from the same `readDirectory`;
fs-watch refresh with debounce.
**Accept:** ignored entries render dim; palette file-jump probe test; watch debounce unit
test.
**Strategy:** `LIFT:pi` ignore-handling if their walker fits (`NOTICE` line); else `OWN`.

---

## Lane H: Calculated pointer support

### The spine: mouse routing lives in `AppCore`

OpenTUI 0.5.1 already parses SGR mouse: `down/up/move/drag/drag-end/drop/over/out/scroll`
with modifiers. We deliberately do **not** scatter per-renderable handlers through views.
One entry point, symmetric with `handleKey`:

```
AppCore.handleMouse(event: PointerEvent, nowMs: number)
```

Routing order: overlay (palette/help) first → pane hit-test via `layout.rects(screen)` →
pane-local coordinates into an optional `Pane.handleMouse?(local, event)`. Because
`AppCore` is renderer-free, the probe harness grows `probe.click(x, y)`,
`probe.scroll(x, y, dir)`, `probe.drag(from, to)`: **every mouse behavior is testable in
the same deterministic workflow suite as keys.** That is the whole trick: pointer support
with wm-grade rigor instead of view-layer event soup.

### The ladder (each rung ships alone, keyboard-parity proven)

#### H1 (1pt): Click-to-focus + wheel scroll
Click any pane → focus (the `focus.*` action by another door). Wheel over a pane routes as
`up`/`down`-equivalent scrolling to that pane *without* changing focus (hover-scroll, the
single most game-feel win in a tiling TUI).
**Accept:** probe tests: click focuses, wheel scrolls a non-focused file pane, focus
unchanged.
**Strategy:** `OWN`.

#### H2 (1pt): Overlay rows: click + hover
Palette/help (and future popup menus): hover (`over`/`out`) moves the selection highlight,
the same `paletteIndex` the arrows drive; click runs the row; click outside dismisses
(= `Esc`).
**Accept:** probe tests: hover sets index, click executes, outside-click closes; arrows
and hover fight cleanly (last input wins).
**Strategy:** `OWN`.

#### H3 (2pt): Split ratios *(keyboard feature; drag prerequisite)*
`divide()` is hard-coded 50/50 today. Add `ratio` to split nodes with min-size clamping,
plus keyboard resize verbs (`leader shift+,/.`-family, sticky like the dock verbs), the
C8 "resize verbs" option, now motivated. Persist ratios in the Track P workspace file.
**Accept:** property tests: gapless/overlap-free invariant holds at any ratio; clamping;
zoom→unzoom byte-identical with ratios.
**Strategy:** `OWN`.

#### H4 (2pt): Border drag-resize
Hit-test a 1-cell grip along split boundaries; `drag` adjusts the H3 ratio live;
`drag-end` commits. Cursor-style hint via OpenTUI `MousePointerStyle` where supported.
**Accept:** probe drag tests over fixture layouts incl. nested splits and the dock edge
(dock ratio joins the same mechanism).
**Strategy:** `OWN`.

#### H5 (3pt): Pane drag: swap and dock *(the Hyprland borrow, semantics only)*
Drag a pane by its title row: drop on another pane → `swap` (its existing action); drop on
a screen edge → dock to that side; a drop-target highlight (border emphasis on the
candidate) renders during the drag. This is Hyprland's grab-and-relocate *feel*,
reimplemented from observed behavior, never source.
**Accept:** probe drag workflows for swap, dock-left, dock-right, and cancel (`Esc` or
drop-in-place); highlight state visible in snapshots.
**Strategy:** idea-level reference only; `OWN` implementation.

#### H6 (1pt): Terminal reality pass *(merge into Track L)*
Mouse-protocol validation on Windows Terminal + kitty/alacritty/foot: SGR availability,
scroll granularity, drag event cadence, and a config escape hatch: one option,
`pointer: "on" | "off"` (schema justification: terminals with broken mouse reporting, and
users who want native text selection back; `off` must cost zero).
**Accept:** findings recorded in `docs/windows.md` / Linux notes; `pointer: "off"` leaves
the terminal's native selection untouched.
**Strategy:** `OWN`.

### Refused (on purpose, per the simplicity budget)

- No hover tooltips or hover-revealed information: state is legible or it is redesigned.
- No clickable chrome glyphs (close buttons, tab strips): chrome stays clean; verbs stay
  on keys, click-to-focus covers targeting.
- No drag text-selection layer competing with the terminal's own: `pointer: "off"` is the
  answer, not a reimplementation.
- No double-click semantics: nothing in the grammar needs a timing-sensitive gesture.

## Sequencing

1. **C29 → C30 → C32** is the browser's critical path (C31 rides the dock engine same
   week; C33 second pass).
2. **H1 + H2** land first and cheap; they prove the `handleMouse` spine on real terminals.
3. **H3** ships as a keyboard feature on its own merit; **H4** then **H5** follow behind
   it. **H6** folds into Track L's terminal pass.

Browser and pointer lanes are disjoint files end-to-end (`browser-*` vs `app-core`/`layout`),
safe for parallel agents, probe workflows as the merge gate, per the iteration-3 doctrine.

**Exit criteria:** browse the repo, open three files into tiles, and rearrange them,
entirely from the keyboard; then do the same session with one hand on the mouse where it's
honestly faster (click focus, wheel scroll, hover-pick a palette row, drag a border), and
find that nothing, anywhere, *required* the mouse.
