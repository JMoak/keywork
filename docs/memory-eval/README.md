# Memory decider eval

The reports here are how a memory question earns its way to a decider other than the builtin
([`121`](../backlog/121-jev-memory.md), decision 10 and K15). Each `<decider>-<version>.md` is
written by `bun run memory:eval report` over the checked-in corpus; regenerate a report rather than
edit it.

- [`builtin-1.md`](builtin-1.md) is the reference arm: today's rules, network-free, beside the
  memory-off floor. It proves nothing by itself; every challenger is gated against it.
- A challenger's report (the first will be `jev-1.13.0.md`) carries a verdict table whose
  `Proven` column says `yes` for each question that cleared all of its criteria on the held-out
  half. A question reaches that decider only when the report is checked in **and**
  `memoryEvalProofs` in `packages/engine/src/memory/proven-questions.ts` lists it in the same
  change; `scripts/memory-eval/report.test.ts` fails when the two disagree in either direction.
  The adapter asks `provenQuestions("jev-1.13.0")` (or `isQuestionProven`) and runs every other
  question through the builtin.

## The gate (decision 10)

On the held-out half of the corpus, for each question:

1. Recall questions: recall of relevant notes within 0.02 of the builtin's, and harmful drops
   (relevant notes the builtin kept and the challenger dropped) under 2% of relevant notes.
2. Recall questions: tokens injected at 60% of the builtin's or less. Curation questions:
   decider spend at 20% of the builtin's or less.
3. Hot-path questions: `waitedMs` p95 under 50 ms.
4. Every question: ECE under 0.05 after an isotonic map fitted on the other half (reported with
   its noise floor). A decider that states no odds cannot pass.
5. Curation questions: agreement with the person's own verdicts at least the builtin's.

## Running it

```sh
bun run memory:eval run --decider builtin --out artifacts/memory-eval/today
bun run memory:eval run --decider jev --out artifacts/memory-eval/today
bun run memory:eval report --run artifacts/memory-eval/today --write docs/memory-eval
```

`run --decider jev` replays `jev-1.13.0.cassette.jsonl` beside the corpus. With no cassette and
no TypeSafe key (`KEYWORK_TYPESAFE_API_KEY`, then `TYPESAFE_API_KEY`) it skips and the report
says why; with a key it records a fresh cassette (costs cents), which later runs and CI replay.
`--record` forces a fresh measurement. CI never calls Jev: `bun run test` runs the builtin over
the fixture and the cassette replay.

To build a corpus from your own work (local only; nothing leaves the machine except the judge's
calls to your own chat model):

```sh
bun run memory:eval harvest --sessions ~/.keywork/sessions/<workspace> \
  --vault .keywork/memory --out artifacts/memory-eval/mine
```

Harvest applies decisions 4 and 5 as it writes: subjects and excerpts pass
`redactForPersistence` (exact secret values from the environment, then secret shapes), recall
candidates hold the first paragraph up to 480 characters, curation notes their body up to 2,000,
drift evidence 12 lines and 6,000 characters. The judge is `roles.judge` or your default model;
`--no-judge` skips it. Point `--vault` at the vault as it stood when the sessions ran.

## The corpus

`packages/engine/src/memory/fixtures/decisions/` holds `sessions/` (recorded by keywork's own
engine from the scripts in `scripts/memory-eval/fixture-sessions.ts`; re-record with
`bun scripts/memory-eval/fixture-sessions.ts`), `vault/`, and what harvest writes from them:
`corpus.jsonl` (one decision point per line), `labels.jsonl` (hindsight, inbox and judge labels,
plus the person's `hand` labels, which a re-harvest keeps) and `harvest.json`. The line shapes
are in `scripts/memory-eval/corpus.ts`; a hand label is one of

```json
{"point":"release#call-3","note":"Release Tagging","relevant":false,"source":"hand","evidence":"why"}
{"point":"pair:Release Tagging|Release Pipeline","answer":"newer-supersedes-older","holds":true,"source":"hand","evidence":"why"}
```
