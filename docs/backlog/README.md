# keywork: Backlog Index

> The full task breakdown derived from [`../tasks.md`](../tasks.md) and [`../vision.md`](../vision.md).
> Tasks are sized 1–3 points where possible (a few are honestly bigger and say so) and listed
> **in execution order** within each file. Dependencies are intentionally not modeled here;
> order implies them loosely, and the workstream files can be attacked in parallel.
>
> **Point scale:** 1pt ≈ one focused hour or two · 2pt ≈ a half-day · 3pt ≈ a full day.
> **Strategy tags:** `LIFT:pi` / `LIFT:opencode` / `LIFT:aider` / `LIFT:openclaw` /
> `LIFT:hermes` / `LIFT:hipporag` = adapt MIT/Apache source with attribution (record in
> `NOTICE`; Apache-2.0 sources additionally carry their license text) ·
> `ADAPT:rosavera` = adapt Jordan's own private rosavera code (no attribution obligation) ·
> `OWN` = original work.
> The former `REIMPL:crush` tag is retired (2026-08-10): Crush is not a design source;
> every task that carried it is now `OWN`, designed from first principles.
>
> **Standing guardrails:** Anthropic is API-key / Agent-SDK only, ever; the G1 provider
> (landed 2026-09-03) speaks the Messages API with an API key and nothing else; no
> subscription-OAuth code paths ported from any source.

## Where a topic is decided

Precedence is topic-scoped: an overlay wins where it speaks, and where it is silent the
next-newer overlay that speaks applies, down to the base workstream file. The table names the
file that currently owns each topic; the file itself says what it amends.

| Topic | Owning file(s) |
|---|---|
| Workspace anchoring, modes (Plan · Recall · Agent), arc splits | [`99`](99-workspace-and-modes.md) (PD11–PD13); mode semantics in [`../modes.md`](../modes.md) |
| Chroma and arcs (arc as the work unit, ramp, funding ladder, workspace multiplicity) | [`98`](98-chroma-and-arcs.md) (PD8–PD10); landed arc surfaces in [`110`](110-arcs-on-screen.md) |
| Typography and the page (transcript type, title bar, titling, needs-you chrome) | [`104`](104-the-page.md) (PD18–PD20, PD25); glyph tiers, themes and motion in [`100`](100-visual-craft.md) (PD14–PD17) |
| Instrument display (cost lineage, changed files, lens grammar) | [`102`](102-instrument-grammar.md) (discussion capture, not authoritative) |
| Inference resolution, `/connect`, `/model`, onboarding | [`105`](105-inference-resolution.md) (IR-01–IR-19, CD-01–CD-10); implementation ledger [`107`](107-inference-implementation.md) |
| Long-session survivability and the launch rail (compaction, gauge, headless contract, packaging, soak) | [`108`](108-survivability-and-launch-rail.md); stream 3 ledger [`109`](109-long-session-survivability.md) |
| Arcs and workspaces on screen | [`110`](110-arcs-on-screen.md) |
| Bots (the *who* axis) | [`106`](106-bots.md): PD21 binding, PD22/PD23 adopted under the policy-row model (Q-B8, 2026-09-03); D16, B9, C67 landed 2026-09-03, ledger at the end of the file |
| Memory and skills (workstream J) | [`95`](95-memory-and-skills.md); the arc rung in [`98`](98-chroma-and-arcs.md) PD9; bot layer in [`106`](106-bots.md) once adopted |
| File browser and calculated mouse | [`94`](94-file-browser-and-mouse.md) |
| Trust and permissions | [`50-trust.md`](50-trust.md), amended by [`97`](97-product-direction.md) E7 and [`99`](99-workspace-and-modes.md) PD12 (per-pane permission mode), [`103`](103-dsh-influence.md) E8/E9 (sandbox, secrets), [`108`](108-survivability-and-launch-rail.md) A19/A20 (gates as entries, headless `ask` answers no) |
| Code audit and its waves | [`111`](111-code-audit.md) |
| Workspace readiness and `/init`, the `/connect` surface, the arc pane and its fold primitive, dock pins, memory browser scoping | [`112`](112-feel-and-look-wave.md) |
| The own title row and needs-you chrome, gap / borderless / corner chrome, the arc airlock digest, arc jump rows, the verified e2e baseline | [`113`](113-arcs-and-chrome-wave.md) |
| Where to resume from | [`115`](115-open-ledger.md) (read first; cites the owner of each item) |
| LSP: the engine port, the diagnostics-in-tool-result moment, server posture, F4a / F4b / F5 | [`114`](114-lsp.md) (scoping; F4 / F5 in [`60`](60-code-intel.md) superseded) |

