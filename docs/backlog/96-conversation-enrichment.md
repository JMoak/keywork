# Conversation Pane Enrichment & Streaming Feed — Planning Overlay

> Planning overlay, 2026-08-10. Where this file speaks for the conversation pane's
> streaming feed it wins; elsewhere the usual chain applies
> ([`95-memory-and-skills.md`](95-memory-and-skills.md) → 94 → 92 → 91 → 90 → workstreams).
>
> A companion analysis — `docs/research/coding-agent-nuances.md`, a triage of nuanced
> behaviors across mature coding agents against keywork's philosophy — is being produced
> in parallel. When it lands, its shortlist merges into the candidate list below; nothing
> here is adopted until that merge is reviewed. Crush is excluded from that survey by
> decision (2026-08-10).

## Where the pane stands (Track V + QA, landed)

Multiline prompt with real cursor, input history ring, clamped scrollback with live-snap,
tool blocks collapsing in place (`· name args` → `✓ name — firstLine`), queued prompts as
dim `⋯` rows draining FIFO, wheel scroll, ask modal y/a/n, dispose that denies/interrupts.
The pane is functional. Enrichment is about making the feed *legible at a glance* — the
density-ramp identity applied to the one surface users stare at all day.

## Principles that bind this work

- **Vocabulary of record** ([`../design-language.md`](../design-language.md)): the ░▒▓█
  density ramp is the one system — provenance, curing, staging, loading. No spinners;
  deterministic marks only (tile-fill). Color never the only axis.
- **Needs-you only**: nothing in the feed begs for attention unless a keystroke is wanted.
  Completion is quiet; the ask row and the inbox threshold are the only shouts.
- **Keyboard-first**: every enrichment is reachable and dismissible from the keyboard;
  mouse remains garnish (H-lane semantics).
- **Feed is truth**: enrichment renders what the bus/session already know — no state that
  lives only in the renderer (AppCore/probe testability is the bar, per C0 discipline).

## Candidate lanes (V2 — sized, unadopted until survey merge)

