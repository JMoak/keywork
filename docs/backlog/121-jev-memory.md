# 121: Jev for memory: a System-One decider beside the builtin

> **Kind:** research + design overlay (2026-10-15), adopted the same day: Jordan's sixteen
> decisions are recorded below, K10 landed with the adoption and K13 and K15 the next day (ledger at the end). It owns the memory
> decider: the `MemoryDecider` port and its two implementations (the rules and LLM judgments
> keywork has today, and TypeSafe's Jev), the `memory.decider` config key, the TypeSafe key and
> its place in `keywork connect`, the `memory.decided` event, the decider's eval, and how
> `keywork serve` and keywork-app show decisions. It amends [`95`](95-memory-and-skills.md) only
> where a decision below says so (the Gardener's judgment seam gains a sibling; J-D8's role map
> gains a member that is not a chat model); J-D4, J-D6 and J-D7 stand unchanged and win over
> anything here that reads otherwise. Key handling follows [`105`](105-inference-resolution.md)
> IR-15 to IR-18; the routes follow [`118`](118-app-surface.md) 118-1 and 118-2, and the tasks
> continue 118's numbering at K10.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only; the app never
> touches a model credential, and it never touches the second credential this overlay adds
> either. Pi and OpenCode are MIT and adapted only with attribution in `NOTICE`; nothing here
> lifts code from either, from the Jev-Mem repository, or from any Jev SDK or extension, and
> `NOTICE` is untouched. Crush is never a source. The user commits; agents never `git commit`
> or `git push`. Every task below is `OWN`.

## What it is

keywork's memory makes dozens of small judgments a session, and until now it has had two ways
to make them. Rules are cheap and blind: before every edit or command, any note that shares a
word with the path or the command line goes into the context whole, up to three notes and
1,024 tokens; two notes are compared only when a third of their words overlap; the bootstrap
takes pinned notes, then the map's order. A chat model is perceptive and dear: one generative
call per note pair at an arc's close and one per touched note in a drift check, each returning
a self-reported `confidence` that the thresholds then treat as a probability. A System-One
decider is the missing middle. It reads meaning like the model, costs like the rules (about
$0.00006 for one question over five candidate notes), answers with a typed choice and a
distribution instead of prose, and cannot write a word. With Jev beside the builtin, memory's
judgments (what to recall before an action, whether a daily entry is durable, how two notes
relate, whether a note survived a diff) go to a model built to judge; the writing (note bodies,
merged text, the flush) stays with the person's chat model; and the authority (provenance,
staging, the gate, scope) stays with policy, where J-D6 put it. The bet is that memory gets
cheaper and quieter at once: fewer whole notes in the context because they shared a token,
curation affordable at every session close instead of only when an arc closes, and every
judgment on the record with its question, its odds and its fallback, so a person can see why a
note arrived and an eval can prove the trade before anyone makes it the default.

The sentence a person reads in their config:

> `"memory": { "decider": "jev" }`: memory's small judgment calls (what to recall before an
> edit, how two notes relate, whether a note still holds) go to TypeSafe's Jev on your own
> TypeSafe key; your model still writes every note, and only the notes Jev is asked about
> leave the machine.

