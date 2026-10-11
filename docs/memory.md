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
  .sync/layout.json         present only once `keywork memory sync setup` ran (multi-host, below)
  .sync/lease.json          the cross-host sweep lease; gitignored, synced by file-sync tools
  daily/YYYY-MM-DD.<host>.md  this host's daily segment (multi-host vaults only)
  curation.<host>.md        this host's curation segment (multi-host vaults only)
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
10. **Two hosts never clobber each other; conflicts become notes** (J14 multi-host
    half, 2026-10-11). In a multi-host vault every append-only surface is a per-host
    file, the merge driver resolves the shared files deterministically, a dual rewrite
    of one note lands as a `conflict-of` sibling plus one inbox card, and Gardeners on
    different hosts take turns through a lease. Details in "Multi-host vaults" below.

## Multi-host vaults

A vault is synced the moment someone puts it in git, OneDrive, Syncthing or Dropbox, so
keywork reconciles itself instead of asking the sync tool to be clever (95 F1: *sync
however you like; keywork reconciles itself*). Nothing below runs until
`keywork memory sync setup` has been run once on any host; a vault that never ran it
keeps writing exactly the single-host bytes it always wrote.

**Partition by writer.** `sync setup` writes `.sync/layout.json`. From then on every
host (`os.hostname()` lowered and dashed, at most 32 characters) appends daily entries
to `daily/<date>.<host>.md` and audit lines to `curation.<host>.md`. Reads union the
shared file with every host segment: `readDaily` orders entries by time across
segments, `readAudit` orders by timestamp, `listDailyDates` collapses segments to
dates, and `forget` maps a merged entry back to the segment that holds it. Two hosts
never write the same file, so file-level union, which every sync tool does natively,
is the whole merge. Atomic notes stay single files; they are the only surface that
can still collide, and the merge driver and the intake below cover them.

**Merge driver on the blessed path.** When the vault is inside a git work tree,
`sync setup` also writes `*.md merge=keywork-memory` to the vault's `.gitattributes`
and registers `keywork memory sync merge %O %A %B %P` in the clone's git config
(per clone, never auto-installed, offered by the explicit verb only). The driver is
deterministic:

- `MEMORY.md` is set-merged: links added by either side stay, links removed by either
  side go, ours order first.
- `daily/*` and `curation*.md` never conflict: both appends are kept, and a rewrite on
  both sides falls back to a line union.
- Atomic notes merge field by field. A field only one side changed takes that side.
  Derived fields that both sides changed resolve by rule: `usefulness` and
  `confidence` take the higher value, `aliases` and `revised_by` union, `drift` keeps
  the later `at`, `pinned` is true if either side pinned, and `supersedes`,
  `superseded_by`, `distilled_from` keep ours. Bodies take the only changed side or
  both appends to the same base. Anything else (a human field rewritten on both sides,
  a true dual rewrite of the body, malformed frontmatter on any side) exits 1 with
  whole-file conflict markers so git marks the file and the intake below finishes the
  job.

**Conflict intake.** `reconcileVault()` runs before the first bootstrap read of every
workspace open and on `keywork memory sync`. It reads every note file raw (so a hunk
marker inside frontmatter cannot break the read) and heals two shapes:

- A note holding git conflict markers (whole-file from the driver, or git's own
  hunk-level markers, diff3 base included) is split: ours stays at the note's path,
  theirs becomes `<Note> (conflict copy).md` stamped `conflict-of: "[[Note]]"`.
- A sync tool's conflict artifact (`Name (… conflicted copy …).md` from Dropbox and
  Nextcloud, `Name.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX.md` from Syncthing) becomes
  the same `(conflict copy)` sibling. When the original is missing the copy is simply
  restored under the original name.

Every quarantine goes through the ledger as one entry (`revert` undoes it) and stages
exactly one `contradiction` card for the pair, deduplicated by the pair key, so the
Gardener's existing merge and contradiction machinery adjudicates; there is no new
review surface.

**Sweep lease.** In a multi-host vault the Gardener takes `.sync/lease.json`
(`{host, acquired, expires}`, ten minutes) before sweeping and removes it after. A
fresh lease held by another host defers the sweep: the report carries
`deferred: {host, until}` and the audit records `gardener deferred: <host> holds the
sweep lease until <t>`; the next close sweeps as usual. A stale lease is taken over.
The file is gitignored (git sync is manual, so a clone never contends live) and
synced by file-sync tools, where it matters.

**Report.** `keywork memory sync` prints the layout and this host's name, the hosts
seen in segments, the lease state, every quarantine and restoration it performed, the
cards it staged, and the index reconciliation.

**Not built yet** (recorded in 95's J14 ledger entry): rematerializing derived
frontmatter from the audit union instead of the per-field rule; OneDrive's
`Name-<Computer>.md` artifact pattern (ambiguous with real titles); per-host arc and
bot layers; a conflict-pattern lint line in the memory pane.

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
