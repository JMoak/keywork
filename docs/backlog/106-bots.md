# Bots: Overlay + Ledger (proposed 2026-08-21, adopted in part 2026-09-03)

> **Status: adopted in part (D16, B9, C67 landed 2026-09-03); PD22/PD23 adopted under the
> policy-row model (Q-B8, Jordan 2026-09-03) but not yet built.** Decided by Jordan, recorded
> inline as **⟨J⟩**: the entity merge (Q-B1, PD21.1), the scope layout (PD21.2), the
> group-by toggle (Q-B2), the `notes` default (Q-B5), and the two-verb policy-row model
> (Q-B8). Q-B3 is set aside, Q-B6 stays open for discussion, Q-B4 and Q-B7 stand as
> reversible assumptions of the 2026-09-03 round. J26 (the PD22 layer) and J27 through the
> `skills` level landed 2026-09-06; the ledger records them. This file wins over
> [`105`](105-inference-resolution.md) and below where it speaks; the ledger at the end
> records what the tree actually does.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only, nothing before
> workstream G; Pi/OpenCode are MIT, adapt with attribution in `NOTICE`; Crush is FSL,
> never a source. The user commits; agents never `git commit`/`git push`.

## The idea (Jordan, 2026-08-21)

A **bot** is a named persona the user creates (`/new-bot`): a tiny optional system prompt
and a name (given, or self-chosen). Sessions can be started *as* a bot
(`/new-bot-session [name]`, picker when no name), so bots group session history; and,
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
allowlist, narrow-never-widen permission overrides, and a prompt body, switched per pane
with `/agent-<name>` (`tui/src/extension-commands.ts:63`). It is a *role*, stateless by
construction: no memory, no history, no identity on screen, and it is overloaded on the
word "agent" (the `Agent` class, Agent mode, sub-agents). A bot is exactly that role made
persistent: **bot = identity + definition + durable memory layer + session grouping +
learning policy.** That is one new axis, not a new system: it composes the arc kernel's
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
by J-D1) or the workspace garden (wrong scope; it's about the craft, not the repo). A bot
layer is the *who* rung. It also gives Grok-style "learns how you like things done" a
home that is provenance-gated, readable, and one-key revertable, which Grok's opaque
cloud state is not.

**Three places the concept could go wrong, and the recommended guard for each:**

1. **Two persona concepts.** If bots land beside D6 agents, users meet "agent" and "bot"
   and have to learn the difference. Recommend **bots absorb agents** (PD21): the D6 file
   format stays (OpenCode lift, `NOTICE` unchanged), the *name* and the *directory* change,
   and a bot with `learning: off` is byte-identical to today's agent. Pre-release, zero
   migration, the arc/task-group precedent.
2. **A fifth door on the inbox.** The bot's distillation must not become a new ritual.
   Recommend it rides the existing session-end door (P3's door 1/2) with bot-layer items
   tagged by the bot's mark, plus a bot-scoped Gardener micro-sweep (J7 kernel, budget
   capped, proposals only). The arc airlock stays the only extra door.
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
  origins are staged by construction, and the bot's self-improvement proposals (to its
  own instructions, to its skills) are inbox proposals against a protected-core file,
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

## PD21: The entity (items 1–2 decided by Jordan 2026-08-21; 3–5 proposed)

1. **Bots absorb D6 agents.** ⟨J⟩ *"join/merge the persona concepts with bots as the
   lead."* One user-facing persona concept, named **bot**. The
   definition format is unchanged (OpenCode-lifted frontmatter + prompt body); the type
   renames `AgentDefinition` → `BotDefinition`; `/agent-<name>` / `agent-none` become
   `/bot …`. "Agent" keeps meaning the loop (`Agent` class), Agent mode, and sub-agents.
2. **Layout: two spaces, project is the default.** ⟨J⟩ *"like mcp configurations:
   a global space for definition, and a project space; project/workspace is the default,
   global is there for users who are interested."* Project scope
   `.keywork/bots/<slug>/bot.md` (+ `skills/` beside it, per J-D5.4 skills stay outside
   the vault) is where `/bot new` writes unless the user picks global; user scope
   `~/.keywork/bots/<slug>/bot.md` is the opt-in (`/bot new --global`, or the scope row
   in the creation flow). Layered load through the landed `LayeredDirs` walk (built-in >
   project > user, the commands/agents/skills precedent), untrusted repo contributes zero
   bots. The bot's **memory** lives inside the vault of the scope it is declared in:
   `<vault>/bots/<slug>/` with its own `MOC.md` and daily logs, mirroring `arcs/<slug>/`
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
   switch keeps today's `/agent` behavior: agent rebuild, refused mid-turn, recorded.
   Sessions bound to no bot run the default persona exactly as today.
5. **Definition frontmatter** (schema-validated, every key `.describe()`-justified):
   `description`, `model` (a **session selection seed** applied at bind as an ordinary
   `model_change`, IR-07 rank 2, never an override that fights `/model`; CD-04 stands),
   `tools` allowlist, `allow/ask/deny` narrowings (never widen, D6 rule), `sigil`,
   `learning` (PD23). No other keys.

## PD22: The bot layer on the ladder (adopted 2026-09-03 under the policy-row model; not built)

The funding ladder gains a *who* stratum beside the arc rung, not above it:

```
session ledger ─► { arc layer · bot layer } ─► workspace vault ─► user global
```

1. **Content rule.** Arc and workspace layers hold knowledge about the work; the bot layer
   holds knowledge about the craft: how this persona does its job, preferences it has
   learned about the user, its routines, what it tried and abandoned. The flush prompt
   gains a bot clause ("what did you learn about doing this job / how the user likes it
   done"); a bot learning a workspace fact writes it to the workspace or active arc layer
   through the same write path with the same provenance, taint, staging, and redaction
   rules, per line, exactly as at workspace scope.
2. **Recall: adds, never hides.** The active bot's layer is a boosted stratum atop
   workspace + arc + user scope (the arc rule, `ArcRecall` composition reused); other
   bots' layers are excluded from ambient recall but explicitly searchable. J13 citation
   events carry the layer, so "is the bot's memory actually used" is measured, not hoped.
3. **Bootstrap.** The bot MOC transcludes in its own adaptive slice after the arc slice
   (J-D8 tunables; absolute readout in `/policy`). Unbound sessions: zero cost.
4. **Not a funnel stage.** Bot-layer notes do not distill upward by default; they are
   about the bot. The Gardener's bot-scoped micro-sweep (J7 kernel; session end; budget
   capped) merges/supersedes within the layer and proposes to the one inbox. Cross-bot
   meta-distillation is explicitly out of scope until real bot layers exist (J24's
   dogfooding gate applies).
