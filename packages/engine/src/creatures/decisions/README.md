# Keeper decisions: the shadow layer over answered asks, and what the keeper hands over

Slice E7 of stead milestone one and wi-kk4j of milestone two (`docs/spec/product/CREATURES.md` section 5
in the stead repo). Every ask the keeper answers becomes one row of ratchet's decision ledger,
and a `keeper.would-approve` gate records beside it what it would have recommended. By default
nothing acts: the gate runs in shadow, every ask waits for the keeper, and no recommendation
reaches a session. A rule class acts only after the keeper promotes it on its calibrated
evidence, and every promotion can be taken back.

## How ratchet is consumed

The engine depends on an exact version of `@jmoak/ratchet` through its declared package export.
`ratchet.ts` re-exports the package's public types and derives the few narrowed keeper types from
that surface. `loadRatchet()` imports the package by name, so source runs, packed consumers and
release builds use the same dependency.

Both the standalone binary and the npm bundle carry Ratchet. Their smoke checks run
`creatures report` in an empty personal home. No sibling checkout, source-path define or separate
Ratchet build is required by a consumer.

`ratchet.test.ts` packs the installed dependency, installs that tarball into an empty temporary
consumer, checks its published declarations and runs the copied engine adapter. It then bundles
the adapter and runs that bundle after removing the package and source adapter. This exercises
the boundary that an installed product uses.

A missing dependency leaves the writer's existing failure behavior intact:
`{ recorded: false, reason: "unavailable" }`. The error names the package that failed to load.

## The row

`<node state>/decisions/keeper-would-approve.jsonl`, where the node state is `~/.keywork/node`
(`nodePaths().state` in the CLI). The file is ratchet's `JsonlLedger`: a decision line per ask,
then an outcome line with the keeper's label.

