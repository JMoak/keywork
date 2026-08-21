# Bots — Proposal Overlay (2026-08-21, awaiting Jordan's decisions)

> **Discussion capture + proposed overlay.** Partly decided: Jordan's first-round answers
> (2026-08-21, recorded inline as **⟨J⟩**) settle the entity merge and the scope layout;
> the rest stays recommendation (PD21–PD24, written in the binding voice so they can be
> adopted by striking one word) with open questions for Jordan, now including the
> process-discipline discussion (Q-B8). Once adopted this file wins over
> [`105`](105-inference-resolution.md) and below where it speaks; until then it builds
> nothing. Every claim about landed code cites the tree as of 2026-08-21.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing before
> workstream G; Pi/OpenCode are MIT — adapt with attribution in `NOTICE`; Crush is FSL —
> never a source. The user commits; agents never `git commit`/`git push`.

## The idea (Jordan, 2026-08-21)

A **bot** is a named persona the user creates (`/new-bot`): a tiny optional system prompt
and a name (given, or self-chosen). Sessions can be started *as* a bot
(`/new-bot-session [name]`, picker when no name), so bots group session history — and,
the real point, each bot is an inner-project entity with its own learning arc and its own
distillation methodology fitted to what it does. Grok Bot (xAI, beta 2026-08-11) is the
named influence: persistent "teammates" that remember conversations, learn how you like
work done, and get sharper over time.

## Where it lands in the model we already have

keywork already has four organizing axes, each with a landed kernel:

| Axis | Entity | Answers | Kernel today |
|---|---|---|---|
| where | **workspace** | which declared working set, which vault | J1/J19 seams, `workspaceIdentity` |
| when | **arc** | which trajectory of work, with an end | `engine/memory/arcs/` (J17/J18 kernel landed 2026-08-16) |
| how much | **mode** | Plan · Recall · Agent, per session | `docs/modes.md` (E7 spec) |
| which | **session** | one conversation tree | Pi-format JSONL, Track T |

Nothing answers **who**. The closest thing is D6 "agents as markdown"
(`engine/src/extensions/markdown-agents.ts`): a name, an optional `model:`, a tool
allowlist, narrow-never-widen permission overrides, and a prompt body — switched per pane
with `/agent-<name>` (`tui/src/extension-commands.ts:63`). It is a *role*, stateless by
construction: no memory, no history, no identity on screen, and it is overloaded on the
word "agent" (the `Agent` class, Agent mode, sub-agents). A bot is exactly that role made
persistent: **bot = identity + definition + durable memory layer + session grouping +
learning policy.** That is one new axis, not a new system — it composes the arc kernel's
shapes (registry, bindings, boosted recall stratum, airlock door) and D6's composition
seam (`cli/src/compose.ts` `buildAgent`: `spec.definition` → `restrictTools` +
`narrowedPermissions` + prompt swap).

The clean mental model, one line each:

- a **workspace** is where you work, an **arc** is what you're working on, a **bot** is
  who you're working with, a **mode** is how much rope it has right now, a **session** is
  one conversation. Every axis is opt-in depth; a session bound to nothing behaves
  byte-for-byte as today (the arc rule, restated).

### Feedback on the concept, straight

