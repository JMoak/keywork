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

## Scoping (options-first, per the 98/100 rules; nothing below is built)

### C70 · cycle arc (the arc stage) · 3pt + 1pt captures · `OWN`

**Jordan's ask.** "A 'cycle Arc' key in the navigation that's not a high priority key that
fits. That would move all sessions as a grouped sick looking entity that keeps their
uniqueness for selection intact as well."

**Reading.** Arcs are the *when* axis, but the main area is still one flat tiling of every
session regardless of arc. Cycling an arc should bring one arc's sessions forward *as a
group*: the group reads as one entity (one hue family, one motion), each member stays its
own pane (own title, own micro-gradient, own focus, still reachable by `ctrl+p`).

**Design: the stage is a visibility mask, not a second tree.** The main tree stays the one
tree. A stage is a filter over its leaves: `all` (today's view), then one stage per active
arc in creation order, then `no arc`, then back to `all`. Cycling to `#dock-v2` hides every
main-area leaf not bound to dock-v2; hidden leaves collapse and their siblings take the room
(the dwindle layout already does this for removals); returning to `all` restores everyone
in place. No per-stage arrangements to persist, no second layout model, and `split` inside a
stage inherits the stage's arc, so new panes land where the eye is. Docks are never
filtered (tree, arcs node, memory, MCP are cross-arc by nature). Zoom composes as today.

- **Keys.** `leader ]` next stage, `leader [` previous, both sticky (`ctrl+k ] ] ]` walks
  three arcs). Commands `/stage next|prev|all|<slug>`; `/arc stage` from the arcs node row
  (`enter` on an arc row with `shift` held is a later nicety, keyboard first).
- **Group identity.** Members already share the arc's golden-angle anchor with a
  micro-gradient (C45), so a staged group reads as one hue family; uniqueness survives in
  the micro-gradient, the title, and focus. Status chip becomes the stage readout while
  staged: `#dock-v2 · 2 of 3 arcs` (nothing new on `all`). The arcs node lights the staged
  arc's row in its hue.
- **Motion (PD16, ink only).** Geometry snaps. Incoming members' borders rise ░→▒→▓→█ in the
  arc hue over `quick`; outgoing members just disappear. The whole main area is one region,
  the group rise is its one mover; any key settles it.
- **Focus and jump.** Focus on a hidden pane moves to the stage's most recently focused
  member (else the first). `ctrl+p` still lists every pane; jumping to a hidden one raises
  its stage first, then focuses it. `hjkl` traverse visible leaves only.
- **Persistence.** `WorkspaceState` gains `stage?: "all" | { arc } | "unbound"`; restore
  re-applies it if the arc still exists, else `all`.
- **Open decisions (Jordan).** (a) `]`/`[` versus `leader tab`; (b) whether `split-arc`
  from inside a stage should jump to the new arc's stage (recommended: yes, the eye follows
  the new work) or stay; (c) whether `no arc` deserves a stage (recommended: yes, it is how
  you find strays).
- **Acceptance.** e2e `arcs` scenario extension at 160×40: two arcs + one unbound pane;
  cycle all → dock-v2 → arc-2 → no arc → all with a capture each; chip text; jump to a hidden
  pane raises its stage; persisted stage restores after a relaunch; tier-0 render identical
  minus hue. Unit: `Layout.stage(filter)` rects/focus/traversal, stage ordering, restore.

### C71 · pins for docked panes · 2pt · `OWN`

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

### C72 · the memory browser · 3pt skeleton + 2pt ledger lens · `OWN`

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

## Flags for Jordan

- `/init`'s reopen rides the same in-process relaunch `/workspace` uses (destroy renderer,
  compose again). 110 flagged it unverified on a live terminal; `/init` is now the first
  everyday path through it, so one live run on Windows Terminal decides whether the fallback
  ("reopen keywork yourself, trust is saved") is needed.
- Memory pane is offered in every trusted workspace now, empty until the vault exists; if
  that reads as clutter in the discovery goldens later, gate it on readiness instead.
- `/connect` cannot do the ChatGPT subscription sign-in (browser/device flow); the terminal
  `keywork connect` still can. The targets screen does not mention it yet.
- Chords proposed above (`]`/`[`, `leader i`) are candidates, not decisions.