The one-line model, in the 106 grammar: a **decision** is a typed question memory asks about
named candidates. Its *who* is the decider (the builtin, or Jev on the person's key), its *what*
is the candidates' names and bounded excerpts and never the conversation, its *how much rope*
is a choice among outcomes policy already allows (never a write, a grant or a wider scope), and
its *when* is the moment memory would have decided anyway.

## Where the tree stood (2026-10-15)

Read in source before deciding; each fact is cited where it shaped a decision.

- **Recall is lexical-only as shipped.** `openWorkspaceMemory` (`cli/src/memory.ts:77`) builds
  `new MemorySearch(store)` and nothing sets `WorkspaceMemory.embeddings`, so the semantic leg
  is empty and a hit means a shared BM25 term or a graph seed (`engine/src/memory/search.ts`).
- **Point-of-action recall is the hot path.** `Agent.executeToolCall` awaits `actionRecall`
  before every mutating tool runs (`engine/src/agent.ts:623`). `selectRelevant`
  (`memory/point-of-action.ts`) keeps any hit that is not superseded, not already surfaced and
  has a lexical or semantic rank, up to 3 notes and `min(1024, flushReserve / 8)` tokens,
  inside 150 ms, and appends the bodies whole to the tool result, where they ride the context
  until compaction (row 1, 121-8).
- **The bootstrap is the cached system prompt.** Pinned notes, then MOC order, whole notes
  within `memoryBootstrapBudget` 4,096 tokens (`cli/src/memory.ts:67`, invariant 6 in
  `docs/memory.md`); arcs and bots add layers (`arcs/recall.ts arcBootstrapLayer`). Requests
  carry `cache_control: automaticPromptCache` (`engine/src/providers/messages-wire.ts`), and
  the skill roster lives in the `skill` tool's description (`skills/tools.ts
  useSkillDescription`), so anything reshaped per turn there costs the cached prefix (row 6,
  the rejected list).
- **Search hands the model snippets.** RRF over three legs with the superseded floor, `limit`
  8 by default, 120-character snippets (`search.ts`, `recall-tools.ts`); the model then reads
  whole notes with `memory_get`. Arc and bot strata are multiplied by a constant 2
  (`arcs/recall.ts`, `bots/recall.ts`).
- **Curation has one seam and it is mostly unplugged.** The Gardener's two judgments go
  through `CurationJudgmentPort.proposePromotions` and `classifyPair` (`gardener.ts:34`). Only
  arc close (`arcs/closing.ts closingJudgment`, an LLM call per entry batch and per pair) and
  bot sweeps (`bots/sweep.ts`, propose-only) wire one. The workspace Gardener
  (`cli/src/memory.ts:91`) gets none, so workspace promotion and pair curation are dormant: a
  workspace sweep folds usefulness, reviews skills and proposes unlinked mentions, nothing
  more. Pairs reach the judge only past Jaccard 0.3; thresholds `promote` 0.8, `review` 0.5,
  `act` 0.8 are applied to the model's self-reported confidence.
- **Drift is already a three-way verdict.** `drift.ts driftJudgment` asks the chat model one
  question per touched note (`hold`, `stale`, `unsure`), evidence capped at 12 lines and 6,000
  characters; `stale` only stages a `drift-review`.
- **The flush reads the whole conversation.** `MemoryFlush` (`flush.ts`) runs one silent turn
  when `flushDue` (`session/context-budget.ts`), and the model answers `NO_REPLY` when nothing
  is worth keeping; `session/settle.ts` runs it after the turn.
- **Records say what, never why.** `context.injected` (`memory-bootstrap`, `memory-recall`,
  `memory-action`, `skill`) is journaled by `tapJournal` (`session/journal.ts`), so a recorded
  session holds every injection, every tool call with its arguments and every `memory_search`
  result. Nothing records why a note was chosen. That record is what makes a replay eval
  possible (K15).
- **Keys have one home.** `auth-store.ts` stores a credential in the OS store as
  `provider.<name>` and leaves only the name in `~/.keywork/auth.json` (`secretStore:
  "plaintext"` writes it there instead); `inference/builtins.ts` lists chat providers with a
  scoped and an ambient environment variable each; `inference/verify.ts` checks a key with
  `GET <endpoint>/models` and reads a `data` list; `setup.ts connectCommand` is the terminal
  flow. Auxiliary roles (`closing`, `naming`) resolve through `config.roles`
  (`inference/roles.ts`).
- **Config has no memory key.** `shared/src/config/schema.ts` has none; every option carries a
  `.describe()`, and anything that steers a credential or a data flow is "honored from the
  user config layer only".
- **No onboarding flow is built.** IR-16 is a record; first-run surfaces are empty states and
  the status-bar tips (`tui/src/tips.ts`, `wanted(signals)`).

## What Jev is (read 2026-10-15)

| | What we found | Whose word |
|---|---|---|
| The model | TypeSafe AI's first "System One" model, launched 2026-09-15. Given `state` and a map of typed questions it returns answers, never text: `noul` (yes or no, a probability), `choice` (one of up to 255 named options, with `probabilities` and a `confidence`), `score` (2 to 10 ordered levels). | Vendor docs (API reference, quick start) |
| The call | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, body `{ model, state, questions }`; response `{ model, answers, usage: { input_tokens, output_tokens } }`. Errors: 400 (a rule broken; `max_tokens_exceeded`), 401, 413, 415, 422, 429, 529 (overloaded); the SDKs retry 429 and 529 with backoff. A key is checked with `GET /v1/models`; responses carry `x-typesafe-request-id`. | Vendor API reference; the key check and the request-id header from third-party guides (flaviocopes, Zuplo) |
| Models | `jev-1.13.0` (`jev-latest`) and `jev-1.14.0` (`jev-preview`, from 2026-10-14). Aliases move when TypeSafe ships, so their answers change without notice; pinning a version is the documented remedy. No deprecation policy is published. | Vendor models page |
| Limits | 64k tokens per request and 32k per question (state plus the longest question) by default, 262k behind a `TypeSafe-Danger-Zone-Long-Context` header that is "slower and less accurate"; text only; English best; 32 MiB body. Rate limits are per organization, in tokens and requests per second, shown in the console; one guide reports 80 requests or 100,000 tokens per second in October. | Vendor docs; the numbers from a third-party guide, unverified |
| Price | $0.042 per million input tokens; output tokens are free. | Vendor models page |
| Latency | Vendor: "most queries complete in about 100 ms"; launch material says 70 to 500 ms. Independent: p50 280 ms and p95 397 ms for one question from Seoul, p50 271 ms with 16 questions bundled in one request. | Vendor docs and launch coverage; independent audit (jujumilk3) |
| Calibration | Vendor: trained with RLCD ("reinforcement learning for calibrated decisions"); the confidence page makes no calibration claim and says to fit thresholds on your own data, act at high confidence, confirm at medium, escalate at low. Independent: overconfident on `choice` (refit temperature 1.30) and badly on `score` (44.7% accurate at a stated 0.74), underconfident on `noul` (0.66), near-calibrated on public multiple-choice sets (scienthoon: 900 synthetic tickets plus 3,721 benchmark items); a `noul` and a two-option `choice` of the same question differ by 0.125 on average, and without an explicit "unknown" option ambiguous items scored 0% at 0.793 confidence (jujumilk3); the Towards Data Science test over 3,080 tasks reports the 0.7 to 0.9 band at mean confidence 0.81 but 53% accuracy, and 0.9 to 0.99 at 0.95 but 79%. | Vendor docs; independent audits; the TDS figures come from search summaries because the article refused our fetch (HTTP 403) |
| Determinism | Not deterministic: 50 identical requests gave 15 distinct answer sets. Bundling independent questions in one request barely moves answers (0.4% flips). | Independent audit (jujumilk3); the CEO says the same ("no seed") on Latent Space |
| Weak spots | Reads questions literally, so multi-factor judgments are split into separate questions; unreliable at arithmetic, counting and date comparison; label order matters little. On open judgments it trails a chat model: phishing 62.6% against Claude Haiku 4.5's 81.3%, 95.0% once the question was decomposed; 77-way routing 78.8% against 84.0%. | promptfoo relaying TypeSafe's guidance; the head-to-heads via a secondary summary (greennode), unverified |
| Data | Privacy policy: TypeSafe "will not train or fine tune" any model on prompts or other input. DPA: personal data is kept "for as long as necessary", with no fixed period and no deletion procedure; subprocessors listed at `trust.typesafe.ai` with a 15-day objection window; EU and UK transfers under SCCs; 72-hour breach notice. Zero data retention for enterprise customers only. | Vendor legal pages, read directly |
| Access | A waitlist at launch, opened to all 2026-09-20, new signups paused 2026-09-22 per one guide; other guides say signup is open with $5 of credit. Current status unverified. | Third-party guides |

What the evidence adds up to: Jev is not a better judge than a chat model on open questions.
Its edge is price (no output charge, input at a few cents per million), latency under half a
second, a distribution instead of a verbalized number, and a shape code can threshold. Its
calibration is good enough to route on only per question, with an "unsure" option and
thresholds fitted on our own data, which is exactly what 121-4, 121-7 and K15 require.

## What the field does (read 2026-10-15)

| Source | What it does | What keywork takes |
|---|---|---|
| Jev-Mem (arXiv 2609.23986, Jiang, Li and Li; UT Dallas per press) | A System-One controller (Jev, called through `TypeSafeClient.system_one`, version unstated) makes memory's control decisions and a System-Two LLM only answers. Write path: typing nouls, relation nouls, a temporal choice, an alias-resolution noul, periodic consolidation (nouls for redundancy, contradiction and obsolescence; a choice among keep separate, merge, promote, uncertain), escalation to a summarizer at merge or promote ≥ 0.85. Read path: six routing nouls, candidate-scoring nouls (relevance, new information, relation usefulness), stopping nouls. Candidates are chosen deterministically (vector, keyword, entity, time); the controller sees full memory content. LoCoMo with gpt-4o-mini answering: 0.777 against 0.700 for MAGMA, build 158 s against 1,404 s, query 0.93 s against 1.47 s. | The split (rules pick candidates, the decider judges, the generator writes); nouls for candidate relevance; a choice with an `uncertain` option for consolidation; high escalation thresholds. Not taken as evidence for keywork: one benchmark, no ablation of the controller against an LLM or against rules, no token counts, text and tables that disagree in places, and an adversarial-category score (0.962) that dwarfs every baseline. |
| TencentDB Agent Memory's decision service (dev.to write-up, 2026-10-13) | A pluggable decision interface with a Jev integration. Recall shows the decider candidate ids and descriptions and loads contents only after it selects; an update classifier labels new information as conflict, changed applicability, new rule, reinforcement or no change, and only the first three trigger regeneration; on failure the system "can fall back to its previous strategy". Self-reported: skill recall over 72 tasks cut repeated input from failed matches from 24.96M to 15.04M tokens (39.7%) with success 66.7% against 65.3%; memory generation cut total cost 13.8% and regenerations 39.7%, the decisions costing 0.72% of the total at 85.1% binary accuracy. | The port shape (an interface, not a dependency); ids and descriptions for recall; the update classes (as `entry-durability`); fallback to the prior strategy. Not taken: the numbers as a forecast. The author's affiliation is not stated, the sets are small, latency is unreported, and we found no decision-service code in the public repository. |
| Strands Decider (AWS Strands Labs, Apache-2.0, 2026-10-01) | A 2B open decision model (a Qwen3.5-2B torso with a pointer head of about a million parameters) served locally by `strands-decider serve` at `/v1/systemone` with the same `state`, `questions` and `answers` shape for `noul`, plus `choice` and `score`; 115 ms median on an RTX 3090; claims answers at ≥ 0.9 confidence are right about 95% of the time on unseen short classification tasks. | Evidence that the wire is becoming a shape rather than a vendor: the adapter is written against `/v1/systemone`, so a loopback decider is a later registration with no egress (121-14). Not taken: a local model now. |
| OpenAI Decisions API (preview 2026-09-29, public beta 2026-10-06 per press) | `/v1/decisions` on GPT-6 Luna, typed answers over a developer's options; one independent test measured a 1.46 s median. | Only the signal: the category is real and contested, so the port must not be shaped around one vendor. |
| pi-fabric (a community Pi extension; license unstated) | Lets a reasoning model write small programs that call Jev repeatedly; the key comes from Pi's `auth.json` or `TYPESAFE_API_KEY` and never appears in a body, a guest or a diagnostic; no automatic retries. | Ideas only: the key's precedence and its absence from every diagnostic. No code. |
| Jev in the Wild (arXiv 2609.30216) | 2,170 public Jev projects by 2026-09-22; attribute judgment and scoring dominate. | Adoption, not quality. |

## The decision inventory

Every memory decision keywork makes today, where it is made, and Jev's part in it. *Decide*:
Jev's answer takes effect, inside 121-7's bands, with the builtin as fallback. *Assist*: Jev's
score is shown to a person or the model and changes nothing by itself. *Stay out*: the decision
stays where it is.

| # | Decision | Made today in | Jev | Why | Saves | Risk | Outside evidence |
|---|---|---|---|---|---|---|---|
| 1 | What to add before an edit or command | `memory/point-of-action.ts selectRelevant`, awaited at `agent.ts:623` | **Decide** (`action-relevance`) | The highest-volume automatic injection and the bluntest rule (any shared term qualifies); bodies ride the context until compaction; a wrong drop costs little because the agent can still search | Context, high | Low | Jev-Mem candidate scoring; TencentDB select-then-load |
| 2 | How two notes relate | `gardener.ts curateNotePairs` (Jaccard ≥ 0.3), then `classifyPair`, one LLM call per pair (`arcs/closing.ts`); dormant at workspace level | **Decide** the relation and which note to keep; the chat model writes any merged body | A five-way choice is the decider's sweet spot; today each pair is a generative call with a self-reported confidence | Background spend, high | Medium (an auto-applied supersession retires a note) | Jev-Mem consolidation nouls and choice, 0.85 escalation |
| 3 | Whether a daily entry is worth a note | `gardener.ts promoteFromDailyLogs`, then `proposePromotions` (the LLM reads every candidate entry); dormant at workspace level | **Decide** the triage; the chat model writes title and body for the entries Jev passes | Filtering before the distiller is where TencentDB's 39.7% fewer regenerations came from; their update classes map one to one | Background spend, medium to high; makes workspace curation affordable at all | Medium (a missed fact stays in the daily log, still searchable) | TencentDB update classifier |
| 4 | Whether a note survived a diff | `drift.ts driftJudgment`, one LLM call per touched note | **Decide** (`drift-verdict`) | Already a three-way choice with `unsure`; `stale` only stages a proposal | Background spend, medium | Medium | None direct |
| 5 | Which search hits the model sees | `search.ts runSearch` (RRF, `limit` 8), `recall-tools.ts` snippets | **Decide**, phase two (K19): leave out decisive misses and say so in the result | Snippets are cheap; the saving is the `memory_get` reads they invite | Context, medium | Low | Jev-Mem sufficiency and stopping nouls |
| 6 | Which skill applies | The roster in the `skill` tool description (`skills/tools.ts`); the model chooses | **Assist**, phase two, only if K15 finds wasted loads: a one-line hint after the cache line, never a reshaped roster | A per-turn roster rewrites the cached prefix; the hint needs the prompt as state (Q13) | Context, unknown here | Low | TencentDB skill recall (39.7% less repeated input over 72 tasks) |
| 7 | Whether a mention should become a link | `gardener.ts proposeUnlinkedMentions` (any title or alias of 3+ characters) | **Assist**: score the card, suppress decisive misses | Inbox rot is 95's named risk; this is attention, not tokens | Attention | Low | Jev-Mem alias-resolution noul |
| 8 | Arc close triage and inbox order | `arcs/draft.ts`, `arcs/airlock.ts`, `staging.ts byCreationThenSubject` | **Assist**: the decision's odds on the card; the person still presses the key | The airlock is the person's ritual (J-D4 layer 3) | Attention | Low | None |
| 9 | Which layer wins (workspace, arc, bot) | Constant ×2 boosts in `arcs/recall.ts`, `bots/recall.ts` | **Stay out** | Scope is policy (J6); relevance across the layers a session may see is already answered by row 1 | | | |
| 10 | What the bootstrap injects | `bootstrap.ts`, `store.bootstrap`, 4,096 tokens | **Stay out** | It is the cached system prompt, composed before any prompt exists, and its order is the person's pins and map | | | |
| 11 | Whether a flush is worth running | `flush.ts` (the model answers `NO_REPLY`) | **Stay out** | It needs the whole conversation as state (rejected), and the flush already rides the cached prefix | | | |
| 12 | When to flush and when to compact | `context-budget.ts flushDue`, `compactionDue`; `settle.ts` | **Stay out** | Arithmetic, which Jev is documented to be bad at | | | |
| 13 | Usefulness and curing | `gardener.ts foldUsefulness`, `cli/src/memory.ts curingStage` | **Stay out** | Arithmetic over recalls and citations; F2 keeps popularity out of rank; curing is display (J-D6) | | | |
| 14 | Whether a staged untrusted write lands | `staging.ts`, `store.approve` | **Stay out** of deciding | Trust is granted, never earned (J-D6); nothing untrusted lands without a person (J-D4); an assist score is Q15 | | | |
| 15 | Preference proposals, forget plans, citations | `ask-gate.ts` (three approvals), `forget.ts`, `citations.ts` | **Stay out** | Counting and parsing | | | |

**Ranked.** By expected saving: 1 (context, on every mutating call), then 2 and 3 (background
spend, and together they make workspace curation affordable at every close), then 4, 5 and 6.
A heavy session makes 50 to 200 mutating calls; at five candidates and about 1,500 input
tokens per decision that is 75k to 300k Jev tokens, about a cent, against up to 1,024 injected
tokens per call that today stay in the context until compaction. By risk: 1, 5, 7 and 8 are
low (a wrong answer costs a note the agent can still search for, or a score a person reads); 3
and 4 are medium (a missed fact waits in the daily log; a stale verdict only proposes); 2 is
the highest, because an auto-applied supersession retires a note, which is why it acts alone
only above 0.95 and only inside the blast radius. Build order follows: 1 first, then 3, 2 and 4
behind the eval, 5 to 8 only as the eval earns them.

## Decisions of record

**121-1 · Jev judges, the model writes, policy decides.** The decider answers typed questions
about candidates that deterministic code chose (Jev-Mem's split: candidates by rule, judgment by
System One, synthesis by System Two). It never produces text that persists, never writes the
vault, never grants, never widens scope, and never sees anything a session's scope (J6) hides.
Generation stays with the person's chat model: titles, bodies, merged bodies, the flush,
compaction summaries. Authority stays with policy: provenance, staging, the airlock, the blast
radius, the gate. A decision changes only which of the outcomes policy already allows happens:
a note injected or not, a proposal staged or not, an agent-authored pair merged or proposed.

**121-2 · One port, two implementations.** `engine/src/memory/decider.ts` defines the port,
one method per question family rather than a generic `ask`, because the builtin must stay
today's code and a generic ask would make it parse questions:

```ts
export interface MemoryDecider {
  readonly id: string;
  chooseForAction(input: ActionCandidates): Promise<MemoryDecision<Selection>>;
  triageEntries(input: EntryCandidates): Promise<MemoryDecision<EntryTriage>[]>;
  relatePair(input: NotePair): Promise<MemoryDecision<PairRelation>>;
  assessDrift(input: DriftCase): Promise<MemoryDecision<DriftAssessment>>;
  weighMention(input: MentionCandidate): Promise<MemoryDecision<MentionVerdict>>;
}
```

`builtinDecider(seams)` wraps what exists: `selectRelevant`, the Gardener's
`CurationJudgmentPort` (or nothing where none is wired), `driftJudgment`, the mention rule.
`jevDecider(options)` is the TypeSafe adapter (121-14), and `withFallback(jev, builtin)`
composes them so every Jev method has the builtin answer to fall back on (121-6).
`cli/src/compose.ts` picks one from `memory.decider` and the credential;
`point-of-action.ts`, `gardener.ts` and `drift.ts` take a decider instead of their current
seams. J-D8's role map gains a member that is not a `roles` entry: the decider is not a chat
model, so it never resolves through IR-14's resolver and never appears in `/model`. A child
session (120) uses its parent's composition, and so its parent's decider.

*As built (K10, 2026-10-15):* each method returns `Decided<Outcome>`, `{ outcome, decision }`,
rather than `MemoryDecision<T>`: `decision` is 121-5's record exactly, and `outcome` is what the
caller acts on, which can carry what the record must not (the chat model's merged body, the
kept search hits). The K10 ledger below has the whole surface.

**121-3 · One switch, honored from the user layer only.** `configSchema` gains:

```ts
memory: z
  .object({ decider: z.enum(["builtin", "jev"]).describe(deciderDescription) })
  .partial()
  .strict()
  .describe(
    "Memory behavior that is the user's call rather than the vault's; exists so the one memory choice that sends data off the machine lives in readable config. Honored from the user config layer only.",
  ),
```

with `deciderDescription`, verbatim:

> Who makes memory's small judgment calls: which recalled notes are worth adding before an edit
> or a command, whether a daily-log entry is durable, how two notes relate (duplicate,
> supersedes, contradicts, distinct), whether a note still holds after a diff. "builtin", the
> default, keeps keywork's own rules and, where a judgment needs one, your chat model; "jev"
> asks TypeSafe's Jev decision model on the key `keywork connect typesafe` saved, sending only
> the question and the candidate notes it is about (never the conversation), and uses the
> builtin answer whenever Jev is unreachable, late or unsure. Either way your chat model writes
> every note and nothing untrusted lands without you. Exists because these judgments run on
> every edit and every sweep, so a fast typed judge changes how much memory costs and how much
> of it reaches the context, and because sending note text to another vendor is the user's
> call. Honored from the user config layer only; a checked-in project file can never send a
> workspace's memory anywhere.

Unset means builtin. Selecting `jev` with no key is not an error: memory runs builtin, says so
once per process (`memory decider: jev selected, no TypeSafe key · keywork connect
typesafe`), and the server and `keywork doctor` report IR-18's `unavailable-credential`.

*Until Jev exists (K10, 2026-10-15):* the key and its text landed with K10, and while no build
can compose a Jev decider, `"jev"` passes the schema but stops startup with one line,
`memory decider: jev selected, but this keywork has no Jev decider yet · set "memory": {
"decider": "builtin" } in <the user keywork.json>`, so nobody believes Jev is deciding when it
is not. The change that composes `jevDecider` (K11 over K13) deletes the refusal and brings in
the `no-key` notice above.

*As built (K13, 2026-10-16):* the refusal is gone. `"jev"` composes `withFallback(jev,
builtin)`; with no key the notice above prints once per process, when the first decider is
composed, and startup never stops. A question Jev would have taken records `fallback: {
reason: "no-key" }`; an unproven one records no fallback, by 121-4.

**121-4 · Questions are a versioned catalog, and only proven questions reach Jev.** All the
questions for one decision point travel in one request (bundling is safe and adds about 15 ms
for 16 questions).

| Question | Type | Jev sees (state) | Takes effect | Otherwise |
|---|---|---|---|---|
| `action-relevance@1` | `noul` per candidate, keyed by note name | `action { tool, subject }`, `notes { <name>: { title, layer, excerpt } }`, at most 5 | p ≤ 0.10 drops the note; p ≥ 0.90 ranks it first; the deterministic filters (superseded, already surfaced, budget, note cap) still apply | The builtin rule keeps it in RRF order |
| `entry-durability@1` | `choice`: `new-durable`, `changes-a-note`, `reinforces-a-note`, `episodic`, `unsure` | `entry { text, date, provenance }`, `neighbors { <name>: { title, excerpt } }`, at most 3 | Top ≥ 0.90: `episodic` and `reinforces-a-note` skip the distiller; `new-durable` and `changes-a-note` go to it (the latter with the neighbor as a pair candidate) | To the distiller, today's path |
| `entry-kind@1` (same request) | `choice`: J12's ontology (`decision`, `convention`, `tool`, `dependency`, `person`, `error-pattern`, `task`, `file`, `module`) plus `none` | As above | Top ≥ 0.90 suggests a kind on the proposal | No kind |
| `pair-relation@1` | `choice`: `duplicate`, `newer-supersedes-older`, `older-still-holds`, `contradiction`, `distinct`, `unsure` | `older { title, body, provenance }`, `newer { … }`, bodies capped at 2,000 characters; which is older is computed in code | 121-7's curation bands | Escalate to the builtin LLM judgment, or propose without acting |
| `drift-verdict@1` | `choice`: `hold`, `stale`, `unsure` | `note { title, body }`, `evidence` (at most 12 diff lines, 6,000 characters) | Top ≥ 0.90 stamps the verdict; `stale` stages a `drift-review` as today | The builtin LLM judgment if a provider is available, else `unsure` |
| `mention-is-link@1` | `noul` | `source { title, sentence }`, `target { title, excerpt }` | p ≤ 0.10 suppresses the link card (the decision is still recorded) | The card, with its score |
| `search-relevance@1` (K19) | `noul` per hit | `query`, `hits { <name>: { title, snippet } }`, at most 8 | p ≤ 0.10 leaves the hit out, and the result says how many were left out | The hit stays |
| `skill-applies@1` (K19, Q13) | `choice`: skill names plus `none` | `prompt` (first 500 characters, redacted), `skills { <name>: description }` | Top ≥ 0.90 adds one line naming the skill after the cache line | Nothing |

Rules for the catalog, each from the evidence above: `noul` and `choice` only (`score` is the
worst-calibrated type in every independent test); every choice includes `unsure`, and `none`
where nothing may apply; anything about dates or counts is computed in code and handed over as
a fact; one judgment per question. A question's id carries a version; rewording bumps it, and a
bump un-proves it. The proven set (`memoryEvalProofs` in `engine/src/memory/proven-questions.ts`,
read as `provenQuestions(jevModel)`) starts empty and grows only by a change that checks in the
K15 report for that question and that model version. Under `jev`, an unproven question runs builtin and records no fallback: it
is the design, not a failure.

**121-5 · Every decision is an event and a record.** `memory.decided` joins the engine bus
beside `context.injected` and carries one `MemoryDecision`:

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Unique per decision. |
| `question` | `string` | Catalog id with version, e.g. `action-relevance@1`. |
| `about` | `{ kind: "call", callId } \| { kind: "pair", older, newer } \| { kind: "entry", entryId } \| { kind: "note", note } \| { kind: "mention", note, target } \| { kind: "query", query }` | What was decided. |
| `candidates` | `string[]` | Note names or entry ids offered; never bodies. |
| `choice` | Per question: `{ kept: string[], dropped: string[] }`, or an option name | The outcome that took effect. |
| `scores` | `Record<string, number>` | Per-candidate probability (nouls) or per-option probability (choices); absent for a rule with no score. |
| `confidence` | `number?` | Jev's `confidence` for a choice; for nouls, the smallest `\|2p − 1\|` among kept candidates. |
| `decider` | `"builtin" \| "jev"` | Who decided what took effect. |
| `model` | `string?` | The version that answered, from the response (`jev-1.13.0`). |
| `rule` | `string?` | For a builtin decision, the rule in words: `shares "auth" with the path`, `jaccard 0.41`. |
| `fallback` | `{ reason, undecided? }?` | Why the builtin decided under `jev` (121-6); `undecided` names the candidates Jev left to the rule. |
| `latencyMs` | `number` | How long the decision took. |
| `waitedMs` | `number?` | Hot path only: what it added after the tool finished (121-8). |
| `inputTokens` | `number?` | Jev's `usage.input_tokens`, for cost. |
| `stateHash` | `string?` | SHA-256 of the state sent, so a replay can prove it rebuilt the same question. |

In-turn decisions (rows 1 and 5) ride the session bus and are journaled by `tapJournal` as a
`memory_decision` custom entry, replayed with `replay: true`, so a recorded session finally says
why memory injected what it did. Sweep and command decisions (rows 2, 3, 4 and 7) happen
outside a turn: they are appended to a machine-local log, `~/.keywork/decisions/<workspace
identity>.jsonl` (skill telemetry's precedent keeps machine state out of the git-able vault),
and under `keywork serve` recorded as a server event with an empty `sessionId`, like
`memory.inbox`. A proposal staged under a decision carries optional `decision`, `score` and
`decider` fields. `context.injected` for `memory-action` and `memory-recall` gains an optional
`decision` id, so a transcript row can answer "why this note". Builtin decisions are recorded
too: the point is the record, and the builtin's rule in words is as useful to a person as Jev's
odds.

**121-6 · Fallback is always the builtin, and every reason has a name.**

| Situation | What happens | `fallback.reason` |
|---|---|---|
| `jev` selected, no key | Builtin for everything; one notice per process | `no-key` |
| 401 | Builtin until the key changes; one notice | `refused` |
| Past the deadline | The builtin answer, already computed | `late` |
| 429 or 529 | Hot path: builtin at once, never a retry. Sweeps: honor `retry-after` inside the sweep's time budget, then builtin | `rate-limited`, `overloaded` |
| 400 `max_tokens_exceeded`, 413, 422, an unparsable answer | Builtin; each is a bug in our own state builders and a failing test | `malformed` |
| Three consecutive failures | A breaker opens for 60 s; every decision runs builtin without a call | `degraded` |
| An answer inside the undecided band | That candidate or pair goes to the builtin rule | `undecided` (with names) |
| The response's `model` is not the pinned version | Builtin, because thresholds are fitted per version | `unproven-model` |

Constants, not config (D9): the hot path's grace is 150 ms after the tool (121-8), a sweep
request's deadline 5 s, the breaker 3 failures and 60 s. For the hot path the builtin selection
is computed locally beside the Jev request, so falling back costs nothing. For sweeps the
builtin is the LLM judgment where one is wired (escalating uncertain cases to a stronger model
is the vendor's own advice) and a proposal with no auto-apply where none is. The breaker mirrors
`closingJudgment`'s existing degrade latch.

*As built (K13, 2026-10-16):* one reason joins the table. A request that fails before any
answer, with no connection or with a server error other than 529, is `unreachable`; it counts
toward the breaker like every failure except `refused`. A 403 is `refused` like a 401. Until
K14 the hot path's 150 ms is the Jev request's own deadline, measured from the ask.

**121-7 · Odds, not verdicts: thresholds that respect the calibration evidence.**

- Recall questions (a `noul` per candidate): drop at p ≤ 0.10, rank first at p ≥ 0.90,
  anything between is the builtin rule's call. Nouls ran underconfident in the one test that
  measured it, so this band errs safe.
- Curation choices: act alone only inside the blast radius (both notes agent-authored, J-D4's
  invariant), at top probability ≥ 0.95 with `confidence` ≥ 0.90; stage a proposal showing the odds
  at top ≥ 0.50; below that, escalate to the builtin LLM judgment or propose without acting.
  `contradiction` always goes to the inbox, as today.
- Nothing acts inside 0.70 to 0.90, the band where the TDS test found 53% accuracy behind a
  stated 0.81. The Gardener's `promote` and `act` of 0.8 sit inside that band; they stay what
  they are for the builtin's self-reported numbers and are never reused for Jev's.
- Thresholds belong to one question and one model version and are never carried across
  phrasings (a `noul` and a `choice` of the same judgment differ by 0.125 on average).
- **Calibration is shipped, not learned.** K15 fits a map per question and model version on the
  eval corpus (isotonic, reported with the ECE noise floor), and the map is a reviewed constant
  in code. Nothing adapts on one machine from its own history, so the decider's behavior stays
  reproducible from code, config and the record: J-D6's rule, applied to odds.

**121-8 · Decide early, join late.** Today the hot path waits up to 150 ms for recall before a
mutating tool runs (`agent.ts:623`). Under either decider, the decisions for every mutating call
in a reply start the moment the reply's calls are known (before the gate asks, so a person's
think time hides them too), the tool runs without waiting, and the recall is joined to the
result when the tool finishes, with 150 ms of grace. A decision past the grace takes the builtin
selection computed beside it. The worst-case added wait stays today's 150 ms; a `bash` that runs
for seconds hides Jev entirely; a fast `edit` pays at most the grace. A call the gate denies
discards its decision. `waitedMs` is the number the eval gates on.

**121-9 · What leaves the machine, and what never does.** Two classes. A decision that replaces
an LLM call sends what that call sends today, to a different processor and usually less of it.
A decision that replaces a local rule is new egress, named here.

| Question | Today | Under `jev`, sent to TypeSafe | New egress |
|---|---|---|---|
| `action-relevance` | Nothing leaves (local BM25) | The tool name and subject (the path, or the command's first line, at most 200 characters) and at most 5 candidates as title, layer and excerpt (the first paragraph, at most 480 characters) | Yes |
| `entry-durability`, `entry-kind` | Arc close and bot sweeps send entries to the closing model; the workspace sends nothing (dormant) | One entry's text and at most 3 neighbor excerpts | Yes at workspace level; the distiller then reads only what Jev passes |
| `pair-relation` | Both bodies to the closing model | Both bodies, at most 2,000 characters each (the embedding cap) | No |
| `drift-verdict` | The note and the evidence lines to the chat model | The same | No; the code lines change processor (Q5) |
| `mention-is-link` | Nothing | The sentence around the mention, the target's title and excerpt | Yes |
| `search-relevance` (K19) | Nothing | The model's own query, hit titles and 120-character snippets | Yes |

Memory content leaves as **excerpts** for recall questions (TencentDB's ids-and-descriptions
posture) and as **bounded bodies** for curation questions, which cannot tell a duplicate from a
contradiction without the claims (Jev-Mem's posture). Every string passes
`redactForPersistence` (exact secret environment values, then secret shapes) on its way out:
vault text was redacted when it was written (P5), but a command line was not. Never sent: the
conversation, the person's prompts (Q13 aside), tool output, file contents (drift's evidence
lines aside), staged untrusted content (Q15 aside), and the TypeSafe key in any body, event,
session file, log or diagnostic (IR-17). An untrusted workspace decides nothing, because its
memory is inert (P1). The onboarding card and `keywork connect typesafe` state TypeSafe's terms
in one line: Jev sees the notes it is asked about; TypeSafe says it never trains on them and
keeps them for a period it doesn't state, unless the account has enterprise zero retention.

**121-10 · The key is a connection, kept where the Anthropic key is kept.** `keywork connect
typesafe` is the only door (IR-15's one management surface). `cli/src/inference/builtins.ts`
gains `builtInDeciders` beside `builtInProviders`:

```ts
{
  name: "typesafe",
  label: "TypeSafe Jev (memory decisions)",
  protocol: "systemone",
  endpoint: "https://api.typesafe.ai/v1",
  defaultModel: "jev-1.13.0",
  auth: {
    kind: "api-key",
    scopedVariable: "KEYWORK_TYPESAFE_API_KEY",
    ambientVariable: "TYPESAFE_API_KEY",
    keyUrl: "https://console.typesafe.ai/keys",
  },
}
```

`connectionsPort.targets()` lists it under its own heading ("memory decisions") so nobody
mistakes it for a chat provider; the inference registry never reads `builtInDeciders`, so
`/model`, routing and roles cannot bind it. The key lands where the Anthropic key does:
`saveCredential("typesafe", …)` puts it in the OS credential store as `provider.typesafe`
(DPAPI, Keychain, Secret Service) with only the name in `~/.keywork/auth.json`, or in
`auth.json` itself under `secretStore: "plaintext"`. Precedence is the built-ins' own:
`KEYWORK_TYPESAFE_API_KEY`, then the saved key, then `TYPESAFE_API_KEY` (the variable
TypeSafe's SDKs read). Verification is `GET /v1/models` with the bearer key; `verify.ts` learns
to read TypeSafe's `models` list beside `data`; a 401 is `not saved: TypeSafe refused the key`;
a list without the pinned version saves with a notice. TypeSafe publishes no key prefix, so
there is no prefix check. Removing the connection forgets the vault secret and drops memory to
builtin with the `no-key` notice. At the end of a successful connect keywork asks one question
(Q3), `use Jev for memory decisions now? [Y/n]`, and on yes writes `"memory": { "decider":
"jev" }` to the user config and prints the line it wrote.

`keywork doctor` gains one row, read from config, the credential and connect's observations,
with no network call:

```
memory decider  builtin · keywork's own rules
memory decider  jev · jev-1.13.0 · saved key (OS credential store) · verified 2026-10-15 · 2 of 6 questions proven
memory decider  jev selected · no TypeSafe key · keywork connect typesafe
memory decider  jev · key refused 2026-10-15T09:12Z · keywork connect typesafe
```

*As built (K13, 2026-10-16):* TypeSafe's list answers `models[].name` and names only the
aliases (models page, read 2026-10-16), so the pinned version is never in it and the notice
always prints: `TypeSafe's list does not name jev-1.13.0 · keywork asks for it by version and
checks the model behind every answer`. Connect states the terms line of 121-9 before it asks
for the key. The proven count reads `0 of 5`: the catalog maps the five questions the port asks;
`entry-kind@1` joins it when `EntryTriage` carries a kind. An environment key shows as its
variable's name, and the trial flag adds `trial on (KEYWORK_DECIDER_TRIAL=1)`. A runtime 401 is
recorded as connect's `lastFailure` so the refused row survives the process.

**121-11 · The first-run moment teaches and never configures.** IR-16 holds: nothing invokes
`connect` for the person. In the terminal, `tui/src/tips.ts` gains one tip, wanted when the
vault has notes and no TypeSafe key is saved (`memory can ask Jev what to recall · keywork
connect typesafe`), and the memory pane's header names the decider (`decider builtin`,
`decider jev · 2 proven`, `decider jev · no key · keywork connect typesafe`). In the app, the
onboarding card (AJ4) shows in the memory pane while `GET /memory` reports `decider.selected:
"jev"` with `credential: "missing"` or `"refused"` (persistent, because memory is quietly
running builtin), and once per workspace as a dismissible invitation when the decider is
builtin and no key exists (Q7). Its one action opens a terminal pane running `keywork connect
typesafe`, AD2's onboarding rule; it has no field for a key and no toggle for the decider.

**121-12 · The wire, additive to contract 1.x.**

- `GET /memory` gains `decider`: `{ selected, active, credential: "saved" | "environment" |
  "missing" | "refused", model?, proven: string[], lastFailure?: { at, reason }, nextAction? }`.
  The credential is reported as a fact, never as a value.
- `GET /memory/decisions?session=<id>&question=<id>&limit=<n>` (`listMemoryDecisions`): the
  newest decisions from the session journal and the machine-local sweep log, capped at 256.
- `memory.decided` joins `engineEventTypes` (in-turn, on the session's id) and is recorded as a
  server event with an empty `sessionId` for sweeps and commands.
- `ContextInjection.decision?: string`; staged review items gain optional `decision`, `score`
  and `decider`.
- `docs/events.md` gains a "Memory decisions" section; `bun run contract:fixtures` regenerates
  both fixtures; `contractVersion` takes one minor bump.

**121-13 · The app displays decisions and never makes one.** keywork-app holds no key, calls no
decider, keeps no threshold and writes no keywork config (AD1, AD2, AD9). It renders the
decisions lens in the memory pane (AJ2), why a note arrived on a transcript row (AJ3), the
decider's state and the onboarding card (AJ4), and the odds on inbox cards (AJ5), all from
121-12's routes and events. Confidence renders as density (AD7: density carries state): a
decisive answer at full ink, an undecided one dim, a fallback with the builtin's rule in words.

**121-14 · An own client, a pinned model, a wire-shaped adapter.** `engine/src/memory/jev.ts` is
a small client over `FetchLike`: one `POST /v1/systemone` per decision point, an uncompressed
JSON body (a decision is a few kilobytes), zod-parsed answers, the request id kept for
diagnostics. The key arrives as a constructor option the way provider keys do and never leaves
the client. No `@typesafe-ai/sdk`: one more exact-pinned dependency for one POST buys nothing,
and the SDK's automatic retries would fight 121-6's no-retry hot path. The model is pinned to
`jev-1.13.0` in code; moving to `jev-1.14.0` is a change that carries a fresh K15 report, never
an alias. The adapter takes an endpoint, so a loopback server speaking the same shape (Strands
Decider's `strands-decider serve`) is a later registration with no egress, deliberately not
built here. Jev spend is priced from `usage.input_tokens` at the published rate and joins the
session ledger as a `decider` line in `/cost` (Q9); one sweep caps Jev input at a constant 200k
tokens, under a cent.

## Evaluation: proven before it is default

**The script** is `scripts/memory-eval.ts` (`bun run memory:eval`), with its modules under
`scripts/memory-eval/` (corpus, replay, judge, cassette, metrics, report), modeled on the soak
harness (`scripts/soak.ts`, `scripts/soak/budget.ts`). **The fixture** is
`packages/engine/src/memory/fixtures/decisions/`: `corpus.jsonl` (one decision point per line),
`vault/` (the vault as it stood), `labels.jsonl` (hindsight labels and the person's inbox
verdicts), and `jev-1.13.0.cassette.jsonl` (recorded Jev answers). It is built from keywork's
own dogfood workspace with Jordan's consent, scrubbed by `redactForPersistence` and a
read-through, plus the J4 probe corpus (`memory/recall-probe.ts`) extended with action cases.

Three verbs:

- `harvest --sessions <dir> --vault <dir> --out <dir>` walks recorded session files. keywork
  already records what an eval needs: every tool call with its arguments, every
  `context.injected` with its note, every `memory_search` and `memory_get` result, and
  citations through the J13 ledger. It snapshots the vault as it stood (git, or the ledger's
  before-content) and rebuilds each decision point: for action recall, the subject and the
  candidates the search returns against that snapshot; for curation, the entries and pairs the
  Gardener would weigh and the person's own approve or discard on any proposal that reached
  them. Local only.
- `run --decider builtin|jev|off --corpus <dir> --out artifacts/memory-eval/<stamp>` replays
  every decision point through one decider. `off` is `recall-probe.ts`'s `memoryOffControl`,
  the floor. Jev answers go to a cassette and later runs replay from it, because Jev is not
  deterministic; a fresh cassette is a new measurement. CI runs builtin and the cassette, never
  live Jev; a live run needs a key and costs cents.
- `report` prints the table below and every disagreement between the arms as an example.

| Measure | How it is taken |
|---|---|
| Tokens injected | The note tokens each decider would inject per decision point, and carried tokens: each injection times the turns it rides until compaction or the session's end, from the recorded timeline. |
| Recall quality | Hindsight labels per candidate: relevant when the note is cited (`[[link]]`, J13) or acted on in the next three turns, as judged by a `judge` role (`roles.judge`, the person's own chat model; nothing goes to TypeSafe for judging) reading those turns, the action and the note. Reported as recall of relevant notes, precision, and harmful drops (relevant notes the builtin kept and Jev dropped), each harmful drop printed. |
| Answer quality | On a sample of decision points where the arms disagree, the next model turn is re-run from the recorded history with each arm's injection, and the judge compares the continuations blind, order randomized. Expensive and decisive; run on demand. |
| Curation quality | Agreement with the person's past inbox verdicts on merge, supersession, promotion and link proposals (from the ledger and `curation.md`), and with the judge on pairs no person saw. |
| Latency | Per question p50 and p95; on the hot path, `waitedMs` p50, p95 and max; fallback rate by reason. |
| Calibration | Per question and model version: reliability bins, ECE with a noise floor, the fitted map, and a complement probe (a question and its negation on a sample should sum to 1). |
| Cost | Jev input tokens at $0.042 per million; builtin LLM spend from the session ledger's priced usage. |

**The gate (proposed, Q10).** A question joins the proven set when, on the held-out half of the
corpus: (1) recall of relevant notes is within 0.02 of the builtin's and harmful drops are under
2% of relevant notes; (2) tokens injected fall to 60% of the builtin's or less (recall
questions), or background spend to 20% or less (curation questions); (3) hot-path `waitedMs` p95
is under 50 ms; (4) ECE after the shipped map is under 0.05; (5) for curation, agreement with
the person's own verdicts is at least the builtin's. Making `jev` the default, or the default
whenever a TypeSafe key is saved, is a separate decision taken on the report, never by code.

## Tasks

Sizes on the README scale (1pt about an hour or two, 2pt a half-day, 3pt a day).

### keywork

| Task | Size | What | Accept | Needs |
|---|---|---|---|---|
| **K10 the port and the builtin** | 2 | `engine/src/memory/decider.ts` (`MemoryDecider`, `MemoryDecision`, question ids) and `builtinDecider` over today's code; `point-of-action.ts`, `gardener.ts` and `drift.ts` take a decider; `memory.decided` on the bus, journaled as `memory_decision` and replayed; the builtin's `rule` in words; `docs/events.md` | Every existing memory, gardener, drift and agent test passes unchanged; each action recall emits one decision with its candidates, kept and dropped; replay re-emits from the journal; `bus.test.ts` and the event contract agree | Nothing: lands first, alone |
| **K11 the switch** | 1 | The composition picks the decider from `memory.decider` (the key and its project-layer strip landed with K10) and the credential; the `no-key` notice; the `.keywork/workspace.json` builtin pin (decision 6); deletes K10's startup refusal | `jev` without a key composes builtin and notices once; a pinned workspace composes builtin under `jev` and nothing in its project files can select `jev` | K10, K13 |
| **K12 the key** | 2 | `builtInDeciders` with protocol `systemone`; `keywork connect typesafe`; `verify.ts` reads `models`; credential `provider.typesafe` in the OS store; environment precedence; removal; the closing question (Q3); the doctor row; the tip | Connect stores into the OS store and `auth.json` keeps only the name; a 401 refuses; `/model` and roles never see `typesafe`; a doctor row per state; removal drops to builtin | K11 |
| **K13 the Jev adapter** | 3 | `engine/src/memory/jev.ts` (client over `FetchLike`, pinned model, deadlines, breaker, error mapping) and `jev-questions.ts` (catalog, state builders with caps and redaction, answer parsing, bands, proven set); `withFallback` | Contract tests over recorded `noul` and `choice` responses; every row of 121-6 forced through a fake server; a secret in a command line never reaches a request body; an unproven question never calls out | K10, K12 |
| **K14 decide early, join late** | 2 | `Agent` starts action decisions when a reply's calls are known, runs the tool, joins with 150 ms of grace; `ContextInjection.decision` | A decider slower than the tool adds at most the grace; a denied call discards its decision; several calls in one reply each join their own; `waitedMs` recorded | K10 (K13 for the live path) |
| **K15 the eval** | 3 | `scripts/memory-eval.ts` (`harvest`, `run`, `report`), `scripts/memory-eval/`, the fixture directory, the cassette, the `judge` role; `bun run memory:eval` | The builtin arm reproduces the journaled injections of harvested sessions exactly; cassette replay is byte-stable; the report prints every measure; CI runs builtin plus cassette | K10 (the Jev arm needs K13 and a key) |
| **K16 curation through the decider** | 2 | Under `jev` the workspace Gardener wakes: `entry-durability` triage, the distiller on passed entries only, `pair-relation` with escalation, merged bodies from the chat model for auto-applied merges only, `mention-is-link`; proposals carry `decision`, `score`, `decider`; the machine-local sweep log; 121-7's bands (proposal-only first, Q14) | The blast-radius test is unchanged (a human-authored note is never touched); a decisive agent pair merges, an undecided one escalates, a contradiction is always a card; the sweep's token cap holds | K13, K15 (the questions proven) |
| **K17 over the wire** | 2 | `GET /memory` `decider`, `GET /memory/decisions`, `memory.decided` in both event lists, the staged-item fields, regenerated fixtures, one minor bump | Server and serve tests for both routes and for the event on SSE, in-session and process-level; `check:contract` green | K10, K12 |
| **K18 the terminal shows it** | 2 | TUI memory pane: the decider in the header and a decisions lens; the fold on a recall row reads `recalled [[Auth Tokens]] · jev 0.94` or `recalled [[Auth Tokens]] · builtin · shares "auth" with the path`; inbox cards show the odds | Model tests and a capture of the lens; the zero-decision state is calm | K10, K16 |
| **K19 search trim and the skill hint, only if earned** | 2 | `search-relevance@1` and, if Q13 says yes, `skill-applies@1` | Each passes the K15 gate before it ships | K15 |

### keywork-app (display only)

App tasks are AJ-numbered so they can join the app's plan without colliding with its M, N, S and
W ids.

| Task | Size | What | Accept | Needs |
|---|---|---|---|---|
| **AJ1 the protocol mirror** | 1 | `@keywork-app/protocol` gains `MemoryDecision`, the `decider` block, `listMemoryDecisions`, `ContextInjection.decision` and the staged-item fields | `check-contract` green against the keywork release that carries K17 | K17 released and pinned |
| **AJ2 the decisions lens** | 2 | A `decisions` lens in `packages/ui/src/panes/memory` beside garden, note, ledger and daily: newest first, one row per decision (`jev · action recall · edit src/auth.ts · kept 1 of 3 · 0.94 · 212 ms`), fallbacks named with the builtin's rule, confidence as density tokens, live on `memory.decided` | Projection tests from envelope fixtures; rows for decisive, undecided, fallback and builtin; the empty state teaches | AJ1 |
| **AJ3 why this note** | 1 | A recall on a conversation tool row unfolds to its decision: odds, or the rule in words | A row with a `decision` id shows it; a row without one shows nothing new | AJ1 |
| **AJ4 the card and the chip** | 1 | From `GET /memory` `decider`: a chip in the memory pane header; the card per 121-11, whose one action opens a terminal pane running `keywork connect typesafe`; the invitation's dismissal kept in the app's per-workspace storage | No input element for a key exists anywhere in the app (a test asserts it); the persistent card clears when the server reports a saved key | AJ1 |
| **AJ5 odds on the inbox** | 1 | Proposal cards show `score` and `decider` | Display test | AJ1, K16 |

### Order

K10 lands first and alone: it changes no behavior and gives every later task, and the eval's
builtin arm, the record to stand on. Then three lanes run in parallel: the key (K11, K12), the
adapter (K13, then K14), and the eval (K15's harvest and builtin arm). The Jev arm of K15 runs
once K13 and a key exist, and its report is what lets K16 and K19 ship. K17 and K18 follow
K10's event shape. The app lane (AJ1 to AJ5) starts when a keywork release carries K17 and the
app pins it. Nothing flips a default. Points: keywork 21, app 6.

**The order of record** (decided (Jordan, 2026-10-15)): K10 first and alone, landed the same
day; then K13 (the Jev adapter) and K15 (the eval) in parallel. K13 needs no saved key to be
built, because its client takes the key as an option and its tests run against a fake server;
K11 and K12 follow and compose what K13 built.

## Decisions of record (Jordan, 2026-10-15)

Raised as sixteen questions with a recommendation each; Jordan accepted every recommendation on
2026-10-15. The numbering is the questions' own.

1. **One switch or many?** Decided (Jordan, 2026-10-15): one key,
   `memory.decider: "builtin" | "jev"`, with the proven set in code deciding which questions Jev
   may take. D9, and per-question readiness is measured, not a taste. The key landed with K10.
2. **The value's name.** Decided (Jordan, 2026-10-15): `"jev"`. A local decider, if it comes,
   adds a value.
3. **Does `keywork connect typesafe` turn it on?** Decided (Jordan, 2026-10-15): yes, by one
   question at the end of a successful connect (`use Jev for memory decisions now? [Y/n]`,
   default yes) that writes the user config and prints the line it wrote (K12).
4. **Excerpts or bodies for recall?** Decided (Jordan, 2026-10-15): excerpts (title, layer, the
   first paragraph up to 480 characters) for recall questions; bodies capped at 2,000
   characters only for curation and drift (K13's state builders).
5. **May diff lines leave for drift?** Decided (Jordan, 2026-10-15): yes, bounded as today (12
   lines, 6,000 characters); the person runs `keywork memory drift` on purpose, and the builtin
   already sends the same lines to the chat provider.
6. **A workspace's refusal.** Decided (Jordan, 2026-10-15): yes. `.keywork/workspace.json` may
   pin a workspace to builtin, narrowing only and never turning Jev on: the one project-layer
   memory key, for repositories whose memory must not leave the machine. It lands with K11,
   where the composition first has a choice to narrow; K10 does not carry it.
7. **The first-run moment.** Decided (Jordan, 2026-10-15): both. A one-time invitation for
   everyone (the terminal tip and the app card, dismissible) and the persistent card whenever
   Jev is selected without a usable key (121-11; K12 and AJ4).
8. **Act thresholds.** Decided (Jordan, 2026-10-15): these constants until K15's per-question
   maps replace them. Curation auto-applies only at ≥ 0.95 with confidence ≥ 0.90 and only
   inside the blast radius; recall drops only at p ≤ 0.10.
9. **Jev spend in `/cost`.** Decided (Jordan, 2026-10-15): a `decider` line, priced from
   reported usage.
10. **The gate numbers.** Decided (Jordan, 2026-10-15): K15's five criteria and margins as
    written (0.02 recall, 2% harmful drops, 60% tokens, 50 ms p95, 0.05 ECE), tightened after
    the first report.
11. **Pin or alias.** Decided (Jordan, 2026-10-15): pin `jev-1.13.0` in code and bump by eval;
    `jev-1.14.0` (the preview since 2026-10-14) gets its own report.
12. **Trying it before the eval lands.** Decided (Jordan, 2026-10-15): yes.
    `KEYWORK_DECIDER_TRIAL=1` lets Jev take unproven questions on the machine that sets it,
    with a notice each session so nobody forgets it is on; never config, never a default (K13).
13. **Skill hints.** Decided (Jordan, 2026-10-15): no, until K15 shows wasted skill loads cost
    more than a few hundred tokens a session. No prompt leaves the machine.
14. **Waking workspace curation.** Decided (Jordan, 2026-10-15): proposal-only for the first
    release (nothing auto-applies at workspace level), then 121-7's bands once the inbox
    verdicts in K15 support them (K16).
15. **An injection score on staged untrusted writes.** Decided (Jordan, 2026-10-15): not in this
    overlay; revisit after K15. Untrusted content never goes to TypeSafe.
16. **The default, later.** Decided (Jordan, 2026-10-15): no flip in this overlay; a passing
    report comes to Jordan first.

## Rejected

- **Jev at the gate.** Permissions, asks and grants are the gate's (the E-stream, J-D7). A
  decider that answered or loosened an ask would be a second policy engine; keywork-app's
  guardrail 3 says the same of the app.
- **Jev writing anything.** No titles, bodies, merged text, summaries or reasons come from the
  decider. It cannot generate, and a persisted string with no author is what J-D4's provenance
  exists to prevent.
- **Raw transcripts as state.** No conversation turns, prompts or tool output go to TypeSafe;
  this alone rules out a Jev-gated flush and a prompt-routed bootstrap.
- **Jev approving untrusted writes or promoting by confidence.** Trust is granted (J-D6); the
  airlock is the person's.
- **Jev on arithmetic.** Flush and compaction timing, budgets, usefulness and curing stay code;
  Jev is documented to be unreliable at arithmetic, counting and dates.
- **A Jev-ranked bootstrap or a per-turn skill roster.** Both rewrite the cached prefix on
  every request and would cost more than they save.
- **`score` questions.** The worst-calibrated type in every independent test, and unneeded:
  every judgment here is a choice or a yes or no.
- **Thresholds learned on the machine.** Behavior that drifts with personal history breaks
  J-D6's reproducibility; maps ship as reviewed constants.
- **Retries in the hot path, aliases in code, an SDK dependency, a gateway in the middle.**
  OpenRouter, Vercel, Zuplo, Portkey and LiteLLM all route Jev; each adds a processor and a
  second key.
- **A key field or a decider toggle in the app,** an app-side decider, or the app reading
  `auth.json`.
- **Popularity in the decider's state.** F2 kept usefulness out of rank; the decider judges
  relevance to the moment, not fame.
- **Letting Jev widen scope or reach a layer the session cannot see.** J6 fails closed; the
  decider sees only what the session's recall already returned.

## What is deliberately not in it

- A local decider (Strands Decider or any loopback `/v1/systemone` server): wire-ready by
  121-14, not built.
- Any other decision API (OpenAI's Decisions API): not evaluated.
- Jev anywhere outside memory (routing, titles, tool choice, review): this overlay owns memory
  only.
- Proactive recall in the memory pane (J9's file-open recall): when it lands it should use
  `action-relevance` as its relevance floor; it is not built here.
- Separate deciders for arc and bot layers: they share the session's decider through the
  composition.
- Any change to J-D4, J-D6, J-D7, the scope policy, staging or the airlock.
- Edits to other documents. On adoption, 95 gets a dated pointer under J-D8 and J7,
  `docs/events.md` and `docs/memory.md` gain their sections with K10 and K16, and the backlog
  README gets a row for 121.

## Sources (read 2026-10-15)

Each is flagged by whose word it is: **vendor** (TypeSafe), **independent** (no stated tie to
TypeSafe), **project** (a party with its own stake in the result), or **relay** (a third party
restating others).

- [TypeSafe API reference](https://docs.typesafe.ai/api): **vendor**
- [TypeSafe models](https://docs.typesafe.ai/models.md): **vendor**
- [TypeSafe confidence](https://docs.typesafe.ai/confidence.md): **vendor**
- [How to build with System One](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md): **vendor**
- [State](https://docs.typesafe.ai/concepts/state.md): **vendor**
- [Quick start](https://docs.typesafe.ai/introduction/quickstart): **vendor**
- [Legal index](https://docs.typesafe.ai/legal.md), [privacy policy](https://typesafe.ai/legal/privacy-policy), [data processing agreement](https://typesafe.ai/legal/data-processing): **vendor**, read directly
- [Latent Space: Jev, System One models for Prod, not God (Diogo Almeida)](https://www.latent.space/p/jev): **vendor** (the CEO, interviewed)
- [Latent Space AINews: Jev, a "System One Model"](https://www.latent.space/p/ainews-jev-a-system-one-model-that): **relay** of vendor claims, with community reactions
- [Jev-Mem: System-One-Controlled Agentic Memory, arXiv 2609.23986](https://arxiv.org/abs/2609.23986) and [HTML](https://arxiv.org/html/2609.23986): **independent** academic work, the authors' own results; affiliation from [AI Weekly](https://aiweekly.co/alerts/ut-dallas-jev-mem-cuts-agent-query-latency-367-on-locomo) (**relay**)
- [Jev in the Wild, arXiv 2609.30216](https://arxiv.org/abs/2609.30216): **independent** ecosystem study; affiliations not shown
- [Just Ask Jev, arXiv 2609.29429](https://arxiv.org/abs/2609.29429): **independent** as far as the page shows; abstract only read
- [TencentDB Agent Memory adds JEV decision support (dev.to)](https://dev.to/ellytan/when-should-an-agent-use-team-experience-tencentdb-agent-memory-adds-jev-decision-support-5296): **project**, self-reported numbers
- [Towards Data Science: Jev vs. LLMs](https://towardsdatascience.com/jev-vs-llms-when-ai-moves-from-generation-to-decision-making/): **independent**; refused our fetch (403), its figures taken from search summaries and unverified first-hand
- [jev-calibration-audit FINDINGS](https://github.com/jujumilk3/jev-calibration-audit/blob/main/FINDINGS.md): **independent**
- [jev-ood-calibration](https://github.com/scienthoon/jev-ood-calibration): **independent**
- [What is Jev (greennode)](https://greennode.ai/blog/what-is-jev): **relay** of third-party head-to-heads
- [promptfoo: TypeSafe provider](https://www.promptfoo.dev/docs/providers/typesafe/): **relay** of vendor statements, with its own caveats
- [Zuplo AI gateway: using Jev](https://zuplo.com/docs/ai-gateway/jev.md): **relay** (a gateway's docs)
- [How to get access to Jev and an API key (flaviocopes)](https://flaviocopes.com/jev-api-key/): **relay**; access status and rate-limit figures unverified
- [TechCrunch: Amazon releases its own Jev clone](https://techcrunch.com/2026/10/01/amazon-releases-its-own-jev-clone-as-decision-models-flood-the-web/): **independent** press
- [Strands Decider README](https://raw.githubusercontent.com/strands-labs/strands-decider/main/README.md): **project** (a competitor's own claims)
- [OpenAI Decisions API (eesel)](https://www.eesel.ai/blog/openai-decisions-api): **independent** test; dates and status conflict across sources
- [pi-fabric: Jev](https://cdn.jsdelivr.net/npm/pi-fabric@0.92.15/docs/jev.md): **project** (a community Pi extension); license unstated, ideas only

## Ledger

### K10 · the port and the builtin · landed 2026-10-15

**The port.** New `engine/src/memory/decider.ts`: `MemoryDecider` (`id`, `chooseForAction`,
`triageEntries`, `relatePair`, `assessDrift`, `weighMention`), each returning
`Decided<Outcome>` = `{ outcome, decision }`; `MemoryDecision` exactly as 121-5's table, with
`DecisionSubject`, `DecisionChoice`, `Selection`, `DecisionFallback` and `FallbackReason`; the
catalog as `memoryQuestions` (`action-relevance@1`, `entry-durability@1`, `entry-kind@1`,
`pair-relation@1`, `drift-verdict@1`, `mention-is-link@1`, `search-relevance@1`,
`skill-applies@1`) and the option lists `entryDurabilities`, `noteKinds` (J12's ontology plus
`none`), `pairRelations` and `mentionVerdicts`; the inputs `ActionCandidates` (`PendingAction`,
the hits, the surfaced set, `ActionBudget`), `EntryCandidates`, `NotePair` (`a`, `b`,
`similarity`), `DriftCase`, `MentionCandidate`; and the code every decider shares: `agesOf`
(which note of a pair is older, by `created`), `keptSideOf`, `screenForAction` (superseded,
already surfaced) and `actionBudgetFit` (the note cap and token budget, in words), plus
`recorded(decided, sink)`, which hands the decision to a `DecisionSink` and returns the outcome.

**The builtin.** New `engine/src/memory/builtin-decider.ts`: `builtinDecider({ curation?,
drift? })`, network-free. Action recall keeps a hit that is not superseded, not already
surfaced, has a lexical or semantic rank and fits the cap and budget, in search order, which is
`selectRelevant` moved here whole; entry triage answers `unsure` for every entry, which sends it
to the distiller as before; pair relation asks the wired `CurationJudgmentPort.classifyPair`
with the pair in the Gardener's own order and maps its verdict onto the catalog (`supersedes`
becomes `newer-supersedes-older` or `older-still-holds` by which note it keeps; a duplicate
keeps `older` or `newer`; distinct and contradiction pass through), or answers `unsure` with
no chat model; drift asks the wired `DriftJudgmentPort` and returns its assessment untouched, or
`unsure` with none; every mention the rule found is a `link`. Each decision carries the rule in
words: `[[Auth Tokens]] shares "auth" with the path; [[Old Auth]] is superseded`, `jaccard
0.41 · judged by closing:anthropic, keeping the older note`, `asked drift:anthropic · <its
reason, one line, 200 characters at most>`, `every trusted entry within the sweep budget goes to
the distiller`, `mentions "bun" without linking it`.

**Callers.** `point-of-action.ts` takes `decider?` (builtin when absent) and `onDecision?`, and
gains `pendingAction(call)` (the subject and whether it is a path or a command);
`gardener.ts` takes `decider?` and `onDecision?` and routes triage (before the distiller),
pair relation and unlinked mentions through it, the candidates still chosen in code
(`newestWithinBudget`, `similarPairs` at Jaccard 0.3, `unlinkedMentions`); `drift.ts`
`checkDrift` takes `decider?` and `onDecision?`, `judgment` now optional. Arc close (the
airlock's Gardener) and bot sweeps reach the port through the Gardener's builtin over the
judgment they already pass. `cli/src/compose.ts` wires point-of-action's `onDecision` to
`memory.decided` on the session bus.

**The record.** `memory.decided { decision }` joins `EngineEvents` and `engineEventTypes`;
`tapJournal` writes it as a `memory_decision` custom entry and `replayJournalEntry` re-emits it
with `replay: true`. `docs/events.md` gains "Memory decisions"; `bus.test.ts`, the server's
vocabulary check and both fixtures agree. `contractVersion` 1.1 to 1.2: the server's
compile-time vocabulary check makes the engine list the wire list, so 121-12's one minor bump
happens here, and K17's routes take their own.

**Config.** `memory.decider` in `configSchema` with 121-3's two descriptions verbatim; the
project layer's allowlist (`keybindings`, `palette`) already strips it, now tested;
`memoryDeciderOf(config)` answers `"builtin"` when unset. `cli/src/memory-decider.ts`
`refuseUnbuiltDecider`, called where every command loads its config (`inference-state.ts`), stops
startup on `"jev"` with `memory decider: jev selected, but this keywork has no Jev decider yet ·
set "memory": { "decider": "builtin" } in <the user keywork.json>`; `main.ts` prints it as it
prints a `ConfigError` and exits 1.

**Deviations from the text.** The port returns `Decided<Outcome>` (121-2's note): the record
never carries a body, and `chooseForAction`'s outcome is the kept `SearchHit[]`, because a
layered search can return two notes with one name (a workspace note and an arc note), which a
name-based outcome would merge. `PairRelation` is the catalog's six options; the Gardener's old
four-way verdict type is renamed `PairVerdictRelation`. `relatePair`'s outcome, `PairJudgment`,
carries `keep` for a duplicate, `confidence` (the chat model's own number, which the Gardener's
`act` threshold still reads) and the chat model's `mergedBody`; the record carries the option
name, the confidence and the rule. Pair curation and promotion still run only where a chat
model is wired, because the distiller and merged bodies are writing: the workspace Gardener
stays dormant under the builtin and asks only mention questions. Decisions outside a turn reach
`onDecision` on `GardenerOptions` and `DriftCheckOptions`, which nothing wires yet (K16's
machine-local log, K17's process-level event). Not here, by the task table: `ContextInjection.decision`
and `waitedMs` (K14), the workspace pin (K11, decision 6). The bootstrap order is not routed: the
inventory's row 10 keeps it out of the decider, and the rejected list says why.

**Tests.** `builtin-decider.test.ts` pins the builtin to the code it replaced: 300 random draws
against a verbatim copy of the old `selectRelevant`, every old pair verdict either way round
against the old `resolveKeep`, drift and triage pass-through, the rule in words.
`decider-routing.test.ts` proves each caller asks the decider it is given and records each
decision (the distiller sees only passed entries, a duplicate merges with the decider's body,
`unsure` acts on nothing, `no-link` stages no card, a drift verdict is stamped and staged, a
Gardener with no chat model asks no triage or pair question). `journal-decisions.test.ts` covers
the journal round trip and replay order; `cli/src/memory-decider.test.ts` the composed session
(bus, journal, replay) and the refusal at startup; `load.test.ts` the user-layer-only key. Every
existing memory, Gardener, drift, agent and CLI test passes unchanged: 368 files, 5057 tests
(364 and 5025 before), `bun run check` green.

### K13 · the Jev adapter · landed 2026-10-16

Built over the wave 7 server lane and K10. By the lane's brief it carries the parts of K11 and
K12 that make `"jev"` real: the composition's choice, the `no-key` notice in place of K10's
refusal, the key through `keywork connect typesafe`, the closing question and the doctor row.

**What was checked against TypeSafe (2026-10-16).** Read directly: the API reference
(`docs.typesafe.ai/api`, and its `.md`), the quick start and the models page. Verified there:
`POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>` and
`Content-Type: application/json`; a body of `{ state, model, questions }`, where `state` is a
string, object or array and `questions` maps keys the caller chooses ("not sent to the
underlying model") to `{ type: "noul", instructions, criteria?: { true?, false? } }` or
`{ type: "choice", instructions, criteria: { <option>: <description> } }` (255 options at
most); a response of `{ model, answers, usage: { input_tokens, output_tokens } }`, a noul
answering `{ type: "noul", noul }` with no confidence and a choice answering `{ type:
"choice", choice, probabilities, confidence }`; statuses 400 (`max_tokens_exceeded` among its
causes), 401, 413, 415, 422, 429 and 529, with JSON error bodies of no documented shape; the
quick start's sample answers `"model": "jev-1.13.0"` to a request for `jev-latest`; the
models page lists `jev-1.13.0` (`jev-latest`) and `jev-1.14.0` (`jev-preview`), $0.042 per
million input tokens with output free, and `GET /v1/models` answering `{ models: [{ name,
description, release_date }] }` that "currently lists the aliases", versioned names being
accepted either way. Two readings in this overlay were incomplete and are settled in code: a
noul answers in a field named `noul`, and the models list is `models[].name`. From a
third-party guide only (flaviocopes): the `x-typesafe-request-id` header and `retry-after` on a
429. Assumed with no source: a 403 is a refusal like a 401, a 5xx other than 529 is
`unreachable`, `retry-after` is seconds or an HTTP date, and the key page is
`https://console.typesafe.ai/keys`. No live call was made: no key exists, and the tests never
touch the network.

**The client.** New `engine/src/memory/jev.ts`: `jevClient({ key, endpoint?, fetchFn?, ... })`
over `FetchLike` with no new dependency. One `POST <endpoint>/systemone` per decision point, an
uncompressed JSON body `{ model: "jev-1.13.0", state, questions }`, the key only in the header.
Replies are zod-parsed and must answer every question asked with the type asked (a choice
outside the offered options is `malformed`). The model is pinned (`jevModel`); any other model
in a reply is `unproven-model`, with what it cost kept. Deadlines are constants
(`jevDeadlines`: 150 ms hot path, 5 s sweep), enforced by a timer that also aborts the request.
A 401 or 403 latches `refused` for the client's life (a reload after connect builds a new
client); three failures in a row open the breaker for 60 s (`degraded`); a sweep honors one
`retry-after` that fits its deadline, the hot path none. `jevStateHash` is the SHA-256 of the
state sent; the request id rides the reply and `onFailure`.

