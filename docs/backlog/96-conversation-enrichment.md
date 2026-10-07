# Conversation Pane Enrichment & Streaming Feed: Planning Overlay

> **Status (2026-08-22, D-04 close-out check):** not closed; the file stays in place.
> Landed: V2.1 (tail-follow), V2.2 (diff preview), V2.3 (markdown + code fences, `markdown.ts`
> / `highlighter.ts`), V2.5 (context gauge + cost line, `context-gauge.ts`; the at-threshold
> compaction offer landed 2026-10-07, `compaction-offer.ts`), V2.10 (retrieval disclosure), V2.13 (backtrack-fork with
> checkpoint restore). Still open, in this file's own numbering: V2.4 thinking blocks, V2.9
> recall citations (J13's UX face). V2.11 provenance gutter landed 2026-10-02. V2.6, V2.8, V2.12, V2.14 and
> V2.15 landed 2026-09-06; V2.7 @-mention autocomplete, V2.16 commit-message drafting and
> V2.17 away summary + `/btw` landed 2026-10-02 (status below). The typography of the feed
> itself has since moved to [`104`](104-the-page.md).

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
- **In-place companion landed (2026-10-02, 117 SW14).** Where V2.13 forks into a new pane,
  `/undo` now rewinds the same session one prompt: files back to that prompt's checkpoint,
  leaf moved to its parent, turn out of the transcript, prompt back in the composer, `undo
  staged` in the title row until a send commits or `/redo` cancels. Seams: `rewindBefore` on
  `SessionAttachment` (cli `sessions/ports.ts`), `tui/prompt-undo.ts`, and
  `ConversationModel.undoLastPrompt` / `redoPrompt`. Detail and deviations in `50` E4.
- **V2.11 landed (2026-10-02, provenance gutter).** External recalled content is detected on
  the rail; the visible stamp stays PD18 (`█` user, `▓` agent prose, `░` machine for every
  agent tool row, `█` kept for a user's own `!cmd` as V2.8 recorded). Detection: a
  `memory_get` / `memory_search` result whose keywork framing says `provenance: untrusted` or
  `[untrusted]` (framing `neutralize.ts` keeps recalled text from forging) settles with
  `ToolRun.provenance = "external"` (`transcript-feed.ts` `carriesUntrustedRecall`); external
  rows never join a SW25 group. Nothing is guessed: MCP results stay unmarked because the feed
  does not see a server's `trusted` flag; the fix is an `external` field on `tool.started`
  from `agent.ts` (an engine seam, not built here). **Jordan's call:** flipping agent tool
  rows to `▓` so that `░` means external only is one line in `toolVoice`
  (`transcript-view.ts`) plus regenerating the tool-row goldens. Tests:
  `transcript-feed.test.ts` "provenance on the rail" (3).
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
- **V2.7 landed (2026-10-02, @-mention autocomplete).** Typing `@` (at the start or after a
  space or bracket, so `me@host` stays prose) opens the slash tray over the workspace files:
  `tui/mention-completer.ts` ranks the `FileIndex` walk (the file-jump index, so `.gitignore`
  rules and the 2,000-file cap carry over) with the palette's `fuzzyScore`, file-name hits
  first, dot paths hidden until the query reaches for them (the browser's default), and paths
  the `@file` grammar can't carry (spaces) left out. `tab` inserts `@<repo path> `, `enter`
  inserts too unless the typed path is already complete (then it sends), `esc` dismisses the
  tray for that token without touching the text, and a clicked row inserts. On send,
  `tui/mention-attachments.ts` reads each mention through `scanTemplate`, the same grammar
  markdown commands use, and appends `<attached path="…">` blocks after the typed prompt:
  workspace-relative paths only, binary files skipped, each file cut at 30,000 chars. "Once,
  cached" is structural: a block already in the conversation's history byte for byte is not
  sent again, so it rides the prompt cache with the message it came in. The transcript, the
  queue rows, `/undo` and backtrack-fork all show the prompt as typed (`promptAsTyped`), so
  file bodies never land in the composer. Seams: `ConversationPorts.workspaceFiles`, wired
  through `SessionPaneDeps` from `app.ts` and gated like file jumps on workspace readiness;
  the read goes through the pane's existing `readFile` port. Tests:
  `mention-completer.test.ts` (10), `mention-attachments.test.ts` (9), `prompt-editor.test.ts`
  "@-mentions" (7), `conversation-model.test.ts` "@-mentions" (2).
  *Assumptions Jordan may reverse:* the tray still prints its `/` name prefix ahead of a path
  (`conversation-pane.ts` was another lane's file this round; the fix is passing a per-mode
  `namePrefix`); attachments are text appended to the user message, so the JSONL keeps the
  file body with the prompt and a resumed session replays it.
- **V2.17 landed (2026-10-02, away summary and `/btw`).** `tui/away-summary.ts` keeps an
  `AwayWatch` per conversation: you count as present when the pane has focus and the terminal
  does too (the existing focus reporting, so terminals with notifications `off` only use pane
  focus). Leaving opens a stretch; a turn that settles inside it marks it; coming back with a
  marked stretch posts one quiet info line at the bottom of the transcript, for example
  `while you were away: changed src/parser.ts; it ended on "All tests pass."; waiting on you:
  edit {...}`. Files come from the bus (successful `write` / `edit` calls and the `changed N
  files on disk` listing SW13 adds to bash results), the closing line is the last prose line
  of the newest reply (fences and list marks stripped; an error names where it stopped), the
  waiting clause is the pending ask. No model call, no notification, no stamp change: it
  renders and nothing else (PD25). Plain ASCII punctuation, since it can land in a glyph-tier-0
  frame. `/btw <question>` streams one tool-less request through the bound provider with the
  session's messages flattened into a `<session>` text block as background (newest 60,000
  chars), and renders the question as an info row and the answer as a progress-style entry
  that a streaming reply never merges into. Nothing touches `Agent` history or the JSONL; the
  answer lives only in the pane, so it is gone after a restart. Tests: `away-summary.test.ts`
  (7), `side-question.test.ts` (3), `conversation-model.test.ts` "/btw" (2, history length
  unchanged and the request's background checked) and "away summary" (3: away pane, watched
  turn, terminal focus).
  *Assumptions Jordan may reverse:* any absence counts, however short, as long as a turn
  finished inside it; the background is flattened text, since replaying tool blocks without
  tool definitions is a 400 on the Messages API; `/btw` works mid-turn.
- **V2.16 landed (2026-10-02, commit-message drafting).** `/commit-draft` (aliases
  `draft-commit`, `commit-message`) in `tui/commit-draft.ts`: reads the staged diff, or the
  unstaged one when nothing is staged, with `--stat` first and the patch cut at 30,000 chars,
  asks the focused session's bound provider for a conventional commit message, shows it as a
  fenced block in that transcript and copies it through the OSC 52 path the copy verbs use.
  The last line says `keywork never commits, that part is yours`; the module only ever runs
  `git diff`, with `core.fsmonitor`, external diff drivers and textconv off so an untrusted
  repo's config can't run anything. Registered beside the copy verbs in `app.ts`. Tests:
  `commit-draft.test.ts` (8, mock provider and fixture diff: staged first, unstaged
  fallback, clean tree, no model, no clipboard, git failure, the cap, diff-only git calls).
  *Assumptions Jordan may reverse:* untracked files are not in the draft (plain `git diff`
  leaves them out); the bound session model drafts, there is no cheap-tier pick yet.
- **V2.5 compaction offer landed (2026-10-07).** When a turn settles with the context
  estimate past the memory-flush line and not yet past the compaction line
  (`compaction-offer.ts`, `compactionOfferDue`), one info line offers `/compact [focus]` and
  says keywork compacts on its own at the line. It never runs anything, fires once per
  crossing (so never twice in a turn, and not again until the reading falls back below the
  flush line), and stays silent when no compaction hook is bound. Tests:
  `compaction-offer.test.ts` (4) and `conversation-model.test.ts` "compaction offer" (2, a
  4000-token declared window).
  *Assumptions Jordan may reverse:* the offer line is the flush line rather than a fraction
  of the compaction line; a long stretch above the line gets one offer, not one per turn.

## Ordering instinct (pre-survey)

V2.2 and V2.1 first; they compound the trust story (see what you approve; see what runs).
Then V2.4/V2.11 (cheap identity wins), V2.5 (the HUD), V2.6–V2.8 (input power),
V2.9/V2.10 with the J-stream, V2.3 last of the big ones (largest surface, most wrap-cache
risk), V2.12 whenever Track L runs. Revisit after the survey merge.
