# File Browser & Calculated Mouse — Design Lanes

> Planning overlay, 2026-08-10. Where this file speaks for its two lanes it wins; elsewhere
> [`92-iteration-3.md`](92-iteration-3.md) → 91 → 90 → workstream files apply. IDs continue
> the C-series (browser is TUI work) and open the **H-series** (pointer input).
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing before
> workstream G; Pi/OpenCode are MIT — adapt with attribution in `NOTICE`; Crush is FSL —
> never a source (no code, no design credits since 2026-08-10). Hyprland is referenced for
> *interaction semantics only* — no
> source consulted or ported. The user commits; agents never `git commit`/`git push`.

## Ledger (2026-08-10, 200 tests / 20 files green)

| ID | Status | Landed as |
|---|---|---|
| C29 | **done** | `BrowserModel` + 19 unit tests; lazy per-dir reads, path-anchored cursor, `/`-initiated filter over `fuzzyScore`, property test on cursor visibility. |
| C30 | **done** | `BrowserPane`; `/browse [dir]` (alias `/files`), `leader f` summon-or-focus, files open via `PaneIntents` into the main area. |
| C31 | **done** | `/browse` opens docked (existing dock side, else left); expansion state deliberately not persisted. |
| C32 | **done** | `PaneIntents` (`openFile`/`focusPane`) on `AppCore`, injected into browser factory; `/open <dir>` redirects to the browser via injectable `isDirectory`. |
| C33 | open | second pass as specced. |
| H1, H2, H3 | **done** | `AppCore.handleMouse` spine + `pointer.ts`; overlay frames as shared pure functions; split-node `ratio` with min-size clamping, `leader shift+./,` resize verbs, `grow`/`shrink` commands; probe `click`/`hover`/`scroll`. |
| H4–H6 | open | H4 must account for the ~1-cell chrome offset between `layout.rects` and the bordered render (flagged in H1 work). |

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

## Why now

`FilePane`/`FileModel` landed with `/open <path>` (C11 partial). The natural next rung is
opening *directories* — a browser pane that feeds file panes. Simultaneously the product
bar has been raised: keywork should feel like **terminal-video-game-grade software** —
instant, spatial, legible — which means light, deliberate pointer support for the moments
where a pointer is honestly the best instrument (overlay row selection, pane focus, border
drag). Both lanes ride the same architectural spine: pure models + `AppCore` routing +
probe-harness determinism.

## Principle check (before any code)

[`ux-principles.md`](../ux-principles.md) P1 and the §4 refusal *"No mouse-required or
mouse-first features — mouse support may exist as garnish only"* remain binding and are
**not** revised by this document. Everything in lane H maps 1:1 onto an existing keyboard
action; the mouse adds a second door, never a new room. Review question on every H PR:
*"delete the mouse handler — is any capability lost?"* The answer must be no.

---

## Lane C-FB — Directory / file browser

### The shape

One new pure model + one thin pane, mirroring the `FileModel`/`FilePane` and
`ConversationModel`/`ConversationPane` pattern exactly:

- **`BrowserModel`** — a lazily-expanded directory tree: cursor row, expand/collapse state,
  dirs-first + alpha ordering, hidden-file toggle, type-to-filter. Pure state machine over
  an injected `readDirectory(path) → Entry[]` so tests never touch the real fs unless they
  want to. Windowed rendering via the `visibleLines(rows)` idiom — no full-tree realization,
  no recursive scans, expansion reads one directory at a time.
- **`BrowserPane`** — renders the model; selection bar, `▸/▾` affordances, dim-styled
  hidden entries, count-in-title (` · 42 entries`), same rounded-border chrome as every pane.

Ranger-style Miller columns are rejected: the tiler *is* the second column — Enter opens a
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

#### C29 (2pt) — `BrowserModel`
Pure tree model as above. Filter is a subsequence match over the visible (expanded) set,
consistent with the palette's matcher. Cursor survives refresh and collapse (clamps to
nearest surviving row).
**Accept:** unit tests for expansion laziness (a dir is read exactly once until refresh),
cursor clamping, filter, hidden toggle; property test — any op sequence keeps cursor on a
visible row.
**Strategy:** `OWN`.

#### C30 (2pt) — `BrowserPane` + `/browse [dir]` + summon
Pane over the model; `/browse` (default cwd) opens it; summon chord (`leader f`) focuses an
existing browser instead of duplicating — this lands the C11 "summon-per-type" gap for its
first type. Opening a file routes through a **`PaneIntents`** surface (see C32).
**Accept:** probe workflow — `/browse`, navigate, Enter on a file yields a focused
`FilePane`; summon-or-focus tested; `/open <dir>` redirects to the browser instead of
failing with `EISDIR`.
**Strategy:** `OWN`.

#### C31 (1pt) — Dock-native default
The browser's natural home is the dock: `/browse` opens docked-left by default (undock verb
already returns it to the main tree). Workspace persistence (Track P) records browser panes
like any other: type + root path.
**Accept:** probe workflow — browse → restart-shaped snapshot round-trip keeps dock side,
root, and expansion state is *not* persisted (fresh read on restore, by design).
**Strategy:** `OWN` on the dock engine.