| ID | Candidate | Sketch | Seam | Size |
|---|---|---|---|---|
| V2.1 | Live tool tail-follow | While a tool runs, the collapsed line grows a 2–3 line dim tail window of its latest output (bounded, elided middle); settles to the one-line `✓` form. Density-ramp fill on the gutter marks progress-alive without a spinner. | TranscriptEntry tool kind + bus `tool.output` deltas | 2pt |
| V2.2 | Diff preview in the ask | The y/a/n ask for write/edit renders the pending mutation as a unified diff block (bounded, scrollable) before approval — approve what you can see. | ToolGuard.confirm payload + pane ask rendering | 2pt |
| V2.3 | Markdown + code-fence rendering | Assistant text renders headings/bold/inline-code/fenced blocks with syntax-aware tinting (own minimal highlighter; no dependency). | visibleTranscript wrap layer | 3pt |
| V2.4 | Thinking-block rendering | ThinkingPart (A1 types exist) renders as `░`-prefixed dim collapsed block, expandable per entry; redacted thinking stays a sealed mark. | TranscriptEntry kinds | 1pt |
| V2.5 | Context meter + cost line | Status bar gains a deterministic context-fill mark (`estimateContextTokens` exists) and per-session token totals; auto-compaction offer at threshold hooks the Track-T seam. | status bar + compaction seam | 2pt |
| V2.6 | Queue editing | Queued `⋯` rows become addressable: cancel one, reorder, or promote-to-steer (interrupt + send). Completes the enter-while-busy story. | model.queued() | 1pt |
| V2.7 | @-mention autocomplete | `@path` in the prompt completes against the workspace tree (BrowserModel walk reused); inserts canonical repo paths — the same entity space J's graph uses. | InputBuffer + palette-style matcher | 2pt |
| V2.8 | `!` shell escape | `!cmd` in the prompt runs through the bash tool with the same guard/ask path and renders as a user-provenance tool entry — no parallel unguarded executor. | command parse + bash tool | 1pt |
| V2.9 | Recall citations surface | Memory-derived claims render a `▸ n sources` affordance; one keystroke walks claim → note → provenance → supersession (J13's UX face; emits the citation ledger event = the successful-recall signal). | J13 + memory pane | 2pt |
| V2.10 | Retrieval-source disclosure | First hybrid query in a session renders a one-time quiet line naming the embedding source/model (J4's mandatory-familiarity invariant); `RetrievalSource` is already surfaced by `MemorySearch`. | J4 (landed) + pane notice | 1pt |
| V2.11 | Per-entry provenance gutter | Transcript gutter carries the █user/▓agent/░external glyphs so taint is ambient in the feed itself, matching the vault rendering. | render gutter | 1pt |
| V2.12 | OSC integration | Terminal title = session title + working state; OSC 9;4 progress where supported (WT/ConEmu); silent elsewhere. Linux-first per platform priority. | app.ts binding | 1pt |

Deferred-by-nature: image paste rendering (A1 ImagePart exists; terminal image protocols
are a Track-L/kitty question), $EDITOR escape + kill-ring (already ledgered to I4).

## Survey merge (2026-08-10)

The nuance survey landed ([`../research/coding-agent-nuances.md`](../research/coding-agent-nuances.md));
its shortlist folds in as follows. Refinements to existing candidates: **V2.1** adopts
Amp's render-only live tail (progress frames render to the human; only final output
reaches the model — progress never costs context); **V2.2** gains Gemini's
edit-the-proposed-diff-in-`$EDITOR` before approving (approval stops being binary);
**V2.5** renders the context gauge as a single density-ramp cell (the convergent meter,
in our vocabulary); **V2.8** confirmed as the one universal grammar keywork lacks, plus a
`KEYWORK=1` env marker (LIFT:pi); **V2.12** adopts Gemini-style state glyphs in the title.

New candidates from the survey:

| ID | Candidate | Sketch | Source | Size |
|---|---|---|---|---|
| V2.13 | Esc-backtrack prompt stepping → fork | Empty-input Esc-Esc walks prior user prompts; selecting one edits-and-forks there with paired conversation+checkpoint restore — B4 fork + E3 undo unified into one gesture. Convergent across Claude/Codex/Amp/Zed; keywork has the best substrate and no gesture. | OWN | 2pt |
| V2.14 | Large-paste placeholder collapse | `[pasted #N, M lines]` rendering with expand-on-demand; WP-5 landed the routing, this is the rendering half. Claude+Gemini converge. | OWN | 1pt |
| V2.15 | Copy verbs via OSC 52 | Copy last block/message/hunk first-class (P12 declares it, no ID existed); OSC 52 makes it work over SSH — Linux-first. | OWN | 1pt |
| V2.16 | Commit-message drafting, never committing | Cheap-tier draft of a conventional commit for the working tree — keeps the user-commits convention structural while removing its friction. | LIFT:aider | 1pt |
| V2.17 | Away summary + `/btw` side-questions | Quiet what-happened-while-unfocused digest (needs-you compatible: renders, never notifies) and a side-question that doesn't enter the main context. | OWN | 2pt |

Outside this pane's scope, routed elsewhere: bounded lint/test auto-fix loop (reflection
cap 3, LIFT:aider) → F-stream note; MCP `readOnlyHint` fast-path → E1 note; distill-session-
to-command → D-stream. Survey verdicts adopted as anti-goals here: no auto-commit, no
silent auto-compaction, no LLM-classified approvals, no ask timeouts (an ask that expires
was never an ask).

## Status (2026-08-10)

- **V2.1 landed.** `tool.output` bus event + `bashTool` `onOutput` tap (engine, minimal);
  `tail-follow.ts` renders a ≤3-line dim tail with `\r`/ANSI sanitizing, middle-elision, and a
  deterministic ░▒▓█ byte-count mark. Render-only per the Amp refinement: only the tool's final
  output reaches the model. Remaining seam: `coreTools` (cli wiring) does not yet pass
  `onOutput` through to the agent bus — reported, not wired.
- **V2.2 landed.** `diff-render.ts` (own LCS unified diff, no dependency) previews write/edit
  asks as a bounded, scrollable diff computed from tool args vs current file content; asks for
  non-write tools are unchanged. The Gemini edit-in-`$EDITOR` refinement stays deferred to I4.
- **V2.13 landed (prompt-stepping + conversation fork).** Empty-input Esc-Esc walks prior
  prompts with a transcript highlight; enter forks the session before the chosen prompt (B4
  seam via the session-tree port) into a new pane with the prompt preloaded for editing; busy
  panes interrupt instead. **Remaining:** checkpoint-paired file restore — needs per-user-turn
  checkpoint tags plus a `Checkpoints.restoreTo` API and cli wiring (E3 seam), then the fork
  port restores files alongside the conversation.

## Ordering instinct (pre-survey)

V2.2 and V2.1 first — they compound the trust story (see what you approve; see what runs).
Then V2.4/V2.11 (cheap identity wins), V2.5 (the HUD), V2.6–V2.8 (input power),
V2.9/V2.10 with the J-stream, V2.3 last of the big ones (largest surface, most wrap-cache
risk), V2.12 whenever Track L runs. Revisit after the survey merge.
