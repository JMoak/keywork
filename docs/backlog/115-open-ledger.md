# 115: The open ledger

> **Kind:** running pickup list (2026-09-07). Decides nothing; every item cites the overlay that
> owns it. Read this first when resuming, then the owning overlay before building. Strike items
> as they land and add the landing date; when a section empties, delete it.

## Where the tree stands (2026-10-07)

The 117 sweep is committed at `25e9f67`. On top of it, uncommitted: the 2026-10-07 round
(wave one: the pty terminal pane SW11, the extension host D1 to D3, thinking replay per
generation + mid-run compaction + `/forget`, six feel-polish items, the memory lane; wave two
stopped early at the wrap-up call: runway audit rows cleared, MCP elicitation parsing only,
extension product wiring planned in 40). Gate after integration: `bun run check` clean,
vitest 324 files / 4426 tests, e2e 48 of 48 (`memory-browser` and `terminal-mirror` can flake on
timing under full-run load and pass in isolation). Earlier state: wave 4 committed at `0c8ac9a`.

## Pickup order

Read [117](117-influence-sweep.md) before this list. Its four phases landed on 2026-10-02 (29 tasks,
ledger at the end of that file, gate 302 files / 4229 tests, e2e 47 of 47, all uncommitted); what
remains of it is SW10 (Bun, decision 117-3), SW11 (the terminal pane spike) and the scope-first
items, plus the calls listed under "Where the tree stands" there.

1. Jordan reviews and commits the 2026-10-07 round (commit messages proposed per lane in the
   117 / 40 / 95 / 30 ledgers); installs Bun 1.3.14 locally so the e2e harness stops
   segfaulting on Ctrl+C.
2. Extension host product wiring (40 "Product wiring, not landed"): decide the multi-session
   hosting shape first, then `host.observe(bus)`, composition, toasts, `/extensions`, docs.
