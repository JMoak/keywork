# Instrument Grammar — Discussion Capture (2026-08-16)

> Status: **discussion capture, not yet an authoritative overlay.** Records the
> instrument-display conversation with Jordan (status information: model/effort, tokens,
> cost, changed files) — two items decided here, two set aside for a dedicated design
> session. Becomes PD-numbered only after that session. Reference frame: PD17/C55
> (cockpit & context gauge), C18 status grammar, FR4.12 cost capture, C14 diff pane,
> `../design-language.md` restraint rules (honest instrumentation · density=state,
> hue=identity · hour-ten test · tier-0 floor).

## The four proposals and their dispositions

| # | Proposal | Disposition (Jordan, 2026-08-16) |
|---|---|---|
| 1 | **The detail slot** — one lens-cycled detail slot everywhere instead of chip accretion | **Set aside** for a dedicated design session; notes below are the entry material |
| 2 | **Cost with lineage** — hierarchical cost attribution (subagent → parent turn → session → arc → workspace) | **Decided: pursue.** Make it robust and beautifully visible where/when it appears — the bar is putting other coding agents to shame |
| 3 | **Changed files with turn provenance** — files node, per-turn attribution, jump-to-turn, seen-bit | **Decided: pursue, conditionally.** Only with certainty it can be built and supported robustly; the extra depth ships exceptionally well or not at all (valuable but heavy) |
| 4 | **Model/effort chip with resolution provenance** | Discuss in the same design session as #1 |

## Substrate ledger — what already exists in code (verified 2026-08-16)

- **Cost accounting largely landed** (`engine/pricing.ts` + tests): nano-dollar
  `CostRollup` with priced/metered/unpriced honesty counters, `sessionCost` over session
  entries (respecting `model_change` entries), `groupCosts` for arbitrary grouping keys,
  `knownCostNanos` (a total is only "known" when zero turns were unpriced),
  `formatCostNanos`. Surfaced today in the session store's per-session cost
  (`session/store.ts:31`), agent live totals (`agent.ts:48`), sessions-overview rows
  (`tui/sessions-overview-model.ts:85`), and the conversation model's cost line with
  basis disclosure (`tui/conversation-model.ts:751`).
- **`model_change` is already a session entry type** — model switches are provenance-
  carrying history, not ambient state. The pattern to extend for effort/mode (PD12 item
  3 already mandates mode changes as session entries).
- **Arcs exist in the engine** (`engine/src/memory/arcs/`: registry, bindings, airlock,
  recall) and sessions-overview rows carry `arcId` — the grouping key for arc rollups is
  real, PD13's binding-as-session-entries carries it through fork/clone.
- **Checkpoints** (`engine/checkpoints.ts`): shadow-repo per-turn tree snapshots,
  `captureTree`/`restoreTo`/`takeTurnTag`, tags persisted on `MessageEntry.checkpoint`.
  Known gap (92 ledger): per-pane turn-tag isolation under concurrent multi-pane turns —
  shared `Checkpoints` mints one tag.
- **Bus events**: `tool.started` / `tool.output` / `tool.finished` only — **no
  file-changed event exists.**
- **Status line today**: `statusBar` (`tui/app.ts:857`) with a per-render `statusLabel`
  thunk showing `provider · activePreset`; C18's `<model>` slot is spec, not yet wired.
- **No effort/reasoning setting exists anywhere** — only encrypted reasoning-content
  passthrough in `openai-responses.ts`. Effort display presupposes effort plumbing.
- **Provider is process-global** — chosen at CLI startup; D6 `model:` frontmatter was
  deferred pending a provider-factory seam (G1-adjacent). Per-pane model divergence is
  not yet possible, which is exactly when chip #4 earns its keep.

## #2 Cost with lineage — decided direction

Every flagship shows flat per-session cost; keywork's session tree + arcs + (future)
spawn lineage allow **attributed** cost. Shape agreed in discussion:

- Subagent spend rolls up the `↳ spawned by` lineage (FR6.17) into the parent turn, the
  arc, the workspace; a parent transcript's spawn line carries what the delegation cost.
- `/cost` deep-dive renders as a tree mirroring the arcs node, rows in arc anchor hue;
  the summary surfaces (pane title detail, sessions/arcs rows) stay one-glance concise.
- Second-order: PD9's `delivered:` stamps enable cost-per-delivered-outcome later.
- Honesty rules ride the existing machinery: `knownCostNanos`/unpriced-turn disclosure —
  a total that hides unpriced turns never renders as a total.

Remaining pieces: arc-grouped rollups surfaced in the arcs node (FR2.5, open) · the
`/cost` tree pane · sparkline instruments (C55) · lineage attribution itself, which
waits on the subagent spawn mechanism (unscoped — the transparency contract is FR6.17,
the mechanism needs its own scoping task). Design the tree shape now so lineage slots in
without rework. Final visible form goes through the design session's lens decision (#1).

## #3 Changed files with turn provenance — decided, with the robustness gate

**The feasibility finding that satisfies the robustness condition:** attribution must
come from **checkpoint tree diffs, never tool-call inference**. Diffing consecutive
per-turn snapshot trees (`git diff-tree` in the shadow repo) is exact regardless of how
the change happened — bash included, which is where inference-based approaches lie.
The machinery is already trusted for restore; reading diffs from it adds no new failure
modes. That makes the core (files node · diffstat · which-turn-touched-it ·
jump-to-turn) certain-buildable.