5. **The digest is the existing door.** Bot-layer staged items surface in the session-end
   digest (P3 door 1/2) tagged with the bot's sigil. No new door, no new counter.

## PD23: The learning policy (adopted 2026-09-03 under the policy-row model; `learning` parsed, only `off` acts)

One frontmatter key, named cumulative levels, omakase default:

| `learning:` | Adds | Notes |
|---|---|---|
| `off` | nothing | a stateless role; byte-identical to today's D6 agent |
| `notes` *(default)* | bot layer + flush clause + session-end digest + scoped micro-sweep | cheap, reversible, the Grok-style "remembers how you like it" |
| `skills` | J10 self-healing + skill genesis scoped to `bots/<slug>/skills/` | "routines", versioned by reality; genesis gates from 98's idea 11 hold (≥2 recurrences, one proposal per pattern ever) |
| `self` | proposals against the bot's own `bot.md` | protected core: the bot may only ever *propose* a change to its instructions, inbox-only, one-key apply/decline; never a direct write |

Rules beneath every level: J-D6, a bot can never widen permissions (D6's
narrow-never-widen holds at every level); J-D7, none of this touches tool trust; the
simplicity escape hatch: if `self` proves noisy in daily use, drop the level rather than
tune it. Per-bot model roles (J-D8 `flush`/`gardener` per bot) are deliberately **not**
offered; IR-14's shared resolver handles auxiliary inference and a future named-role
extension would cover bots without a bot-specific knob.

## PD24: Surfaces & grammar (proposed)

1. **Commands** (replacing the sketch's `/new-bot` + `/new-bot-session` with keywork's
   existing verb grammar):
   - `/bot`: picker overlay (preset-picker precedent): existing bots (MRU, sigil, name,
     description, last used, session count) + **new bot**. Enter opens a new session pane
     bound to the chosen bot.
   - `/bot <slug>`: open a new bound session pane directly (the `/new-bot-session`
     verb).
   - `/bot new [name]`: the creation flow, one prompt for purpose (optional), one for
     name (optional). No name ⇒ the titler role proposes a slug from the purpose line
     (PD20 cheap-call path; `kebabTitle` normalization; untrusted-text handling); the user
     accepts or edits. Writes `bot.md`; memory materializes lazily on first write (PD11
     precedent).
   - `/bot none`: unbind the focused session (mid-session rebuild rules apply).
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
   one toggle), recommended over a separate bots node so FR2's node family does not grow
   a fourth sibling for a view that is a grouping of the first (Q-B2).
4. **Cost and return.** `groupCosts` (landed for arcs) keyed by bot: per-bot cost on the
   picker row and `/cost`. On `/bot <slug>`, the bot's briefing opens with a "since you
   last used me" delta over its layer (J23 pattern): the payoff moment, spec-first like
   J21 (Q-B6).

## Process discipline (open; Jordan, 2026-08-21)

⟨J⟩ *"We need to ensure these processes are next level cleanly defined and effective and
not fluffy if we have this many. There's a better path we may need to discuss."* Then,
on the first cut of this section: *"lets simplify, 5 is like a lot."*

