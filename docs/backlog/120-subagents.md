# 120: Subagents: `delegate`, child sessions, lineage

> **Kind:** scoping overlay + phase one ledger (2026-10-12). It owns spawning: the `delegate`
> tool, child sessions and their lineage on disk, the child row in the transcript, the
> `child.started` / `child.finished` events, and how `keywork run` and `keywork serve` report
> children. It implements [`101`](101-feedback-round-4.md) FR6.17 (the transcript half now, the
> overview half as a task below) and gives [`102`](102-instrument-grammar.md) #2 the lineage
> it was waiting on. It amends [`119`](119-session-lifecycle.md) 119-1 (a session's files gain
> a child dir) and revisits the "no subagent primitive is planned in core (D2/P6)" line in
> `docs/research/coding-agent-nuances.md` and the OpenCode dossier, with the justification in
> 120-3. Where it speaks it wins over those files; [`106`](106-bots.md),
> [`108`](108-survivability-and-launch-rail.md) and [`119`](119-session-lifecycle.md) win on
> anything this file only cites.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only. Pi and OpenCode
> are MIT and adapted only with attribution in `NOTICE`; nothing here lifts code from either,
> and `NOTICE` is untouched. Crush is never a source. The user commits; agents never
> `git commit` or `git push`. Every task below is `OWN`.

## What it is

keywork had no way for an agent to hand work off. A model that wanted a broad search or a
second pair of eyes had to do it in its own context and pay for every line of raw output
forever after. This overlay gives it one verb, `delegate`: a child session starts under the
current one, in the same workspace and arc, as a bot if one is named, under the parent's gate.
It runs to the end of its turn, and its final answer comes back as the call's result with the
child's id on the first line. The child is a real session on disk, so a person can read it,
open it in a pane and keep talking to it.

The one-line model, in the 106 grammar: a **child** is a session another session started. Its
*who* is a bot, its *where* is the parent's arc and workspace, its *how much rope* is the
parent's and never more, and its *when* is inside the parent's turn.

## Where the tree stood (2026-10-12)

Read in source before deciding; each fact is cited where it shaped a decision.

- **Tool calls run one at a time.** `Agent.executeToolCalls` loops over a reply's calls in
  order (`engine/src/agent.ts`), so one parent can hold at most one live child. A concurrency
  cap is a process cap, not a per-parent one (120-12).
- **`parentSession` is a fork pointer.** It's a path written by `store.clone`, and 119-4's one
  reader (`forkOrigin`) says "fork of". Reusing it for children would mislabel every one
  (120-1).
- **A store has one leaf.** `SessionStore.persistAsLeaf` moves the leaf on every append, so two
  writers in one file would interleave their parent ids (120-1, option A).