Prerequisites and the heavy tail:
1. **Per-pane turn-tag isolation** (known 92 gap) — required before per-turn attribution
   is truthful under concurrent panes. Do this first; it's debt regardless.
2. A `file.changed` bus event derived from checkpoint diffs (not from write/edit tools).
3. Perf posture for large repos (diff-tree is cheap; renames/binary need decided
   rendering, not cleverness).
4. The **depth tier** (seen-bit per file-version, needs-you density until reviewed,
   restore-before-this-turn from a file row) is the exceptional-or-not-at-all part —
   gate it behind the core landing clean, options-first captures before commitment.

## Design session agenda — #1 the detail slot, #4 the model/effort chip

### #1 The detail slot (one slot, many lenses)

Pitch on the table: every pane title and sessions/arcs row gets exactly **one detail
slot**; the slot's lens (`tokens · cost · files · timing`) is keyboard-cycled workspace
state, swapping everywhere at once — the workspace answers one question at a time.
"Cost viewer mode" = the cost lens + `/cost` for depth. Cockpit flavor stays the
show-everything posture; calm stays default.

Anchors to design against:
- `statusLabel` thunk and pane title detail are the existing mount points; FR4.12's
  "pane title detail" and C55's instruments should re-anchor onto the slot so it isn't
  built twice. Sequencing consequence: **the lens decision precedes or co-lands with
  C55.**
- C37's collapsed-row minimalism (title · age · density mark · arc tag; counts only on
  expand/focus) is binding taste precedent — a lens adds at most one cell-efficient
  field to a collapsed row.
- Flavor instrumentation density (C49, calm ↔ cockpit) is a separate axis: flavor = how
  much, lens = which question. Confirm orthogonality or fold one into the other.
- Keymap: shift+tab is taken (PD12 modes). Lens cycling needs its own key; check against
  FR3.10's coverage audit.
- Lens is workspace state → persists via workspace descriptors.

Open questions:
- Q1: Lens scope — global per workspace (pitched) or per-pane? What does the C37
  switchboard do with a per-pane lens?
- Q2: Does the status line recompose per lens, or only title/row slots?
- Q3: Launch lens set — is `files` gated on #3's core landing?
- Q4: Zero-data honesty per lens (no pricing, no changes yet) — calm empty or absent?
- Q5: Tier-0/NO_COLOR renders of each lens payload.

### #4 The model/effort chip with resolution provenance

Pitch on the table: the chip shows the **resolved** model/effort for the focused pane
and *where the value came from*, rendered in provenance ink — full density when set
explicitly in this session, lighter when inherited (agent, workspace, config default).
One glance answers "what model" and "did I choose this or drift into it."

Anchors to design against:
- **PD12's resolution chain is the pattern** (own → split source → arc MRU → config
  default) and PD12 already mandates mode rendering in pane chrome + status line. The
  chip should ride one generalized per-session-setting resolution mechanism, not a
  parallel one — decide that generalization in the session.
- **E2's divergence rule is the honesty precedent**: derive the displayed value from
  live state, never a cached label; divergence renders truthfully (`custom`).
- `model_change` session entries already exist; effort/mode changes follow the same
  entry pattern (E5 rule).
- Provenance density (`█ ▓ ░`) currently means user/agent/external in the memory
  domain — decide whether config-origin reuse strengthens or dilutes the grammar
  (the alternative: a distinct but rhyming treatment, e.g. bright vs dim of the same
  glyph, keeping `█▓░` memory-only).

Remaining engineering (independent of the design, can be sequenced anytime):
1. **Provider-factory seam** — the heavy prerequisite; unblocks per-session model
   switching, D6 `model:` frontmatter, and makes the chip's multi-model case real.
   G1-adjacent; Anthropic guardrail untouched.
2. **Effort as a first-class setting** — config schema field (D9 `.describe()`),
   provider request wiring, per-session override, session-entry recording.
3. C18 grammar extension + options-first C40 captures of chip candidates.

Open questions:
- Q6: Provenance-ink reuse vs rhyming-treatment (above).
- Q7: Effort rendering — text (`high`) vs one-cell ramp mark; does a ramp mark violate
  "density is state" by encoding a setting?
- Q8: Where does the chip live — status line only, or also pane chrome when panes
  diverge? (It only *must* appear per-pane once models can diverge per-pane.)
- Q9: Does the chip belong inside the #1 lens system (a `setup` lens?) or is it
  permanent chrome exempt from lens cycling? (Pitched: permanent — trust info doesn't
  rotate.)

## Sequencing sketch (for the design session to confirm)

1. Per-pane checkpoint turn-tag isolation (unblocks #3 core; standing debt).
2. Design session: lens grammar (#1) then chip (#4) — the slot is the container, the
   chip a citizen or an exemption. Options-first C40 captures for both.
3. #2 now-half: arc rollups into the arcs node + `/cost` tree (shape lineage-ready);
   #3 core files node via checkpoint diffs. Both mount into the slot once decided.
4. Provider-factory seam + effort plumbing (anytime; prerequisite for #4's full case).
5. #2 lineage attribution and #3 depth tier: after subagent scoping and after the core
   surfaces prove calm at hour ten, respectively.