## Workstreams

| File | Workstream | Tasks | Points |
|---|---|---|---|
| [`00-m0-skeleton.md`](00-m0-skeleton.md) | M0: repo skeleton | 6 | 9 |
| [`10-engine.md`](10-engine.md) | A: engine core | 15 | 30 |
| [`20-sessions.md`](20-sessions.md) | B: session trees | 8 | 15 |
| [`30-tui.md`](30-tui.md) | C: TUI, keyboard, tiling | 18 | 37 |
| [`40-extensions.md`](40-extensions.md) | D: extensions, commands, MCP | 12 | 24 |
| [`50-trust.md`](50-trust.md) | E: trust & safety | 5 | 10 |
| [`60-code-intel.md`](60-code-intel.md) | F: code intelligence | 5 | 10 |
| [`70-anthropic.md`](70-anthropic.md) | G: Anthropic (API-key provider; G1 + G2 landed 2026-09-03, ledger inside) | 2 | 3 |
| [`80-p2-reach.md`](80-p2-reach.md) | P2: server, attach, workspaces; external-surface posture (2026-08-10); P2.1 server landed 2026-09-06; P2.2 attach and P2.4 notifications landed 2026-09-07 | 7 | 20 |

## Overlays

Each row says what the file decides and when it binds; the detail lives in the file.

