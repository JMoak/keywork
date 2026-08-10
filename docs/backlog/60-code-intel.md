# Workstream F — Code Intelligence

> All three rungs committed (D5 — "going hard in the paint"), landed in cost order: CLI
> recipes → repo map → LSP-as-agent-tools. Rungs 2–3 are blessed extensions, proving the
> extension API carries real features.

---

### F1 (1pt) — CLI recipes
Curated skills/commands (D5/D7 formats) for the TS toolchain: `typecheck` (tsc), `lint`
(biome/eslint detection), `test` (vitest/bun detection), each with output-parsing hints in
the prompt body so the model reads results well. Not core code — content.
**Accept:** skills invoke correctly in a fixture TS repo via mock conversation.
**Strategy:** `OWN` content.

### F2 (3pt) — Repo map: extraction & ranking
Blessed extension: parse TS/JS (ts-morph or SWC) for exported symbols/signatures; rank by
graph centrality + recency (Aider's approach, Apache-2.0 — adaptable); respect
`.keyworkignore`; incremental cache keyed by file hash.
**Accept:** fixture repo yields stable ranked map; incremental update touches only changed
files; snapshot test on map content.
**Strategy:** `LIFT:aider` ranking approach (attribute); `OWN` TS implementation.

### F3 (1pt) — Repo map: injection policy
Token-budgeted map injection via D2 context hook: configurable budget, shrink-to-fit
(drop lowest-ranked), on-demand `repo_map` tool for the model to request more.
**Accept:** token-count test honors budget; tool call returns expanded map.
**Strategy:** `LIFT:aider` policy ideas.

### F4 (3pt) — LSP lifecycle
Blessed extension: spawn/manage `vtsls` (or `typescript-language-server` — pick by eval,
document): initialize handshake, doc sync driven by file-change events, health monitoring,
graceful degradation when the server dies (agent falls back to F1/F2 silently — never blocks
the loop).
**Accept:** server boots against fixture repo; kill-recovery test; degradation test proves
loop continues without it.
**Strategy:** `OWN` design; consult `LIFT:opencode` MIT LSP layer where useful.

### F5 (2pt) — LSP as agent tools
Expose `diagnostics` (post-edit errors/warnings, push-after-write as context hint),
`symbol_lookup` (definition/references/hover) as registered tools; the after-edit diagnostics
push is the killer feature — the model sees the type error the moment it writes it.
**Accept:** E2E — mock agent introduces a type error, diagnostics event lands in context
within the same turn; symbol lookup round-trips on fixture code.
**Strategy:** `OWN` design and implementation.
