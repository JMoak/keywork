# Obsidian — Design DNA & Vault Interop

> Research dossier for **keywork**, added 2026-08-10 for the workstream-J memory store
> (J3/J9/J12). Obsidian is the dominant local-first PKM app; keywork's memory directory
> can be a first-class Obsidian vault for free.

> **LICENSING — READ FIRST**
> **The Obsidian app is proprietary (commercial EULA) — never adapt or port its source**
> (none is published). What IS open: the file conventions (`[[wikilinks]]`, `![[embeds]]`,
> YAML frontmatter — open conventions predating Obsidian, freely adoptable, no
> attribution); **MIT**: obsidianmd/obsidian-api typings, JSON Canvas format, Dataview,
> Datacore, Breadcrumbs, obsidian-second-brain (agent-memory vault prior art) — adaptable
> with `NOTICE` attribution. ⚠️ **Juggl (graph plugin) is GPL-3.0 — ideas only.** Verify
> every plugin's license individually; "plugins are usually MIT" fails.

## Design DNA keywork adopts

1. **Files over apps** — notes are plain files that outlive the software. Already
   keywork's posture; the discipline is keeping it strict (index always disposable).
2. **`[[wikilinks]]` as zero-friction graph-building** — two brackets + autocomplete is
   the entire schema; links are cheap so they actually get made. The agent's memory graph
   edges are, first of all, wikilinks in markdown.
3. **Backlinks: linked + unlinked mentions.** Unlinked mentions (plain-text occurrences
   of a note's title/aliases not yet linked, one action to convert) is the most-loved
   discovery feature and trivially textual — for keywork, automated graph densification
   the Gardener runs.
4. **Frontmatter properties as typed metadata** — reserved `tags`/`aliases`; wikilinks in
   properties must be quoted (`up: "[[Parent]]"`); `aliases` powers autocomplete and
   mention-matching. Breadcrumbs' typed directional relations (`up/down/next/prev/custom`,
   with implied reciprocals) shows typed KG semantics expressible as plain YAML.
5. **Evergreen-note methodology (Matuschak)** — atomic (one concept per note),
   concept-oriented titles ("titles are APIs"), densely linked, continuously *revised*
   rather than appended. Maps 1:1 onto agent-memory hygiene; append-only memory rots
   (confirmed by every agent-vault practitioner writeup — their fix, self-rewriting
   notes, is keywork's Gardener).
6. **Daily notes** (`daily/YYYY-MM-DD.md`) as the append-friendly episodic surface,
   linking out to atomic notes. Exactly keywork's daily-log layer.
7. **Local graph over global graph** — community verdict: the global graph view is eye
   candy past ~200 notes; the 1–2-hop local neighborhood is "almost magical." keywork
   skips global-graph ambitions; the TUI renders the local graph as an indented
   links-in/links-out outline.

## Vault-citizenship spec (J3 acceptance criteria)

- UTF-8 `.md`; note identity = filename; concept-like unique names; avoid `#^[]|` in
  filenames. Write bare `[[Name]]` links and enforce vault-wide unique note names.
- Support `[[Name|display]]`, `[[Name#Heading]]`, `[[Name#^block]]`, `![[embeds]]` at
  parse level; resolution case-insensitive.
- Valid YAML frontmatter at byte 0; `tags`/`aliases` as lists; wikilinks in properties
  quoted; one type per key vault-wide; keywork's own keys (provenance, curing state,
  confidence, typed relations) are ordinary properties — instantly Dataview-queryable.
- Daily logs at `daily/YYYY-MM-DD.md` (Obsidian's default pattern).
- Ship **no `.obsidian/`** and gitignore it — Obsidian creates its own on "open folder
  as vault."

## TUI translations (J9)

Backlinks panel (grep+parse) · unlinked mentions with convert-action · local graph as
indented 1–2-hop outline (links out / links in) · `[[` fuzzy autocomplete over filenames +
aliases · orphan/dead-link lint (the one useful "global" function) · Dataview-lite
frontmatter queries (adapt from Dataview/Datacore, MIT, NOTICE line).

## Sources

obsidian.md/license · Wikipedia: Obsidian (software) · obsidianmd/obsidian-api (MIT) ·
obsidianmd/jsoncanvas (MIT) · blacksmithgu/obsidian-dataview + datacore (MIT) ·
SkepticMystic/breadcrumbs (MIT) · HEmile/juggl (**GPL-3.0**) ·
eugeniughelbur/obsidian-second-brain (MIT) · notes.andymatuschak.org/Evergreen_notes ·
Obsidian help: Properties, Internal links, Vault types · practitioner writeups (XDA
shared-memory vault; Stefan Imhoff agentic note-taking).