| File | Kind | Decides |
|---|---|---|
| [`94-file-browser-and-mouse.md`](94-file-browser-and-mouse.md) | Planning overlay (2026-08-10); wins for its two lanes | The file browser (C-series) and calculated pointer support (H-series) design lanes. |
| [`95-memory-and-skills.md`](95-memory-and-skills.md) | Planning overlay (2026-08-10); wins for workstream J | Memory and self-healing skills: scopes, engine-core memory, hybrid retrieval, Gardener curation, provenance-gated airlock writes, Obsidian-citizen vault and entity graph (J-D1–J-D5), fifth-pass fault resolutions. 15 tasks, +36. |
| [`96-conversation-enrichment.md`](96-conversation-enrichment.md) | Planning overlay (2026-08-10); wins for the conversation pane's streaming feed | Twelve sized enrichment candidates (V2.x); adoption gated on the `research/coding-agent-nuances.md` merge; V2.1/V2.2/V2.10/V2.13 landed via 92. |
| [`97-product-direction.md`](97-product-direction.md) | Authoritative (2026-08-15); wins over 96 and below | Second feedback pass: panes as the front door (D15), two-dock layout (C38), geometry fix (C35), sessions surfaces (C36/C37), per-pane permission mode (E7), J15/J16, e2e capture harness (C39–C43); Q1–Q10 open. 12 tasks, +25. |
| [`98-chroma-and-arcs.md`](98-chroma-and-arcs.md) | Authoritative (2026-08-15); wins over 97 and below | Names the work unit **arc**: PD8 chromatic depth, PD9 funding ladder and arc cycle, PD10 workspace multiplicity; workflow-round addendum J20–J25/C47. 13 tasks, +27. |
| [`99-workspace-and-modes.md`](99-workspace-and-modes.md) | Authoritative (2026-08-16); wins over 98 and below | PD11 workspace materialization, anchoring and linking; PD12 modes Plan · Recall · Agent; PD13 arc-aware splits. |
| [`100-visual-craft.md`](100-visual-craft.md) | Authoritative (2026-08-16); wins over 99 and below | The visual-craft pass: PD14 glyph tiers, PD15 first-class theme system, PD16 motion grammar, PD17 cockpit gauge; tasks C48–C57. 10 tasks, +19. |
| [`101-feedback-round-4.md`](101-feedback-round-4.md) | Authoritative (2026-08-16); wins over 100 and below | Live-use feedback: landed ledger (crash containment, Dock · Main · Dock, H/J/K/L pane movement, persisted titles) and new tasks FR1–FR6. 18 tasks, +36. |
| [`102-instrument-grammar.md`](102-instrument-grammar.md) | Discussion capture (2026-08-16); not authoritative | Instrument display: cost-with-lineage and changed-files provenance pursued, lens grammar queued for a design session; Q1–Q9 open. |
| [`103-dsh-influence.md`](103-dsh-influence.md) | Scoping overlay (2026-08-16); wins over 101 and below where it speaks | DeepSeek Harness research: A19–A22, E8 sandbox modes, E9 secrets at rest, non-adoptions of record; Q-DSH1–Q-DSH9. 6 tasks, +10. |
| [`104-the-page.md`](104-the-page.md) | Authoritative (2026-08-16); wins over 103 and below where it speaks | The page pass: PD18 transcript typography, PD19 title-bar grammar, PD20 titling pipeline, PD25 needs-you chrome. 9 tasks, +17. |
| [`105-inference-resolution.md`](105-inference-resolution.md) | Authoritative decisions (2026-08-20); wins over 104 and below where it speaks | Inference resolution as an engine primitive: the stable IR-01–IR-19 contract and the CD-01–CD-10 connection-surface contract. |
| [`106-bots.md`](106-bots.md) | Authoritative in part (2026-09-03); wins where it speaks | Bots as the *who* axis (PD21–PD24); D16 bot definitions, B9 binding entries, C67 `/bot` surfaces landed 2026-09-03; J26/J27/C68 queued behind the policy-row model. 6 tasks, +12. |
| [`107-inference-implementation.md`](107-inference-implementation.md) | Implementation + ledger (2026-08-21) for 105; 105 wins on disagreement | IR-T1–IR-T5 sized and landed, gates IR-G1–G5 green, deviations of record. 5 tasks, +13. |
| [`108-survivability-and-launch-rail.md`](108-survivability-and-launch-rail.md) | Planning + ledger (2026-08-21); wins over 107 and below where it speaks | Stream 3 long-session survivability (ledger in 109) and stream 4 the launch rail (A19, A20 headless exit contract, G3 packaging, FR1.2 soak), all landed; headless `ask` answers no (flagged). 4 tasks, +9. |
| [`109-long-session-survivability.md`](109-long-session-survivability.md) | Implementation + ledger (2026-08-21) for 108 stream 3; cited records win | Context budget primitive, after-turn settler, C55 gauge on real marks (options round open), declared windows end to end, cost across model switches. 5 tasks, +9. |
| [`110-arcs-on-screen.md`](110-arcs-on-screen.md) | Implementation + ledger (2026-08-21) for stream 5; cited records win | Arcs and workspaces visible and drivable: binding entries, CLI arc service, `/arc` and PD13 splits, arc hue, arcs node, workspace multiplicity. 6 tasks, +14. |
| [`111-code-audit.md`](111-code-audit.md) | Audit + work plan (2026-08-22); names defects and tasks, changes no decision | Whole-tree audit: P0/P1/P2 findings, structure and redundancy items, docs and em-dash ledger, waves A–D with Jordan's decisions; waves A + B landed 2026-08-22. ~60 tasks. |
| [`112-feel-and-look-wave.md`](112-feel-and-look-wave.md) | Ledger + scoping (2026-08-22); wins where it speaks | Landed: workspace readiness + `/init` (arcs-initiation root cause), lazy memory, `/connect` connections screen, C71 dock pins, C70 the arc pane in two parts (docked node, then the fold primitive: held panes, `space` / `a`, folded-and-waiting rows, held restore), C72 the memory browser (garden / note / ledger lenses, the `?` question box with why-lines, prompt cut, one-key revert) (2026-08-23); open: C72-c heat candidates; decisions ledger at the end. 3 tasks, +11. |
| [`113-arcs-and-chrome-wave.md`](113-arcs-and-chrome-wave.md) | Plan + ledger (2026-08-30); wins where it speaks | Lanes W1 to W5 over the fully specified leftovers; W2 (C69 own title row, C66 rung, C50 remainder) and W3 (J18 digest surface, arc jump rows) landed 2026-08-30; e2e baseline corrected (11 of 13 scenarios were red at `bccb058`); open decisions and reversible assumptions listed. |
| [`114-lsp.md`](114-lsp.md) | Scoping overlay (2026-09-03); nothing built | LSP behind an engine `LanguagePort`: three options sized (A diagnostics only, recommended and default `off`; B read tools; C OpenCode-shaped, refused for v1), the after-save seam, diagnostics as text in the tool result, PATH-only user-installed servers, cost budgets, F4a / F4b / F5 tasks with a stdio fixture server, Q-L1 to Q-L5 for Jordan. |
| [`115-open-ledger.md`](115-open-ledger.md) | Running pickup list (2026-09-07); decides nothing | Read first when resuming: gate state, pickup order, every unbuilt item and every open call with the overlay that owns it. Strike as things land. |

