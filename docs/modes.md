# keywork Modes — Plan · Recall · Agent

> E7 spec, 2026-08-16, implementing [`backlog/99-workspace-and-modes.md`](backlog/99-workspace-and-modes.md)
> PD12 (with PD13.4's touchpoint). Where PD12 speaks this document implements it; where PD12
> was silent, decisions were taken here as **⟨PR-n⟩** and **reviewed by Jordan 2026-08-16**,
> with verdicts recorded in the decision index at the end (all approved; PR-2 amended in
> place). E5 (50-trust) is absorbed: its Plan agent is this Plan mode's floor, its `Tab` is
> `shift+tab`, its Build is Agent. Checked against the
> [`100-visual-craft.md`](backlog/100-visual-craft.md) overlay (PD14–PD17): no conflict; the
> presentation section cites its touchpoints. Every claim about existing code carries a
> file:line citation verified against the tree on 2026-08-16.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only; Pi/OpenCode are
> MIT (adapt with attribution in `NOTICE`); Crush is FSL and never a source. The user commits;
> agents never `git commit`/`git push`.

## The shape

A **mode** is a per-session narrowing lens over whatever agent the session runs: a toolset
restriction, a permission delta, and one system-prompt sentence. Nothing else. Modes only
ever *narrow*; Agent mode is the identity lens (zero delta, byte-identical to today).
**⟨PR-1⟩** Mode is an axis orthogonal to D6 markdown agents rather than a set of three
agents: a pane running a custom `reviewer` agent can still flip to Plan, and the two
narrowings compose stricter-wins. This keeps E5's machinery (per-agent `restrictTools` +
`narrowedPermissions`, `packages/engine/src/extensions/markdown-agents.ts:34-52`) as the
one narrowing mechanism in the codebase instead of adding a second.

The enforcement spine already exists and modes add no new authority path:

- The `Agent` resolves each tool call to `allow | ask | deny` via an injected
  `PermissionResolver` (`packages/engine/src/agent.ts:204`), falling back to
  `defaultPermission`: mutating ⇒ ask, else allow (`agent.ts:231-233`).
- `deny` reaches the model as a refusal tool result, `"denied by permission policy"`,
  `isError: true` (`agent.ts:205-207`). A declined ask reads `"declined by user"`
  (`agent.ts:208-210`). This is E5's "denied by config, not by prompt hope" bar, already met.
- Tools absent from the toolset are absent from the provider request (`agent.ts:166-171`),
  so the model cannot see them; a hallucinated call throws `ToolNotFoundError` and returns
  as an error result (`packages/engine/src/tools.ts:15-19`, caught at `agent.ts:214-217`).
- Composition precedent: `narrowedPermissions` merges an agent definition over a base
  resolver with strictness `allow < ask < deny` (`markdown-agents.ts:40-58`). Modes reuse
  `stricter` verbatim.

## Mode semantics

### The composition law

Effective bundle = **preset resolver ∘ agent narrowing ∘ mode narrowing**, stricter-wins at
every join:

- *Toolset:* `modeToolset ∩ agentToolset`, a set intersection over the composed tool list
  built in `packages/cli/src/main.ts:294-309` (core four + memory recall + skills + MCP
  surface).
- *Permissions:* `stricter(presetVerdict-or-agentNarrowed, modeVerdict)`: the mode layer
  wraps the resolver exactly as `narrowedPermissions` wraps it today
  (`main.ts:315-318`). The E2 preset stays the base (`packages/cli/src/presets.ts:27-39`
  rebinds it live); no mode can loosen what `careful` denies, and no `open` preset can
  loosen what Plan denies.
- *Prompt:* one mode section appended after the D2 core prompt and project/user sections
  (`packages/engine/src/prompt.ts:23-25` gains one optional trailing section). Agent mode
  appends nothing; the assembled prompt stays byte-identical to today's.

