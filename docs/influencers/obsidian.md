# Obsidian: Design DNA & Vault Interop

> Research dossier for **keywork**, added 2026-08-10 for the workstream-J memory store
> (J3/J9/J12). Obsidian is the dominant local-first PKM app; keywork's memory directory
> can be a first-class Obsidian vault for free.

**Status 2026-10-02.** Obsidian 1.14.0 to 1.14.4 changed nothing keywork's vault depends on.
The adjacent news is the Agent Skills spec's validator rules and Claude Code's memory
hardening (see "Since 2026-08-10"), which land in `docs/backlog/117-influence-sweep.md` as
SW16 and SW8. The vault DNA below has landed with J3; the TUI half is open under J9 in
`docs/backlog/95-memory-and-skills.md`.

> **LICENSING: READ FIRST**
> **The Obsidian app is proprietary (commercial EULA); never adapt or port its source**
> (none is published). What IS open: the file conventions (`[[wikilinks]]`, `![[embeds]]`,
> YAML frontmatter; open conventions predating Obsidian, freely adoptable, no
> attribution); **MIT**: obsidianmd/obsidian-api typings, JSON Canvas format, Dataview,
> Datacore, Breadcrumbs, obsidian-second-brain (agent-memory vault prior art), adaptable
> with `NOTICE` attribution. ⚠️ **Juggl (graph plugin) is GPL-3.0: ideas only.** Verify
> every plugin's license individually; "plugins are usually MIT" fails.

## Design DNA keywork adopts

1. **Files over apps**: notes are plain files that outlive the software. Already
   keywork's posture; the discipline is keeping it strict (index always disposable).
   **Landed:** J3, `packages/engine/src/memory/store.ts`; there is no database and search
   rebuilds in memory (`memory/search.ts`).
2. **`[[wikilinks]]` as zero-friction graph-building**: two brackets + autocomplete is
   the entire schema; links are cheap so they actually get made. The agent's memory graph
   edges are, first of all, wikilinks in markdown.
   **Landed:** J3/J12, wikilinks parse in `memory/notes.ts` and become graph edges in
   `memory/graph.ts`. Autocomplete is **open** (J9).
3. **Backlinks: linked + unlinked mentions.** Unlinked mentions (plain-text occurrences
   of a note's title/aliases not yet linked, one action to convert) is the most-loved
   discovery feature and trivially textual; for keywork, automated graph densification
   the Gardener runs.
   **Landed** for densification: J7 `proposeUnlinkedMentions` in `memory/gardener.ts` files
   link proposals into the review inbox. **Open:** the backlinks panel (J9).
4. **Frontmatter properties as typed metadata**: reserved `tags`/`aliases`; wikilinks in
   properties must be quoted (`up: "[[Parent]]"`); `aliases` powers autocomplete and
   mention-matching. Breadcrumbs' typed directional relations (`up/down/next/prev/custom`,
   with implied reciprocals) shows typed KG semantics expressible as plain YAML.
   **Landed:** J3, `memory/frontmatter.ts` and `memory/notes.ts` (quoted wikilink
   relations, `aliases`), typed predicates in `memory/graph.ts` (J12).
5. **Evergreen-note methodology (Matuschak)**: atomic (one concept per note),
   concept-oriented titles ("titles are APIs"), densely linked, continuously *revised*
   rather than appended. Maps 1:1 onto agent-memory hygiene; append-only memory rots
   (confirmed by every agent-vault practitioner writeup; their fix, self-rewriting
   notes, is keywork's Gardener).
   **Landed:** J3 atomic notes with unique titles (`memory/naming.ts`) and J7 merge and
   supersede passes (`memory/gardener.ts`).
6. **Daily notes** (`daily/YYYY-MM-DD.md`) as the append-friendly episodic surface,
   linking out to atomic notes. Exactly keywork's daily-log layer.
   **Landed:** J3, `memory/store.ts` and `memory/vault-files.ts`.
7. **Local graph over global graph**: the community verdict is that the global graph view is eye
   candy past ~200 notes; the 1–2-hop local neighborhood is "almost magical." keywork
   skips global-graph ambitions; the TUI renders the local graph as an indented
   links-in/links-out outline.
   **Landed** in the engine: `MemoryGraph.outline` in `memory/graph.ts`. **Open** in the
   TUI (J9): the memory pane does not call it yet.

## Vault-citizenship spec (J3 acceptance criteria)

**Landed** with J3 (layout in `docs/memory.md`): unique names enforced case-insensitively
with link-breaking characters rejected (`memory/naming.ts`), `|display` and `#heading`
forms parsed (`memory/notes.ts`), `daily/YYYY-MM-DD.md`, and `.obsidian/` never created and
ignored (`memory/vault-files.ts`).

- UTF-8 `.md`; note identity = filename; concept-like unique names; avoid `#^[]|` in
  filenames. Write bare `[[Name]]` links and enforce vault-wide unique note names.
- Support `[[Name|display]]`, `[[Name#Heading]]`, `[[Name#^block]]`, `![[embeds]]` at
  parse level; resolution case-insensitive.
- Valid YAML frontmatter at byte 0; `tags`/`aliases` as lists; wikilinks in properties
  quoted; one type per key vault-wide; keywork's own keys (provenance, curing state,
  confidence, typed relations) are ordinary properties, instantly Dataview-queryable.
