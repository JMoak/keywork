# keywork — Implementation Task Breakdown

> **Note (post-review):** task IDs in this file are superseded narrative — the canonical,
> fine-grained IDs live in [`backlog/`](backlog/README.md), with
> [`backlog/90-plan-review.md`](backlog/90-plan-review.md) as the authoritative overlay
> (new tasks, resequencing, corrected milestone map).

> Derived from [`vision.md`](vision.md). Organized for **parallel execution**: six workstreams
> with explicit dependency gates. Tasks tagged with their lift strategy:
> **[LIFT:pi]** / **[LIFT:opencode]** / **[LIFT:aider]** — adapt MIT/Apache source with attribution ·
> **[OWN]** — original work. (The former **[REIMPL:crush]** tag is retired — 2026-08-10
> decision: Crush is not a design source; those items are now [OWN].)
>
> Anthropic provider wiring is deliberately **absent until M3** (API-key only, per guardrail).

## Milestones

- **M0 — Skeleton**: repo builds, tests run, CI green. (serial, small)
- **M1 — Core loop**: talk to a model, four tools work, sessions persist, single-pane TUI.
- **M2 — Identity**: tiling panes, keyboard system, extensions, gate, undo. *The demo.*
- **M3 — Depth**: MCP host, repo map, Anthropic API-key provider, polish.
- **P2 — Reach** (post-v1): workspace server, `keywork attach`, shared workspaces, LSP tools.

## M0 — Skeleton (serial; everything gates on this)

| ID | Task | Strategy |
|---|---|---|
| M0.1 | Bun + TS monorepo scaffold: `packages/{engine,tui,extensions,cli}`, Vitest wired, strict tsconfig | [LIFT:opencode] repo layout patterns |
| M0.2 | Supply-chain hygiene: exact pins, `--ignore-scripts`, lockfile CI check | [LIFT:pi] practices |
| M0.3 | `AGENTS.md` (+ `CLAUDE.md` shim) with conventions, guardrails, lift-attribution policy, NOTICE file for attributions | [OWN] |
| M0.4 | CI: typecheck + Vitest + lint on Windows & Linux runners | [OWN] |

## Workstream A — Engine core (owner-track 1)

| ID | Task | Depends | Strategy |
|---|---|---|---|
| A1 | Provider-agnostic message/turn format + streaming abstraction | M0 | [LIFT:pi] `pi-ai` / [LIFT:opencode] `packages/llm` — study both, pick one, **excise all subscription-OAuth** |
| A2 | Typed event bus: event vocabulary designed OpenAPI/SSE-shaped (D7) | M0 | [OWN] bus design; [LIFT:opencode] SSE event naming |
| A3 | Agent loop: prompt assembly (shortest-viable system prompt), tool dispatch, steer/queue interruption semantics | A1, A2 | [LIFT:pi] loop + prompt structure + `streamingBehavior` |
| A4 | Four core tools: `read`/`write`/`edit`/`bash` (Windows-first bash story decided here) | A3 | [LIFT:pi] tool impls |
| A5 | Headless print/JSON mode over the bus (unlocks E2E Vitest harness for everyone) | A3 | [LIFT:pi] print-mode contract |
| A6 | First non-Anthropic provider live (e.g. OpenAI-compatible + one more) for daily driving | A1 | [LIFT:opencode] provider configs |

## Workstream B — Sessions (owner-track 2; parallel with A after M0)

| ID | Task | Depends | Strategy |
|---|---|---|---|
| B1 | JSONL tree store: Pi session format (`id`/`parentId`, active leaf), read/write/replay | M0 | [LIFT:pi] documented `session-format.md` |
| B2 | Tree ops: `/fork`, `/clone`, `/tree`, labels, branch summaries on switch | B1 | [LIFT:pi] |
| B3 | Compaction: auto + promptable `/compact`, branch-aware | B1, A3 | [LIFT:pi] |
| B4 | Replay contract for extension state reconstruction (feeds D-stream) | B1 | [LIFT:pi] |

## Workstream C — TUI & keyboard (owner-track 3; parallel after M0)