Mode bundles are code-shipped constants in the E2 presets' style
(`packages/shared/src/trust/presets.ts:10-14` is the model: plain data, readable in one
screen). No config surface to edit them in v1 (D9 discipline); the one config option modes
add is the default (below).

### Plan

*Purpose:* investigate and design at full reading power; mutate nothing.

| Axis | Delta |
|---|---|
| Toolset | `read`, `bash`, `memory_search`, `memory_get`, `skill`; `write`/`edit` and all MCP-mounted tools **removed from the list** |
| Permissions | `write: deny`, `edit: deny` (backstop for aliases); `bash`: **investigation allowlist, everything else denied** (rules below) |
| Prompt | `Mode: plan — read, search, and design. File-mutation tools are unavailable; only read-only investigation commands run, everything else will be refused. Deliver findings and a concrete plan. Switching to agent mode is the user's act alone.` |

**⟨PR-2⟩** Three edges decided here (bash posture **amended by Jordan, 2026-08-16**: the
original ask-always draft was too broad; Plan now runs a narrow allowlist and denies the
rest):

1. **bash stays, behind an investigation allowlist; outside it, deny rather than ask.** A
   Plan that cannot run `rg` or `git log` is decoration, but an ask on arbitrary commands
   makes the human the read-only filter. Jordan's call: too risky, keep it narrower. The
   mode bundle therefore carries its own bash rule set, evaluated with the **existing**
   glob machinery: same matcher, same most-literal-wins specificity, same
   chaining-character containment (`shared/src/trust/permissions.ts:16-28`; `mostSpecific`
   at `permissions.ts:30-36`; a command containing `` ; & | < > ` $ ( ) `` or a newline can
   only match deny rules, `permissions.ts:24-26`, so `rg foo; rm -rf .` falls to the
   blanket deny by construction, never rides an allow). The mode's verdict then composes
   stricter-wins with the preset/config layer as everywhere else: a config `deny` still
   denies inside the allowlist; a config `git *: allow` can never widen past the blanket.
   The defaults, each delete-tested:

   | Rule | Verdict | Why it earns its place |
   |---|---|---|
   | `rg *` · `grep *` | allow | the investigation workhorses; search never writes |
   | `ls` · `ls *` | allow | directory shape at a glance (two patterns because the glob literal `ls ` requires the space) |
   | `cat *` · `head *` · `tail *` | allow | file peeks where the `read` tool's ceremony isn't worth it |
   | `wc *` | allow | size/count answers ("how big is this module") for planning estimates |
   | `git status*` · `git log*` · `git diff*` · `git show*` · `git blame*` | allow | the read-only git quintet: history and provenance archaeology are planning's raw material; deliberately *not* `git *` |
   | `find *` | ask | enumeration is common but `-delete`/`-exec` make blanket allow wrong; one keystroke keeps it honest |
   | `tsc --noEmit*` · `bun test*` · `bun run check*` | ask | verification belongs in planning, but these execute project-defined code and can touch disk, so the human confirms each run |
   | `*` (everything else) | **deny** | the blanket: Plan's read-only claim is config, not hope; chained commands land here by the containment rule |

   The allowlist is **config-extendable, user layer only**: `modes.planBash` in the
   schema below merges over the defaults (same most-literal-wins resolution across the
   union; entries may say `allow` or `ask`, never `deny`, since global `permissions.bash`
   deny rules already win through `stricter` and belong there). The I12 alternative, a
   bash-less read-only toolset (Pi's `createReadOnlyToolDefinitions`,
   `backlog/92-iteration-3.md:156-158`), remains rejected as the default (it guts
   investigation) and remains the natural shape for *headless* plan runs if those ever
   exist.
2. **MCP tools are excluded from Plan's toolset.** Their mutation behavior is undeclared
   (`Tool.mutates` is optional, `engine/src/tools.ts:4`; MCP tools don't set it), and D1's
   deferred schemas mean we often know nothing but a name. A tool whose mutation behavior
   is unknown does not belong in a read-only toolset. Revisit when MCP tool annotations
   land.
3. **`skill` stays**: it only loads instructions (`engine/src/extensions/skills.ts:39`);
   anything a skill *does* still goes through gated tools.

### Recall

*Purpose:* the memory session: answer from the vault first; correct and prune it by
proposal, never by direct write.

| Axis | Delta |
|---|---|
| Toolset | `memory_search`, `memory_get`, `read`, `write`, `edit`; no `bash`, no `skill`, no MCP |
| Permissions | `bash: deny` (backstop); `write`/`edit` **vault-jailed**: any target outside the vault root resolves `deny`; inside the vault they resolve `allow`; no ask, because every Recall write lands staged (next section), so the gate would double-charge |
| Prompt | `Mode: recall — answer from memory first: search with memory_search before reading the repo. You may propose memory corrections or prunes by writing to the vault; every write becomes a staged proposal for the user's review, never a direct change. If a review finds nothing worth proposing, reply exactly NO_REPLY. Work outside memory needs agent mode.` |

`read` keeps its ordinary workspace confinement: checking a note's claim against the
actual file is the whole point of a correction session. Memory-search-first is prompt
posture; tool *ordering* is not enforceable by config and should not pretend to be. The
two enforceable clauses, no mutation outside the vault and no shell, live in config.

### Agent

Full capability behind the ordinary gate. No toolset delta, no permission delta, no prompt
section. `standard` preset defaults + `defaultPermission` still mean mutating tools ask
(`agent.ts:231-233`), which is why Agent is a safe config default (PD12.3).

### Outside-the-mode attempts

Three distinct surfaces, all already honest:

1. A tool absent from the toolset is invisible to the model; a hallucinated call returns
   `Unknown tool: write` as an error result (`tools.ts:15-19`, `agent.ts:214-217`).
2. A tool present but denied returns the `"denied by permission policy"` error result
   (`agent.ts:205-207`). The model continues the turn and can tell the user what it wanted.
3. A Recall vault-jail miss takes the same deny path, with the mode resolver's message
   naming the jail: `denied by permission policy (recall mode: writes outside the memory
   vault)`. One string, so the model can explain instead of retrying blind. *(Requires the
   deny result to carry the resolver's reason: today the string is fixed at `agent.ts:206`;
   the resolver return type grows an optional reason. M-1.)*

## Recall's proposal flow

PD12.1: corrections and prunes are approval-gated proposals riding the **existing** J-D4
staging + R3 one-inbox machinery. The seams, all landed:

- **Staging is structural** in the store: `.staging/` with content + metadata sidecars
  (`packages/engine/src/memory/store.ts:145`, `store.ts:426-427`), invisible to every read
  surface until `approve(stagedId)` / `discard(stagedId)` (`store.ts:281`, `store.ts:301`;
  invariants in [`memory.md`](memory.md)). Today only `provenance: "untrusted"` writes
  stage; **Recall adds a `stageAll` posture**: a session-context flag the write path
  honors so *every* durable memory write from a Recall session lands staged regardless of
  provenance, with its true provenance preserved in the sidecar. One flag on the landed
  kernel; no second pipeline.
- **One inbox**: staged items surface through the `ReviewInbox`
  (`packages/engine/src/memory/inbox.ts:65-121`; dedupe by semantic key at
  `inbox.ts:79-98`) at `.staging/inbox.json` (`packages/cli/src/memory.ts:43`), rendered
  in the memory pane with the `░n` counter (`packages/tui/src/memory-pane-model.test.ts:232`)
  and drained at the P3 doors. Recall proposals are ordinary rows there: no fourth-door
  ceremony, no new surface.
- **Prunes are supersessions and discards; nothing is deleted**: a prune proposal stages a
  supersession or a retire against the target note (the inbox's existing
  `supersession-proposal`/`merge-proposal` vocabulary, `inbox.ts:22-23`); J-D4's protected
  core and the never-delete posture hold unchanged.

**The in-pane approval prompt** (immediacy, PD12's "approval-gated" made cheap): when a
Recall write stages, the conversation pane raises the existing ask overlay machinery,
`pendingAsk` with the diff window and single-key answers
(`packages/tui/src/conversation-model.ts:159-183`, `conversation-model.ts:560-572`),
showing the staged diff:

- **`y`/`enter`** → `store.approve(stagedId)`: the note lands with its recorded
  provenance, ledger-revertable as any write (P7).
- **`n`/`esc` = decline** → **⟨PR-3⟩ the item stays staged in the inbox**: decline means
  "not now" rather than "never"; the inbox is the record and `░n` increments. Discard is a
  deliberate act taken in the memory pane (`d` on the row), never a reflex key on an
  overlay.
- The tool result the model sees is the same in both cases:
  `staged proposal ‹id› — awaiting review`. The model never learns mid-turn whether the
  human approved; its plan cannot fork on an approval race.

**NO_REPLY**: when a review turn finds nothing to propose, the prompt instructs replying
exactly `NO_REPLY`, reusing the flush contract (`packages/engine/src/memory/flush.ts:11`,
`flush.ts:82`), including its render rule: a bare `NO_REPLY` reply is recorded in the JSONL
for honest replay and suppressed from the conversation surface
(`flush.test.ts:92` precedent).

## The resolution chain, operationally

PD12.3: **own mode → inherit from split source → the arc's most recently used mode →
config default.** Each link, made concrete:

1. **Own mode** comes from session entries (below). The chain is consulted **once, at pane
   attach**; from the first entry on, the JSONL is the only truth for this session.
2. **Inherit from split source** is **materialized, not looked up**: the split action
   stamps the new session's first mode entry with the source pane's effective mode at
   split time. Link 2 therefore can never dangle, needs no cross-session read at resolve
   time, and survives everything the JSONL survives. Splits from sessionless panes
   (browser/tree/memory/mcp) stamp nothing and fall through per PD13.4.
3. **The arc's most recently used mode** hinges on one fact: **the recency event is a mode
   entry being written by any session bound to the arc** (a shift+tab press or a
   materialized inheritance stamp; wall-clock last-writer-wins). It is stored
   machine-locally as `arcModes: Record<arcSlug, Mode>` in the Track-P workspace state
   under the `workspaceIdentity` seam, and **not** in the vault: mode is machine
   ergonomics rather than knowledge, and keeping it out of the vault keeps F1 sync
   conflict-free by construction. Until J17 lands (no arcs exist), this link is vacuously
   empty and the chain skips it.
4. **Config default** closes the chain with the `modes` block, user config layer (two
   options total):

   ```ts
   modes: z.object({
     default: z.enum(["plan", "recall", "agent"]).default("agent").describe(
       "Mode a session starts in when nothing more specific resolves (its own mode entry, " +
       "then its split source, then the arc's most recently used mode); exists because a " +
       "plan-first team should not pay a keystroke per session to say so. Ships as agent — " +
       "safe because mutating tools still ask under the ordinary gate, so the default is " +
       "never silently mutating.",
     ),
     planBash: z.record(z.string(), z.enum(["allow", "ask"])).describe(
       "Glob patterns over the full bash command string extending plan mode's built-in " +
       "read-only allowlist (allow | ask only; everything unlisted stays denied in plan); " +
       "exists because investigation tooling varies by stack (a just or cargo shop needs " +
       "its own read-only verbs) and the alternative is users abandoning plan mode. Same " +
       "matcher and most-specific-wins rules as permissions.bash; commands with shell " +
       "chaining characters always fall to the deny blanket; deny entries belong in " +
       "permissions.bash, which overrides this list everywhere.",
     ),
   }).partial().strict()
   ```

   Slots into `configSchema` (`packages/shared/src/config/schema.ts:110-151`), honored from
   the user config layer only, like `permissions` (`schema.ts:143-145`): a checked-in
   project file must not steer a stranger's sessions into `open`-adjacent postures.

## shift+tab

### Keymap placement & collision analysis

New entry in the `appActions` table (`packages/tui/src/app-core.ts:18-191`):

```
"mode.cycle": { chords: "shift+tab", help: "cycle mode (plan → recall → agent)",
                invoke: (core) => core.cycleMode(),
                command: { name: "mode", description: "cycle the focused session's mode" } }
```

A bare chord rather than a leader binding: mode flips are E5-Tab-frequency acts and PD12.2
says cycle-in-place. Findings from the collision sweep:

- **No existing binding uses tab in any form.** The full action table binds only
  `leader <key>` chords plus `ctrl+p` (`app-core.ts:181`), `f1` (`app-core.ts:175`),
  `ctrl+q` (`app-core.ts:186-190`, hard-checked again at `app-core.ts:448`), and the
  `ctrl+k` leader itself (`app-core.ts:336`). `shift+tab` is free at the global layer.
- **Dispatch order protects overlays.** `dispatchKey` consults palette/help/preset
  overlays *before* the keymap (`app-core.ts:452-466`, keymap at `app-core.ts:468`), so
  with any overlay open, shift+tab is inert. That is correct: an overlay is a modal
  question, and mode-flipping under it would change the ground the question stands on.
- **One pane-level near-collision, adjudicated**: the slash-suggestion menu completes on
  `chord.name === "tab"` **without checking `shift`**
  (`packages/tui/src/conversation-model.ts:607-614`), so shift+tab in a slash query today
  *accidentally* completes the suggestion. The global binding will intercept first
  (`app-core.ts:468-481`; keymap wins before the pane's `handleKey` pass), which is the
  intended outcome; the spec nonetheless mandates adding `&& !chord.shift` at
  `conversation-model.ts:607` so the pane's behavior is honest even if a user rebinds
  `mode.cycle` to `none` (keybindings config supports it, `keymap.ts:31`).
- **Ask overlay and backtrack are pane-internal** (`conversation-model.ts:281-282`), so a
  global shift+tab fires above them. Acceptable by the mid-turn rule below: the entry
  records, application waits, and the pending ask still resolves under the verdicts that
  launched it.
- **Terminal encoding caution**: many terminals emit shift+tab as CSI Z (back-tab).
  `chordOf` passes through whatever name OpenTUI's parser reports (`keys.ts:55-73`);
  binding must cover both `shift+tab` and the parser's back-tab name if they differ, and
  the acceptance probe must drive both encodings.

### Mid-turn switches

**⟨PR-4⟩ Record now, apply at the turn boundary. Never interrupt.**

- The press **always succeeds**: the mode entry is appended immediately (the human's
  decision is a fact the record must keep), chrome flips to the new word at once with a
  `░` pending prefix (density carries state, per design-language) while the old bundle
  finishes the turn.
- **Application** rebuilds the agent at the turn boundary through the landed swap seam:
  `bindSessionLifecycle` already rebuilds and `swapAgent`s after a turn when the flush
  joins history (`packages/tui/src/app.ts:486-501`, swap at `app.ts:500`;
  `conversation-model.ts:347-349`), and the per-pane `agentSwitchers` closure is the same
  rebuild path (`app.ts:124`, `app.ts:161-169`). Idle sessions apply instantly (the
  boundary is now). Multiple presses mid-turn each record an entry; only the final value
  is applied at the boundary. **Ordering law at the boundary**: the swap lands before the
  next queued prompt delivers (`conversation-model.ts:331-335`, `drainQueue` at
  `conversation-model.ts:380-384`), so a prompt queued after the press runs under the mode
  the user chose, never the one they left.
- **Why not interrupt**: the in-flight turn's tool calls were permitted under the bundle
  that launched them; yanking verdicts mid-stream makes the JSONL a liar about what policy
  produced which result. Mode is a lens; the emergency brake is **esc**
  (interrupt, `conversation-model.ts:396-398`), and it composes: esc, then shift+tab,
  then resend. This also retires the current agent-switch refusal UX ("agent busy · finish the
  turn first", `extension-commands.ts:81-83`, guarded at `app.ts:164`) for modes: a
  refused keystroke on a cycle key would read as a broken key.

## The session entry

**⟨PR-5⟩** Mode changes ride the Pi-sanctioned extension entry, not a new union member:

```json
{ "type": "custom", "customType": "keywork/mode", "data": { "mode": "plan" },
  "id": "…", "parentId": "…", "timestamp": "…" }
```

Rationale: the session format is Pi v3 with a **closed** vocabulary plus `custom` as the
designed extension door (`packages/engine/src/session/entries.ts:55-59`; the compatibility
test pins the exact type list, `session/pi-format.test.ts:118-133`). `thinking_level_change`
and `model_change` are first-class *because Pi's format defines them*; adding a keywork
`mode_change` type would fork the format for zero capability, since `custom` entries
already replay, fork, label, and tree correctly and are ignored by context assembly
(`entries.ts:159-172` default arm), which is right: mode state must not leak synthetic
messages into the model's context. Arc-binding entries (PD13.3, J17) should take the same
`custom` shape: one convention, stated here first. `SessionStore` grows the trivial
public appender the pattern needs (`session/store.ts:88-111` today exposes only the
built-in appenders; `appendEntry` is private at `store.ts:198-207`).

## Presentation

Hue is identity and never state (PD8, [`design-language.md`](design-language.md)), so mode
is **a word, not a color**, exactly the E2 preset treatment: "secops reads the file, users
read the word."

- **Pane chrome**: the mode word leads the title (` plan · parser work · 123▸45 `) via
  the existing `paneTitle` composition (`packages/tui/src/pane-chrome.ts:30-32`,
  `conversation-pane.ts:49-54`). Lens-first ordering: the mode qualifies everything after
  it. **⟨PR-6⟩ Agent renders nothing**: the default mode is absence of ink
  (design-language: every item justified or absent), which makes today's frames
  byte-identical and any non-default mode instantly visible.
- **Pending state**: `░ plan` while a mid-turn switch awaits its boundary: density
  carries the state, the word carries the identity; the prefix drops on apply. Glyph
  tiers per 100/PD14 (declared, with fallback one tier down): the word is tier 0; the
  `░` prefix is tier 1, falling back to `~` at tier 0 (the J-D4 provisional prefix
  reused, same "not yet settled" meaning).
- **Status line**: the mode word joins the C18 grammar after the preset word
  (`keywork · <model> · <preset-word> · plan · ░n`), reflecting the **focused** session,
  absent for Agent. Today's label is composed in `packages/cli/src/main.ts:326` and
  rendered at `app.ts:557-580`; the label seam grows focus-awareness (M-5).
- **Mixed-mode multi-pane**: each pane's own title word is the per-pane truth; the status
  line tracks focus. A twelve-pane frame with three Plans reads as three ` plan ·` titles,
  with no legend required.
- **Zero-state**: fresh app, all Agent: zero mode ink anywhere; the C40 capture must be
  byte-identical to today's.
- **`NO_COLOR` / monochrome**: words and `░` are text; safe by construction, which also
  meets 100's restraint floor ("beauty must survive the floor").
- **100-overlay conformance** (checked 2026-08-16, no conflict): the mode word renders
  through theme tokens only, so PD15 flavor hot-swap repaints it with everything else;
  under PD16's motion grammar a mode flip is a state flip at tempo `instant` and the
  pending-prefix drop likewise: ink only, no geometry motion, nothing ambient. The
  status-line and chrome vocabulary of record remains
  [`design-language.md`](design-language.md) (100's supersession record reaffirms it).

## Placement (vision D2)

**Position: modes ship as blessed-extension surface, honoring PD12.4's default; no core
residency is claimed.** The audit that backs it:

- The **bundles** are declarative data in the E-stream style (constants beside
  `permissionPresets`, `shared/src/trust/presets.ts:10-14`), composed through seams that
  already serve extensions: `restrictTools`/`narrowedPermissions`
  (`markdown-agents.ts:34-52`) and the `agentFactory` parameter surface
  (`app.ts:75-80`).
- The **switch surface** (keymap action, chrome word, status slot) is shell chrome with an
  exact precedent: the E2 preset picker already lives in `app-core.ts:573-590` as chrome
  over an injected port. Shell chrome rendering policy-plane state is D2's shell doing its
  one job rather than a new core system.
- The **two engine deltas** are single-flag extensions of landed core: the store's
  `stageAll` posture on the J11 kernel (memory is core by J-D2's written justification)
  and the optional deny-reason on `PermissionResolver` (a richer return type on an
  existing seam, `agent.ts:12`).
- **Disable/replace** stays real: `mode.cycle: "none"` in keybindings removes the key
  (`keymap.ts:31`); the config default keeps sessions in Agent; markdown agents remain the
  power-user path to arbitrary bundles.

## Non-goals (v1)

- No per-mode model roles (J-D8 stays orthogonal; a mode never switches models).
- No user-defined or configurable mode bundles: three fixed modes; markdown agents are
  the escape hatch.
- No mode-scoped memory semantics beyond Recall's staging posture (J-D7: tool permissions
  and memory validity stay separate systems).
- No per-mode chords or split-into-mode keys (PD12.2 superseded them).
- No headless `--mode` flag until a headless consumer exists.

## Implementation tasks

IDs are working labels (M-*); formal E-series IDs assigned at integration. The C40 capture
harness (`scripts/e2e-capture.ts`, `scripts/e2e/`) is the acceptance vehicle wherever a
frame is named.

### M-1 (2pt) — Mode bundles & composition law
The three bundles as shared constants; mode toolset intersection + stricter-wins resolver
wrapper composed after agent narrowing in both compositions (`cli/src/main.ts:291-324`,
`cli/src/chat.ts:104-107`); Recall's vault-jail resolver; `PermissionResolver` grows the
optional deny-reason carried into the refusal result (`agent.ts:205-207`).
**Accept:** Plan write attempt returns the config-denial result with zero prompt reliance
(E5's bar, restated); property test: across all (preset × agent-definition × mode)
combinations no verdict is ever looser than either input; Recall vault-jail fixture denies
an outside-vault edit with the reasoned message; Plan bash fixtures: every default
allowlist row resolves to its stated verdict, an off-list command (`npm install`) and a
chained command (`rg foo; rm -rf .`) both deny, a config `git *: allow` does not widen
past the blanket while a config `permissions.bash` deny wins inside the allowlist, and a
`modes.planBash` extension resolves under most-literal-wins across the union;
MCP-surfaced tool invisible in Plan.

### M-2 (2pt) — Recall staged-proposal write path
`stageAll` session posture on the memory write path (provenance preserved in the sidecar);
staged-proposal tool-result text; prune-as-supersession staging into the `ReviewInbox`;
`NO_REPLY` suppression in the conversation surface for Recall review turns.
**Accept:** property extension of the J11 walk: no Recall-mode write sequence becomes
load-bearing without `approve`; approve lands with true provenance and ledger revert;
decline leaves the item listed by the inbox; `NO_REPLY` turn renders nothing while the
JSONL records it; e2e-harness scenario: Recall session proposes a correction, `░n`
increments in a captured frame.

### M-3 (1pt) — Session entry & resolution chain
`keywork/mode` custom entries (public appender on `SessionStore`); attach-time resolution;
split materialization (source's effective mode stamped; sessionless-source splits skip);
`arcModes` MRU slot in workspace state behind the `workspaceIdentity` seam (vacuous until
J17); `modes.default` config option with the `.describe()` text above.
**Accept:** mode entries survive fork/clone/replay and never contribute context messages;
chain fixture exercises every link including the vacuous-arc skip; Pi-format compatibility
test still pins the closed vocabulary; schema round-trip with the user-layer-only rule.

### M-4 (2pt) — shift+tab & mid-turn application
`mode.cycle` action + chord (both terminal encodings), palette row `/mode`; record-now /
apply-at-boundary via the `agentSwitchers`/`bindSessionLifecycle` rebuild seam; pending
`░` state; the `!chord.shift` guard at `conversation-model.ts:607`.
**Accept** (robustness emphasized per Jordan's review; the race cases are pinned rather
than sampled): probe each race. **Switch during stream**: entry appended immediately,
in-flight tool results unchanged, new bundle live on the next turn. **Switch during
pending ask**: the ask resolves under the verdicts that raised it, and its resolution
never applies the new bundle early. **Switch with queued prompts**
(`conversation-model.ts:331-335`, `drainQueue` at `conversation-model.ts:380-384`): the
boundary swap lands *before* the next queued prompt delivers, so queued prompts run under
the new mode (asserted rather than assumed). Also: cycle on idle applies instantly; three
rapid presses apply only the last; overlays keep shift+tab inert; back-tab encoding
drives the action; dispose mid-pending leaks nothing (the recorded entry stands, no swap
fires).

### M-5 (1pt) — Presentation
Mode word in pane title (lens-first, Agent elided), focus-aware status-line slot, pending
prefix, zero-state.
**Accept:** C40 captures: all-Agent frame byte-identical to today's; mixed-mode
three-pane fixture shows per-pane words and a focus-tracking status line; monochrome and
`NO_COLOR` captures stay legible; pending-prefix frame during a mid-turn switch.

### M-6 (1pt) — Recall in-pane approval
The staged-proposal overlay riding `pendingAsk` (diff window, `y`/`n`/`esc` semantics per
the flow above; `d` reserved for the memory pane).
**Accept:** probe workflow: propose → overlay with diff → `y` approves through
`store.approve`; `n` leaves it staged and the inbox row present; capture fixture of the
overlay; dispose mid-ask leaves the item staged, never discarded.

### M-7 (1pt) — Mode scenario pack
End-to-end capture scenarios: cycle across all three modes, Plan denial turn, Recall
proposal round-trip; masked goldens opt-in per the C40 conventions.
**Accept:** scenarios run offline on the mock provider; goldens reproduce across two runs;
the pack lands in `scripts/e2e/scenarios.ts` alongside S1–S6.

Sequencing: `M-1 → M-2 → M-6` (engine → memory → overlay), `M-3` independent after M-1's
types, `M-4` after M-1 + M-3, `M-5` after M-4, `M-7` last. Total 10pt.

## Decision index — reviewed by Jordan, 2026-08-16

| # | Decision | Where | Verdict |
|---|---|---|---|
| PR-1 | Mode is an orthogonal narrowing lens over the active agent rather than three agents | The shape | **Approved** — implementation must meet a "top-tier strategy, foresight, and beauty" bar (Jordan's words); the M-task acceptance criteria carry that weight |
| PR-2 | Plan's bash posture | Plan | **Approved with amendment** (Jordan, 2026-08-16): the ask-always draft was too broad; Plan now runs the narrow read-only investigation allowlist recorded above, deny outside it; spec updated in place |
| PR-3 | Recall writes always stage; decline leaves staged (inbox is the record); discard only in the memory pane | Recall's proposal flow | **Approved** — with a "top-tier consideration" bar on the implementation |
| PR-4 | Mid-turn switch records immediately, applies at the turn boundary, never interrupts | shift+tab | **Approved** — robustness emphasized; M-4's acceptance pins the race cases (switch during stream, during pending ask, with queued prompts) rather than sampling them |
| PR-5 | Mode entries are Pi `custom` entries (`keywork/mode`), and arc bindings should follow | The session entry | **Approved** as specced (low-stakes per Jordan) |
| PR-6 | Agent mode renders no ink anywhere (word appears only for Plan/Recall) | Presentation | Proposed — not in the reviewed batch; stands for review with the doc |
