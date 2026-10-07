# Workstream E: Trust & Safety

> Shipped as blessed default-on extensions (D2/D3 decisions): replaceable by power users,
> present for everyone else. The UX is keywork's own graduated-trust design over
> OpenCode's lifted allow/ask/deny machinery.

---

### E1 (3pt): Gate extension
The permission gate as a `tool_call`-hook extension (D2): allow/ask/deny matrix per tool,
glob-scoped bash rules (`git *` allow, `rm *` ask), per-agent overrides (D6 agents), "ask"
rendered as an overlay with allow-once / always / deny; decisions persistable to project
config.
**Accept:** matrix unit tests; E2E: mock tool call triggers overlay, "always" persists and
skips next prompt; deny reaches the model as a refusal result.
**Strategy:** `LIFT:opencode` config model + rule semantics.
**Landed 2026-10-02 (117 SW15, decision 117-2):** `permissions` is now one ordered list of
`{action, resource, effect}` rules after OpenCode v2's model (design only, no code adapted);
the last matching rule wins. Actions are tool names, `mcp` for every MCP tool, or `*`.
Resources are workspace-relative path globs for `read` / `write` / `edit` (`**/` spans
directories, absolute patterns match absolute paths, case folds on Windows), command globs for
`bash` (`git status *` also matches a bare `git status`), and the full tool name for `mcp`, so
`github__*` covers one server (116 AB3). A compound command splits on `; & | newline`: any
deny denies, then any ask asks, an unmatched part falls to the built-in ask, and a part with
`` < > ` $ ( ) `` never rides an allow. No match keeps the built-in posture (read-only allow,
mutating and MCP ask) rather than OpenCode's flat ask, so `standard` stays the empty list.
The legacy `{tools, bash}` map still loads, translated in `shared/src/trust/rules.ts`: tool
rules first in declaration order, then bash globs from least to most literal (first declared
last among ties), then every bash deny; all twelve legacy permission tests pass unchanged.
Presets are rule lists, `activePreset` compares rule sets, so the status-line ladder reads the
same. The project layer still contributes no permissions at all (load test covers the new
shape).

### E2 (1pt): Permission presets UX
Design direction (Jordan, 2026-08-10): **named presets + status word**. Two or three
named policy presets defined as bundles in the policy file, **`careful` · `standard` ·
`open`** (Jordan, 2026-08-10; `standard` ships as default); the active preset's name
sits in the status line (fills C18's slot); one chord
opens the preset picker, cycling with confirmation when loosening. Presets are plain
policy-file bundles: secops reads the file, users read the word. Scoped per 95/J-D7:
this surface is tool permissions only, sharing at most visual vocabulary with memory's
validity machinery.
**Accept:** preset change updates gate behavior immediately; indicator matches actual
matrix state (no lying UI); custom policy edits that diverge from every preset render a
distinct "custom" state, never a preset's name.
**Strategy:** `OWN` design and presentation.

### E3 (2pt): Git snapshots
On each file-mutating tool call, record a snapshot ref (git stash-like plumbing objects, no
working-tree pollution, no commits on the user's branch; per M0.3 conventions this repo's
user never wants surprise commits); ring buffer per session.
**Accept:** snapshots created on write/edit events; user's `git status` and branch untouched;
snapshot GC bounded.
**Strategy:** `LIFT:opencode` snapshot mechanism.
**Landed 2026-10-02 (117 SW13, diff of what a shell command changed):** the `bash` tool (one-shot
and persistent shell alike) is wrapped by `engine/src/tools/command-changes.ts`, which takes a
shadow-tree `snapshot()` before and after each call and asks `Checkpoints.changesBetween` for
the numstat and `git diff-tree -p` between the two trees. Neither call touches the undo ring
or the turn tag. A command that changed files gets a `changed N files on disk:` section with
`path +added -deleted` lines and the unified diff appended to its result; over the 30,000-char
output cap the diff is left out and only the per-file line counts stay. A read-only command's
result is unchanged. The C14 diff pane now refreshes after `bash` as it does after `write` and
`edit`. SW7's write guard still does not cover the shell, so an `AGENTS.md` rewrite through
`bash` is not refused, but it does show in both the result and the pane. Fix on the way: a
shadow repo that lives inside its own worktree now excludes itself via `info/exclude`, where
before it snapshotted its own objects. Cost: two extra `git add -A` + `write-tree` and one
`diff-tree` pair per shell call, measured inside the existing e2e budget.

### E4 (2pt): `/undo` & `/redo`
Restore file state to any snapshot boundary (per tool-batch), redo forward; session entry
records the restore (B format) so replay is honest; surfaced in palette + diff pane markers.
**Accept:** E2E: agent edits 3 files, `/undo` restores all, `/redo` reapplies; conversation
history annotated.
**Strategy:** `LIFT:opencode`.
**Landed 2026-10-02 (117 SW14, undo that returns the prompt):** `/undo` in the TUI now takes
back the focused session's last prompt as a staged change, after OpenCode v2 snapshots (design
only, no code adapted). The files go back to the checkpoint stamped on that prompt's entry,
the session leaf moves to the prompt's parent (in memory; the JSONL keeps every entry), the
agent is rebuilt on the shorter active path, the turn leaves the transcript, and the prompt
text lands in the composer (anything already typed there stays recallable with up, through
the draft-recovery seam). The title row's telemetry zone reads `undo staged` while it waits.
Sending anything commits: the new prompt appends at the moved leaf and becomes the new
branch. `/redo` cancels: files return to the tree snapshotted just before the undo, the leaf
and the full history come back, the turn is spliced back into the transcript. With nothing
to take back (no session store, no settled prompt) the commands fall back to the old
file-only undo and redo. Deviations: the whole tree is restored, not only paths attributed
to agent steps, so a user edit made after that prompt also rolls back (and `/redo` brings it
back); one level of staging only; the `undo staged` mark hides with the rest of the
telemetry at clipping widths; to type `/redo` the restored prompt has to be cleared from the
composer first.

### E5 (2pt): Plan/Build agents & Tab switch
Two blessed default agents as D6 markdown: **Plan** (read-only toolset via E1 per-agent
rules) and **Build** (full); `Tab` toggles; active agent visible in status line; switch is a
session entry.
**Accept:** Plan agent's write attempt is denied by config, not by prompt hope; Tab switch
mid-session preserves context.
**Strategy:** `LIFT:opencode` (markdown agent format verbatim + permission wiring).
