# Memory vault: layout and invariants

The memory store (`packages/engine/src/memory/`) is a per-scope atomic-note vault
(backlog J3) with the J11 write-gating kernel: provenance tagged, untrusted writes
staged until approved, everything one-key revertable. Files are truth; there is no
database. The vault root is injected (J1's `resolveVaultPath` supplies it); so is the
clock, so every timestamp is deterministic under test.

## Layout

```
<vault root>/
  MEMORY.md                 links-only map of content (MOC), never prose
  curation.md               append-only curation audit (approve/discard events)
  daily/YYYY-MM-DD.md       append-only episodic log, per-entry provenance markers
  <Concept Title>.md        atomic notes, one concept per file
  entities/<repo/path>.md   entity notes named by repo path (P4)
  .staging/<uuid>.json      staged items: untrusted writes (content + metadata sidecar) and reviews
  .obsidian/                never created by keywork; ignored if present (gitignore it)
```

- **Atomic notes** carry the machine layer in YAML frontmatter: `provenance`
  (`user` | `agent` | `untrusted`), `created`, optional `pinned`, `confidence`,
  `aliases`, and quoted wikilink relations (`supersedes: "[[Old Note]]"`,
  `superseded_by: "[[New Note]]"`; the pair is stamped across both notes in one
  ledger step). Bodies use bare `[[Name]]` wikilinks. A note without frontmatter is
  treated as human-authored (`user`).
- **Titles** are unique concept-oriented filenames, enforced case-insensitively.
  Rejected outright: path separators, `..`, reserved Windows device names, Obsidian
  link-breaking characters (`[]#^|`), leading/trailing dots, and the reserved vault
  names (`MEMORY`, `curation`, `daily`, `entities`).
- **Entity notes** are the one exception to bare-name links: they link by full path
  (`[[entities/packages/tui/layout.ts]]`), store case-preserving, match
  case-insensitively, and carry the short filename in `aliases`.
- **Daily logs** are append-only. Each entry is `- HH:MM [prov: <class>] text`, or
  `- HH:MM [prov: <class>, session: <id>] text` when the writer named its session;
  continuation lines are indented two spaces so entry content can never forge a
  marker, and the session rides inside the marker bracket so text cannot forge that
  either.
- **Session origin** (2026-10-07): a note written with a session id carries
  `origin_session` from its first write; a later write from a different session appends
  that id to `revised_by` instead of overwriting the origin. `keywork memory forget
  --session <id>` reads both (see "Forget by origin" below).
- **Drift stamps** (2026-10-07): `keywork memory drift [range]` asks one bounded provider
  question per note the diff touches and records the answer as a `drift` map
  (`verdict: hold | stale | unsure`, `at`, `against`) in frontmatter, plus a
  `drift [[Note]]: <verdict> against <ref> · <reason> · <evidence>` line in
  `curation.md`. The body is never edited; a `stale` verdict also stages a
  `drift-review` proposal for the Gardener inbox.

## Invariants

1. **Provenance is structural.** Every durable write is stamped with its caller-
   declared provenance class: frontmatter for notes, the per-entry marker for daily
   logs.
2. **Untrusted writes are staged by construction.** `provenance: "untrusted"` writes
   land in `.staging/` and are invisible to `listNotes`, `readNote`, `readMoc`,
   `readDaily`, and `bootstrap` until `approve` moves them to their target
   (`discard` deletes them). Supersession stamping is also deferred to approval.
   A `staged: true` frontmatter flag hides a note from all reads as defense in
   depth. Property-tested: no operation sequence makes an untrusted write
   load-bearing without passing through `approve`.
   The core `write` / `edit` tools cannot bypass this (117 SW7, 2026-10-02): a note the
   agent writes under the vault becomes a staged proposal stamped `provenance: agent`
   whatever its frontmatter claims; the vault's own structure, `AGENTS.md`, `CLAUDE.md`
   and skill directories are refused with a message that names the right door. Recalled
   text is neutralized before it reaches the model (SW8: invisible characters stripped,
   framing lookalikes escaped).
3. **Every mutation is one-key revertable.** The session ledger records each
   create/edit/approve/discard with full before/after content and hashes (P7).
   `revert` restores the prior content only if the file still matches the
   operation's recorded result; otherwise it reports `needs-rebase` and touches
   nothing.
4. **Redaction precedes persistence** (P5). Exact values of injected secret env vars
   are elided as `‹redacted:NAME›`, and conservative secret shapes (`sk-` keys,
   `Bearer` tokens, long mixed-case tokens) are elided by shape before anything,
   staged content included, reaches disk.
5. **Untrusted workspace ⇒ inert memory** (P1). With the injected `trusted` flag
   false, reads return nothing, writes throw `MemoryInertError`, and bootstrap
   yields empty.
6. **Bootstrap never truncates** (R4). Given a token budget, the MOC resolves to
   whole notes in documented priority order: pinned notes first, then MOC order,
   superseded and unresolved links excluded; a note that does not fit is skipped,
   never cut.
7. **Malformed frontmatter is a typed error naming the file**
   (`MalformedFrontmatterError`): never a crash, never a silent skip.
8. **Forget by origin is a staged change, never a direct delete** (2026-10-07).
   `planForget` lists the notes whose `origin_session` is the given id and the daily
   entries whose marker names it; `stageForget` turns that into one `forget-proposal`
   in the review inbox. Approval removes the note files and the named daily entries
   (continuation lines included) through the ledger, so `revert` restores them byte
   for byte. A note the session originated but another session revised, or one it
   only revised, is refused with the reason and kept: mixed provenance is never
   split by guessing.
9. **The index reconciles itself; files stay truth** (J14 first rung, 2026-10-07).
   Lexical and graph legs read the vault on every search; `MemorySearch.reconcile()`
   re-embeds any note whose text changed outside keywork and drops the vector of any
   note that vanished, reporting both. There is no rebuild command because there is
   nothing to rebuild.

## Skills beside the vault

Skills stay outside the vault (J-D5), but their curation shares the vault's rules
(2026-10-07, Hermes-style hygiene designed from the documented curator, no code copied):

- **Archive instead of delete.** `<project>/.keywork/skills-archive/<name>/<stamp>/`
  holds a full copy of a skill directory taken before every agent patch or rewrite,
  before every archive, and before a restore overwrites a live skill. The archive sits
  beside the convention dirs, so discovery never loads it.
- **Actor ledger.** `.keywork/skills-archive/ledger.jsonl` records
  `{at, actor, action, skill, version?}` for create / patch / rewrite / pin / unpin /
  archive / restore; the actor is `agent`, `curator` or `user`.
- **Pin.** `metadata.pinned: "true"` in a skill's frontmatter exempts it from the
  Gardener's `skill-review` proposals and from archiving until unpinned.
- **Blast radius.** Every mutation, pin included, goes through `claimAgentAuthored`;
  a human-authored or bundled skill has no write path.
- **Dry run by default.** `keywork skills archive <name>` and `keywork skills curate`
  report what they would do; `--apply` does it. `keywork skills history <name>` shows
  the ledger and versions; `--restore <stamp>` brings one back.