#### C32 (1pt) — `PaneIntents`
Small capability object passed to pane factories: `openFile(path)`, `focusPane(id)` —
the sanctioned way any pane asks the app to open another pane. Replaces the current
private-method reach and is the seam the session-tree pane (C13) and diff pane (C14) will
need anyway.
**Accept:** browser and `/open` both route through it; a toy pane in tests opens a file
pane without touching `AppCore` internals.
**Strategy:** `OWN`.

#### C33 (2pt) — Repo-aware polish *(second pass; not blocking)*
`.gitignore`-aware dimming (not hiding) via a fast ignore matcher; palette "files" section
(the C26 gap) fuzzy-jumping over a bounded index built from the same `readDirectory`;
fs-watch refresh with debounce.
**Accept:** ignored entries render dim; palette file-jump probe test; watch debounce unit
test.
**Strategy:** `LIFT:pi` ignore-handling if their walker fits (`NOTICE` line); else `OWN`.

---

## Lane H — Calculated pointer support

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
`probe.scroll(x, y, dir)`, `probe.drag(from, to)` — **every mouse behavior is testable in
the same deterministic workflow suite as keys.** That is the whole trick: pointer support
with wm-grade rigor instead of view-layer event soup.

### The ladder (each rung ships alone, keyboard-parity proven)

#### H1 (1pt) — Click-to-focus + wheel scroll
Click any pane → focus (the `focus.*` action by another door). Wheel over a pane routes as
`up`/`down`-equivalent scrolling to that pane *without* changing focus (hover-scroll, the
single most game-feel win in a tiling TUI).
**Accept:** probe tests — click focuses, wheel scrolls a non-focused file pane, focus
unchanged.
**Strategy:** `OWN`.

#### H2 (1pt) — Overlay rows: click + hover
Palette/help (and future popup menus): hover (`over`/`out`) moves the selection highlight —
the same `paletteIndex` the arrows drive; click runs the row; click outside dismisses
(= `Esc`).
**Accept:** probe tests — hover sets index, click executes, outside-click closes; arrows
and hover fight cleanly (last input wins).
**Strategy:** `OWN`.

#### H3 (2pt) — Split ratios *(keyboard feature; drag prerequisite)*
`divide()` is hard-coded 50/50 today. Add `ratio` to split nodes with min-size clamping,
plus keyboard resize verbs (`leader shift+,/.`-family, sticky like the dock verbs) — the
C8 "resize verbs" option, now motivated. Persist ratios in the Track P workspace file.
**Accept:** property tests — gapless/overlap-free invariant holds at any ratio; clamping;
zoom→unzoom byte-identical with ratios.
**Strategy:** `OWN`.

#### H4 (2pt) — Border drag-resize
Hit-test a 1-cell grip along split boundaries; `drag` adjusts the H3 ratio live;
`drag-end` commits. Cursor-style hint via OpenTUI `MousePointerStyle` where supported.
**Accept:** probe drag tests over fixture layouts incl. nested splits and the dock edge
(dock ratio joins the same mechanism).
**Strategy:** `OWN`.

#### H5 (3pt) — Pane drag: swap and dock *(the Hyprland borrow — semantics only)*
Drag a pane by its title row: drop on another pane → `swap` (its existing action); drop on
a screen edge → dock to that side; a drop-target highlight (border emphasis on the
candidate) renders during the drag — Hyprland's grab-and-relocate *feel*, reimplemented
from observed behavior, never source.
**Accept:** probe drag workflows for swap, dock-left, dock-right, and cancel (`Esc` or
drop-in-place); highlight state visible in snapshots.
**Strategy:** idea-level reference only; `OWN` implementation.

#### H6 (1pt) — Terminal reality pass *(merge into Track L)*
Mouse-protocol validation on Windows Terminal + kitty/alacritty/foot: SGR availability,
scroll granularity, drag event cadence, and a config escape hatch — one option,
`pointer: "on" | "off"` (schema justification: terminals with broken mouse reporting, and
users who want native text selection back; `off` must cost zero).
**Accept:** findings recorded in `docs/windows.md` / Linux notes; `pointer: "off"` leaves
the terminal's native selection untouched.
**Strategy:** `OWN`.

### Refused (on purpose, per the simplicity budget)

- No hover tooltips or hover-revealed information — state is legible or it is redesigned.
- No clickable chrome glyphs (close buttons, tab strips) — chrome stays clean; verbs stay
  on keys, click-to-focus covers targeting.
- No drag text-selection layer competing with the terminal's own — `pointer: "off"` is the
  answer, not a reimplementation.
- No double-click semantics — nothing in the grammar needs a timing-sensitive gesture.

## Sequencing

1. **C29 → C30 → C32** is the browser's critical path (C31 rides the dock engine same
   week; C33 second pass).
2. **H1 + H2** land first and cheap — they prove the `handleMouse` spine on real terminals.
3. **H3** ships as a keyboard feature on its own merit; **H4** then **H5** follow behind
   it. **H6** folds into Track L's terminal pass.

Browser and pointer lanes are disjoint files end-to-end (`browser-*` vs `app-core`/`layout`)
— safe for parallel agents, probe workflows as the merge gate, per the iteration-3 doctrine.

**Exit criteria:** browse the repo, open three files into tiles, and rearrange them —
entirely from the keyboard; then do the same session with one hand on the mouse where it's
honestly faster (click focus, wheel scroll, hover-pick a palette row, drag a border) — and
find that nothing, anywhere, *required* the mouse.