**The catalog.** New `engine/src/memory/jev-questions.ts`: `jevQuestions` maps the five port
questions (`action-relevance@1`, `entry-durability@1`, `pair-relation@1`, `drift-verdict@1`,
`mention-is-link@1`) to Jev questions, each a plan of `{ ask, read }` whose state builder caps
and redacts and whose reader applies the bands. Recall: one noul per candidate keyed by note
name (the layer appended when two layers share a name), five candidates at most, each sent as
title, layer and first paragraph at 480 characters (decision 4), the subject already bounded at
200 characters. Curation and drift: bodies at 2,000 characters; drift's evidence goes through
the builtin's own `boundedDriftEvidence` (now exported from `drift.ts`), so the 12 lines and
6,000 characters are the same bytes the chat model gets (decision 5); a mention sends the
sentence around it and the target's excerpt; an entry, its text and at most three neighbor
excerpts. Every string is redacted before it is capped (`scrubberFor`), so a cut never leaves
half a secret. Bands (`jevBands`, decision 8): recall drops at p 0.10 or less and ranks first
at 0.90 or more; a drift or durability verdict decides at a top answer of 0.90; a pair relation
acts alone at 0.95 with TypeSafe's confidence at 0.90, is a proposal from 0.50, and escalates
below; `unsure` is never decisive. The proven set is K15's: `jevDecider` reads
`provenQuestions(client.model)`, the pinned model id being the edition a report is named for,
so a question reaches Jev only through an entry `{ edition: "jev-1.13.0", question }` in
`memoryEvalProofs` checked in beside its report. The list is empty.