Memory does two things: it takes knowledge in and gives it back. Two verbs; everything
with a name today is a stage of one of them. ⟨J⟩ *"can we alias them for intuitiveness?"*
Proposed user-facing pair: **learn** (in) and **recall** (out). You teach, it learns
(95's empty-state line "keywork remembers what you teach it" already says so); it recalls
(PD12's Recall mode already owns the word, so no second concept). "remember" stays the
umbrella in prose, never a process label. On surfaces: `/learn` stages something now,
`/recall <query>` is explicit search, `◇n` reads "n to review" (the human half of learn),
a bot row can read "learned 3 · recalled 7 this week".

| Verb | What already carries a name (landed ✔ / planned) |
|---|---|
| **learn** | ledger chips ✔ · daily logs ✔ · flush J8 ✔ · signal pack J20 · Gardener J7 ✔ · micro-sweep F4 · skill healing J10 · sync reconciliation J14 · re-attestation J25 · arc airlock J18 ✔ · meta-distillation J24 · skill genesis · **the one inbox R3 ✔** (the human's seat in this path: exit digest · while-you-were-away · long-running offer · arc airlock door) |
| **recall** | bootstrap R4 ✔ · arc slice · arc briefing J21 · point-of-action J22 · return delta J23 |

Roughly fifteen names for two verbs, and the bot draft in PD22/PD23 would have added five
more (flush clause, bot micro-sweep, digest tagging, bootstrap slice, bot return delta).
That is the drift Jordan is pointing at: layers growing their own *processes* when they
should only own *policy*.

**Adopted (⟨J⟩ 2026-09-03, Q-B8):** two verbs, learn (in) and recall (out); every layer (session · arc · bot · workspace ·
user) learns and recalls the same way; the only per-layer thing is a small policy row
(what it remembers, when it cures, where it promotes, which inbox door; what it recalls
and how big its bootstrap slice is), schema-validated per D9, readable in `/policy`. A
bot's "distillation methodology" is then its policy row, `learning:` is a preset over
that row, and no bot-specific process names exist. The landed arc code already has the
shape in miniature (arc store = `MemoryStore` over a sub-vault, arc recall = composition
over the one search API). If Jordan's better path is different it replaces this
paragraph. Jordan adopted it as written on 2026-09-03: PD22/PD23 are binding under this
model, `learning:` is a preset over the policy row, and no bot-specific process names may
be introduced when J26/J27 build them.

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
- ~~**Q-B2** Sessions overview group-by toggle (recommended) vs a separate bots node in
  FR2's family?~~ **Decided (Jordan, 2026-09-03): the group-by toggle (none · arc · bot), no
  separate bots node.** Jordan wants that surface world-class when C68 builds it.
- **Q-B3** (narrowed 2026-08-21; set aside 2026-09-03, still open) Scope layout is decided (PD21.2: project default,
  global opt-in). Remaining: does a *global* bot's memory live once in the user vault and
  follow the user (recommended; that is what "interested users" want from a global bot),
  or partition per workspace? The content rule applies either way.
- **Q-B4** Mid-session bot switch: keep D6's rebuild-and-record behavior (recommended), or
  forbid and require a new session so grouping stays unambiguous? **Not decided.** The
  2026-09-03 round builds rebuild-and-record as a reversible assumption; Jordan asked for
  Grok Bot's switching model to be looked at first.
- ~~**Q-B5** Default `learning` level: `notes` (recommended) or `off` until the layer proves
  itself in dogfooding?~~ **Decided (Jordan, 2026-09-03): `notes`.** The D16 schema default.
- **Q-B6** Is the bot briefing (return delta + bot MOC) worth its own spec-first task, or
  does it fold into J21's arc briefing as one composition with two sources?
- ~~**Q-B8** Process discipline: see the section below. Jordan flagged a better path to
  discuss before PD22/PD23 are adopted.~~ **Decided (Jordan, 2026-09-03): the policy-row
  candidate as written.**
- **Q-B7** Self-naming trigger: at creation from the purpose line (recommended, one cheap
  call) or on the bot's first turn via a `name_bot` tool (zero extra calls, later)? Built as
  the recommendation on 2026-09-03 (an assumption, Jordan has not weighed in).

## Tasks (sized; IDs continue existing schemes)

### D16 (2pt): Bot definitions absorb agents (implements PD21.1/.2/.5)
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

### B9 (1pt): Binding entries (closes J17's deferred persistence; serves arcs and bots)
One replayable `custom` entry (`customType: "keywork.binding"`, `{arc?, bot?}`) appended
on bind/unbind/switch; replay restores `ArcBindings`/`BotBindings`; forks and clones
inherit; Pi-format fixture stays green (custom entries are Pi vocabulary).
**Accept:** bind → exit → resume restores both bindings; fork child inherits; Pi fixture
unchanged; unbound sessions write no binding entry.
**Strategy:** `LIFT:pi` custom-entry contract (already in `NOTICE`).

### J26 (3pt): Bot memory layer (implements PD22)
`BotRegistry` (mirror of `ArcRegistry`: slug, MOC-as-entity, lazy materialization, status),
`botStore`, `BotRecall` boosted stratum composed over the search API (adds-never-hides;
other bots excluded ambient, explicit search allowed), bootstrap slice, flush bot clause,
J13 citations carry `layer: bot:<slug>`, `learned_by:` stamping on bot-authored notes.
**Accept:** two sessions bound to one bot recall each other's bot-layer writes; an unbound
session is byte-for-byte today; another bot's layer invisible to ambient recall yet
searchable; bootstrap respects the split budget; a workspace fact written by a bot lands in
the workspace/arc layer, not the bot layer (flush fixture); untrusted vault inert.
**Strategy:** `OWN` over the J17 shapes; rides landed J3/J4/J6/J13 seams.

### J27 (2pt): Learning policy (implements PD23; `off`, `notes`, and `skills` landed 2026-09-06, `self` open)
The `learning` levels: `notes` (session-end digest tagging + bot-scoped Gardener
micro-sweep, budget capped, proposals only), `skills` (J10 hooks scoped to the bot's
`skills/` dir; genesis gates from 98 idea 11), `self` (instruction-change proposals against
`bot.md` through the one inbox; protected-core: direct write provably impossible at every
level). Policy readout in `/policy`.
**Accept:** per-level fixture: `off` writes nothing anywhere; `notes` digest lists the
bot's staged items with its sigil and no new door appears; `skills` self-patches a stale
bot skill and never touches a human-authored skill; `self` yields exactly one inbox
proposal per distinct change and `bot.md` is byte-identical until the user applies; sweep
cost stays under cap.
**Strategy:** `OWN`; composes J7/J8/J10/J11/P3 machinery. After J26 (+ J10 for `skills`).

### C67 (2pt): `/bot` surfaces (implements PD24.1)
Picker overlay, `/bot <slug>` / `new` / `none`, the creation flow (purpose · name · scope
row defaulting to project, `--global` opt-in) with self-naming via the titler role, split/fork inheritance, mid-session switch notices, `keywork bot` CLI, palette
+ tray rows, `jump: true` rows in the go overlay.
**Accept:** probe workflows: create (named and self-named; project default, global
opt-in writes `~/.keywork/bots/`) → open → split inherits →
switch refused mid-turn → `none` unbinds; zero-state picker is a calm invitation; hostile
self-name renders inert; e2e capture of the picker in both themes + `NO_COLOR`.
**Strategy:** `OWN`. After D16 + B9.

### C68 (2pt): Bot identity across surfaces (implements PD24.2–.4)
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

`/bot new`. "what's this bot for?" *Reviews my PRs the way I would, terse, hunts for
missing tests.* "name?" Enter. It proposes `test-hawk`; enter again. A new pane opens,
title bar reads `ᴛ test-hawk`, the sessions node shows a new group. You work. At the end
the digest says "test-hawk wants to remember 2 things", both about how you review, not
about the repo. Next week `/bot test-hawk` opens with "since you last used me: 2 notes,
1 skill patched" and gets to work already knowing you hate snapshot tests. Open
`.keywork/memory/bots/test-hawk/` in Obsidian: it's a vault. Delete it in anger: the bot
forgets, nothing else moves.

## Supersession record (to apply on adoption)

- 40/D6 "Agents as markdown": **absorbed by PD21**; the format lift stands, the name and
  directory change; `/agent-*` commands retired for `/bot`.
- 98/J17's deferred "session-entry binding persistence": **delivered by B9** for arcs and
  bots together.
- `design-language.md` chroma rules: **one clarification added on adoption**: bot
  identity is typographic (sigil + name); hue remains arc/pane identity only.
- `docs/modes.md` ⟨PR-1⟩ ("mode is orthogonal to D6 agents"): **reads unchanged with
  "bot" for "agent"**; the composition law (preset ∘ bot narrowing ∘ mode narrowing) holds.

## Ledger

### D16 · bot definitions absorb agents · landed 2026-09-03

- **The module.** `engine/extensions/bots.ts` replaces `markdown-agents.ts`. A bot is
  `bots/<slug>/bot.md` under `.keywork/` in the project (trusted only) or the user root,
  discovered directory by directory through the existing layered walk (project wins over
  user, untrusted repo contributes zero). The slug is the directory name and goes through the
  shared `validateSlug("bot", …)` that arcs now use too (`InvalidArcSlugError` retired for
  `InvalidSlugError` in `@keywork/shared`). Frontmatter is a strict zod schema, every key
  `.describe()`-justified: `description`, `model`, `tools`, `allow` / `ask` / `deny`,
  `sigil` (one glyph, default the slug's first letter), `learning` (`off` · `notes` · `skills`
  · `self`, default `notes`; only `off` has behavior until J26/J27). An unknown key, a wide
  sigil, a bad level, or a non-slug directory quarantines that bot and keeps the rest.
- **Composition.** `AgentBuildSpec.bot` replaces `definition`; the D6 swap semantics are
  unchanged (a bot with a body replaces the system prompt, `tools` narrows, permissions never
  widen). `keywork run --bot <slug>` runs the persona headless, refuses an unknown slug as a
  usage failure (exit 2) naming the bots here, and writes the binding into the session when a
  session dir is given. Command files name a persona with `bot:` instead of `agent:`.
- **Surfaces.** `/agent-*` and `/agent-none` are gone. The chat REPL has `/bot [slug|none]`.
  The panes app has the `/bot` family below (C67). Old `.keywork/agents/*.md` files are not
  read; one concept, no alias.
- **Evidence.** `bots.test` (schema, layering, quarantine, `learning: off` byte-identical to
  the old agent fixture), `commands.test`, `compose.test`, `run.test` (`--bot` persona and
  refusal), `chat.test` (`/bot` verbs, binding survives resume), `slug.test`.

### B9 · binding entries · landed 2026-09-03

- The `arc_binding` entry became one `binding` entry carrying deltas on two axes,
  `{ arc?: string | null, bot?: string | null }` (`null` releases, absent leaves the axis
  alone). `SessionStore.binding()` folds the active path, so a branch before a binding still
  reverts it and clones carry it into forks; `arcBinding()` / `botBinding()` read the axes,
  `appendArcBinding` / `appendBotBinding` write one delta each. Legacy `arc_binding` lines
  migrate at parse time, so sessions written before this round keep their arc. Unbound
  sessions write nothing. Tree rows and `keywork sessions tree` render `arc → x`,
  `bot → y`, `arc released`, `bot released` through one `describeBinding`.
- **TUI.** `SessionAttachment.bot` / `bindBot`; `PaneSession.switchBot` rebuilds the agent as
  the bot, applies the bot's `model:` as an ordinary `model_change` seed (a later `/model`
  wins and keeps the bot), persists the binding, and refuses mid-turn; a resumed session
  builds its agent as the persisted bot from the first frame; splits inherit the source
  pane's bot; `PaneOrigin.bot` names one explicitly.
- **Evidence.** `store-binding.test` (deltas, fold, forks, legacy migration), the Pi-format
  fixture unchanged, `session-panes.test` (seed, `/model` wins, release, resume, inherit).

### C67 · `/bot` surfaces · landed 2026-09-03

- **Grammar.** `/bot` opens the picker; `/bot <slug>` opens a new session pane bound to the
  bot (arc inherited from the focused pane); `/bot-switch <slug>` rebinds the focused pane
  between turns; `/bot none` and `/bot-release` unbind; `/bot-new [slug]` starts the creation
  flow. Notices read in the page grammar: `bot → ⚖ reviewer`, `bot released`,
  `still working · switch bots between turns`, `no bot named x · bots · S scout · /bot-new x
  creates it`.
- **Picker.** Rows are `sigil name · purpose · global? · n sessions · current`, most recently
  used first (from the session store's bindings), fuzzy on name and purpose; typing a fresh
  slug offers `new bot <slug>`, an empty query ends with `+ new bot`.
- **Creation flow.** Three rows, purpose · name · scope, plus a footer that says what enter
  does. An empty name asks the naming role for a slug from the purpose line (`suggestBotName`
  in the engine, `roles.naming` in config, falling back to the session's default model) and
  shows it as `proposed · edit or enter`; a proposal that is not a slug is dropped silently.
  The slug problem shows in place and enter refuses until it is fixed. Scope defaults to
  project (`← →` or tab flips to global). Enter writes `bots/<slug>/bot.md` with
  `description` and `learning: notes`, reloads the roster, opens a pane bound to the new bot,
  and says `bot → T test-hawk · new`.
- **CLI.** `keywork bot list|new|rm` (`new <slug> [purpose] [--global]`; `rm` asks, and
  without a terminal refuses rather than assumes).
- **Go overlay.** `bot-<slug>` jump rows focus a pane bound to the bot or open one.
- **Evidence.** `bot-commands.test`, `bot-picker.test`, `bot-create-model.test`,
  `cli/bots.test`; e2e `bots-tour` and `bots-tour-ascii` (picker, bound pane, switch notice,
  creation flow, written file).

**Gate (lead-run):** `bun run check` clean, vitest 3321 passed / 1 skipped (237 files),
e2e 40/40.

### Assumptions Jordan may reverse (2026-09-03)

1. Q-B4 stays rebuild-and-record; the refusal notice is `still working · switch bots between
   turns`.
2. Q-B7 self-naming happens at creation from the purpose line, one cheap call.
3. A bot created through the flow gets `description` only and an empty body, so it runs the
   composed prompt (project instructions, memory) with its identity carried by sigil and name;
   a hand-written body keeps the D6 swap. How purpose reaches the model is J26/J27's call.
4. Picker recency comes from scanning the session dir's bindings; per-bot cost and the group-by
   toggle stay with C68.
5. The e2e capture ships in the default theme plus a glyph-tier-0 variant; the harness has no
   theme or NO_COLOR knob yet, so those two captures wait on one.
6. `agent:` in command frontmatter became `bot:` with no alias.
7. Pane-tray rows for bots were not added; the palette and go overlay carry the family.

### J26 · bot memory layer · landed 2026-09-06

- **The layer.** `engine/memory/bots/registry.ts` mirrors the arc registry: `BotRegistry` over a
  vault root, `bots/<slug>/` with `MOC.md` as the bot's graph entity (frontmatter `bot`, `status`
  `active` or `retired`, `created`), lazy `materialize(slug)` on the first write, `retireBot` as
  the status verb, and `botStore(slug)` as a `MemoryStore` over the sub-vault that stamps every
  note it writes with `learned_by: "[[bots/<slug>/MOC]]"` (`Note.learnedBy` reads it back as the
  slug; `NoteInput.learnedBy` stamps a note a bot writes into another layer). `bots/` joined
  `arcs/` and `daily/` as a structural directory, so the workspace walk never sees a bot note.
- **Recall.** `engine/memory/bots/recall.ts`: `BotRecall` composes over any `MemorySearcher` (the
  arc-composed one in practice), adds the active bot's hits boosted twice, tags them
  `{ layer: "bot", bot }`, applies the superseded floor, and hides nothing. Other bots' layers
  stay out of ambient recall and are reachable through `searchBot`. `MemoryLayerRef` gained the
  bot variant and `searchHitLayer` yields `bot:<slug>`, so J13 citation events carry the layer
  with no further change. `botBootstrapLayer` selects the MOC first, then pinned, then most
  useful, within whatever budget it is handed.
- **Composition.** `cli/bot-memory.ts` resolves a bot's layer from its scope: project bots in the
  workspace vault (trusted only), global bots once in the user vault at
  `~/.keywork/memory/bots/<slug>/`, `learning: off` nothing at all. It wraps the session's
  searcher, supplies the flush target, and precomputes the bootstrap split per learning bot: the
  bot slice gets a quarter of the 4096-token bootstrap budget and the workspace slice gets the
  rest minus what the bot slice actually used, so an empty layer costs the workspace nothing.
  Composed prompts carry workspace + bot slices; a bot with its own body gets only its own slice
  appended. The standing injection `memory-bootstrap · scope bot:<slug>` announces it and the
  slice's notes are recorded as bootstrap recalls on the session ledger at the first turn. The
  same `composeAgents({ bots })` serves the panes app, `keywork run --bot`, and the chat REPL;
  the binding is read from the session store, so resume and mid-session switches follow.
- **Flush.** The prompt gains the bot clause only while a learning bot is bound: lines that start
  with `bot:` are craft and land in the bot layer's daily log (materializing the layer on the
  way); unprefixed lines are work and land in the workspace or active arc layer through the
  unchanged path, same provenance, taint, staging, and redaction. `isMemoryFlushPrompt` still
  recognizes the composed prompt for replay.
- **Digest.** Bot-layer staged items ride the existing memory-pane inbox with the sigil as the
  row tag (`⚖ Hostile Habit.md`); approve and discard route to the owning bot store. No new door,
  no new counter. Bot layers are not yet listed as memory-pane layers (C68).
- **Evidence.** `engine/memory/bots/registry.test` (lazy MOC, `learned_by`, workspace walk,
  retire, slug, untrusted inert), `recall.test` (two sessions one bot, other bot ambient-invisible
  yet searchable, arc tags kept beneath, retired skipped, untrusted inert, budget), `flush.test`
  (clause routing, write-only-where-landed, unbound prompt byte-identical, partition),
  `cli/bot-memory.test` (cross-session recall through `memory_search`, `bot:reviewer` citations
  in the ledger and audit, unbound byte-for-byte on prompt, tools, flush prompt, daily write and
  files, split budget in the built prompt, swapped-prompt slice, `learning: off` zero cost,
  content rule at flush, slice refresh after learning, global bot in the user vault, untrusted
  inert, digest tag and approve routing).

**Gate (lane-run, 2026-09-06):** `bun run check:types` clean outside other lanes' in-flight
TUI/doctor/run edits; `biome check` clean on every touched file; vitest
`packages/engine packages/cli` 1550 passed with the 6 failures all in other lanes' files
(`doctor.test`, `run.test`); `bot-memory.test` 13/13 across three runs. The lead runs the full gate.

### Assumptions Jordan may reverse (2026-09-06)

8. Q-B3 taken as recommended: a global bot's layer lives once in the user vault
   (`~/.keywork/memory/bots/<slug>/`) and follows the user across workspaces; the user vault is
   treated as trusted. The content rule is what keeps workspace facts out of it.
9. The bot bootstrap share is a fixed quarter of the workspace bootstrap budget (1024 of 4096
   tokens), adaptive downward only: the workspace slice reclaims whatever the bot slice leaves.
   No config knob; the absolute readout waits for J27's `/policy`.
10. Craft is routed by a `bot:` line prefix the flush prompt asks the model to use. A forgotten
    prefix puts a craft line in the work layer, never a work fact in the bot layer, which is the
    safe direction under the content rule.
11. Bot recall and the bot flush ride the workspace's memory seams: a bound session in a directory
    with no workspace declaration gets no bot layer either, global bot or not.
12. `learned_by` uses the PD21.2 wikilink form rather than a bare slug. The bot store stamps its
    own notes; `NoteInput.learnedBy` is the hook for bot-authored notes elsewhere, and no live
    path writes those yet (daily-to-note promotion inside the layer is J27's micro-sweep).
13. Bootstrap slices are computed once at composition and refreshed in-process after each bot
    flush; notes added to a layer from outside the app show up at the next launch, as the
    workspace slice does today.
14. `memory_search` searches bot-layer notes but not bot-layer daily entries, matching the arc
    layer; the daily search stays on the workspace log.

### C68 · bot identity across surfaces · part 1 landed 2026-09-06

- **Title bar (PD24.2).** `TitleBarState.bot` (`sigil` + `name`) renders in the PD19 detail
  zone as a `bot` span, first in the tail: `█ auth-retry-fix #dock-v2 · ⚖ reviewer · $0.012 ·
  plan`. Broadsheet and column show `sigil name`; clipping and masthead keep the sigil alone.
  The shedding order under width pressure is now bot name → arc tag → mode word → telemetry →
  sigil, then the fitted name, then the stamp. Tail ink is `textMid` (`pane-chrome.ts`
  `tailInk`). `ConversationPane` composes it from `ledger.bot` through a `botOf` option that
  `session-panes.ts` threads from the existing `SessionPaneDeps.botOf`; a bot whose definition
  is gone falls back to `defaultSigil`. Identity is text, so glyph tier 0 and `NO_COLOR` keep
  it legible by construction.
- **Sessions overview group-by (PD24.3, Q-B2).** `SessionsOverviewModel` carries `groupBy`
  (`none · arc · bot`); `g` cycles it in the pane (pane-local key, no leader chord; tray row
  `group`). Rows become `OverviewRow = SessionOverviewRow | SessionGroupRow`: headers are
  unselectable, keyed `group:<axis>:<member>`, and read `⚖ reviewer · 2 sessions · 3m`,
  `#dock-v2 · 1 session · 1m`, `no bot · 2 sessions · 2m`. Groups order by their newest
  session, sessions most-recent-first inside, the unbound remainder last; an axis with nothing
  bound renders flat (no lone `no bot` header). The cursor stays on the same session across
  a grouping change and a refresh. The axis persists through the `session-tree` descriptor
  (`groupBy`, parsed back against an allow-list) and the `PaneRequest`/factory, so it survives
  a workspace restore. A dim footer `g · group by arc or bot` / `g · grouped by bot` appears
  once the overview holds two or more sessions. Bot group labels take the sigil from the
  roster via `SessionTreePaneSeams.botSigil`; `SessionOverviewItem.bot` comes from the CLI
  summary's `store.botBinding()`.
- **Per-bot cost (PD24.4).** `cli/bots.ts` `boundStores` + `botCosts` run the engine's
  `groupCosts` over every bot-bound session's entries; `knownCostNanos` lands on
  `BotSummary.costNanos` only when every turn priced. Picker rows read `S scout · reads
  before writing · 2 sessions · $0.0030 · current`; `/cost` in a bound pane appends `bot ⚖
  reviewer · $0.0123 across 3 sessions` through a new `ConversationPorts.botSpend` seam wired
  from `BotsPort.list()` (`app.ts` `botSpendLookup`), and stays byte-identical for unbound panes.
- **Design language.** One clarification under the chroma section: bot identity is sigil and
  name, never hue; hue stays the arc's.
- **Waits on J26 (Q-B6 open):** the bot tag on bot-layer items in the memory pane and digest,
  and the `/bot <slug>` briefing. The design-language line already names the memory-item tag
  so J26 has its grammar.
- **Evidence.** `title-bar.test` (bot zone across tiers, with and without an arc, shedding
  order, monochrome, span tagging), `sessions-overview-model.test` (grouping, ordering,
  header skipping, refresh survival, hint text), `session-tree-pane.test` (g cycle, descriptor
  round-trip, revive grouped, refresh, footer hint, tray), `workspace-state.test` (groupBy
  parse + rejection), `bot-picker.test` (cost fact), `conversation-model.test` (`/cost` bot
  line), `cli/bots.test` (per-bot rollup equals `groupCosts` exactly; an unpriced turn leaves
  the cost unknown). `arc-pane`, `arcs-pane`, `workflows-panes` tests moved to `sessionRows()`
  / `cursorSession()`.
- **Goldens.** None recaptured. `tray-tour/entity-tray.txt` will move by one row (the new
  `group` tray entry); `bun run e2e tray-tour --update-goldens` refreshes it. The footer hint
  shows only at two or more sessions, so the chrome-states captures (one session) are unchanged.
- **Crossings (additive):** `pane.ts` / `pane-kinds.ts` / `workspace-state.ts` `groupBy` on the
  `session-tree` descriptor, `app.ts` factory + `botSpend` wiring, `session-panes.ts` two
  pass-throughs, `conversation-model.ts` `reportCost`, `arc-pane.ts` / `arcs-pane.ts` read
  session rows through `sessionRows()` / `cursorSession()` / `withoutArcTag`.

**Gate (lane-run):** `bun run check:types` clean; vitest `packages/tui` + `cli/bots.test`
1552 passed (95 files); biome clean on `packages/tui/src` and the touched cli files. Full gate
lead-run.

### Assumptions Jordan may reverse (2026-09-06, C68 part 1)

1. Shedding rank: bot name before the arc tag (PD24.2's wording), sigil after telemetry, so the
   sigil is the last tail zone standing before the fitted name.
2. The bot shows at every tier (sigil-only below column); the arc stays broadsheet-only as PD19
   decided, because nothing else carries bot identity while the border hue carries the arc's.
3. Bot ink in the title tail is `textMid`, the same rung as telemetry.
4. Unbound sessions form the last group (`no arc` / `no bot`) rather than sorting by recency
   with the bound groups; an axis with nothing bound renders flat.
5. Group headers carry `label · n sessions · age of newest`; session rows stay unchanged (no
   per-row bot sigil), since the group label is where PD24.2 places bot identity.
6. The footer hint appears at two or more sessions, the point where grouping means something.
7. Per-bot cost surfaces only when every bound turn is priced (`knownCostNanos`), mirroring the
   session rows; partial totals stay off rather than reading as the whole.
8. `/cost` reports the bot line through `BotsPort.list()` (a session-dir scan) rather than a
   dedicated cost port.

### J27 · learning policy · `notes` level landed 2026-09-06 (`skills` and `self` wait on J10)

- **The micro-sweep.** `engine/memory/bots/sweep.ts` `sweepBotLayer({ registry, slug, judgment })`
  runs the J7 Gardener over the bot's own store in a new `proposeOnly` mode: every promotion
  the judgment port returns lands in the bot's inbox as a `borderline-promotion`, every pair
  action becomes a merge or supersession proposal, and usefulness is reported but never
  stamped. The only files a sweep touches are `.staging/` sidecars and the layer's own
  `curation.md` audit line. Layers that never materialized, retired layers, and untrusted vaults
  are skipped with a named reason (`no-layer`, `retired`, `inert`) and no write at all.
- **The cap.** `botSweepTokenBudget = 1024`. `SweepOptions.entryTokenBudget` (new on the Gardener,
  unset for the workspace sweep) hands the judgment port only the newest daily entries that fit,
  in log order, and skips the port entirely when nothing fits. `entryTokens` is the same
  `ceil(length / 4)` estimate notes already use.
- **Approve lands the note.** The J11 kernel now lands an approved `borderline-promotion` as an
  agent note through the same write path as `writeNote` (provenance, confidence, redaction, the
  store's `learned_by` stamp, one revertable ledger entry); a promotion whose note appeared in
  the meantime is dropped without a write. Until now approving a promotion only cleared it,
  which would have left the notes level with nothing to learn from.
- **Wiring.** `BotMemory.sweep(judgmentFor)` sweeps every bot with a layer, skipping any bot the
  lookup gives no judgment for. `compose-panes.ts` adds it as a second closer after the
  workspace sweep; the judgment is `closingJudgment` over the shared `closing` role provider,
  falling back to the provider of a session bound to that bot (the arc close's provider rule,
  now shared as `closingProvider`).
- **The digest.** Bot-layer proposals ride the memory-pane inbox J26 already tags with the sigil
  (`⚖ Terse Reviews` as a `promotion` row); approve routes to the owning bot store, and the
  workspace vault never sees the note. `returnDelta` gains an optional bot line, `1 learned by
  ⚖ reviewer: [[Terse Reviews]]`, after the arc line and before the workspace line, with
  `gatherReturnDelta({ bots, bot })` reading the layer; no caller passes it yet (see assumptions).
- **`/policy`.** In a bot-bound pane the conversation model answers `/policy` itself through a
  new `ConversationPorts.botOf` seam (threaded from the existing `SessionPaneDeps.botOf`, no
  `app.ts` change) and prints `learning · ⚖ reviewer · notes` followed by one row per level,
  the current one marked `▸`. `skills` and `self` read "not built yet, runs as notes" so a bot
  declared at either level is never mistaken for a finished one. `BotEntry.learning` is now
  stamped by the CLI's `entryOf`. An unbound pane falls through to the command port exactly as
  before, so `/policy` there is still `unknown command /policy`; the command is not in the
  suggestion tray for the same reason.
- **Evidence.** `engine/memory/gardener.test` (propose-only routes a confident promotion to the
  inbox and touches only staging plus the audit; a confident agent merge becomes a proposal;
  usefulness reported unstamped; budget keeps the newest entries that fit in log order; nothing
  fits skips the port), `bots/sweep.test` (proposals never notes, approve lands with
  `learned_by`, the cap pinned at 1024 with a 12-entry log, no-layer / retired / inert write
  nothing), `store.test` (approved promotion lands as an agent note and reverts; a note that
  arrived first wins), `return-delta.test` (bot line placement and sigil; byte-identical without
  a bot), `cli/bot-memory.test` ("the learning policy": `off` session changes only the workspace
  daily and grows no `bots/` dir while a sneaky judgment is never consulted; `notes` sweep
  proposes into the bot inbox, the digest row reads `⚖ Terse Reviews`, approve lands in the bot
  layer only; unmaterialized layers skipped without a write), `tui/conversation-model.test`
  ("/policy": full readout, `self` marked not built yet, unbound pane unchanged),
  `cli/bots.test` (`learning` on entries), `cli/compose-panes.test` (two closers).
- **Crossings (additive):** `engine/memory/store.ts` (`promotionDeltas`, `noteContent` /
  `noteDeltas` split out of `writeNote`, approve subject is the landed path), `engine/index.ts`
  exports, `cli/bots.ts` `entryOf.learning`, `cli/compose-panes.ts` closer + `closingProvider`,
  `tui/bots.ts` `BotEntry.learning` + `learningPolicyReadout`, `tui/session-panes.ts` one
  pass-through, `tui/conversation-model.ts` `/policy` case.

**Gate (lane-run, 2026-09-06):** `bun run check:types` clean; biome clean on every touched
file; vitest over the touched files (`engine/memory/**`, `cli/bot-memory`, `cli/bots`,
`cli/memory`, `cli/compose-panes`, `tui/conversation-model`, `tui/bot-commands`,
`tui/session-panes`) 514 passed across 36 files. The lead runs the full gate.

### Assumptions Jordan may reverse (2026-09-06, J27 notes)

1. "Proposals only" is read strictly: the bot sweep never writes a note, merge, supersession, or
   usefulness stamp on its own, even inside the agent-only blast radius PD22.4 would allow.
   Loosening it is one flag (`proposeOnly: false`) on the sweep's Gardener.
2. The sweep cap is 1024 entry tokens per bot per close, newest entries first; older craft that
   never fit waits for a quieter close. No config knob.
3. The bot sweep reuses the arc `closingJudgment` port unchanged, so its prompt still speaks of
   "a keywork arc"; a craft-flavoured instruction is a follow-up on `closing.ts` (arc territory).
4. Approving a `borderline-promotion` now lands the note everywhere, workspace included; the
   old approve-as-dismiss behaviour is gone since discard already covers it.
5. `/policy` prints only the learning level; the J-D8 bootstrap slice readout (1024 of 4096
   tokens) is still owed and needs the CLI budget to reach the pane.
6. The return-delta bot line exists in the engine but no surface passes a bot yet; `chat.ts`
   "since you were here" and the arc pane are the candidates, both outside this lane.
7. A bot declared `skills` or `self` runs as `notes` at runtime (J26 already did this); the
   readout says so rather than refusing the level.

### J27 · learning policy · `skills` level landed 2026-09-06 (`self` open)

- **The Gardener reads skill telemetry.** `Gardener.sweep({ skills })` takes a `SkillEvidence`
  snapshot (`{ name, authoredBy }` per skill plus the `readSkillTelemetry` snapshot) and turns it
  into `skill-review` proposals, one per agent-authored skill that is either churning (patches
  plus rewrites at or above `skillChurn`, default 2) or unused (zero uses and no activity for
  `skillIdleDays`, default 30, measured against the Gardener's clock). The proposal cites the
  counts (`uses`, `patches`, `rewrites`) and the inbox row reads `rework skill release-tag ·
  4 uses, 2 patches, 1 rewrites` or `retire skill old-routine`. Skills without the
  `authored_by` marker are never proposed on, the blast-radius rule J7 already keeps, and the
  Gardener still writes no skill file: approving a review only clears the row. The workspace
  closer (`compose-panes.ts`, `chat.ts`) now hands `sweepOnClose` the evidence built by
  `skillEvidenceOf(composition.skills, skillTelemetryFile(...))`.
- **Skill genesis.** `skills/genesis.ts` reads a command sequence out of a daily entry
  (backticked commands in order, or `$ `-prompted lines), normalizes whitespace, and fingerprints
  the ordered sequence (sha256, 16 hex). A sequence needs two or more commands to count, and
  `recurringSequences` needs two distinct entries carrying the same fingerprint before anything
  fires. `bots/skill-genesis.ts` runs that over the bot layer's whole daily log, skips fingerprints
  already in the layer's reserved `skill-genesis.json`, proposes a `skill-proposal` (`name`,
  `fingerprint`, `commands` as one redactable string, `occurrences`) through the store's inbox,
  then records the fingerprints and one audit line (`skill genesis: proposed 1`). The fingerprint
  is remembered at proposal time, so a declined pattern never re-fires and a second bot with the
  same routine gets its own single proposal from its own ledger. No model call is involved, so the
  judgment cap stays the 1024 entry tokens the notes level set.
- **The bot library.** `BotMemory.skillsFor(bot)` exists only for a bot declared `skills` with a
  layer: a `SkillLibrary` over the bot's own `.keywork/bots/<slug>/skills/` (discovered through the
  new `discoverSkillsUnder`) plus the workspace skills it does not shadow, with a `SkillGenesis`
  root at the bot's dir, convention `skills`, author `keywork/<slug>`, and its own telemetry file
  (`~/.keywork/skills/<identity>/bot-<slug>.json`). `composeAgents` gives a bound session that
  library's tools in place of the workspace library's, so a stale bot skill self-patches through
  the unchanged J10 path and lands in the bot's dir, while the workspace library never sees the bot
  skill. `BotMemory.sweep` passes the library's skills and telemetry as evidence to the bot sweep,
  and `BotMemory.approve` lands an approved `skill-proposal` by creating the skill through the
  library (`skillDescriptionFor` / `skillBodyFor`, a numbered command list) before clearing the
  row; a name the library already holds is left alone. The memory pane's approve routes bot rows
  through it.
- **Two notes-lane follow-ups.** `closingJudgment` takes a `subject`: `{ kind: "bot", slug, sigil }`
  swaps both prompts for craft wording ("the closing distiller for ⚖ reviewer, a keywork bot ...
  keep to craft") and drops the arc steer clause; the arc wording is byte-identical without it.
  The chat REPL's "since you were here" now passes the bound bot and its registry to
  `gatherReturnDelta`, so a resumed bot-bound session prints `1 learned by H helper: [[Terse
  Reviews]]`.
- **`/policy`.** `skills` reads `keeps routines in its own skills dir, self-patched, proposed from
  recurring commands`; `self` still reads `not built yet, runs as notes`.
- **Evidence.** `skills/genesis.test` (extraction, normalization, distinct-occurrence gate, order
  sensitivity, naming fallback), `memory/gardener.test` "skill telemetry" (churning and unused
  proposed with counts, fresh and human skills skipped, staging-only writes, no re-stage while
  pending), `bots/sweep.test` "at the skills level" (one occurrence proposes nothing, two propose
  exactly one, discard then a third occurrence proposes nothing, a second bot gets its own,
  notes level silent, judgment under the cap with genesis on, telemetry review in the bot inbox),
  `arcs/closing.test` (arc versus bot wording), `cli/bot-memory.test` "the skills level"
  (self-patch lands in the bot dir with the author kept while the human workspace skill is
  byte-identical and the workspace library never sees the bot skill; genesis proposal row
  `R new skill bun-run-check · 3 steps, seen 2 times`, approve creates the skill under the bot
  with `authored_by: "keywork/routinier"` and no `.keywork/skills/` appears, the third
  occurrence proposes nothing; churning bot skill flagged `R rework skill build · 0 uses, 2
  patches, 0 rewrites`), `cli/chat.test` (bot line on resume), `cli/memory.test` (`sweepOnClose`
  with evidence stages a review), `tui/conversation-model.test` (`/policy` readout).
- **Crossings (additive):** `memory/staging.ts` two proposal kinds and keys; `extensions/skills.ts`
  `discoverSkillsUnder`; `cli/memory.ts` inbox rows for both kinds, `skillEvidenceOf`,
  `sweepOnClose(memory, skills?)`, approve routed through `BotMemory.approve`; `cli/compose.ts`
  `skillToolsFor` takes the library a bot session resolves; `cli/paths.ts` `botSkillTelemetryFile`;
  `engine/index.ts` exports.

**Gate (lane-run, 2026-09-06):** `bun run check:types` clean outside other lanes' in-flight TUI
test edits; biome clean on every touched file; vitest over the touched files 225 engine
(`skills/**`, `memory/gardener`, `memory/bots/**`, `arcs/closing`, `staging`, `store`,
`extensions/**`) plus 96 CLI (`bot-memory`, `chat`, `memory`, `compose-panes`, `bots`) plus 70
`tui/conversation-model`, all passing. The lead runs the full gate.

### Assumptions Jordan may reverse (2026-09-06, J27 skills)

1. A bot's skills live beside its definition at `.keywork/bots/<slug>/skills/` (the user root for a
   global bot), the git-able place a person already edits. The memory vault's `bots/<slug>/` was
   the other reading of PD23 and would have parsed a `SKILL.md` as a note.
2. "Command sequence" means two or more backticked or `$ `-prompted commands in one daily entry;
   a lone command never seeds a skill. Order is part of the fingerprint.
3. The fingerprint is remembered when the proposal is staged, so approve, discard, and a proposal
   that is still pending all count as "proposed once ever". Fingerprints live in the bot layer's
   reserved `skill-genesis.json` and go through the store's ledgered reserved write.
4. Approving a `skill-review` only clears the row. The Gardener proposes; retiring or rewriting a
   skill stays a human act (or the bot's own `skill_rewrite` mid-run).
5. Review thresholds are `skillChurn: 2` and `skillIdleDays: 30` on the Gardener's threshold
   record; no config knob.
6. A proposed skill is named after its first command (`bun-run-check`), falling back to
   `routine-<fingerprint>`; a name the bot library already holds means approve creates nothing.
7. The bot library also lists workspace skills it does not shadow, so a bot can still load and, when
   they carry the marker, repair shared skills; its genesis root is only ever its own dir.
8. Bot skill telemetry is per workspace identity and bot (`~/.keywork/skills/<identity>/bot-<slug>.json`),
   so a global bot's counts do not follow it across workspaces.
9. The bot closing prompt has no steer clause; direction is an arc-close affordance.
10. `self` still runs as `notes`; the readout says so.
