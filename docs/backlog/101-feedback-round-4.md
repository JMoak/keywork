# Feedback Round 4 — Live-Use Findings & Direction (2026-08-16)

> Authoritative overlay, 2026-08-16, from Jordan's live-use feedback session. Where this
> file speaks it wins; where silent, [`99`](99-workspace-and-modes.md) →
> [`98`](98-chroma-and-arcs.md) → [`97`](97-product-direction.md) → earlier overlays as
> chained there.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing
> before workstream G; Pi/OpenCode/OpenClaw are MIT — adapt with attribution in `NOTICE`;
> Crush is FSL — never a source. Hyprland is **behavior reference only** (GPL): study the
> feel, never the source. The user commits; agents never `git commit`/`git push`.

## Landed in this pass (2026-08-16)

- **Crash containment for the input path.** Every keypress/paste/mouse handler and the
  frame builder run behind guards; failures append a stack to `~/.keywork/tui-crash.log`
  and surface a status notice instead of killing the terminal. Renders coalesce to one
  rebuild per tick, so key bursts no longer stack full-tree rebuilds. Process-level
  uncaught/rejection handlers log and survive; a crash storm (20 in 5s) tears down
  cleanly instead of wedging. Next crash report should come with a stack from the log.
- **Dock1 · Main · Dock2 is now structural.** The main area is always carved between the
  docks; when nothing lives there it renders as a calm idle panel (with the keys to fill
  it) rather than letting docks swallow the screen. Docks clamp to a sane minimum width,
  can go much narrower than before, and resize by dragging their boundary column with
  the mouse — `,`/`.` remain for keyboard resize.
- **Hyprland-style move on `H/J/K/L` in nav.** In main: swap with the neighbor, push
  into the adjacent dock at the matching height, or promote to the screen edge when
  nothing blocks. In a dock: `J/K` reorder the stack, inward `H/L` re-enters main at the
  near edge. `D/U` chords are gone; `C` cycles main → left → right → main, and
  `/dock-left` `/dock-right` `/undock` remain as commands.
- **Session titles persist.** The one-shot LLM title now writes through to the session
  store (`setName`), so the pane, the sessions node, and the next launch all agree; a
  restored session adopts its stored name instantly and skips re-titling.
- **Click a session row to reach its chat.** Overview click focuses the open pane or
  attaches-and-opens; entries-level click moves the cursor.
- **Fresh-start default layout.** No persisted state → sessions node docked left, one
  session in main, MCP node docked right, chat focused (the OpenCode-familiar shape,
  fully reshapeable). Persisted state now rules completely — furniture is no longer
  force-re-added on every start.

## Landed 2026-08-16, second wave

- **FR1.1 — pane drag with rectangular drop previews.** Dragging a pane's title row lifts
  it; a ghost rect previews the landing geometry for main↔main swaps, dock insertion
  slots (band-per-slot, exact landing rect), dock↔dock moves, and the empty-main return.
  Drop routes through `Layout.dropTargetAt`/`applyDrop`, which reuse the same
  swap/remove/insert primitives as the keyboard verbs, so mouse and keyboard can never
  disagree; every target is fits-checked, so an impossible drop simply shows no preview.
  Landing this surfaced a latent geometry defect: `growDock` could squeeze the main area
  below its tree's minimum width because column carving only ever reserved one pane's
  minimum — the carve now reserves the live tree's true minimum, and the layout fuzz walk
  gained a random drag-drop branch that holds the exact-tiling invariant.
- **FR3.8 — one command tray grammar.** New `tray.ts` row primitive (marker · aligned
  name column · description · right-aligned shortcut); the slash suggestions under the
  prompt render as a bordered tray and the palette renders from the same rows, so the two
  surfaces cannot drift apart visually. Goldens regenerated.
- **FR1.3 — `/doctor`.** Opens `~/.keywork/tui-crash.log` in a file pane at its tail
  (the file viewer gained home/end jumps and an open-at-end seam), or posts a calm
  notice when nothing has crashed. Alias `/crashlog`.

Still open in FR1–FR6: FR1.2 endurance soak, FR2 entity nodes, FR3.9/3.10 per-entity
trays and the coverage audit, FR4 providers & cost, FR5 chroma/tastiness/tips, FR6
LSP/subagent transparency/security scoping.

## FR1 — Interaction depth (drag, previews, endurance)

1. **(3pt, OWN)** **Drag panes in main and docks.** Building on the boundary-drag
   plumbing (`AppCore.routeDockResize` shows the shape): dragging a pane's title bar
   lifts it; while lifted, render a **rectangular drop preview** — the ghost rect of the
   landing geometry (Hyprland/WM-style) — for main↔main, main↔dock, dock↔dock, and
   dock-reorder targets. Drop applies the same `Layout.move`/insertion primitives the
   keyboard uses, so keyboard and mouse can never disagree about semantics. Hit-test on
   `down` over a pane's top border row; `drag` updates the preview target; `up` commits.
2. **(2pt, OWN)** **Agent runtime endurance.** The crash journal is in; now make
   days-long sessions boring: sweep every floating promise in engine/agent paths into
   the journal, add a soak test that replays thousands of turn/tool events through a
   pane, and audit reconnect paths (MCP, provider streams) for silent-death states that
   currently need a restart.
