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

## Landed 2026-08-16, provider-onboarding wave (deltas vs. Pi/OpenCode)

A comparison of `keywork setup` against Pi's and OpenCode's OpenAI onboarding surfaced
three deltas; all three are addressed. **This amends A14's strategy line** ("no OAuth of
any kind"): that line was guardrail hygiene around the Anthropic rule, not an OpenAI
product decision. The Anthropic guardrail is untouched — `check-guardrails.ts` was not
weakened and still passes; it scopes to Anthropic/Claude endpoints and headers, which is
exactly why OpenAI subscription sign-in can land without going near it.

- **Credentials moved out of config.** `~/.keywork/auth.json` (0600, dir 0700) now holds
  provider credentials as a tagged union (`api_key` | `oauth`), written by `keywork
  setup`; `keywork.json` `apiKeys` is honored as a legacy fallback but no longer written.
  Config stays shareable without shipping keys (`packages/cli/src/auth-store.ts`).
- **Precedence flipped to stored-owns-the-provider.** Deliberate credentials (a
  `KEYWORK_`-scoped variable or anything saved by setup) outrank ambient environment
  variables across all providers, so a stale `OPENAI_API_KEY`/`OPENROUTER_API_KEY` in a
  shell profile can no longer hijack a provider the user just connected. Ambient env
  remains the zero-config fallback. Matches Pi ("a stored credential owns the provider")
  and OpenCode's merge order.
- **OpenAI via ChatGPT Plus/Pro subscription sign-in** as a separate `openai-codex`
  provider (Pi's shape, so the plain API-key provider stays clean): PKCE browser flow
  with a localhost:1455 callback plus a device-code flow for SSH, token refresh with
  5-minute skew persisting through the auth store, and requests to
  `chatgpt.com/backend-api/codex/responses` carrying `originator: keywork` (honest
  client identification; the shared Codex client id is the openly tolerated norm —
  OpenCode and Pi both ship it). ADAPT:pi (`codex-login.ts`), attribution in `NOTICE`.
  Engine grew a Responses-API provider (`OpenAiResponsesProvider` + `responses-wire.ts`)
  since the codex backend speaks only that surface, including encrypted-reasoning
  round-trip via a new `redacted-thinking` turn delta (required: the backend rejects a
  `function_call` input item whose reasoning item is missing). Default model `gpt-5.5`.

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

## Landed 2026-08-16, third wave

- **FR3.9 — per-entity trays.** New `pane-tray.ts`: `PaneTrayModel` (open on `/` or `:`,
  fuzzy filter over `fuzzyScore`, arrow/tab wrap, enter runs, esc closes, modal while
  open) + `paneTrayView` rendering through the same `tray.ts` row primitive as the chat
  tray and palette. Sessions node trays are level-scoped (overview: open/entries/refresh;
  entries: fork/label/toggle/back/refresh) and their commands literally press the pane's
  own keys, so tray and keyboard can never disagree; the MCP tray acts on the cursored
  server (restart, enable/disable, tools, refresh) and reveals its menu so the outcome is
  visible. Tray never opens while a label is being typed. Known gap: tray rows are not
  yet clickable (H2 grammar — noted in [`94`](94-file-browser-and-mouse.md)).
- **FR3.10 — command coverage audit.** Every `appActions` entry now structurally requires
  either a `command` declaration or a `coveredBy: <registered command>` (the type refuses
  an uncovered action); `actionCommandNames` exports the map and
  `command-coverage.test.ts` proves, in a fully equipped app, that every nav-mode action
  resolves to a registered command, every declared command runs, and names/aliases are
  collision-free.
- Fixed the red `scenarios.test.ts` assertion (`toHaveProperty` dotted-path trap:
  `"notes.txt"` needs the array form).
- **Live mouse regression root-caused and fixed** (Jordan's "no mouse input at all"):
  keywork's destroy-every-frame painting left OpenTUI's hit grid pointing at dead
  renderable ids, so every event was dropped before dispatch. Fixed with the persistent
  **pointer plane** + move-event repaint gating; full write-up and the forward mouse-UX
  plan live in [`94`](94-file-browser-and-mouse.md) § "State of mouse input". The e2e
  stage gained real mouse verbs and the `pointer-tour` scenario locks delivery
  (click-focus after rebuilds, wheel scrollback, dock drag) through the real renderer.

## Landed 2026-08-16, fourth wave (three parallel agents, gate 1484 tests / 97 files + 7/7 e2e)

- **J17 + J18 arc kernel** (`engine/src/memory/arcs/`): per-arc sub-vault with MOC-as-entity,
  full lifecycle (bind ≤1 per session, fork inheritance, archive-in-place, never deletes),
  boosted recall stratum composed over the search API (workspace hits never masked; other
  live arcs ambient-excluded; archived excluded), question cap with explicit merge-or-drop,
  and the airlock as the fourth door on the ONE inbox: ack sweep → arc-scoped Gardener →
  resolve/carry/drop triage (nothing implicit; below-bar delivery refused) → `delivered:`/
  `valid_from:`/`distilled_from:` stamps + workspace delivery record → stragglers re-staged
  untrusted. Deferred behind seams: session-entry binding persistence, real flush wiring,
  TUI surfaces.
- **J13 + J12 recall depth**: citation ledger (claim → note → provenance → supersession,
  R6 hallucinated-id rejection, citations = the F2 usefulness signal, F3 latency medians);
  vault-derived in-memory graph (closed 9-type/16-predicate ontology, `consolidates` pair
  distinct from supersession) with entity-seeded PPR (LIFT:hipporag, NOTICE) as the third
  RRF leg — self-muting to byte-identical two-leg behavior, superseded floor held
  post-fusion, local 1–2-hop outlines only; memory-pane recall/Gardener view helpers.
- **FR4.12 cost capture**: integer nano-dollar pricing table (no Anthropic ids; scanner
  clean), cache-aware math, provider-metered cost (OpenRouter `usage.cost`) beats
  estimates, unknown never renders `$0.00`; per-session rollups derived on read +
  `groupCosts` seam for arcs; pane-title `$`, sessions-node row cost, conversation-local
  `/cost`; sessions now persist live usage (replay-filtered). Provisional rates flagged in
  the module; `model_change` wiring open (table-estimated rollups on disk light up for
  metered sessions only until then).

Still open in FR1–FR6: FR1.2 endurance soak, FR2 entity nodes (arcs node now unblocked by
J17), FR3 per-entity trays for the future arcs/workspaces nodes (sessions + MCP shipped),
FR4.11 ChatGPT provider (ToS gate first), FR5 chroma/tastiness/tips (arc edge chroma now
unblocked), FR6 LSP/subagent transparency/security scoping.

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

11. **(3pt, ADAPT:pi) — LANDED 2026-08-16** in the provider-onboarding wave above (the
    source became Pi rather than OpenClaw after a code-level survey of Pi's and
    OpenCode's flows). **Gate decision of record (Jordan, 2026-08-16): proceed.** Pi and
    OpenCode both openly ship the Codex OAuth flow with the shared client id and honest
    originator headers, and OpenAI has tolerated that posture; keywork identifies itself
    as `originator: keywork` and ships this OpenAI-only. The Anthropic guardrail is
    untouched: no Anthropic subscription path ever ships.
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
