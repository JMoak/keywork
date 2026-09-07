# Conversation Pane Enrichment & Streaming Feed: Planning Overlay

> **Status (2026-08-22, D-04 close-out check):** not closed; the file stays in place.
> Landed: V2.1 (tail-follow), V2.2 (diff preview), V2.3 (markdown + code fences, `markdown.ts`
> / `highlighter.ts`), V2.5 (context gauge + cost line, `context-gauge.ts`; the at-threshold
> compaction offer is not built), V2.10 (retrieval disclosure), V2.13 (backtrack-fork with
> checkpoint restore). Still open, in this file's own numbering: V2.4 thinking blocks, V2.7
> @-mention autocomplete, V2.9 recall citations (J13's UX face), V2.11 provenance gutter,
> V2.16 commit-message drafting, V2.17 away summary + `/btw`. V2.6, V2.8, V2.12, V2.14 and
> V2.15 landed 2026-09-06 (status below). The typography of the feed itself has since moved
> to [`104`](104-the-page.md).

> Planning overlay, 2026-08-10. Where this file speaks for the conversation pane's
> streaming feed it wins; elsewhere the usual chain applies
> ([`95-memory-and-skills.md`](95-memory-and-skills.md) → 94 → 92 → 91 → 90 → workstreams;
> 90 to 92 are archived under `archive/`).
>
> A companion analysis, `docs/research/coding-agent-nuances.md` (a triage of nuanced
> behaviors across mature coding agents against keywork's philosophy), is being produced
> in parallel. When it lands, its shortlist merges into the candidate list below; nothing
> here is adopted until that merge is reviewed. Crush is excluded from that survey by
> decision (2026-08-10).

## Where the pane stands (Track V + QA, landed)

Multiline prompt with real cursor, input history ring, clamped scrollback with live-snap,
tool blocks collapsing in place (`· name args` → `✓ name · firstLine`), queued prompts as
dim `⋯` rows draining FIFO, wheel scroll, ask modal y/a/n, dispose that denies/interrupts.
The pane is functional. Enrichment is about making the feed *legible at a glance*: the
density-ramp identity applied to the one surface users stare at all day.

## Principles that bind this work

- **Vocabulary of record** ([`../design-language.md`](../design-language.md)): the ░▒▓█
  density ramp is the one system: provenance, curing, staging, loading. No spinners;
  deterministic marks only (tile-fill). Color never the only axis.
- **Needs-you only**: nothing in the feed begs for attention unless a keystroke is wanted.
  Completion is quiet; the ask row and the inbox threshold are the only shouts.
- **Keyboard-first**: every enrichment is reachable and dismissible from the keyboard;
  mouse remains garnish (H-lane semantics).
- **Feed is truth**: enrichment renders what the bus/session already know; no state that
  lives only in the renderer (AppCore/probe testability is the bar, per C0 discipline).

## Candidate lanes (V2: sized, unadopted until survey merge)

| ID | Candidate | Sketch | Seam | Size |
|---|---|---|---|---|
| V2.1 | Live tool tail-follow | While a tool runs, the collapsed line grows a 2–3 line dim tail window of its latest output (bounded, elided middle); settles to the one-line `✓` form. Density-ramp fill on the gutter marks progress-alive without a spinner. | TranscriptEntry tool kind + bus `tool.output` deltas | 2pt |
| V2.2 | Diff preview in the ask | The y/a/n ask for write/edit renders the pending mutation as a unified diff block (bounded, scrollable) before approval: approve what you can see. | ToolGuard.confirm payload + pane ask rendering | 2pt |
| V2.3 | Markdown + code-fence rendering | Assistant text renders headings/bold/inline-code/fenced blocks with syntax-aware tinting (own minimal highlighter; no dependency). | visibleTranscript wrap layer | 3pt |
| V2.4 | Thinking-block rendering | ThinkingPart (A1 types exist) renders as `░`-prefixed dim collapsed block, expandable per entry; redacted thinking stays a sealed mark. | TranscriptEntry kinds | 1pt |
| V2.5 | Context meter + cost line | Status bar gains a deterministic context-fill mark (`estimateContextTokens` exists) and per-session token totals; auto-compaction offer at threshold hooks the Track-T seam. | status bar + compaction seam | 2pt |
| V2.6 | Queue editing | Queued `⋯` rows become addressable: cancel one, reorder, or promote-to-steer (interrupt + send). Completes the enter-while-busy story. | model.queued() | 1pt |
| V2.7 | @-mention autocomplete | `@path` in the prompt completes against the workspace tree (BrowserModel walk reused); inserts canonical repo paths, the same entity space J's graph uses. | InputBuffer + palette-style matcher | 2pt |
| V2.8 | `!` shell escape | `!cmd` in the prompt runs through the bash tool with the same guard/ask path and renders as a user-provenance tool entry; no parallel unguarded executor. | command parse + bash tool | 1pt |
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
reaches the model, so progress never costs context); **V2.2** gains Gemini's
edit-the-proposed-diff-in-`$EDITOR` before approving (approval stops being binary);
**V2.5** renders the context gauge as a single density-ramp cell (the convergent meter,
in our vocabulary); **V2.8** confirmed as the one universal grammar keywork lacks, plus a
`KEYWORK=1` env marker (LIFT:pi); **V2.12** adopts Gemini-style state glyphs in the title.

New candidates from the survey:

| ID | Candidate | Sketch | Source | Size |
|---|---|---|---|---|
| V2.13 | Esc-backtrack prompt stepping → fork | Empty-input Esc-Esc walks prior user prompts; selecting one edits-and-forks there with paired conversation+checkpoint restore: B4 fork + E3 undo unified into one gesture. Convergent across Claude/Codex/Amp/Zed; keywork has the best substrate and no gesture. | OWN | 2pt |
| V2.14 | Large-paste placeholder collapse | `[pasted #N, M lines]` rendering with expand-on-demand; WP-5 landed the routing, this is the rendering half. Claude+Gemini converge. | OWN | 1pt |
| V2.15 | Copy verbs via OSC 52 | Copy last block/message/hunk first-class (P12 declares it, no ID existed); OSC 52 makes it work over SSH; Linux-first. | OWN | 1pt |
| V2.16 | Commit-message drafting, never committing | Cheap-tier draft of a conventional commit for the working tree; keeps the user-commits convention structural while removing its friction. | LIFT:aider | 1pt |
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
  output reaches the model. ~~Remaining seam: `coreTools` (cli wiring) does not yet pass
  `onOutput` through to the agent bus; reported, not wired.~~ 2026-09-06: the seam was
  already wired in `compose.ts`; A18's engine half stamps each chunk with the running call
  id through `Agent.reportToolOutput` and proves the order and the untouched final result in
  `cli/compose.test.ts` (see the A18 landed entry in `95`).
- **V2.2 landed.** `diff-render.ts` (own LCS unified diff, no dependency) previews write/edit
  asks as a bounded, scrollable diff computed from tool args vs current file content; asks for
  non-write tools are unchanged. The Gemini edit-in-`$EDITOR` refinement stays deferred to I4.
- **V2.13 landed (prompt-stepping + conversation fork).** Empty-input Esc-Esc walks prior
  prompts with a transcript highlight; enter forks the session before the chosen prompt (B4
  seam via the session-tree port) into a new pane with the prompt preloaded for editing; busy
  panes interrupt instead. **Remaining:** checkpoint-paired file restore, which needs per-user-turn
  checkpoint tags plus a `Checkpoints.restoreTo` API and cli wiring (E3 seam), then the fork
  port restores files alongside the conversation.
- **V2.12 landed (2026-09-06, OSC title + progress).** `tui/osc.ts` produces every escape as
  a string (`setTitle`, `pushTitle`/`popTitle` via XTWINOPS 22/23, `setProgress` for OSC 9;4,
  `copyToClipboard` for OSC 52) and `terminalSupport(facts)` is the one pure detector:
  progress only under `WT_SESSION` or ConEmu (`ConEmuANSI=ON` / `ConEmuPID`), title and
  clipboard on every live terminal, everything silent when stdout is not a TTY or `TERM=dumb`.
  `TerminalReporter` dedupes writes; `app.ts` reports the focused session's title and C64
  lifecycle after each paint (`▒` working, `█` needs-you, `▓` finished-unseen, `x` failed, no
  glyph idle, ascii fallbacks at tier 0), pushes the old title at boot and pops it on exit.
  `AppOptions.terminal` is the seam (`write`, `facts`); no config option. Tests:
  `osc.test.ts` (14).
  *Assumptions Jordan may reverse:* the title shape `<glyph> <session> · keywork`; tmux gets
  titles and OSC 52 unguarded (tmux forwards both with its defaults); no `NO_COLOR` gating
  since color and titles are unrelated facts; restore relies on the terminal's title stack,
  terminals without XTWINOPS keep the last title.
- **V2.15 landed (2026-09-06, copy verbs via OSC 52).** `tui/copy-commands.ts` registers
  `/copy-message` (aliases `copy`, `copy-reply`), `/copy-code` (`copy-block`) and
  `/copy-diff` (`copy-hunk`) from `app.ts` beside the doctor and flavor commands, so they
  reach the palette and the editor's slash tray. Sources: the newest assistant entry; the last
  fenced block of the newest reply that has one, fence lines stripped; the pending ask's diff
  first, otherwise the last write/edit hunk rebuilt from the tool call's recorded arguments.
  The payload is base64 of the UTF-8 bytes, asserted byte-exact; the clipboard is never read.
  Windows takes the same OSC 52 write (Windows Terminal honors it). Tests:
  `copy-commands.test.ts` (12), plus a collision check in `command-coverage.test.ts`.
  *Assumptions Jordan may reverse:* no pane-local keys yet, since bindings live in
  `app-actions.ts` / `app-core.ts` (the input-power lane's files this round); the proposal is
  `leader y` message, `leader shift+y` code block, `leader d` diff, all free in the leader
  table. A write's hunk is rendered as one all-add hunk. Diff text uses `+`/`-`/space prefixes
  with the codebase's own `@@ -a,b +c,d @@` header; the pane's padded rendering stays its own.
- **V2.8 landed (2026-09-06, `!` shell escape).** A prompt that starts with `!` followed by
  a non-space character is a command; a bare `!` or `! text` stays prompt text for the model.
  `tui/shell-escape.ts` holds the parser and `guardedShellEscape(seams)`, a runner that walks
  the same gate the agent walks for its own bash calls: the policy resolver first (deny wins
  before anyone is asked), then the pane's ask on a silent policy for a mutating tool, then
  `guard.beforeMutation` (checkpoint), then the agent's own `bash` tool instance. It is a
  guarded port, never a second executor: no spawn happens outside the tool. The call carries a
  `user-shell-N` id and renders as a tool entry stamped with the user voice glyph
  (`ToolRun.provenance = "user"`, transcript-view picks the stamp). Output is render-only
  through the existing `tool.output` tail. Idle panes run it inside `Agent.hold`, so the pane
  reads as working and enter queues behind it; busy panes queue `!cmd` as a prompt, and the
  model peels leading shell escapes off the queue at each turn settle before the next prompt
  starts, which keeps FIFO order and lets the queue rows show it. `alt+enter` steers it
  (interrupt, run next). `esc` aborts a running command. `bashTool` now spawns with
  `KEYWORK=1` in the child environment (`harnessSpawnOptions`); nothing was copied, so
  `NOTICE` is unchanged. **Model context decision:** the result reaches the model as a
  user-provenance message (`$ cmd` followed by the trimmed output), recorded through the new
  `ConversationPorts.recordShellEscape` seam, which `session-panes.ts` wires to
  `attachment.append(textMessage("user", …))` after the turn's own messages are persisted.
  That makes resume, fork, compaction and bot switches all see it. The live agent's context
  picks it up on the next rebuild only, because injecting into a running agent's history
  needs an `Agent` seam and `agent.ts` belongs to another lane this round. Tests:
  `shell-escape.test.ts` (9: parser, gate order, deny before ask, decline, checkpoint,
  missing tool), `conversation-model.test.ts` "! shell escape" (10: real `bashTool` `!echo hi`
  as one user-provenance entry, ask gate with y and n, `!rm -rf` denied by the same resolver
  the agent's call hits, bare `!`, busy queueing with record order, steer promotion,
  idle-pane record, no model bound, no port notice, esc abort), `tools.test.ts` (1: the
  `KEYWORK` marker). **Crossing (wired by the lead, 2026-09-06):** `compose-panes.ts` passes
  `AppOptions.shellEscape`, built as `guardedShellEscape` over `coreTools(composition.scope)`
  and the preset resolver, and `app.ts` threads it into `SessionPaneDeps`
  (`compose-panes.test` "runs a prompt-line shell escape through the workspace bash tool
  under the pane guard"). The persistent shell session (`shell-session.ts`) does not carry
  the `KEYWORK` marker yet.
  *Assumptions Jordan may reverse:* the session record is a user text message rather than a
  tool-call pair, since a tool result needs an assistant tool call to hang from and the user
  issued this one; the record lands after the turn it followed; a `!` line typed with no model
  bound still runs (the shell needs no provider); the gate's permission decisions are handed
  to an optional `onDecision` hook rather than emitted on the bus.
- **V2.6 landed (2026-09-06, queue editing).** With the prompt empty and prompts queued,
  `alt+↑` enters queue editing on the newest row and `alt+↓` on the oldest; inside, `↑`/`↓`
  pick, `shift+↑`/`shift+↓` move the row, `backspace` (or `delete`) cancels it, `enter`
  promotes it to steer (cancel, resend as steer, which interrupts the running turn), `esc`
  leaves, and any other key leaves and is handled as usual. The selected `⋯` row renders
  inverted in the accent and a hint row spells the grammar; the busy prompt hint now mentions
  `alt+↑`, and the help overlay's prompt keys list `!cmd`, `alt+up` and `tab`. The queue
  stays the engine's: moves are cancel plus resend from the first displaced row on, so the
  agent's ids and `queue.changed` events remain the truth. Steer rows are pinned at the
  front (the engine sorts them there anyway), so a move that would cross one is refused.
  Tests: `conversation-model.test.ts` "queue editing" (7: entry points and clamping, empty
  prompt and empty queue guards, cancel, move with the transcript and the session log
  (`bindSessionLifecycle` with an in-memory `append`) in the final order, promote-to-steer,
  steer pinning, exit on other keys) and `conversation-pane.test.ts` (1: inverted row and
  hint).
  *Assumptions Jordan may reverse:* `alt` as the queue modifier (it already means steer on
  enter); `enter` rather than `alt+enter` as the promote key inside the mode; moving a row
  re-mints its id, which a future engine `reorder` seam would avoid.
- **V2.14 landed (2026-09-06, large-paste placeholders).** A paste of more than six lines
  (`pasteCollapseLines = 6`, pinned in tests) renders in the prompt as `[pasted #N, M lines]`
  and the full text is submitted; several pastes in one prompt number `#1`, `#2`, …, and
  numbering restarts after each submit. `tab` with the cursor on a placeholder expands it in
  place. `PasteVault` (`tui/paste-placeholder.ts`) holds the texts; `PromptEditor.paste`
  collapses, enter expands. The WP-5 contract holds: paste never submits, CRLF normalizes,
  embedded newlines stay literal, pastes at or under the threshold are untouched. Tests:
  `prompt-editor.test.ts` (4) and `conversation-model.test.ts` "large-paste placeholders" (5:
  threshold, never-submit, numbering with full-text submit, tab expand, restart).
  *Assumptions Jordan may reverse:* the threshold of six; placeholders are plain text in the
  buffer, so backspace eats them a character at a time and a hand-typed placeholder for a
  number the vault never held is submitted literally.

## Ordering instinct (pre-survey)

V2.2 and V2.1 first; they compound the trust story (see what you approve; see what runs).
Then V2.4/V2.11 (cheap identity wins), V2.5 (the HUD), V2.6–V2.8 (input power),
V2.9/V2.10 with the J-stream, V2.3 last of the big ones (largest surface, most wrap-cache
risk), V2.12 whenever Track L runs. Revisit after the survey merge.