3. **(1pt, OWN)** **Crash log surfacing.** `/doctor`-style command that tails
   `~/.keywork/tui-crash.log` into a pane so field reports don't require filesystem
   spelunking.

## FR2 — Entity nodes: sessions, arcs, workspaces, MCP

4. **(2pt, LIFT:opencode)** **MCP node to OpenCode caliber.** The MCP pane exists;
   bring it to the character of the sessions node: per-server liveness marks, tool
   counts, enable/restart inline, and its own command tray (FR3). OpenCode's MCP
   presentation is the reference — adapt with attribution.
5. **(3pt, OWN)** **Arcs node.** Same two-level shape as the sessions node but grouped
   by arc, with the arc's chroma as the group rule and an ASCII treatment that earns the
   "world-class" bar (arc glyph rail, member sessions indented under a colored edge).
   Chroma tokens come from [`98`](98-chroma-and-arcs.md).
6. **(2pt, OWN)** **Workspaces node.** Third sibling: workspaces with focus dirs, MRU,
   and open-session counts per [`99`](99-workspace-and-modes.md)/PD11. Activate = switch
   workspace (confirm when it would retire live panes).
7. **(1pt, OWN)** **Node color pass.** Sessions/arcs/workspaces/MCP share one restrained
   accent grammar: liveness marks colored, titles neutral, arc tags in arc chroma; the
   selected row keeps the inverted-accent bar. One place (`theme.ts`) defines it.

## FR3 — Command surface

8. **(2pt, OWN)** **Command tray in chat.** The slash suggestions under the prompt
   become a proper tray: bordered, column-aligned (name · description · shortcut),
   arrow/tab navigation, and shown for `/` in any conversation pane. The palette and
   tray render from the same row primitive so they can't drift apart visually — this is
   also the fix for "slash visuals are ugly."
9. **(1pt, OWN)** **Per-entity trays.** Sessions/arcs/workspaces/MCP nodes each get a
   `:`-or-`/` tray scoped to their commands (rename, fork, retire, restart…), same
   visual grammar as the chat tray.
10. **(2pt, OWN)** **Command coverage audit.** Every built behavior reachable as a
    command: focus by direction, move by direction (done: `/push-*`), zoom, dock
    width by side (done), preset, tree/memory/mcp summons (done), plus gaps found by
    walking `appActions` and pane keymaps. Acceptance: a keyboard-free session can do
    everything nav mode can.

## FR4 — Providers & cost

11. **(3pt, LIFT:openclaw)** **ChatGPT-subscription provider.** Goal: a paid ChatGPT
    plan (Plus/Pro) drives keywork the way OpenClaw wires it. **Gate before code:**
    verify the current OpenAI ToS posture for Codex OAuth outside official surfaces and
    record the decision in this file; prefer the official Codex mechanisms and adapt
    OpenClaw's MIT implementation with attribution. The Anthropic guardrail is
    untouched: this is OpenAI-only, and no Anthropic subscription path ever ships.
12. **(2pt, LIFT:opencode)** **Cost capture.** Per-turn token/cost accounting like
    OpenCode's: model pricing table, per-session and per-arc rollups, surfaced in the
    pane title detail (replacing the raw `in▸out` counters), the sessions node cursored
    row, and a `/cost` command.

## FR5 — Craft & visual identity

13. **(2pt, OWN)** **Arc edge chroma.** An arc's color applies to the pane's outer
    borderline — full-strength when focused, dimmed-but-legible when not (extend
    `pane-chrome.ts` border color resolution: arc chroma ⊕ focus state). This is the
    visible answer to "arcs need to be clearly defined in the interfacing."
14. **(2pt, OWN)** **Design tastiness pass.** One deliberate sweep with
    [`design-language`](../design-language.md) + [`100`](100-visual-craft.md): status
    bar rhythm, overlay spacing, idle-main composition, glyph vocabulary (░▓█·▸), and
    the two-or-three accent moments per screen that make minimalism feel intentional
    rather than absent.
15. **(1pt, OWN)** **Tips, TUI-native.** A single rotating one-liner in the idle-main
    panel and post-quiet status bar (never a modal, never on hot paths), sourced from a
    curated list keyed to features the workspace hasn't used yet. Kill switch in config
    with a `.describe()` justification.

## FR6 — Platform scope

16. **(3pt, LIFT:opencode)** **LSP the OpenCode way.** Adopt OpenCode's approach:
    auto-spawn servers per detected language, an LSP client surfacing diagnostics into
    the agent loop and hover/defs into tools. Scope the adaptation and record
    attribution; keep the client behind an engine port so the TUI stays dumb.
17. **(2pt, OWN)** **Subagent spawn transparency.** Spawning a subagent creates a
    session in the same arc, visible in the sessions/arcs nodes with a `↳ spawned by`
    lineage row, live progress mark, and the parent's transcript linking to it. No
    invisible children — this is the transparency contract for multi-agent work.
18. **(2pt, OWN)** **Enterprise security scoping doc.** Not code: a scoping document
    sizing what "enterprise platform standards" means for keywork — audit log, SSO/IdP,
    secret handling, sandbox/jail posture, update/supply-chain integrity, SBOM,
    disclosure policy — each with a rough point cost and a ship-tier (OSS default vs.
    enterprise build). Lands as `docs/research/enterprise-security-scope.md`.