- Daily logs at `daily/YYYY-MM-DD.md` (Obsidian's default pattern).
- Ship **no `.obsidian/`** and gitignore it; Obsidian creates its own on "open folder
  as vault."

## TUI translations (J9)

Backlinks panel (grep+parse) · unlinked mentions with convert-action · local graph as
indented 1–2-hop outline (links out / links in) · `[[` fuzzy autocomplete over filenames +
aliases · orphan/dead-link lint (the one useful "global" function) · Dataview-lite
frontmatter queries (adapt from Dataview/Datacore, MIT, NOTICE line).

Status 2026-10-02: the memory pane exists (`packages/tui/src/memory-pane-model.ts`: layers,
notes with provenance and curing stage, the one inbox, ledger, Gardener activity, query legs).
Unlinked mentions arrive as inbox proposals (J7). Still **open** under J9: the backlinks
panel, the local outline, `[[` autocomplete, and dead-link lint (the engine collects
`danglingLinks` in `memory/graph.ts` but nothing surfaces them). Dataview-lite queries are
**open** with no task that names them.

## Since 2026-08-10

- **Obsidian 1.14.0 to 1.14.4 (2026-09-02 to 10-01):** Bases kanban, search matching full
  paths, opening external files. Nothing changes the vault-citizenship spec.
- **Agent Skills spec** (agentskills.io, Apache-2.0 repo, last commit 2026-08-09; keywork's
  D7 skill format): the `skills-ref` validator rejects unknown top-level frontmatter keys
  (allowed: `name`, `description`, `license`, `compatibility`, `metadata`,
  `allowed-tools`); `name` must be lowercase `a-z`, `0-9` and hyphens and match its
  directory. The client guide recommends scanning `.agents/skills/` at project and user
  level, parsing leniently, and protecting activated skill content from compaction.
  keywork: **open** as SW16 (conformance; today `authored_by` is a top-level key) and SW17
  (skill content survives compaction).
- **Claude Code (observable behavior):** 2.1.284 (2026-09-28) neutralizes invisible
  characters and markup lookalikes in `MEMORY.md` and recalled notes; keywork: **open** as
  SW8. 2.1.285 stops auto-memory from being enabled by background sessions. 2.1.275 fixed
  memory age notes busting the prompt cache.

## Sources

obsidian.md/license · Wikipedia: Obsidian (software) · obsidianmd/obsidian-api (MIT) ·
obsidianmd/jsoncanvas (MIT) · blacksmithgu/obsidian-dataview + datacore (MIT) ·
SkepticMystic/breadcrumbs (MIT) · HEmile/juggl (**GPL-3.0**) ·
eugeniughelbur/obsidian-second-brain (MIT) · notes.andymatuschak.org/Evergreen_notes ·
Obsidian help: Properties, Internal links, Vault types · practitioner writeups (XDA
shared-memory vault; Stefan Imhoff agentic note-taking) ·
<https://obsidian.md/changelog/> · <https://agentskills.io/specification> ·
<https://agentskills.io/client-implementation/adding-skills-support.md> · Claude Code
`CHANGELOG.md` (2.1.275, 2.1.284, 2.1.285).