3. MCP elicitation retry loop through the ask gate, then OAuth to the 2026 rules (117 "MCP
   lane"); both need one-line seams in `compose.ts` and a `keywork mcp` command.
4. Linux walk for SW11 (`docs/windows.md` lists the steps) and the launch runway walk.
5. Options-first notes for P2.3 and E8 (E8 gates the LSP runner seam per 114).
6. One sitting for the decisions below; the 2026-10-07 calls are listed first.

## Unblocked, specified, unbuilt

| Item | Owner | Size | Note |
|---|---|---|---|
| ~~P2.5 HTML export (`/export`)~~ | [80](80-p2-reach.md) | 2 | landed 2026-10-02: `/export [tree] [path]` and `keywork sessions export`, own renderer (no Pi code) |
| ~~P2.6 external prompt injection~~ | [80](80-p2-reach.md) | 2 | landed 2026-10-02: `POST /sessions/{id}/inject`, queues behind a running turn, origin on `turn.started` |
| ~~S0 serve discovery (per-workspace ticket, `--port 0`, stale-ticket tolerance, `/doc` workspace)~~ | [80](80-p2-reach.md) | 2 | landed 2026-09-07 |
| ~~S1 the ask queue (`gate.ask`, `GET /asks`, `POST /asks/{callId}`, `asOf`)~~ | [80](80-p2-reach.md) | 3 | landed 2026-09-07 |
| P2.3 shared workspaces | [80](80-p2-reach.md) | 5 | also decides B1 store concurrency; scope first |
| ~~E9 secrets at rest~~ | [103](103-dsh-influence.md) | 2 | landed 2026-10-02 |
| E8 sandbox modes | [103](103-dsh-influence.md) | 3+ | fail-closed runner seam; scope first |
| ~~V2.7 @-mention~~, V2.11 provenance gutter, ~~V2.16 commit drafting~~, ~~V2.17 away summary + `/btw`~~, ~~V2.5 compaction offer~~ | [96](96-conversation-enrichment.md) | 1–2 each | V2.7, V2.16, V2.17 landed 2026-10-02; V2.5 landed 2026-10-07; V2.11 detection landed, glyph flip is Jordan's call |
| Extension host product wiring (composition, toasts, `/extensions`, `docs/extensions.md`) | [40](40-extensions.md) | 5 | host landed 2026-10-07; wiring plan and the bus-seam gap recorded |
| MCP elicitation retry through the ask gate · MCP OAuth (CIMD, PKCE, RFC 9207, E9 vault) | [117](117-influence-sweep.md) "MCP lane" | 3 + 5 | `mcp/elicitation.ts` parsing landed 2026-10-07; nothing else |
| SW11 Linux verification · SW10 Bun trial | [117](117-influence-sweep.md), `../windows.md` | 1 + 2 | pane landed 2026-10-07 by construction; steps written |
| J14 multi-host half (per-host layout, merge driver, lease) | [95](95-memory-and-skills.md) | 3 | single-vault reconcile landed 2026-10-07 |
| FR6.18 enterprise security scoping doc | [101](101-feedback-round-4.md) | 2 | a document |
| ~~AB2 honest MCP denial hint~~, AB5 agentbox first boot | [116](116-agentbox.md) | 1 each | AB2 and AB3 landed 2026-10-02; AB1 waits on Q-AB1; AB5 needs a Docker host |
| Audit phase 3 crumbs | [111](111-code-audit.md) | 1 | `isPresetName` guards in `presets.ts`, `clip` in `mcp-pane-model.ts`, five-field copy in `cli/src/mcp.ts` |
| K0 checkpoints and per-session inference under `keywork serve` | [118](118-app-surface.md) | 1 | prerequisite for K1 undo and K2 changes; `serve` composes `checkpoints: "off"` and one process provider today |
| K1 session verbs (`behavior` on prompt, `/events?session=`, model, thinking, effort, compact, undo, redo, context, cost, export, rename, `model` on summaries) | [118](118-app-surface.md) | 3 | the app's S3 + S8 + half of S4; shapes dictated by the engine, cited in 118 |
| K2 tree and diff (entries, fork, label, changes, per-path diff, `changes.updated`, `session.tree`) | [118](118-app-surface.md) | 3 | the app's S2 + the rest of S4 |
| K3 workspace, files, trust, status (`/workspace`, `/tree`, `/files`, `/workspace/trust`, mcp, arcs, bots, workspaces, flavors, `surface.changed`) | [118](118-app-surface.md) | 3 | the app's S5 + S7 + S9; the trust route waits on Q-AS1 |
| K4 memory (inbox, layers, notes, daily, verbs, `memory.inbox`) | [118](118-app-surface.md) | 2 | the app's S6 expanded; inert when untrusted |

## Waiting on Jordan

| Call | Owner | What it frees |
|---|---|---|
| Thinking replay cut (Opus 4.5+ / Sonnet 4.6+ / Fable 5+ / Mythos 5+ versus the 5.5 generation only) · thinking-off requests on a preserving model · the live smoke on a post-2026-08-31 key | [70](70-anthropic.md) deviation 3, [117](117-influence-sweep.md) | built on the wider cut; a four-number edit narrows it; smoke closes the compliance sign-off |
| Cache warming: build the keyed off-by-default version or leave it | [117](117-influence-sweep.md) options note | recommendation is leave it |
| Extension host: activation order (project first, then user; Pi does the reverse) · `extension.notice` at `info` over SSE · hook deadline 10s · multi-session hosting shape · `host.observe(bus)` · bot tool restriction over extension tools | [40](40-extensions.md) | the product wiring lane |
| `memory forget` should also drop `curation.md` audit lines that mention the session | [95](95-memory-and-skills.md) | one rule in `forget.ts` |
| Feel polish: `ctrl+v` as the clipboard-image chord · `vi` as the POSIX editor fallback · cost in the title unfocused-only | [30](30-tui.md) C7 | rebinds only |
| V2.11 agent tool rows flip to ▓ | [96](96-conversation-enrichment.md) | one line plus five goldens |
| 117-3 Bun 1.4 · hold the first `Bun.*` product call (`tools/pty.ts`) until then? | [117](117-influence-sweep.md) | SW10; the probe makes the pty call harmless on Node |
| Persist injection origin (P2.6) · `keywork secret set` and plaintext migration (E9) | [80](80-p2-reach.md), [103](103-dsh-influence.md) | small follow-ups |
| Q-B6 bot briefing: own task or folded into J21 | [106](106-bots.md) | C68 part 2 (bot tag in memory pane and digest, `/bot <slug>` briefing), J21 arc briefing (spec only, three open questions) |
| Q-B3 global bot memory location · Q-B4 mid-session switch (look at Grok Bot first) · Q-B7 self-naming trigger | [106](106-bots.md) | built as assumptions; a no reverses them |
| J27 `self` level | [106](106-bots.md) | reads "not built yet, runs as notes" |
| Q-L1 to Q-L5 | [114](114-lsp.md) | all built on the recommendations; F5 read tools wait on a dogfooding note |
| Audit decision 5, shell drivers | [111](111-code-audit.md) | recommendation written (keep both); a yes closes R-05 with no code |
| Q-P1 needs-you stamp · C71-c main-area pins · C72-c heat candidates · C57 frame-budget bar | [113](113-arcs-and-chrome-wave.md), [112](112-feel-and-look-wave.md), [100](100-visual-craft.md) | render options, Jordan picks |
| Lens grammar Q1–Q9 | [102](102-instrument-grammar.md) | design session never scheduled |
| First tag, npm name, README one-liner, Linux walk | [`../launch-runway.md`](../launch-runway.md) | the launch button |

## Parked by design

- FR6.17 subagent transparency: nothing to attach to until spawning exists ([101](101-feedback-round-4.md)).
- ~~FR4.11 ChatGPT provider: behind its ToS gate ([101](101-feedback-round-4.md)).~~ Landed: `cli/src/codex-login.ts` is wired into setup and the inference runtime, recorded in `NOTICE` (noticed stale 2026-10-02).