- **The gate is the `ToolGuard`.** A pane's guard is its `MutationAsk` (`confirm`, with the
  session grants inside it); `serve`'s is the ask broker per session; `keywork run`'s is the
  headless guard with `declineEndsRun` (108's gate terminate amendment). A child that holds
  its parent's guard inherits all three behaviors with no new plumbing (120-6).
- **`beforeTurn` resets the undo tag.** The pane guard's `beforeTurn` calls
  `Checkpoints.beginTurn`, which drops the turn tag. A child calling it mid-parent-turn would
  cost the parent's prompt its restore point (120-8).
- **`buildAgent` already composes a persona.** `cli/src/compose.ts` applies a bot's prompt,
  `restrictTools`, `narrowedPermissions`, its learning bootstrap, the MCP surface and skills.
  Arc and bot recall find a session's binding through the host's `bindingOf(sessionId)`, so a
  child gets its strata only once the host knows its store (120-5).
- **Readers of the session dir read one level.** `sessionFileNames` filters `*.jsonl` in one
  directory; `findSession` is the by-id lookup every surface uses (`ports.ts`, `serve.ts`,
  `command.ts`, `export.ts`, `lifecycle.ts`) (120-1).
- **A slot was waiting.** `InjectionSource` already lists `subagent` and nothing emits it;
  102 #2 decided "cost with lineage" and parked it on a spawn mechanism; 113 and 115 parked
  FR6.17 for the same reason.
- **Earlier lines to square.** 95 J6 says sub-agent contexts fail closed to reduced scope and
  that sub-agent memory writes are untrusted-class until decided otherwise (120-6). 103 says
  subagent bridges to Claude Code or Codex touch the Anthropic perimeter (120-15). D2 and P6
  keep core to four tools (120-3).

## What the field does (read 2026-10-12)

| Source | What it does | What keywork takes |
|---|---|---|
| Claude Code ([sub-agents docs](https://code.claude.com/docs/en/sub-agents)) | An `Agent` tool (wire name `Task`) with `description`, `prompt`, optional agent type and `model`. Definitions are markdown in `.claude/agents/`. Fresh context per subagent; nesting up to 3 deep and 20 at once by default (env vars change both); background by default in interactive sessions; permission prompts surface in the main session with the subagent's name; transcripts live at `{sessionId}/subagents/agent-{id}.jsonl`; a subagent can be resumed with `SendMessage`; forks inherit the whole conversation. | A transcript per child, filed under its parent; the parent's prompts answer the child's asks; a short title beside the prompt. Declined: background, forks, resume-by-message, per-call model (120-15). |
| OpenCode ([agents docs](https://opencode.ai/docs/agents/), dossier §3) | A `task` tool spawns child sessions you navigate with `session_child_first` / `session_child_cycle` / `session_parent`; `permission.task` globs, and a denied agent leaves the tool's description; built-in General, Explore and Scout; a `steps` cap; v2 renamed the permission action `subagent`; v1.18.20 made a failed task resumable by id. | The child as a navigable session (keywork opens it in a pane); the roster in the tool description. Declined: built-in subagents, `mode: subagent`, the step cap (120-15). |
| Codex ([subagents docs](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)) | TOML agents in `.codex/agents/`; `spawn_agent`, `send_input`, `wait_agent`, `close_agent` behind `multi_agent = true`; `agents.max_concurrent_threads_per_session`; children inherit the sandbox and approval mode; `/agent` switches threads; approvals surface from inactive threads. | Inheritance of approval posture. Declined: the messaging protocol between threads (120-15). |
| Pi (`examples/extensions/subagent` in `earendil-works/pi`) | An extension, not core: each subagent is a separate `pi` process with its own context; single, parallel (8 tasks, 4 at once) and chain (`{previous}`) modes; agents in `~/.pi/agent/agents/*.md`; 50 KB of output per task back to the parent. | The bounded answer (keywork's tool output budget does it). Declined: processes, the chain template (120-15). |

What all four agree on, and keywork keeps: a child starts with a fresh context, gets a prompt
written by the parent, works under the parent's approval posture, and hands back one answer.
What they disagree on is where the child lives and how visible it is, which is where keywork's
session tree and panes earn their keep.

## Options

Where a child lives decides almost everything else, so it gets the sized options.

| Option | Shape | Cost | Verdict |
|---|---|---|---|
| **A. A branch in the parent's file** | A new entry kind roots the child's turns inside the parent's JSONL, off the active path. | 3pt plus a second leaf in `SessionStore` | Refused. Branches are a person's what-ifs (B4), and a child would read as an edited reply; the store's single leaf makes two writers in one file a rewrite; Pi readers would see a nonsense branch. |
| **B. A fork** | `store.clone` plus `parentSession`. | 1pt | Refused. A fork copies the parent's context and a child must not; `forkOrigin` would call every child "fork of". |
| **C. A sibling with a lineage key** | A top-level session whose header names its parent. | 2pt | Workable, but every one-level reader needs a filter: the list, the overview, arc counts and `--continue` (which sorts names and would resume a child). Trashing a parent strands its children. |
| **D. A child nested beside its parent** | `<sessionDir>/<parent>.children/<stamp>.jsonl`, lineage in the header. | 2pt | **Recommended and built.** One-level readers never see children; by-id lookup descends; trash moves a parent with its children for one more `rename`; lineage is visible in the filesystem, which D8 wants greppable. |

How a child runs got a smaller version of the same question: in-process through the same
composition (recommended and built) or a separate `keywork run` process the way Pi spawns
`pi`. A process would need its own ask channel back to the parent's pane and its own MCP
connections and language servers; in-process, the child holds the parent's guard and shares
the workspace composition.

## Decisions of record

**120-1 · A child is a session, nested beside its parent.** Its file is
`<sessionDir>/<parent stem>.children/<stamp>.jsonl` (`childDirFor`, `childSessionFile` in
`engine/src/session/children.ts`), its spills sit beside it as for any session, and its
header carries `spawnedBy: { sessionId, callId }`, the parent's id and the `delegate` call
that started it. An id, unlike `parentSession`'s path, survives a trip through the trash.
The key is optional and `sessionFormatVersion` stays 3: Pi put its own lineage pointer in the
header and the Pi-format fixture stays green (verified); that a Pi reader ignores an unknown
header key is inferred, not tested against Pi itself. Readers that read one level (the list,
the overview, `--continue`, arc counts, bot usage, `GET /sessions`) never see a child;
`findSession` searches the top level first, then descends into `*.children` dirs, so opening,
showing, exporting, resuming and `GET /sessions/{id}` reach a child by id.

**120-2 · The tool is `delegate`.** It's the act the model performs: hand off a piece of work
and get an answer back. `task` was the word 98 rejected as the most overloaded in the domain;
`subagent` names the mechanism rather than the act, and PD21.1 kept "agent" for the loop;
`spawn` is process vocabulary. On screen the result is a child, so the pair reads: the model
delegates, a child does the work. Arguments are `{ title, prompt, bot? }`: `title` is a few
words naming the work (the child's session name and the row's label, flattened and capped at
60 characters by `childTitleOf`), `prompt` is the child's first message verbatim, `bot` picks
the persona. One call starts one child and returns one answer. The tool doesn't mutate, so
the gate allows it by default and the child's own calls meet the gate one by one. Its name is
reserved against extension tools beside the core four.

**120-3 · The engine owns child sessions; the composition offers the tool.** D2 keeps core to
four tools, and `delegate` is not one of them: it's composed by `cli/src/compose.ts` the way
memory recall and skill tools are, default on, present only where a host passes a delegation
host, removable by a bot's `tools` allowlist or a permission rule
(`{ "action": "delegate", "resource": "*", "effect": "deny" }`). What lives in the engine is
session-tree machinery (D4): the child store and its lineage, the slots, the events, the
result format, and the rule that a child runs inside its parent's turn. The written
justification D2 asks for: the session tree is keywork's differentiator, and a child is the
case it was built for (ux-principles 3.2 already promised child-session panes); doing it as an
extension would need the extension API to create sessions and compose agents, a much larger
surface than one engine module. The cost is the tool's schema and description on every
request, about 880 characters (some 220 tokens) plus one short line per bot, which P6
counts.

**120-4 · The who is a bot.** `bot` names one from the roster (D16); the tool's description
lists the roster with each bot's purpose so the model can choose. Leaving `bot` out runs the
child as the parent's bot, the way splits and forks inherit (PD13, B9). An unknown name is
refused before anything is created, naming the bots here. The child gets the bot's prompt
swap, tool allowlist and narrowings, its learning bootstrap slice and its recall stratum, all
through the unchanged `buildAgent`. Phase one runs the child on the parent's provider and
records it as an ordinary `model_change`; applying the bot's `model:` seed (PD21.5) needs a
provider resolver from the host and is task S8.

**120-5 · The where is the parent's arc and workspace.** The child's first entries are its
name and one `binding` entry carrying the parent's arc and the child's bot (B9, written only
when either exists). It shares the parent's composition: scope, linked dirs, MCP servers,
language servers, memory vault, skills. The host attaches the child the way it attaches any
session it opens (panes: the store map, citations, the arc service, the extension host
session; `serve`: the same plus a child map behind `bindingOf`; `run`: a child map behind
`bindingOf`) and releases it when the child's turn ends, so arc and bot recall see it and
nothing leaks. Arc counts stay counts of top-level sessions: a session that delegated three
times is one session with three children, and the overview's lineage rows (S6) show them under
it.

**120-6 · Trust is inherited and never widened.** The child holds its parent's guard minus
`beforeTurn` (`childGuardOf`): its asks land in the parent's ask queue, so a pane's needs-you
chrome and notifications fire on the parent; under `serve` they go to the parent's broker; in
`keywork run` they answer no. Session grants are shared both ways: an "always" the person
gives on a child's ask is the person granting on the parent session, which is where they were
looking. Permissions are the parent's effective resolver (already narrowed by the parent's
bot) narrowed again by the child's bot, never widened (D6's rule, J-D6). Tools are capped by
the parent bot's allowlist (`toolCeiling`): a parent running as a read-only bot can't reach
`write` by naming a bot that has it. PD12 modes aren't built; when they land, a child takes
its parent pane's mode under the same never-widen rule. J6's fail-closed clause was written
for contexts outside the session's trust (external attach clients, headless callers, bridges);
a keywork child is in-process, in the same workspace, behind the same gate, so it recalls what
a session bound to the same arc and bot recalls. That reading is Q-SA3.

**120-7 · Headless answers no, and the run stops.** In `keywork run` a child's ask is refused
with `gate: "headless"`, the child stops at it (the guard's `declineEndsRun` holds for the
child too), and the `delegate` result arrives as a `NestedRefusalError`, which the parent
treats exactly like its own headless refusal: no further model call (108's gate terminate
amendment, now covering nested refusals). The run exits 4, `refused` lists the child's calls
beside any of the parent's, and `run.finished` lists the children. Where a refusal doesn't end
runs (panes, `serve`), a declined child keeps going, like its parent would.

**120-8 · One writer per session, and the child's undo belongs to the parent's turn.** While
its turn runs, the delegation owns the child's file: header, name, binding and model first,
then messages after every tool batch and at the end (each assistant message with its usage),
with gate decisions and injections journaled through `tapJournal` (A19). A crash mid-child
leaves a readable partial session. Because the child never calls `beforeTurn`, its first
mutation captures into the parent's turn checkpoint, so `/undo` of the parent's prompt puts
back what the child changed as well.

**120-9 · Results come back as the tool result, with provenance on the first line.** The
format is `↳ child <id> · <bot> · <outcome>`, a blank line, then the child's final text;
`unsaved` takes the id's place when the parent isn't saved, and the bot is left out when there
is none. Interrupted, failed and refused children come back as error results with the same
first line. One parser (`childProvenanceOf`) serves every reader, so the TUI rebuilds a child
row on replay from the stored result alone. The child gets no hidden preamble: its first
message is the prompt, exactly what the child's transcript shows.

**120-10 · Transparency per FR6.17: one row per child.** While the child works its row reads
`↳ <bot or "child"> · <title> · <what it's doing>`: the `delegate` call streams one
`tool.output` line per child tool call (`read src/a.ts`), and `needs you · bash git push`
while a child's ask waits on the parent's prompt. Settled, it reads
`↳ scout · find the callers · 41s · $0.0031 · done` (or `stopped`, `failed`, `refused`), and
unfolding it shows the answer without the provenance line. The fold cursor (`shift+tab`)
reaches a child row from its first frame, and `o` opens the child in a pane, the same verb
that opens a spill; the disclosure hint says `o opens the child`. The lineage mark is `↳` at
glyph tier 1 and `>` at tier 0. Identity on the row is the bot's name; the sigil (PD24.2)
joins with S6.

**120-11 · Cost rolls up; context doesn't.** A child's context is its own; that's the point.
Only its final answer crosses, as a tool result bounded by the tool output budget (a long
answer spills beside the parent like any result). The child's spend rides
`child.finished.costNanos` (present only when every model call was priced, the
`knownCostNanos` rule) and the row shows it, which is 102 #2's "a parent transcript's spawn
line carries what the delegation cost". The parent's context gauge counts the answer like any
tool result and nothing else. Title spend, a `/cost` children line, lineage cost in session
summaries and the arcs node are S7.

**120-12 · Limits: depth one, four at a time.** A child's agent is built without the
`delegate` tool, so it can't try. A finished child opened in a pane gets a normal agent, so
the tool refuses by depth instead, read from the file's path (`childDepthOf` counts `.children`
dirs, which also works for deeper nesting later). `ChildSlots` caps live children per
composition at 4; one more is refused at once with a reason the model can act on (`4 children
are already running · wait for one to finish or do this here`). The cap bites across panes and
served sessions, since one parent never holds two children while calls run in order. Both
numbers are constants, not config (D9).

**120-13 · Lifecycle.** An interrupt (escape, pane close, `POST /sessions/{id}/abort`,
SIGINT) reaches the child through the call's abort signal; the child's partial record is
saved and the row reads `stopped`. Closing a pane also denies a child's pending ask, through
the same ask queue. Compaction folds a `delegate` result like any tool result and never
touches the child's file; mid-run compaction can't run during the call, only between batches.
A child runs one turn, so phase one runs no after-turn settler in it: no flush, no compaction
(S10). Trash moves a parent's child dir with it, restore brings it back and purge deletes it
(119-1's pair grows a third member, `sessionFileSet`); a running parent can't be trashed, so a
running child can't either (119-3). A child removed on its own goes to the trash flat and
comes back as a top-level session that still names its parent (Q-SA6). A fork of a parent
copies the `delegate` results, and their ids keep resolving while the original parent lives.

**120-14 · `serve` is additive to contract 1.0.** `child.started` and `child.finished` ride
the parent's bus, so `/events` carries them on the parent's id with no route change, and
`GET /sessions/{id}` reads a child through the descending lookup. The event-shapes fixture
grows two entries; contract 1.0 gains them as a minor bump at integration. Phase two (S6, S9)
adds `spawnedBy` to the session detail, `GET /sessions/{id}/children`, the child's own bus on
`/events?session=<child>` while it runs, and the child's id on its asks.

**120-15 · What keywork declines, and why.**

- **Background children** (Claude Code's default in interactive sessions, Codex's
  `wait_agent`): the answer is the tool result, the parent waits, and a session has one
  writer. An async child would need a second inbox for answers that arrive mid-conversation.
- **Messaging between agents** (Codex `send_input` and `send_message`, Claude Code resuming
  through `SendMessage`, OpenCode's resumable task id): 106's non-goal says no bot-to-bot
  messaging. Continuing a child is a person's act, in the child's own pane.
- **Forked-context children** (Claude Code forks): a fresh context is the point.
- **A second persona format** (`.claude/agents`, OpenCode's `mode: subagent`, Codex TOML
  agents): bots are the one persona concept (PD21.1), and any bot can be a child.
- **Built-in subagents** (OpenCode's General, Explore and Scout): keywork ships no bots;
  a child with no bot runs the default persona.
- **A per-call `model` argument** (Claude Code): model choice is routing (IR-07, CD-04), and a
  bot's `model:` seed is where a child's model comes from (S8).
- **A process per child and a chain template** (Pi's extension, `{previous}`): a process
  splits the gate and the ask queue; the model chains by calling `delegate` again.
- **Step caps** (OpenCode `steps`, Claude Code `maxTurns`): a knob per agent fails D9;
  interrupt is the person's stop and the slot cap bounds the spend in flight.
- **Bridges to other agents as children** (103): Claude Code or Codex as a child sits on the
  Anthropic perimeter and stays out.
- **A worktree per child** (Claude Code `isolation: worktree`): not now; children share the
  parent's working tree and its undo.

## Tasks

### Phase one (landed 2026-10-12; ledger below)

#### S1 (2pt): the engine primitive

`engine/src/delegation.ts` (`delegateTool`, `ChildSlots`, `childGuardOf`, `childResult`,
`childProvenanceOf`, `childTitleOf`), `engine/src/session/children.ts`, `spawnedBy` on the
header and `SessionStore.createChild`, `appendBinding`, the two bus events,
`NestedRefusalError` in the agent loop, the session file set in `trash.ts` and `spill.ts`.
**Accept:** a child nests beside its parent with lineage, name, binding and messages; unknown
bot, depth and full slots refuse without creating anything; a headless refusal inside the
child ends the parent's run with no further model call; an interrupt reaches the child and
keeps its partial record; trash moves and discards children with their parent.

#### S2 (2pt): composition and hosts

`buildAgent` offers `delegate` where a host passes a `DelegationHost` and composes the child
through itself (`child.toolCeiling`, the parent's effective permissions, `childGuardOf`);
`compose-panes.ts`, `serve-workspace.ts` and `run.ts` pass hosts; `findSession` descends.
**Accept:** no tool without a host and none for a child; a policy deny reaches the child; a
child bot never exceeds the parent bot's allowlist and narrows further with its own rules; a
child's ask reaches the parent's guard and starts no turn; the host attaches and releases the
child; a child is found by id and stays out of the list and `--continue`.

#### S3 (2pt): the child row and `o`

`transcript-feed.ts` child rows from `tool.started`, `child.started`, `tool.output`,
`child.finished` and `tool.finished` (live) or the stored result (replay); `PageMarks.lineage`;
`ConversationPorts.openSession` wired through `focusOrOpenSession`; the disclosure hint.
**Accept:** feed and model tests for live, settled, refused and replayed rows and for `o` on
finished, running and unsaved children; e2e `delegation` drives the whole loop.

#### S4 (1pt): headless and the contract

`run.finished.children`, child refusals in `refused`, one stderr line per child without
`--json`; `docs/events.md`, `docs/headless.md`, the event-shapes fixture.
**Accept:** `run.test` for the listing and for a refused child exiting 4; `serve.test` for the
events on the parent's id and the child read by id; the bus and event contract tests.

### Phase two

#### S5 (3pt): the live child pane

`o` on a running child mounts a pane on the child's bus (D6: panes are bus clients), with the
persisted part replayed first and the prompt closed while the delegation owns the file; when
the child's turn ends the pane takes the session over as an ordinary attachment.
**Accept:** the pane streams the child live, never writes while the delegation does, and
becomes a normal session pane after `child.finished`.

#### S6 (2pt): lineage in the overview and over the wire

FR6.17's `↳ spawned by` rows under their parent in the sessions overview, the arcs node and
the arc pane, with the live mark and the bot's sigil; `spawnedBy` on `GET /sessions/{id}` and
`GET /sessions/{id}/children`, additive.
**Accept:** model tests for nesting, ordering and refresh; capture of the overview with two
children; server tests for both routes.

#### S7 (2pt): cost with lineage

Title spend and `/cost` gain a children line from `child.finished`; session summaries carry
lineage cost beside their own; the arcs node sums it (102 #2). Lands after the pricing lane's
`session-ledger.ts` work settles.
**Accept:** `/cost` after two children matches a hand sum; an unpriced child leaves the total
unknown.

#### S8 (1pt): a bot's model for its children

The host resolves the child bot's `model:` seed (PD21.5) and the child runs on it, recorded as
its `model_change`.
**Accept:** a child of a seeded bot streams on the seed's provider; an unresolvable seed falls
back to the parent's provider with a notice.

#### S9 (2pt): the child on the stream and on its asks

The child's bus on `/events` under its own id while it runs; asks from a child carry its id in
`gate.ask`, `GET /asks` and the pane's ask row (`↳ scout · bash git push`).
**Accept:** `?session=<child>` streams the child's turn; the ask row names the child.

#### S10 (2pt): children in `keywork chat`, child shells, child compaction

`chat` passes a host; a child gets its own shell session; the between-batch settler compacts a
long child mid-run.
**Accept:** a child's `cd` doesn't move the parent's shell; a child past its compaction line
compacts and finishes.

#### S11 (3pt, only if earned): parallel children

The agent runs a reply's `delegate` calls together, under the slot cap, results in call order.
**Accept:** two children in one reply overlap in time and both rows run live; a refusal in one
doesn't strand the other.

## Open questions for Jordan

- **Q-SA1 The off switch.** Built: a bot's `tools` allowlist and the permission list
  (`{ "action": "delegate", "resource": "*", "effect": "deny" }`) turn it off with no new
  config. The alternative is a `delegation: "on" | "off"` key that also drops the schema from
  every request, which D9 asks to justify.
- **Q-SA2 The cap.** Four live children per process, as built, or another number?
- **Q-SA3 J6's reading.** Built: a child recalls what a session bound to the same arc and bot
  recalls. The alternative is J6's fail-closed reduced scope for children too.
- **Q-SA4 A person's "no" on a child's ask.** Built: the child keeps going, as its parent would.
  The alternative ends the child at the first declined ask, so the parent hears about it at
  once.
- **Q-SA5 Live drill-in.** Is S5 the next wave, or is the live row enough for now?
- **Q-SA6 Removing a child alone.** Built: it trashes flat and restores as a top-level session.
  The alternative refuses and points at the parent.
- **Q-SA7 The name.** `delegate` (built) or another verb?

## Documents amended by this overlay

- [`119`](119-session-lifecycle.md): a dated note under 119-1, the session file set.
- `docs/research/coding-agent-nuances.md` and `docs/influencers/opencode.md` row 10: the "no
  subagent primitive is planned in core" lines now point here.
- `docs/events.md` ("Child sessions") and `docs/headless.md` (the child rows, `children`, the
  nested refusal).

## Non-goals and what this overlay does not decide

- No background children, no messaging between agents, no forked contexts (120-15).
- No change to `parentSession` or to how forks are read (119-4 stands).
- No config option (Q-SA1).
- Bot memory writes from a child (flush, the micro-sweep) wait for S10; phase one children
  recall and never flush.
- The design session for 102 #1 (the detail slot) decides where lineage cost lives at a glance;
  S7 builds the numbers, not the lens.

## Ledger

### Phase one · S1 to S4 · landed 2026-10-12 (uncommitted)

**Engine (S1).** New `engine/src/delegation.ts` and `engine/src/session/children.ts`.
`SessionHeader.spawnedBy` and `SpawnLineage` (`entries.ts`); `SessionStore.createChild` and
`appendBinding`, with the shared header built by `freshHeader` (`store.ts`). `bus.ts` gains
`child.started` / `child.finished` with `ChildStarted`, `ChildFinished`, `ChildOutcome`,
`RefusedCall`. `agent.ts` gains `NestedRefusalError`: when a tool throws it, the run ends
exactly as when the parent's own ask is declined under `declineEndsRun`. `trash.ts` renames
`sessionFilePair` to `sessionFileSet` (log, spills, children) and moves all three;
`removeSessionFiles` deletes the child dir too. Exports in `engine/src/index.ts`.

**Composition and hosts (S2).** `cli/src/compose.ts`: `DelegationHost`,
`AgentBuildSpec.child` (`ChildPlacement.toolCeiling`), one `ChildSlots` per `composeAgents`,
`delegationFor` building the child through `buildAgent` itself, `toolNarrowing` /
`withinCeiling` / `hooksNarrowedBy` replacing the bot-only `hooksRestrictedTo`, `delegate`
reserved against extension tools. `compose-panes.ts`: the attach and release bodies became
`attachSession` / `releaseSession`, shared by the session port and the delegation host (one
hunk). `serve-workspace.ts`: a child map behind `storeOf` and `bindingOf`, `attached` /
`released` hoisted so children use them. `run.ts`: a child map behind `bindingOf`, the
delegation host, `traceChildren`, `ChildReport`, `conclude(outcome, io, children)`,
`narrateChildren`. `cli/src/sessions/store.ts`: `findSession` falls back to
`findChildSession` over `*.children` dirs.

**TUI (S3).** `transcript-feed.ts`: `ToolRun.child` (`ChildMark`), `markChild`,
`settleChild`, `childRowSpans`, child rows always disclosable, `child.*` followed;
`toolRowSpans(run, marks)`. `marks.ts`: `lineage` (`↳` / `>`). `transcript-view.ts` passes
the layout's marks. `conversation-model.ts`: `cursoredChild`, `openCursoredChild`,
`ConversationPorts.openSession`, `isOpenSpillKey` renamed `isOpenKey`.
`conversation-pane.ts`: `openHint`. `session-panes.ts`: `openSession` through
`focusOrOpenSession` when a tree port exists.

**Contract and docs (S4).** `server/src/events.ts` lists both events;
`contract-fixtures.ts` samples them; `bun run contract:fixtures` regenerated
`event-shapes.fixture.json` (two entries) and `openapi-document.fixture.json` (two names in
the envelope's type enum). This lane left `contractVersion` alone on the coordinator's
instruction; the integration's one bump to `1.1` (shared with the permissions lane's route)
was already in the tree when the lane closed, and `bun run check:contract` passes. `docs/events.md` gains a "Child
sessions" section (and the stale "fourteen of the fifteen types" line now counts nothing);
`docs/headless.md` gains the child rows, the `children` field and the nested refusal.

**Tests added.** `engine/src/delegation.test.ts` (13: the nested child with lineage, name,
messages, attach and release; arc and bot binding; inheriting the parent's bot; unknown bot;
depth; full slots; a failing child frees its slot; the headless refusal ending the parent with
no extra model call; the interrupt reaching the child; `childGuardOf`; provenance round trip
including a bot named `completed`; `childTitleOf`; slot release). `session/trash.test.ts`
(the file set, children moved and restored, children discarded). `bus.test.ts` (two
sections). `cli/src/delegation.test.ts` (7: tool offered only with a host and never to a
child; host attach, binding and lineage; a policy deny reaching the child; the parent bot's
ceiling; a child bot's own narrowing; one permission rule turning `delegate` off before any
child exists; the child's ask reaching the parent's guard with one `beforeTurn`). `cli/src/run.test.ts` (3: children on the stream and on `run.finished` with
the nested file; a refused child exiting 4 with one parent turn; the stderr line) plus the
panes parity test now composing with a host. `cli/src/serve.test.ts` (child events on the
parent's id, the result's first line, `GET /sessions/{child}`, one top-level store).
`cli/src/sessions/store.test.ts` (a child found by id, absent from the list and from
`--continue`). `server/src/server.test.ts` (both events cross SSE through the existing every-type
loop). `tui/src/transcript-feed.test.ts` (4: live row with activity, cost and answer detail;
cursorable while running; refused without the raw reason; rebuilt on replay).
`tui/src/conversation-model.test.ts` (3: `o` opens a finished child, says so while running,
says so when unsaved). `scripts/e2e/scenarios/index.test.ts` (the registry order).

**e2e.** New scenario `delegation` (`scripts/e2e/scenarios/delegation.ts`): converse, delegate,
the settled row `↳ child · count the files · 24ms · done`, `shift+tab` and the hint, `o`
opening the child's pane titled `count the files` with its own transcript. Three captures, no
goldens. Its agent factory wires `delegateTool` by hand because the harness replaces the
composed factory; the parent store comes from disk after the first turn.

**Commands run.** `bun x tsc --build` clean. `bun x vitest run packages/engine packages/cli
packages/server packages/tui scripts/e2e/scenarios/index.test.ts`: 324 files, 4417 passed and
2 skipped. `bun run check:prose`, `check:guardrails`, `check:pins` and `check:contract` ok;
`biome check` clean on every touched file. `bun scripts/e2e-capture.ts` for `delegation`
(pass, 3 captures), `session-lifecycle` (pass, 8), `first-conversation` (pass, 5) and
`discovery` (pass, 5 goldens verified unchanged). No golden touched. Full `bun run test` and
`bun run e2e` not run: other lanes edit the tree concurrently.

**Deviations from the design above.**

1. Drill-in opens finished children only; a running child answers
   `the child is still working · o opens it once it's done` (S5).
2. Children run on the parent's provider; the bot's `model:` seed waits for S8.
3. The child's spend shows on its row only; the title, `/cost` and summaries wait for S7,
   because `session-ledger.ts` is in the pricing lane's hands this round.
4. Under `serve` the child's own bus isn't on `/events` and its asks carry the parent's
   session (S9).
5. `keywork chat` composes no delegation host, so the REPL has no `delegate` (S10).
6. The row names the bot without its sigil (S6).
7. A resumed child opened in a pane still lists `delegate` in its schema and refuses by depth
   when called; hiding it would need the session's lineage before the agent is built.

**Verified versus inferred.** Verified in source or by test: everything under "Where the tree
stood", every decision's mechanism, the Pi-format fixture unchanged. Read on the web today and
not re-verified against source: the four rows of "What the field does" (Claude Code, OpenCode
and Codex from their docs, Pi from its example's README). Inferred: that Pi's reader ignores an
unknown header key; the schema's token cost, estimated at four characters a token rather than
measured with a tokenizer.
