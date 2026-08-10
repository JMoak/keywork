# Memory vault — layout and invariants

The memory store (`packages/engine/src/memory/`) is a per-scope atomic-note vault
(backlog J3) with the J11 write-gating kernel: provenance tagged, untrusted writes
staged until approved, everything one-key revertable. Files are truth — there is no
database. The vault root is injected (J1's `resolveVaultPath` supplies it); so is the
clock, so every timestamp is deterministic under test.

## Layout

```
<vault root>/
  MEMORY.md                 links-only map of content (MOC) — never prose
  curation.md               append-only curation audit (approve/discard events)
  daily/YYYY-MM-DD.md       append-only episodic log, per-entry provenance markers
  <Concept Title>.md        atomic notes — one concept per file
  entities/<repo/path>.md   entity notes named by repo path (P4)
  .staging/                 staged untrusted writes (content + metadata sidecar)
  .obsidian/                never created by keywork; ignored if present (gitignore it)
```

- **Atomic notes** carry the machine layer in YAML frontmatter: `provenance`
  (`user` | `agent` | `untrusted`), `created`, optional `pinned`, `confidence`,
  `aliases`, and quoted wikilink relations (`supersedes: "[[Old Note]]"`,
  `superseded_by: "[[New Note]]"` — the pair is stamped across both notes in one
  ledger step). Bodies use bare `[[Name]]` wikilinks. A note without frontmatter is
  treated as human-authored (`user`).
- **Titles** are unique concept-oriented filenames, enforced case-insensitively.
  Rejected outright: path separators, `..`, reserved Windows device names, Obsidian
  link-breaking characters (`[]#^|`), leading/trailing dots, and the reserved vault
  names (`MEMORY`, `curation`, `daily`, `entities`).
- **Entity notes** are the one exception to bare-name links: they link by full path
  (`[[entities/packages/tui/layout.ts]]`), store case-preserving, match
  case-insensitively, and carry the short filename in `aliases`.
- **Daily logs** are append-only. Each entry is `- HH:MM [prov: <class>] text`;
  continuation lines are indented two spaces so entry content can never forge a
  marker.

## Invariants

1. **Provenance is structural.** Every durable write is stamped with its caller-
   declared provenance class — frontmatter for notes, the per-entry marker for daily
   logs.
2. **Untrusted writes are staged by construction.** `provenance: "untrusted"` writes
   land in `.staging/` and are invisible to `listNotes`, `readNote`, `readMoc`,
   `readDaily`, and `bootstrap` until `approve` moves them to their target
   (`discard` deletes them). Supersession stamping is also deferred to approval.
   A `staged: true` frontmatter flag hides a note from all reads as defense in
   depth. Property-tested: no operation sequence makes an untrusted write
   load-bearing without passing through `approve`.
3. **Every mutation is one-key revertable.** The session ledger records each
   create/edit/approve/discard with full before/after content and hashes (P7).
   `revert` restores the prior content only if the file still matches the
   operation's recorded result; otherwise it reports `needs-rebase` and touches
   nothing.
4. **Redaction precedes persistence** (P5). Exact values of injected secret env vars
   are elided as `‹redacted:NAME›`, and conservative secret shapes (`sk-` keys,
   `Bearer` tokens, long mixed-case tokens) are elided by shape — before anything,
   staged content included, reaches disk.
5. **Untrusted workspace ⇒ inert memory** (P1). With the injected `trusted` flag
   false, reads return nothing, writes throw `MemoryInertError`, and bootstrap
   yields empty.
6. **Bootstrap never truncates** (R4). Given a token budget, the MOC resolves to
   whole notes in documented priority order — pinned notes first, then MOC order,
   superseded and unresolved links excluded; a note that does not fit is skipped,
   never cut.
7. **Malformed frontmatter is a typed error naming the file**
   (`MalformedFrontmatterError`) — never a crash, never a silent skip.