**Strong, and it fits.** The memory ladder has a hole shaped exactly like this: session →
arc → workspace → user global is all *place and time*; "how Jordan likes reviews done" or
"this persona's routines" has nowhere to live except user-global (too flat, rare/explicit
by J-D1) or the workspace garden (wrong scope — it's about the craft, not the repo). A bot
layer is the *who* rung. It also gives Grok-style "learns how you like things done" a
home that is provenance-gated, readable, and one-key revertable — which Grok's opaque
cloud state is not.

**Three places the concept could go wrong, and the recommended guard for each:**

1. **Two persona concepts.** If bots land beside D6 agents, users meet "agent" and "bot"
   and have to learn the difference. Recommend **bots absorb agents** (PD21): the D6 file
   format stays (OpenCode lift, `NOTICE` unchanged), the *name* and the *directory* change,
   and a bot with `learning: off` is byte-identical to today's agent. Pre-release, zero
   migration — the arc/task-group precedent.
2. **A fifth door on the inbox.** The bot's distillation must not become a new ritual.
   Recommend it rides the existing session-end door (P3's door 1/2) with bot-layer items
   tagged by the bot's mark, plus a bot-scoped Gardener micro-sweep — J7 kernel, budget
   capped, proposals only. The arc airlock stays the only extra door.
3. **Scope bleed.** A user-scope bot used across workspaces could ferry workspace facts
   between repos through its own layer. Recommend the **content rule** (PD22): bot memory
   is about the bot's craft and the user's preferences, never about the code; workspace
   facts a bot learns go to the workspace/arc layer through the ordinary write path. This
   is a prompt rule plus the existing redaction/taint machinery, so it is honest to flag
   as residual risk (Q-B3) rather than pretend it is structural.

**Two simplicity-budget checks pass.** D2's "every addition carries a written
justification": the justification is the missing *who* rung above, and that the entity
costs nothing when unused. D9's "every config option is a design failure until
justified": PD23 adds exactly one new frontmatter key (`learning`) with named levels and
an omakase default.

### What "next level on Grok Bot" means here

What Grok ships ([x.ai announcement](https://x.ai/news/introducing-grok-bot)): always-on
teammates with their own cloud computer, you message them like colleagues, they "keep
context on how you like work done", watch you do something and save it as a routine, and
get more proactive over time. What keywork can do that it can't, using machinery already
landed or specced:

- **Bots are files.** Definition is a markdown file; memory is an Obsidian-citizen
  sub-vault; skills are a directory. Readable, diffable, git-able, team-shareable
  (project-scope bots ride the trusted-clone rules, D6 precedent: untrusted repo
  contributes zero).
- **Learning you can audit.** Every bot-layer line carries provenance (J-D4), untrusted
  origins are staged by construction, and the bot's self-improvement proposals — to its
  own instructions, to its skills — are inbox proposals against a protected-core file,
  never silent edits. "Routines" are J10 self-healing skills, versioned by reality.
- **Bots × arcs × panes.** Two bots on one arc in two tiles; the arc's delivery record
  credits contributing bots; `groupCosts` (landed for arcs, FR4.12) answers "what does my
  reviewer bot cost per week".
- **A bot that names itself and remembers you.** Self-naming through the PD20 titler
  path; on `/bot <slug>` the bot's briefing opens with its own "since you last used me"
  return delta (J23 pattern).

What keywork deliberately does **not** copy in v1: the always-on process. keywork has no
daemon (95 non-goals); a bot is a persistent *identity*, not a persistent *computer*.
Headless `keywork run --bot <slug>` is the CI/scripting door today; P2's server shape is
where a hosted bot run would live later.

## PD21 — The entity (items 1–2 decided by Jordan 2026-08-21; 3–5 proposed)

1. **Bots absorb D6 agents.** ⟨J⟩ *"join/merge the persona concepts with bots as the
   lead."* One user-facing persona concept, named **bot**. The
   definition format is unchanged (OpenCode-lifted frontmatter + prompt body); the type
   renames `AgentDefinition` → `BotDefinition`; `/agent-<name>` / `agent-none` become
   `/bot …`. "Agent" keeps meaning the loop (`Agent` class), Agent mode, and sub-agents.
2. **Layout: two spaces, project is the default.** ⟨J⟩ *"like mcp configurations:
   a global space for definition, and a project space — project/workspace is the default,
   global is there for users who are interested."* Project scope
   `.keywork/bots/<slug>/bot.md` (+ `skills/` beside it, per J-D5.4 skills stay outside
   the vault) is where `/bot new` writes unless the user picks global; user scope
   `~/.keywork/bots/<slug>/bot.md` is the opt-in (`/bot new --global`, or the scope row
   in the creation flow). Layered load through the landed `LayeredDirs` walk (built-in >
   project > user, the commands/agents/skills precedent), untrusted repo contributes zero
   bots. The bot's **memory** lives inside the vault of the scope it is declared in:
   `<vault>/bots/<slug>/` with its own `MOC.md` and daily logs — mirrors `arcs/<slug>/`
   exactly (R1: the MOC note is the bot's graph entity; bot-authored notes anywhere carry
   `learned_by: "[[bots/<slug>/MOC]]"`). A project bot is therefore git-able and
   team-shared with its memory; a global bot follows the user with its memory (Q-B3's
   residual risk is confined to the opt-in path).
3. **Identity.** Slug is identity (same validation as arcs: `validateArcSlug` generalizes
   to `validateSlug`); display name is a renameable handle (J1's name/identity split). A
   bot also carries a one-glyph **sigil** (default: first letter; user-settable) for
   narrow surfaces.
4. **Binding.** A session binds to at most one bot; binding and changes are session
   entries (E5's rule); forks and regular splits inherit (PD13 mirror); mid-session
   switch keeps today's `/agent` behavior — agent rebuild, refused mid-turn, recorded.
   Sessions bound to no bot run the default persona exactly as today.
5. **Definition frontmatter** (schema-validated, every key `.describe()`-justified):
   `description`, `model` (a **session selection seed** applied at bind as an ordinary
   `model_change` — IR-07 rank 2, never an override that fights `/model`; CD-04 stands),
   `tools` allowlist, `allow/ask/deny` narrowings (never widen, D6 rule), `sigil`,
   `learning` (PD23). No other keys.

## PD22 — The bot layer on the ladder (proposed)

The funding ladder gains a *who* stratum beside the arc rung, not above it:

```
session ledger ─► { arc layer · bot layer } ─► workspace vault ─► user global
```

1. **Content rule.** Arc and workspace layers hold knowledge about the work; the bot layer
   holds knowledge about the craft — how this persona does its job, preferences it has
   learned about the user, its routines, what it tried and abandoned. The flush prompt
   gains a bot clause ("what did you learn about doing this job / how the user likes it
   done"); a bot learning a workspace fact writes it to the workspace or active arc layer
   through the same write path with the same provenance, taint, staging, and redaction
   rules — per line, exactly as at workspace scope.
2. **Recall: adds, never hides.** The active bot's layer is a boosted stratum atop
   workspace + arc + user scope (the arc rule, `ArcRecall` composition reused); other
   bots' layers are excluded from ambient recall but explicitly searchable. J13 citation
   events carry the layer, so "is the bot's memory actually used" is measured, not hoped.
3. **Bootstrap.** The bot MOC transcludes in its own adaptive slice after the arc slice
   (J-D8 tunables; absolute readout in `/policy`). Unbound sessions: zero cost.
4. **Not a funnel stage.** Bot-layer notes do not distill upward by default — they are
   about the bot. The Gardener's bot-scoped micro-sweep (J7 kernel; session end; budget
   capped) merges/supersedes within the layer and proposes to the one inbox. Cross-bot
   meta-distillation is explicitly out of scope until real bot layers exist (J24's
   dogfooding gate applies).
5. **The digest is the existing door.** Bot-layer staged items surface in the session-end
   digest (P3 door 1/2) tagged with the bot's sigil. No new door, no new counter.

## PD23 — The learning policy (proposed)

One frontmatter key, named cumulative levels, omakase default:

| `learning:` | Adds | Notes |
|---|---|---|
| `off` | nothing | a stateless role; byte-identical to today's D6 agent |
| `notes` *(default)* | bot layer + flush clause + session-end digest + scoped micro-sweep | cheap, reversible, the Grok-style "remembers how you like it" |
| `skills` | J10 self-healing + skill genesis scoped to `bots/<slug>/skills/` | "routines", versioned by reality; genesis gates from 98's idea 11 hold (≥2 recurrences, one proposal per pattern ever) |
| `self` | proposals against the bot's own `bot.md` | protected core: the bot may only ever *propose* a change to its instructions, inbox-only, one-key apply/decline; never a direct write |

Rules beneath every level: J-D6 — a bot can never widen permissions (D6's
narrow-never-widen holds at every level); J-D7 — none of this touches tool trust; the
simplicity escape hatch — if `self` proves noisy in daily use, drop the level rather than
tune it. Per-bot model roles (J-D8 `flush`/`gardener` per bot) are deliberately **not**
offered; IR-14's shared resolver handles auxiliary inference and a future named-role
extension would cover bots without a bot-specific knob.

## PD24 — Surfaces & grammar (proposed)

1. **Commands** (replacing the sketch's `/new-bot` + `/new-bot-session` with keywork's
   existing verb grammar):
   - `/bot` — picker overlay (preset-picker precedent): existing bots (MRU, sigil, name,
     description, last used, session count) + **new bot**. Enter opens a new session pane
     bound to the chosen bot.
   - `/bot <slug>` — open a new bound session pane directly (the `/new-bot-session`
     verb).
   - `/bot new [name]` — the creation flow: one prompt for purpose (optional), one for
     name (optional). No name ⇒ the titler role proposes a slug from the purpose line
     (PD20 cheap-call path; `kebabTitle` normalization; untrusted-text handling); the user
     accepts or edits. Writes `bot.md`; memory materializes lazily on first write (PD11
     precedent).
   - `/bot none` — unbind the focused session (mid-session rebuild rules apply).
   - CLI: `keywork bot list|new|rm`, `keywork run --bot <slug>` (headless persona).
   - Palette rows and the FR3 tray render from the same primitives; `jump: true` rows for
     bots join the `ctrl+p` go overlay alongside sessions/arcs.
2. **Identity is typographic, never chromatic.** Design-language reserves hue for *which
   pane / which arc*; two identity hues on one border is mud. The bot renders as
   `sigil name` in the PD19 title bar's detail zone (shed before the arc prefix under
   width pressure), as the group label in the sessions overview, and as the per-line tag
   on bot-layer items in the memory pane and digest. One clarification line lands in
   `design-language.md`: *bot identity is carried by sigil and name; hue stays arc's.*
3. **Grouping.** The sessions overview gains **group by: none · arc · bot** (one pane,
   one toggle) — recommended over a separate bots node so FR2's node family does not grow
   a fourth sibling for a view that is a grouping of the first (Q-B2).
4. **Cost and return.** `groupCosts` (landed for arcs) keyed by bot: per-bot cost on the
   picker row and `/cost`. On `/bot <slug>`, the bot's briefing opens with a "since you
   last used me" delta over its layer (J23 pattern) — the payoff moment, spec-first like
   J21 (Q-B6).

## Process discipline (open — Jordan, 2026-08-21)

⟨J⟩ *"We need to ensure these processes are next level cleanly defined and effective and
not fluffy if we have this many. There's a better path we may need to discuss."*

The honest inventory of memory processes, landed and planned, before bots add anything:

| Verb | Processes today (landed ✔ / planned) | Trigger |
|---|---|---|
| capture | session ledger chips ✔ · daily logs ✔ · pre-compaction flush J8 ✔ · signal pack J20 (backtracks, ask-gates, checkpoint anchors) | turn / reserve threshold |
| cure | Gardener sweep J7 ✔ (promote · merge · supersede · usefulness · unlinked mentions) · scoped micro-sweep F4 · skill healing J10 · sync reconciliation J14 · re-attestation J25 | session close / idle / overlay size |
| promote | arc airlock J18 ✔ (ack sweep → distill → digest → archive) · cross-arc meta-distillation J24 · skill genesis (98 idea 11) | arc close / ≥3 arcs |
| review | the one inbox R3 ✔ with doors: exit digest · while-you-were-away · long-running offer · arc airlock | boundary events |
| recall | bootstrap R4 ✔ · arc slice · arc briefing J21 · point-of-action J22 · return delta J23 | session start / tool boundary |

That is five verbs and roughly fifteen named processes. Bots as drafted in PD22/PD23 add
a flush clause, a bot-scoped micro-sweep, digest tagging, a bootstrap slice, and a return
delta — five more names for zero new verbs. The drift Jordan is pointing at is real: each
layer is growing its own *processes* when it should only own *policy*.

**Candidate better path (for discussion, not adopted): one pipeline, N policies.** Every
memory layer (session · arc · bot · workspace · user) runs the same five verbs; what
differs per layer is a small declarative policy record — what to capture, when to cure,
where promotion goes, which inbox door, what bootstrap slice — schema-validated per D9
and readable in `/policy`. Under that framing a bot's "distillation methodology" is not a
bespoke process; it is the bot layer's policy row (and `learning:` is a preset over that
row). Arc close is the arc layer's promotion event; session end is the bot layer's cure
event; nothing gains a name that is not one of the five verbs. J17/J18's landed code
already has this shape in miniature (arc store = `MemoryStore` over a sub-vault, arc
recall = composition over the one search API); the path would generalize that instead of
adding bot-specific siblings. If Jordan's better path is different, it replaces this
paragraph; either way PD22/PD23 wait on the outcome (Q-B8).

## Non-goals (v1)

- Bots as processes: no always-on, no schedules, no own machine; no bot-to-bot messaging.
  P2's server shape is the door; nothing is built toward it here.
- Bot import/export or a marketplace; cross-workspace bot memory federation (rides
  Q11–Q13 when answered).
- Per-bot trust: a bot never has more authority than the session's preset + mode allow
  (J-D6/J-D7 unchanged).

## Open questions (for Jordan)

- ~~**Q-B1** Absorb D6 agents into bots, or keep "agent" as a stateless role beside
  "bot"?~~ **Decided (Jordan, 2026-08-21): merged, bots lead.** PD21.1 is binding.
- **Q-B2** Sessions overview group-by toggle (recommended) vs a separate bots node in
  FR2's family?
- **Q-B3** (narrowed 2026-08-21) Scope layout is decided (PD21.2: project default,
  global opt-in). Remaining: does a *global* bot's memory live once in the user vault and
  follow the user (recommended — that is what "interested users" want from a global bot),
  or partition per workspace? The content rule applies either way.
- **Q-B4** Mid-session bot switch: keep D6's rebuild-and-record behavior (recommended), or
  forbid and require a new session so grouping stays unambiguous?
- **Q-B5** Default `learning` level: `notes` (recommended) or `off` until the layer proves
  itself in dogfooding?
- **Q-B6** Is the bot briefing (return delta + bot MOC) worth its own spec-first task, or
  does it fold into J21's arc briefing as one composition with two sources?
- **Q-B8** Process discipline: see the section below. Jordan flagged a better path to
  discuss before PD22/PD23 are adopted.
- **Q-B7** Self-naming trigger: at creation from the purpose line (recommended, one cheap
  call) or on the bot's first turn via a `name_bot` tool (zero extra calls, later)?

## Tasks (sized; IDs continue existing schemes)

### D16 (2pt) — Bot definitions absorb agents (implements PD21.1/.2/.5)
`bots/<slug>/bot.md` layered load (`LayeredDirs`, built-in > project > user, untrusted
zero); `BotDefinition` (rename + `sigil` + `learning` + `model`-as-seed), schema with
`.describe()` per key; `buildAgent` composes from a bot; `/agent-*` → `/bot` command
family (`extension-commands.ts`); `keywork run --bot <slug>`; `validateSlug` shared with
arcs.
**Accept:** a `learning: off` bot behaves byte-identically to today's agent fixture
(tools narrowed, permissions never widened, prompt swapped); untrusted repo contributes
zero bots; `model:` binds as an ordinary `model_change` at session bind and a later
`/model` wins; headless `--bot` runs the persona; old `/agent-*` names gone from the
registry (command-coverage test updated).
**Strategy:** `OWN` over the D6 lift (format unchanged; `NOTICE` untouched).

### B9 (1pt) — Binding entries (closes J17's deferred persistence; serves arcs and bots)
One replayable `custom` entry (`customType: "keywork.binding"`, `{arc?, bot?}`) appended
on bind/unbind/switch; replay restores `ArcBindings`/`BotBindings`; forks and clones
inherit; Pi-format fixture stays green (custom entries are Pi vocabulary).
**Accept:** bind → exit → resume restores both bindings; fork child inherits; Pi fixture
unchanged; unbound sessions write no binding entry.
**Strategy:** `LIFT:pi` custom-entry contract (already in `NOTICE`).

### J26 (3pt) — Bot memory layer (implements PD22)
`BotRegistry` (mirror of `ArcRegistry`: slug, MOC-as-entity, lazy materialization, status),
`botStore`, `BotRecall` boosted stratum composed over the search API (adds-never-hides;
other bots excluded ambient, explicit search allowed), bootstrap slice, flush bot clause,
J13 citations carry `layer: bot:<slug>`, `learned_by:` stamping on bot-authored notes.
**Accept:** two sessions bound to one bot recall each other's bot-layer writes; an unbound
session is byte-for-byte today; another bot's layer invisible to ambient recall yet
searchable; bootstrap respects the split budget; a workspace fact written by a bot lands in
the workspace/arc layer, not the bot layer (flush fixture); untrusted vault inert.
**Strategy:** `OWN` over the J17 shapes; rides landed J3/J4/J6/J13 seams.

### J27 (2pt) — Learning policy (implements PD23)
The `learning` levels: `notes` (session-end digest tagging + bot-scoped Gardener
micro-sweep, budget capped, proposals only), `skills` (J10 hooks scoped to the bot's
`skills/` dir; genesis gates from 98 idea 11), `self` (instruction-change proposals against
`bot.md` through the one inbox; protected-core: direct write provably impossible at every
level). Policy readout in `/policy`.
**Accept:** per-level fixture — `off` writes nothing anywhere; `notes` digest lists the
bot's staged items with its sigil and no new door appears; `skills` self-patches a stale
bot skill and never touches a human-authored skill; `self` yields exactly one inbox
proposal per distinct change and `bot.md` is byte-identical until the user applies; sweep
cost stays under cap.
**Strategy:** `OWN`; composes J7/J8/J10/J11/P3 machinery. After J26 (+ J10 for `skills`).

### C67 (2pt) — `/bot` surfaces (implements PD24.1)
Picker overlay, `/bot <slug>` / `new` / `none`, the creation flow (purpose · name · scope
row defaulting to project, `--global` opt-in) with self-naming via the titler role, split/fork inheritance, mid-session switch notices, `keywork bot` CLI, palette
+ tray rows, `jump: true` rows in the go overlay.
**Accept:** probe workflows — create (named and self-named; project default, global
opt-in writes `~/.keywork/bots/`) → open → split inherits →
switch refused mid-turn → `none` unbinds; zero-state picker is a calm invitation; hostile
self-name renders inert; e2e capture of the picker in both themes + `NO_COLOR`.
**Strategy:** `OWN`. After D16 + B9.

### C68 (2pt) — Bot identity across surfaces (implements PD24.2–.4)
Sigil + name in the PD19 title bar detail zone with the width-pressure shedding order,
sessions-overview group-by toggle (none · arc · bot), bot tag on bot-layer items in the
memory pane and digest, per-bot `groupCosts` on picker rows and `/cost`, the
design-language clarification line. The bot briefing lands only after its spec (Q-B6).
**Accept:** capture fixtures across title tiers with and without an arc prefix; group-by
round-trips and survives refresh; monochrome capture keeps bot identity legible (it is
text by construction); per-bot cost matches the fixture rollup exactly.
**Strategy:** `OWN`. After J26; coordinates with FR2/FR3 (same files).

## Sequencing

```
D16 ──► B9 ──► J26 ──► J27 (skills level waits on J10)
  └────────► C67 ◄── B9        J26 ──► C68 (with FR2/FR3 node work)
```

D16 and B9 are small and independent of everything in flight; J26 is the headliner and
needs only landed machinery; C67 is the first user-visible moment and can ship with a
`notes`-only J27. Total **12pt**, six tasks.

## The experience

`/bot new`. "what's this bot for?" — *reviews my PRs the way I would, terse, hunts for
missing tests.* "name?" — enter. It proposes `test-hawk`; enter again. A new pane opens,
title bar reads `ᴛ test-hawk`, the sessions node shows a new group. You work. At the end
the digest says "test-hawk wants to remember 2 things" — both about how you review, not
about the repo. Next week `/bot test-hawk` opens with "since you last used me: 2 notes,
1 skill patched" and gets to work already knowing you hate snapshot tests. Open
`.keywork/memory/bots/test-hawk/` in Obsidian: it's a vault. Delete it in anger: the bot
forgets, nothing else moves.

## Supersession record (to apply on adoption)

- 40/D6 "Agents as markdown" — **absorbed by PD21**; the format lift stands, the name and
  directory change; `/agent-*` commands retired for `/bot`.
- 98/J17's deferred "session-entry binding persistence" — **delivered by B9** for arcs and
  bots together.
- `design-language.md` chroma rules — **one clarification added on adoption**: bot
  identity is typographic (sigil + name); hue remains arc/pane identity only.
- `docs/modes.md` ⟨PR-1⟩ ("mode is orthogonal to D6 agents") — **reads unchanged with
  "bot" for "agent"**; the composition law (preset ∘ bot narrowing ∘ mode narrowing) holds.