| Part | Content |
|---|---|
| Trusted state | `tool`, `rule` (the rules a `session` answer would record, `ruleLabel` form), `rule_class`, `creature`, `thread` (`conversation`, `thread`, `routine`, `child`, `mesh`, or `session` for a session no creature owns), `workshop`, `asked_because`, and the digests keywork computes: `destructive` (K9's set), `opaque`, `truncated`, `command_parts`, `inside_workspace` |
| Untrusted span | `ask`: the command, path or arguments, secrets scrubbed, cut at 2,000 characters, rendered after the trusted block by ratchet's `State` builder and left out of `trustedHash` |
| Raw state | not kept (`keepState` off): the ledger holds hashes, never the ask text |
| Tags | `keeper:call:<session>:<callId>` (one row per call), `session:<root session>` (the planned sample's group), `class:<rule class>`, `tool:`, `thread:`, `creature:`, `workshop:`, `door:one-way` |
| Label | `truth` is the verdict, `correct` scores the gate's lean against it, `source` is `keywork:person` (census), `note` is `granted <scope>` or `denied: <reason>` |

Only a fresh answer from the keeper is recorded (`asked: true`, `gate: "user"`). A standing
grant, a rule, a quiet grant and a headless or timed-out denial are not the keeper's call. A
`not-now` denial judged the moment, not the call, so it leaves the population by the keeper's
own reason, never by the gate's verdict. The label is attached after the gate has ruled and
never enters the state.

## The gate

`keeper.would-approve`, one judge question in English, mode `shadow`, baseline `review` (the
application asks the keeper anyway), policy `actAbove 0.95`, promise 98% at 95% confidence with
at most ten acts per session. Floors are code over the trusted digests: a destructive form in
keywork's K9 sense is a ratchet `oneWayDoor` (review at most, settled without asking any model),
and an opaque, cut or unplaced call is reviewed. The oracle is the creature's `decide` model
through the `Decider` port when one is configured, else the built-in rule oracle
(`keeperRuleTable`), which answers only what its table names and leaves the rest failed open,
so the policy reviews it. The evidence version names the oracle, so a change of oracle starts a
fresh phase.

## Report and promotion

`keywork creatures report` prints, per rule class of the newest evidence version: rows,
labelled rows, agreement and Brier over the rows a model answered, the acts the gate would have
taken and how many of those the keeper denied, and ratchet's evidence grade (`gradeOf` with the
planned sample). It opens by saying that nothing is enforced.

It then shows the calibration per model and rule class (`calibration.ts`), and opens by
naming any class that decides for the keeper.

## Calibration per model and rule class

The model is the row's pinned `model`, or the oracle id for the rule oracle. Only shadow rows
and blind audits that an oracle answered count, each labelled with the keeper's answer.

- **Fit split.** The first 50 labelled answers (`keeperFitRows`) for one model in one class fit
  the bar with ratchet's `fitThreshold`: the lowest confidence at which at least 20 calls above
  it kept 98%.
- **Held-out split.** Every call after those 50 is held out. Each call is re-ruled at the fitted
  bar and passed to ratchet's `evaluateAcceptance` with the keeper plan: the first 149 distinct
  calls above the bar, at most 10 from one session, chosen before any label is read.
- **States.** The calibration is `fitting`, `no-bar`, `collecting`, `awaiting-labels`,
  `accepted` or `rejected`. Agreement, its 95% Wilson interval and the exact lower bound stay
  sealed until the sample is complete.
- **Rejection is final.** The splits are fixed by ledger order, so a rejection holds for that
  model and evidence version. Only a new model, rubric or oracle starts a fresh sample.

## Blind review

`keeperAuditRate` is 0.05, ratchet's audit rate (its README and its evidence-grades design).
Each answered ask that an oracle answered is drawn with that probability (`review.ts`). The
draw writes the state the gate saw to `decisions/keeper-review.jsonl`, and only drawn calls
keep their text there.

`keywork creatures review` lists the drawn calls without the gate's guess or the earlier
answer. `keywork creatures review <record id> approve|deny` records the second answer first.
It then relabels the row with source `review:blind:keeper`, keeping the first answer in the
note, and reveals both the gate's lean and the first answer. The calibration counts agreement
with the gate, agreement with the moment, and denials above the bar.

## Promotion and demotion

`keywork creatures promote <rule class>` (or `POST /creatures/{slug}/promote`, scoped to that
creature) accepts exactly one class, by name, and only when:

- the class is not a one-way door, which is refused on principle;
- the class's calibration for the model answering it now is `accepted`;
- the blind review denied no call above the bar.

The promotion is a line in `decisions/keeper-promotions.jsonl` naming the class, model,
evidence version, bar and sample. Nothing promotes itself.

`keywork creatures demote <rule class>` (or `POST /creatures/{slug}/demote`) appends a
demotion. Promoting the class again needs a fresh planned sample after the demotion, because
calibration only reads rows after a class's last demotion.

`decideForKeeper(call, options)` (`promoted.ts`) runs before the keeper is asked:

- **Not promoted.** Any other class, or no promotion, leaves the ask with the keeper, and
  nothing is written.
- **Enforce.** A promoted class asks the gate in ratchet's enforce mode at the promoted bar,
  with the oracle pinned to the promoted model (any other model fails open).
- **Decided for you.** An act is that, logged with the tag `keeper:promoted` and unlabelled.
- **Asked anyway.** At the audit rate, ratchet diverts an act to the keeper as a blind audit.
  The keeper's answer, recorded by the ordinary tap, labels that same row.
- **Drift.** Thirty or more labelled audits since promotion below 98% (the last 200) demote
  the class with `by: "audits"`.

`overturnKeeperDecision` (`keywork creatures overturn <record id>`) labels a decided call
wrong (`keywork:overturn`) and demotes its class with `by: "overturn"`.

## Wiring

`recordKeeperVerdict(answered, { nodeState, decider? })` never throws into the ask path, and
labels the enforce row `decideForKeeper` wrote for the same call instead of writing a second.
`tapKeeperVerdicts(bus, { session, context, record, cwd })` pairs `gate.ask` with the keeper's
`gate.permission` on a session's bus and calls the writer; `keeperContextOf(tag, workshop)`
turns a creature session tag into the context.