### Archived

Superseded overlays, kept for the record under [`archive/`](archive/); 97 declared them
superseded and nothing current cites them for a live decision.

| File | Was |
|---|---|
| [`archive/90-plan-review.md`](archive/90-plan-review.md) | Two-reviewer plan review (2026-08-10): 15 new tasks, resequencing, corrected milestone map. 15 tasks, +43. |
| [`archive/91-progress-and-feedback.md`](archive/91-progress-and-feedback.md) | Completed ledger and the first user-feedback tasks (C24–C28, D12, D13). 7 tasks, +12. |
| [`archive/92-iteration-3.md`](archive/92-iteration-3.md) | Iteration-3 tracks and the running done-ledger of landed waves; platform priority of record (Linux primary, Windows fully supported). |
| [`archive/93-adversarial-review.md`](archive/93-adversarial-review.md) | Adversarial-review findings, WP-1…WP-8 all landed 2026-08-10; kept as the fixed-defect corpus. |

**Total: 156 tasks, ~330 points** (after review + progress overlays; D14 MCP status dock
and workstream J added 2026-08-10; J13/J14/A18 from the fifth-pass fault review; C34/P2.6
from the external-surface posture; C35–C43/D15/E7/J15/J16 from the 2026-08-15 product
direction overlay and its screen-capture addendum; C44–C46/J17–J19 from the 2026-08-15
vision pass 3 on chroma and arcs, with J15 delivered by that overlay; J20–J25/C47 from its
2026-08-16 workflow-round addendum; C48–C57 from the 2026-08-16 visual-craft overlay; A19–A22/E8/E9 from the 2026-08-16 dsh-influence overlay).

**Milestone map** (from `archive/90-plan-review.md`; status ledger in
`archive/91-progress-and-feedback.md`, later waves in their own overlays):
**M1** = M0 · A1–A17 · B1–B8 · C0–C7, C12, C19, C20 · D0 · E3, E4 ·
**M2** = C8–C11, C13, C14, C15a, C16–C18, C21–C23 · D1–D11 · E1, E2, E5, E6 (exit gate:
one keywork feature built *using* keywork) · **M3** = F1–F5 · G1–G6 · C15b · **P2** post-v1.

**ID authority:** these backlog files are canonical; the coarser IDs in `../tasks.md` are
superseded narrative.

**Release posture (Jordan, 2026-08-10):** keywork is **FSL-1.1-MIT** (`LICENSE.md`);
the repo **goes public at the M2 demo**, arriving as the tiling-pane harness, with CI
green and docs coherent as the publishing bar. **The launch screencast is
"zero-to-working in 60 seconds"**: install → onboarding → first agent turn → first undo,
one real-time minute, which makes onboarding polish (C19, D13) and packaging (G3)
launch-critical. The README one-liner leads **feel-led** (the terminal-video-game /
craft experience; Jordan wordsmiths the final line), with the tiling screenshot
adjacent so the feel claim is instantly grounded. Security order of record: WP-1..3 (93) land before all remaining
feature tracks; iteration 4 = workstream J + D14 in parallel after the P/B7 gates.
Visual vocabulary of record: [`../design-language.md`](../design-language.md).
