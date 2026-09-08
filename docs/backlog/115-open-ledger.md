# 115: The open ledger

> **Kind:** running pickup list (2026-09-07). Decides nothing; every item cites the overlay that
> owns it. Read this first when resuming, then the owning overlay before building. Strike items
> as they land and add the landing date; when a section empties, delete it.

## Where the tree stands (2026-09-07)

Wave 4 committed at `0c8ac9a`, tree clean. `bun run check` clean; vitest 273 files / 3854
tests. One run failed a single test in `packages/engine/src/tools/tools.test.ts` (bash-tool
timing) and two reruns passed: a flake to pin before the next lane lands on top.

## Pickup order

1. Pin the `tools.test.ts` flake; run the gate three times.
2. Small unblocked lanes in disjoint pairs: P2.5 + E9, then P2.6 + the V2 trio, audit crumbs
   alongside.
3. Options-first notes for P2.3 and E8 (E8 gates the LSP runner seam per 114).
4. One sitting for the decisions below; Q-B6 and decision 5 free the most code.

## Unblocked, specified, unbuilt

| Item | Owner | Size | Note |
|---|---|---|---|
| P2.5 HTML export (`/export`) | [80](80-p2-reach.md) | 2 | `LIFT:pi`, self-contained |
| P2.6 external prompt injection | [80](80-p2-reach.md) | 2 | endpoint on the landed P2.1 server |
| ~~S0 serve discovery (per-workspace ticket, `--port 0`, stale-ticket tolerance, `/doc` workspace)~~ | [80](80-p2-reach.md) | 2 | landed 2026-09-07 |
| ~~S1 the ask queue (`gate.ask`, `GET /asks`, `POST /asks/{callId}`, `asOf`)~~ | [80](80-p2-reach.md) | 3 | landed 2026-09-07 |
| P2.3 shared workspaces | [80](80-p2-reach.md) | 5 | also decides B1 store concurrency; scope first |
| E9 secrets at rest | [103](103-dsh-influence.md) | 2 | no keychain code exists |
| E8 sandbox modes | [103](103-dsh-influence.md) | 3+ | fail-closed runner seam; scope first |
| J14 sync self-reconciliation | [95](95-memory-and-skills.md) | 3 | nothing built |
| V2.7 @-mention, V2.11 provenance gutter, V2.16 commit drafting, V2.17 away summary + `/btw`, V2.5 compaction offer | [96](96-conversation-enrichment.md) | 1–2 each | no code for any |
| FR6.18 enterprise security scoping doc | [101](101-feedback-round-4.md) | 2 | a document |
| Audit phase 3 crumbs | [111](111-code-audit.md) | 1 | `isPresetName` guards in `presets.ts`, `clip` in `mcp-pane-model.ts`, five-field copy in `cli/src/mcp.ts` |

## Waiting on Jordan

| Call | Owner | What it frees |
|---|---|---|
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
- FR4.11 ChatGPT provider: behind its ToS gate ([101](101-feedback-round-4.md)).