**The composition.** New `engine/src/memory/jev-decider.ts`: `jevDecider({ client, trial?,
secrets?, proofs? })` and `withFallback(jev, builtin)`. An unproven question (no trial) never
calls out and returns the builtin's decision untouched. A failure returns the builtin's
decision with `fallback: { reason }` and the true latency. Recall computes the builtin beside
the request; with an answer, policy screens first (superseded and already surfaced are never
asked), Jev's decisive odds drop or rank first, the rule settles the middle (named in
`fallback.undecided`, its words in `rule`), and the cap and budget run last over Jev's firsts
and then the rule's keeps. Sweep questions ask the builtin only when Jev failed or was
undecided, so a chat-model judgment is spent only where Jev could not decide. Every Jev
decision carries `scores`, `confidence`, `model`, `inputTokens` and `stateHash`.

**The CLI.** `cli/src/memory-decider.ts` replaces the refusal: `memoryDeciderSetup` reads
`memory.decider`, the key (`KEYWORK_TYPESAFE_API_KEY`, then the saved `typesafe` key, then
`TYPESAFE_API_KEY`) and `KEYWORK_DECIDER_TRIAL` (environment only; `"1"` turns it on), and
hands the composition a `deciderFor(seams)`; it feeds the scrubber every secret-named
environment value and every saved API key. `openInferenceState` builds it on every load and
prints its notices once per process. `compose.ts` gives point-of-action recall the composed
decider and prints the trial notice through the composition's own notice channel, so each
`keywork chat`, `run` and `panes` launch and each workspace `keywork serve` opens says it.
`builtins.ts` gains `builtInDeciders` (the 121-10 entry, its endpoint and model taken from the
engine's constants), and the runtime refuses a connection named `typesafe`, so `/model`,
routing and roles never see it. `inference/typesafe-connection.ts` verifies with `GET
/v1/models`, saves with `saveCredential("typesafe", …)` (the OS store as `provider.typesafe`,
only the name in `auth.json`), records connect's observation and writes `memory.decider`;
`verify.ts` reads `models[].name` beside `data[].id` and reports the status. `setup.ts` runs
the terminal flow, lists TypeSafe under a "memory decisions" heading, and asks the closing
question. `doctor.ts` prints the row from `deciderStatusOf`.

**Cost (decision 9).** `pricing.ts` lists `jev-1.13.0` and `jev-1.14.0` at $0.042 per million
input tokens and nothing for output. The TUI's `SessionLedger` counts the decisions this process
paid for (never replayed ones), and `/cost` prints a line such as `decider jev-1.13.0 · 2
decisions · 1500000 input tokens · $0.063`.

**The notices, verbatim.** No key: `memory decider: jev selected, no TypeSafe key · keywork
connect typesafe`. A refusal at runtime: `memory decider: TypeSafe refused the key, so memory
runs builtin until the key changes · keywork connect typesafe`. The trial, each session:
`memory decider: trial on (KEYWORK_DECIDER_TRIAL=1) · Jev answers questions no eval has proven
yet`. Connect's question: `use Jev for memory decisions now? [Y/n]`, then `wrote "memory": {
"decider": "jev" } to <file>`, or on no `memory decider stays builtin · "memory": { "decider":
"jev" } in <file> turns Jev on`.

**Deviations from the text.** `FallbackReason` gains `unreachable` (121-6's note above).
`PairJudgment` gains an optional `band` (`act` or `propose`), and the Gardener honors it in
place of its own `act` threshold when present, because 121-7 forbids reusing 0.8 for Jev's
numbers; a Jev duplicate keeps the newer note, the Gardener's existing default, and carries no
merged body (K16 asks the chat model for one). `EntryCandidates` gains optional `neighbors`,
which nothing fills until K16. `withFallback` takes a `JevDecider` (client, proven set, trial,
scrubber) rather than a second `MemoryDecider`, because Jev alone cannot finish a recall: the
middle band is the rule's. The shared asks (`actionAsk` and its siblings) and the rule's
per-hit verdict (`relevanceByRule`) moved out of the builtin's private code so both deciders
write the same record. The reserved questions stay out of the catalog.

**Not here, and where it lives.** The `.keywork/workspace.json` pin (K11, decision 6). The
one-time invitation of decision 7: the task table gives the terminal tip to K12 and the card to
AJ4, so it is not built here. Removing the TypeSafe connection, and listing it in the TUI's
`/connect` overlay (K12; the terminal `keywork connect` lists it). The workspace Gardener and
`keywork memory drift` still build the builtin (K16 wires curation through the composition).
Decide early, join late (K14). The machine-local sweep log and the per-sweep 200k-token cap
(K16). The server's decider block, its routes, and decider spend in `/sessions/{id}/cost` (K17).

**What K15 must check in before a question is proven.** For each question and model version, a
report on the held-out half of the corpus that passes the five gates of decision 10, then an
entry `{ edition: "jev-1.13.0", question }` in `memoryEvalProofs`, in the same change.
`action-relevance@1`: recall within 0.02 of the builtin, harmful drops under 2% of relevant
notes, injected tokens at 60% of the builtin's or less, hot-path `waitedMs` p95 under 50 ms, and
ECE after the shipped map under 0.05. `entry-durability@1`, `pair-relation@1` and
`drift-verdict@1`: background spend at 20% of the builtin's or less, agreement with the
person's own inbox verdicts at least the builtin's, and ECE under 0.05. `mention-is-link@1`:
agreement with the person's verdicts on link cards at least the builtin's (which proposes every
card) and ECE under 0.05. A fitted map that replaces a band in `jevBands` lands with the report
that fitted it.

**Tests.** `jev.test.ts` (the wire, every status, the deadline and its abort, retries, the
refusal latch, the breaker); `jev-cassette.test.ts` over `fixtures/jev-wire.cassette.jsonl`
(TypeSafe's documented noul answer verbatim, and an action-relevance and a pair-relation
exchange whose requests must match the recorded bytes, their responses transcribed in the
documented shapes rather than recorded live); `jev-questions.test.ts` (the exact state per
question, every cap, redaction before capping, a command line's secrets out of the body, every
band edge); `jev-decider.test.ts` (unproven questions never call out, the trial, a proven
question, the eight failure reasons on every question family, `unproven-model`, `undecided`,
mixed recalls, the curation bands); `decider-routing.test.ts` (the Gardener honors `band`); and in the CLI the composed
session under `jev` (Jev's odds on the bus, `no-key` on trial, no fallback when unproven),
startup with no key, the refusal, the key's precedence, secrets kept out of the body, the
connect flow, the connection's storage, the doctor rows, the registry's refusal of `typesafe`,
and the ledger's decider line through `/cost`.

### K15 · the eval · landed 2026-10-16

**The script.** `scripts/memory-eval.ts` (`bun run memory:eval`) with `harvest`, `run` and
`report`, its modules under `scripts/memory-eval/`: `corpus` (the line shapes, halves, hashes),
`sessions` (a recorded session as turns, tool results and its journal), `exposure` (decisions 4
and 5 as code: redaction, then the 480-character first-paragraph excerpt, the 2,000-character
body, 12 evidence lines and 6,000 characters, the sentence around a mention), `harvest`,
`curation`, `judge`, `replay`, `arms`, `cassette`, `metrics`, `calibration`, `gate`, `report`,
`runs`, `proofs`, `recorder` and `fixture-sessions`. Bun only; no dependency added.

**Harvest** walks session files with keywork's own reader and rebuilds each action point the
way `point-of-action.ts` would have met it: `pendingAction(call)`, a denied call and a repeated
subject skipped, the search at the note cap (3) against the vault given, the surfaced set carried
from earlier points (the journaled `kept` where a `memory_decision` exists, the builtin's
otherwise), `actionRecallDefaults` as the budget (`--action-tokens` overrides). Each point
records `rides`, the assistant turns the injection rides until the next compaction or the end,
and the journaled decision when there is one. Curation points come from the real Gardener run
over a scratch copy of the vault with a listening decider and a silent chat model (so it weighs
every trusted entry, every pair past Jaccard 0.3 and every unlinked mention, and writes
nothing), pending staged `drift-review`s, and pairs the person already judged in `curation.md`.
Hindsight labels: a candidate is relevant when one of the next three turns cites it
(`[[link]]`) or reads it with `memory_get`; candidates the deterministic filters screen out
(already surfaced, superseded) are never labeled or scored, because no decider chooses them.
Inbox labels: `curation.md`'s `approved` and `discarded` lines for merge, supersession,
contradiction, link and drift keys. Judge labels: `roles.judge` or the default chat model (the
new `judgeRole` constant in `cli/src/inference/roles.ts`) reads the action, the note's excerpt and
the next three turns, and judges pairs no person saw; it runs only when a model resolves and is
skipped, with the reason in `harvest.json`, otherwise (`--no-judge` skips it on purpose). The
corpus never holds more than Jev would be sent; a re-harvest keeps `hand` labels.

**Run and the cassette.** `run --decider builtin|off|jev` replays every point through the
`MemoryDecider` port (`portArm`), so any decider runs through it; `off` keeps, triages and links
nothing. Answers and cassettes share one line shape. `jev` replays
`<corpus>/jev-1.13.0.cassette.jsonl`; a cassette that misses a point, or answers a point whose
state hash has changed, is refused rather than replayed; with no usable cassette and no
`KEYWORK_TYPESAFE_API_KEY` or `TYPESAFE_API_KEY` the run skips with the reason, and with a key
it records a fresh cassette through the adapter registered in `liveDeciders`
(`scripts/memory-eval/arms.ts`), K13's
`withFallback(jevDecider({ client: jevClient({ key }), trial: true }), builtinDecider())`: on
trial, because the eval is what proves a question, so Jev must answer every one of them. Line shapes (bodies
elided):

```jsonl
{"action":{"callId":"call-1","subject":"packages/cli/src/auth-store.ts","subjectKind":"path","tool":"edit"},"budget":{"notes":3,"tokens":1024},"candidates":[{"excerpt":"…","layer":"workspace","name":"Auth Store","ranks":{"graph":1,"lexical":1},"superseded":false,"title":"Auth Store","tokens":64}],"half":"fit","id":"credentials#call-1","question":"action-relevance@1","recorded":{"candidates":["Auth Store"],"decider":"builtin","kept":["Auth Store"]},"rides":6,"session":"credentials","surfaced":[]}
{"entry":{"date":"2026-10-08","id":"2026-10-08#0","provenance":"agent","text":"…","time":"09:12"},"half":"fit","id":"entry:2026-10-08#0","question":"entry-durability@1"}
{"a":{"body":"…","created":"…","name":"Shell Timeout","provenance":"agent","title":"Shell Timeout"},"b":{"…":"…"},"half":"fit","id":"pair:Shell Timeout|Command Timeout","question":"pair-relation@1","similarity":0.45}
{"evidence":["…"],"half":"fit","id":"drift:Auth Store","note":{"…":"…"},"question":"drift-verdict@1"}
{"half":"held-out","id":"mention:Biome Lint->Package Manager","mention":"bun","question":"mention-is-link@1","source":{"name":"Biome Lint","sentence":"…","title":"Biome Lint"},"target":{"excerpt":"…","name":"Package Manager","title":"Package Manager"}}
{"evidence":"cited 1 turn later","note":"Auth Store","point":"credentials#call-2","relevant":true,"source":"hindsight"}
{"answer":"duplicate","evidence":"discarded merge:… at …","holds":false,"point":"pair:Release Tagging|Release Pipeline","source":"inbox"}
{"decision":{"…":"the MemoryDecision"},"outcome":{"kept":["Auth Store"]},"point":"credentials#call-1","pointHash":"<sha-256 of the point's decided state>","question":"action-relevance@1"}
```

The last is an answer line, and a cassette line: `outcome` is `{ kept }`, `{ durability }`,
`{ relation, keep?, confidence }`, `{ verdict, reason }` (drift) or `{ verdict }` (mention).
Every file is written with sorted keys, so a replay is byte-identical to its cassette.

**Measures and the gate.** Per question on the held-out half (a stable hash of the point id
splits the corpus): tokens injected and carried; hindsight recall and precision; judge-rated
recall and precision when judge labels exist; harmful drops, each named; agreement with the
person's verdicts (`hand`, then `inbox`, then `judge`); latency p50 and p95; hot-path wait p50,
p95 and max (`waitedMs`, else `latencyMs`, since today's hot path awaits the whole decision);
fallbacks by reason; calibration (reliability bins, ECE before and after an isotonic map fitted
on the other half, a seeded noise floor, the map printed for review); decider cost at $0.042 per
million input tokens. Answer quality and the complement probe are printed as not run. The gate
holds decision 10 as written: recall within 0.02 and harmful drops under 2%; tokens at 60% or
less (recall) or spend at 20% or less (curation); wait p95 under 50 ms (hot path); ECE under
0.05; agreement at least the builtin's (curation). A question with nothing labeled held out, or
a decider that states no odds, does not pass.

**The proof.** `docs/memory-eval/<decider>-<version>.md`, and `memoryEvalProofs` in the new
`engine/src/memory/proven-questions.ts`, exported from the engine with
`provenQuestions(edition)`, `isQuestionProven(edition, question)` and
`deciderEdition(decider, version)`; an edition is the report's name, so Jev's is its pinned model
id, `jev-1.13.0`. The list starts empty, and `report.test.ts` fails when a listed question's
report is missing or does not prove it, or when a checked-in report proves a question the list
lacks, so a question reaches a decider only by a change that checks in both. K13's
`jevDecider` reads `provenQuestions(client.model)`, and `jevModel` is the edition the eval
names (`replay.test.ts` holds the two equal); `KEYWORK_DECIDER_TRIAL` widens it on one machine,
decision 12.

**The fixture and the reference.** `engine/src/memory/fixtures/decisions/`: a 20-note vault in
keywork's own conventions (a superseded note, a duplicate, a supersession, a contradiction,
unlinked mentions, two daily logs, three staged drift reviews, five inbox verdicts), six
sessions recorded by keywork's real engine (an `Agent` with point-of-action recall, the builtin,
the journal and memory's own recall tools; stand-in `write`, `edit` and `bash` tools) from the
scripts in `fixture-sessions.ts`, and what harvest writes from them: 42 decision points (23
action, 6 entry, 4 pair, 3 drift, 6 mention) and 61 labels (44 hindsight, 5 inbox, 12 hand
seeds). The builtin reproduces every journaled action injection of all six sessions.
`docs/memory-eval/builtin-1.md` is the reference: on 9 held-out action points it injects 967
tokens (107.4 a point), carried 3,066, at hindsight recall 1.00 (5 of 5) and precision 0.29 (5
of 17 kept): the blunt rule the inventory's row 1 names, a note in the context because it shared
"src" with the path. Its curation agreement is 0 of 4 entries, 0 of 2 pairs and 0 of 1 drift
(the builtin answers `unsure` with no chat model wired) and 1 of 2 mentions; it costs nothing and
states no odds.

**Deviations from the text.** The fixture's sessions are recorded from scripts rather than
harvested from the dogfood workspace: harvesting Jordan's own sessions is the on-request path
(`harvest --sessions ~/.keywork/sessions/<workspace>`), and the J4 probe corpus is not extended
(its cases are queries, not actions). Harvest reads the vault as given rather than rolling it
back through git or the ledger; the reproduction line in `harvest.json` names any session the
vault no longer reproduces. The builtin arm runs network-free, so its curation answers are
`unsure` and its spend is zero: a curation question cannot pass criterion 2 against it until the
arm can wire the closing model (K16's concern, with the inbox verdicts it will grow). Answer
quality (re-run turns, judged blind) and the complement probe (it needs a negated phrasing, K13's
catalog) are reported as not run. `entry-kind@1` is not measured: the port's `triageEntries`
returns durability only.

**Tests.** `calibration.test.ts` (ECE on known distributions, bins, the isotonic fit, the seeded
noise floor), `metrics.test.ts`, `gate.test.ts` (every margin at its edge), `report.test.ts`
(reference, challenger and skipped reports; the proof check against the real tree),
`exposure.test.ts`, `judge.test.ts`, `harvest.test.ts` (sessions recorded by the real engine in a
scratch vault: skips, rides, hindsight, redaction, judge, curation, inbox, hand labels kept; the
checked-in corpus is exactly what harvesting its sessions gives, and re-recording the scripts
with today's engine gives it again), `replay.test.ts` (the builtin reproduces every journaled
injection, the checked-in report matches a fresh run, live record then byte-stable replay, a
stale cassette refused, the CLI's clean skip) and `proven-questions.test.ts`: 9 files and 82
tests; 379 files and 5,177 tests in all (3 skipped), `bun run check` green.

### K13 with K15 · wired together · 2026-10-16

The two lanes met on main as the contract above says. K13's own proven list
(`jevProvenQuestions`, `provenQuestionsFor`, `ProvenQuestion`) is gone: `jevDecider` takes
`proofs?` and reads `provenQuestions(client.model, proofs)`, so `memoryEvalProofs` is the one
list, empty today, and the doctor's "0 of 5 questions proven" reads it through
`provenQuestions(jevModel)`. `scripts/memory-eval/arms.ts` registers the live adapter,
`withFallback(jevDecider({ client: jevClient({ key }), trial: true }), builtinDecider())`, so
the "no Jev adapter yet" skip is gone; `replay.test.ts` now proves that a key opens it live and
that it asks Jev even an unproven question (a stubbed 401 comes back as `fallback: refused`),
and holds `editionName(jevEdition)` equal to `jevModel`. The fixture recorder gives each search a
60-second deadline in place of point-of-action's 150 ms, because under a loaded full run a
search could miss it and drop a point's `recorded` decision, failing "still records the same
sessions"; that test, which records all six sessions, also gets 30 seconds instead of vitest's 5.
The corpus is unchanged.