| ID | Task | Depends | Strategy |
|---|---|---|---|
| C1 | OpenTUI app shell + render discipline (flicker-free contracts: width-constrained render, output caching) | M0 | [LIFT:opencode] `packages/tui`; [LIFT:pi] pi-tui *contracts* as spec |
| C2 | Keyboard system: leader key + timeout, rebindable JSON (`"none"`, platform defaults), namespaced actions, hot reload | C1 | [LIFT:opencode] binding resolution; [LIFT:pi] hot reload |
| C3 | Command palette = live keybinding docs + runnable actions; discoverability overlay | C2 | [LIFT:opencode]; Omarchy `Super+K` idea |
| C4 | **Tiling pane framework**: panes as bus-subscriber views; verbs split/rotate/zoom/close/focus (D6). **Acceptance (Hyprland-grade dynamic tiling):** one-keystroke pane summon (leader+key per pane type); automatic dwindle-style placement and instant re-balance on open/close — never mandatory manual resizing; directional focus nav (leader+h/j/k/l), directional swap/move, zoom-toggle fullscreen, layout cycle; every verb discoverable in the palette/overlay | C1, A2 | [OWN] — the differentiator; no influencer has this |
| C5 | Conversation pane: streaming render, steer/queue keys, markdown, tool-call display | C4, A3 | [LIFT:opencode] components; [LIFT:pi] steer UX |
| C6 | Session-tree pane + diff pane + terminal pane (first pane set) | C4, B2 | [OWN] composition; [LIFT:opencode] diff rendering |
| C7 | Theming: token palette, JSON schema, `system` terminal-derived default | C1 | [LIFT:opencode] theme schema + system theme |
| C8 | Status line: trust indicator slot, honest token/cost display | C1, A3 | [OWN] |

## Workstream D — Extensions & commands (owner-track 4; parallel after A2)

| ID | Task | Depends | Strategy |
|---|---|---|---|
| D1 | Extension API: Pi's event taxonomy (~30 hooks), registerTool/Command/Shortcut, replayable entries | A2, B4 | [LIFT:pi] wholesale |
| D2 | `/reload` hot reload (extensions/skills/themes/keybindings) | D1 | [LIFT:pi] |
| D3 | Markdown commands: `$ARGUMENTS`, `` !`cmd` ``, `@file`; agents-as-markdown frontmatter | D1 | [LIFT:opencode] verbatim format |
| D4 | `SKILL.md` support + cross-agent discovery walk (`.claude/skills`, `.cursor/skills`, …) | D1 | [OWN]; open standard |
| D5 | **MCP host in core, lazy** (D1-gated): stdio/http/sse transports, deferred tool schemas (names only until used) | D1, A3 | [LIFT:opencode] server-side MCP endpoints; [OWN] lazy-schema design |
| D6 | `.keyworkignore` (gitignore syntax) respected by tools + repo map | A4 | [OWN] (trivial) |

## Workstream E — Trust & safety (owner-track 5; small, parallel after D1)

| ID | Task | Depends | Strategy |
|---|---|---|---|
| E1 | Gate extension: allow/ask/deny matrix, glob bash rules, per-agent | D1 | [LIFT:opencode] config model |
| E2 | Trust ladder UX: visible level in status line, one key to change (feeds C8) | E1, C8 | [OWN] design |
| E3 | Git-snapshot `/undo` `/redo` | A4 | [LIFT:opencode] mechanism |
| E4 | Plan/Build blessed agents + Tab switch | D3, E1 | [LIFT:opencode] markdown agents verbatim |

## Workstream F — Code intelligence (owner-track 6; independent after A4)

| ID | Task | Depends | Strategy |
|---|---|---|---|
| F1 | v1: curated CLI recipes (tsc, eslint, etc.) as skills/commands, not core code | A4, D3 | [OWN] |
| F2 | Repo map extension: ranked structural context | D1 | [LIFT:aider] Apache-2.0, adapt to TS |
| F3 | LSP-as-agent-tools extension (`vtsls` first): diagnostics + symbols; lifecycle mgmt | D1, F2 | [OWN] design / [LIFT:opencode] MIT LSP layer |

## M3 gate — Anthropic provider (deliberately late)

| ID | Task | Depends | Strategy |
|---|---|---|---|
| G1 | Anthropic provider via **API key / Agent SDK only**; review confirms zero OAuth/spoofing surface | A1 stable | [OWN] against official SDK; guardrail-reviewed |

## P2 — Reach (designed now, built post-v1)

Server wrap of the bus (OpenAPI 3.1 + SSE) → `keywork attach --pane X` (tmux/zellij mounting)
→ shared workspaces by `--cwd` [OWN] → notifications designed from keywork's own
work-management model [OWN] → `/share`-style HTML export [LIFT:pi].

## Parallelization map

```
M0 ──► A (engine) ──┬─► A3 ──► A4/A5/A6
      B (sessions) ─┤   (B needs A3 only for B3)
      C (tui) ──────┤   C4 needs A2 · C5 needs A3 · C6 needs B2
                    └─► D (extensions) after A2/B4 ──► E, F after D1
```
Six tracks run concurrently after M0; the critical path is **A2 → A3 → C4/C5 → M2 demo**.
Suggested build order for a small team (or agent fleet): M0 serial → A+B+C1-C3/C7 in
parallel → D as soon as A2 lands → E/F opportunistic → M2 integration → M3.

*Written 2026-08-09; revisit at each milestone gate.*
