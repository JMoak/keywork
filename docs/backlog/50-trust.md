# Workstream E — Trust & Safety

> Shipped as blessed default-on extensions (D2/D3 decisions) — replaceable by power users,
> present for everyone else. The UX is keywork's own graduated-trust design over
> OpenCode's lifted allow/ask/deny machinery.

---

### E1 (3pt) — Gate extension
The permission gate as a `tool_call`-hook extension (D2): allow/ask/deny matrix per tool,
glob-scoped bash rules (`git *` allow, `rm *` ask), per-agent overrides (D6 agents), "ask"
rendered as an overlay with allow-once / always / deny; decisions persistable to project
config.
**Accept:** matrix unit tests; E2E — mock tool call triggers overlay, "always" persists and
skips next prompt; deny reaches the model as a refusal result.
**Strategy:** `LIFT:opencode` config model + rule semantics.

### E2 (1pt) — Permission presets UX
Design direction (Jordan, 2026-08-10): **named presets + status word**. Two or three
named policy presets defined as bundles in the policy file — **`careful` · `standard` ·
`open`** (Jordan, 2026-08-10; `standard` ships as default); the active preset's name
sits in the status line (fills C18's slot); one chord
opens the preset picker, cycling with confirmation when loosening. Presets are plain
policy-file bundles — secops reads the file, users read the word. Scoped per 95/J-D7:
this surface is tool permissions only, sharing at most visual vocabulary with memory's
validity machinery.
**Accept:** preset change updates gate behavior immediately; indicator matches actual
matrix state (no lying UI); custom policy edits that diverge from every preset render a
distinct "custom" state, never a preset's name.
**Strategy:** `OWN` design and presentation.

### E3 (2pt) — Git snapshots
On each file-mutating tool call, record a snapshot ref (git stash-like plumbing objects, no
working-tree pollution, no commits on the user's branch — per M0.3 conventions this repo's
user never wants surprise commits); ring buffer per session.
**Accept:** snapshots created on write/edit events; user's `git status` and branch untouched;
snapshot GC bounded.
**Strategy:** `LIFT:opencode` snapshot mechanism.

### E4 (2pt) — `/undo` & `/redo`
Restore file state to any snapshot boundary (per tool-batch), redo forward; session entry
records the restore (B format) so replay is honest; surfaced in palette + diff pane markers.
**Accept:** E2E — agent edits 3 files, `/undo` restores all, `/redo` reapplies; conversation
history annotated.
**Strategy:** `LIFT:opencode`.

### E5 (2pt) — Plan/Build agents & Tab switch
Two blessed default agents as D6 markdown: **Plan** (read-only toolset via E1 per-agent
rules) and **Build** (full); `Tab` toggles; active agent visible in status line; switch is a
session entry.
**Accept:** Plan agent's write attempt is denied by config, not by prompt hope; Tab switch
mid-session preserves context.
**Strategy:** `LIFT:opencode` (markdown agent format verbatim + permission wiring).
