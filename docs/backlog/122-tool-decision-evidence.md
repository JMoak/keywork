# 122: Tool-call decisions as evidence for an external decider

> **Kind:** design overlay + ledger (2026-10-21), adopted the same day (Jordan's four decisions
> of record below); TD1 to TD3 landed with it. It owns the evidence keywork keeps about its own
> permission decisions: whether a verdict answered an ask (`asked` on `PermissionDecision`), the
> journaled ask (`permission_ask`), and the `keywork sessions decisions` export with its
> `keywork.tool-decision/1` record. It amends [`50-trust.md`](50-trust.md) and
> [`108`](108-survivability-and-launch-rail.md) A19 only where it speaks: asks are now session
> entries too, and they are still never replayed. It changes nothing about who answers an ask;
> the trust gate, presets, grants and the headless contract stand as they were.
>
> **Standing guardrails (unchanged):** Anthropic is API-key / Agent-SDK only. Pi and OpenCode
> are MIT and adapted only with attribution in `NOTICE`; nothing here lifts code from either or
> from anywhere else, and `NOTICE` is untouched. Crush is never a source. The user commits;
> agents never `git commit` or `git push`. Every task below is `OWN`.

## What it is

Ratchet (Jordan's decision engine, a separate repository) wants to learn when a cheap decision
model could answer keywork's tool-call asks without bothering the person. To earn that, it needs
an honest record of what keywork asked, what the person said, and what keywork's own code knew
about the call. keywork must not depend on Ratchet, must not call a model for this, and must not
let a verdict from outside reach a live session. This overlay gives keywork that record and one
command that exports it.

The one-line model: a **tool decision** is one verdict on one agent tool call, carrying the facts
keywork computed about the call (for a command: its parts, whether one is destructive, whether
one is opaque; for a path: whether it sits inside the session's folder and how big the change
is), who answered it (`person`, `headless`, `grant`, `rule`, or `unknown` for journals written
before this overlay), and how long the answer took.

## Where the tree stood (2026-10-20)

Read in source before deciding.

- **Asks were never journaled.** `tapJournal` recorded `gate.permission` but not `gate.ask`
  (`engine/src/session/journal.ts`); the event reference said "never replayed" and the entry
  never existed, so a reopened session could not say what a person had been shown.
- **A fresh answer and a covered call looked the same.** An answered ask with scope `session`
  and every later call that grant covered both journaled as `{ gate: "user", scope: "session" }`
  (`engine/src/agent.ts` ask path versus `permission-ledger.ts` `engineRuling`). Only the first
  is a person's judgment of that call.
- **The facts already existed in code.** `commandParts`, `isOpaqueCommandPart` and
  `isDestructiveCommand` (`shared/src/trust/`) classify a command; they were not exported.
- **Scrubbing for Jev already existed.** Memory scrubs what it sends to Jev with
  `redactForPersistence` and the `knownSecrets` the CLI gathers (`cli/src/memory-decider.ts`).
- **History is thin.** Jordan's machine held 30 sessions with 42 permission decisions, 25 of
  them a person's answer (21 granted, 4 denied), from 2026-08-09 to 2026-08-31.

## Decisions of record (Jordan, 2026-10-21)

- **TD-D1 · What leaves the machine.** The call and keywork's computed facts: the tool name, the
  bash command or the file path, part count, destructive, opaque, inside the session's folder,
  and the size of a write or edit. No file text, no preview text, no conversation. Commands and
  call arguments pass the memory scrubber (known secret values and key shapes) and a mask for
  secret-named assignments (`API_KEY=…`, `$env:GH_TOKEN = …`); a long command is capped and says
  so. A path outside the folder shows the home directory as `~`.
- **TD-D2 · Batch, not live.** keywork exports from its journals on demand and Ratchet replays
  the export through its gate in shadow. keywork never asks a decider about tool calls, adds no
  latency to a turn, and has no path by which a shadow verdict could touch a session.
- **TD-D3 · The bar lives in Ratchet.** Ratchet may propose auto-approval only after an exact
  one-sided 95% bound puts its acted accuracy at or above 98% on a sample planned before the
  data (149 consecutive correct acts when none is wrong). keywork's part is the honest record.
- **TD-D4 · Audits stay opt-in in Ratchet.** A gate promoted without blind audits cannot be
  demoted automatically, and Ratchet says so when it promotes one.

Taken with them, and stated so they can be questioned:

- `asked` is a field on every decision, not a new `gate` value: a client reading `gate: "user"`
  keeps working, and the field tells a person's answer from the calls it covered.
- The journaled ask holds no arguments (the assistant message already carries them) and no
  preview text, only `{ creates, linesBefore, linesAfter }`.
- The export lives under `keywork sessions`, walks delegated children, and names each child's
  root session so related calls can be grouped.
- keywork does not import Ratchet, now or for this.

## The record: `keywork.tool-decision/1`

One JSON object per line, one line per decision on an agent tool call (shell escapes and the
sandbox's unconfined consent are not agent calls and are skipped).

| Field | Meaning |
|---|---|
| `schema` | `"keywork.tool-decision/1"`. |
| `session`, `rootSession` | The session that decided, and the top-level session it belongs to. |
| `callId`, `at`, `tool` | The call, when the decision was journaled, and the tool's name. |
| `subject` | `{ kind: "command", command, truncated, parts, destructive, opaque }` for `bash`; `{ kind: "path", path, insideWorkspace, change? }` for `read`, `write` and `edit`, where `change` is `{ kind: "write", lines }` or `{ kind: "edit", removedLines, addedLines, replaceAll }`; `{ kind: "call", arguments, truncated }` for anything else, its arguments scrubbed and capped at 1,000 characters. |
| `ask` | Present when the ask was journaled: `{ at, rule, grantable, change? }`. |
| `answer` | `{ at, verdict, gate, scope?, by, afterMs? }`. `by` is `person`, `headless`, `grant`, `rule` or `unknown`; `afterMs` is the time from the ask to the answer. |
| `result` | `{ isError }` for a granted call that ran. |

`by` reads `asked` when the decision has it. An older decision is read conservatively: a denial,
a `once` answer or an answer without scope by `gate: "user"` is a person's; a `user` decision
with `session` or `workspace` scope is `unknown`, since it may be an answer or a covered call.

## Tasks

| Task | What | Points | State |
|---|---|---|---|
| TD1 | `asked` on every `PermissionDecision`: the agent, the sandbox's unconfined consent, the shell escape; contract 1.3 | 1 | landed 2026-10-21 |
| TD2 | `permission_ask` journal entry from `gate.ask`, never replayed | 1 | landed 2026-10-21 |
| TD3 | `keywork sessions decisions [--out <path>]` and the record above | 2 | landed 2026-10-21 |
| TD4 | keywork-app: refresh its contract fixtures (`client/src/fixtures/doc.json`, the protocol event fixtures) from 1.2 to 1.3 | 1 | open, in keywork-app |
| TD5 | Shared redaction: the long-token rule counts `/` as a token character, so a long path with mixed case and digits is redacted whole (`C:‹redacted:token›.ts`). The export keeps paths out of shape scrubbing; commands still lose such paths, which errs safe but costs the decider a fact | 1 | open, observed |
| TD6 | A tool-call decider port in the trust gate that may answer an ask in enforce mode, never for a destructive part, only once Ratchet's evidence clears TD-D3 | 3 | not started; needs its own overlay |

## What this does not decide

Whether keywork ever lets a decider answer an ask (TD6), which model it would be, and how such a
decider would be configured. Those wait for evidence, and for an overlay of their own.

## Ledger

- **2026-10-21 · TD1 to TD3.** `engine/src/session/journal.ts` (`asked`, `JournaledAsk`,
  `journaledAsk`, the `permission_ask` event, never replayed), `engine/src/agent.ts`,
  `engine/src/sandbox/session.ts`, `tui/src/shell-escape.ts`, `shared/src/trust/index.ts`
  (exports `commandParts`, `isOpaqueCommandPart`, `isDestructiveCommand`),
  `cli/src/sessions/decisions.ts` and the `decisions` subcommand, `server/src/contract.ts` 1.3
  with regenerated fixtures, [`../events.md`](../events.md). Tests:
  `engine/src/session/journal.test.ts` (asked on allow, ask, deny and a covered call; the ask
  entry without arguments or text; ask before answer; never replayed; a created file),
  `cli/src/sessions/decisions.test.ts` (computed facts, grant versus person, older journals,
  scrubbing, the cap, paths and home, no file text, skipped non-agent decisions, results only
  for calls that ran, delegated children, the command), and the existing suites updated where
  they assert whole decisions.
