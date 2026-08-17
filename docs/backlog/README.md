# keywork — Backlog Index

> The full task breakdown derived from [`../tasks.md`](../tasks.md) and [`../vision.md`](../vision.md).
> Tasks are sized 1–3 points where possible (a few are honestly bigger and say so) and listed
> **in execution order** within each file. Dependencies are intentionally not modeled here —
> order implies them loosely; the workstream files can be attacked in parallel.
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
> **Standing guardrails:** no Anthropic wiring of any kind before workstream G; API-key /
> Agent-SDK only, ever; no subscription-OAuth code paths ported from any source.

| File | Workstream | Tasks | Points |
|---|---|---|---|
| [`00-m0-skeleton.md`](00-m0-skeleton.md) | M0 — repo skeleton | 6 | 9 |
| [`10-engine.md`](10-engine.md) | A — engine core | 15 | 30 |
| [`20-sessions.md`](20-sessions.md) | B — session trees | 8 | 15 |
| [`30-tui.md`](30-tui.md) | C — TUI, keyboard, tiling | 18 | 37 |
| [`40-extensions.md`](40-extensions.md) | D — extensions, commands, MCP | 12 | 24 |
| [`50-trust.md`](50-trust.md) | E — trust & safety | 5 | 10 |
| [`60-code-intel.md`](60-code-intel.md) | F — code intelligence | 5 | 10 |
| [`70-anthropic.md`](70-anthropic.md) | G — Anthropic (late, gated) | 2 | 3 |
| [`80-p2-reach.md`](80-p2-reach.md) | P2 — server, attach, workspaces; external-surface posture 2026-08-10 (citizenship ladder, Wispr-flagship fixture C34, injection endpoint P2.6, native-shell gate) | 7 | 20 |

| [`90-plan-review.md`](90-plan-review.md) | **Authoritative overlay** — combined two-reviewer findings: 15 new tasks (E6 trust gate, C0 TUI harness, D0 slash registry, packaging/docs/onboarding, …), resequencing (guardrail CI grep → M0, undo → M1), resizing, corrected milestone map | 15 | +43 |
| [`91-progress-and-feedback.md`](91-progress-and-feedback.md) | **Authoritative overlay** — completed ledger (done/partial per ID), 7 new tasks from first user feedback (C24 empty state, C25 slash autocomplete, C26 quick menu superseding C5, C27/C28 dock layout, D12 provider-free commands, D13 `/onboarding`), corrected mid-M2 milestone statement, next-up ordering | 7 | +12 |
| [`92-iteration-3.md`](92-iteration-3.md) | **Authoritative overlay** atop 91 — iteration-3 tracks (safety net, sessions durable/navigable/forkable) plus the running done-ledger of landed waves (Track S/T/P/V, Bedrock, workstream-J kernels, D5–D8/D10/D14, MCP lifecycle hardening 2026-08-15); binding platform priority (Linux primary, Windows fully supported) | — | — |
| [`93-adversarial-review.md`](93-adversarial-review.md) | Adversarial-review findings + parallel work plan — WP-1…WP-8 waves (root-jail, interrupt repair, SSE hardening, …) all landed 2026-08-10; kept as the fixed-defect corpus and review-wave precedent | — | — |
| [`96-conversation-enrichment.md`](96-conversation-enrichment.md) | Planning overlay for the conversation pane's streaming feed — 12 sized enrichment candidates (V2.x); adoption gated on the `research/coding-agent-nuances.md` merge; V2.1/V2.2/V2.10/V2.13 already landed via 92 | — | — |
| [`97-product-direction.md`](97-product-direction.md) | **Authoritative overlay** (2026-08-15, wins over 96/95/94/92/91/90) — second hands-on feedback pass: panes becomes bare-`keywork`'s front door (D15), two-dock engine + location cycling superseding 92 Track Q item 4 (C38), geometry unification fixing the overlap glitch (C35), live/dedup'd sessions surfaces (C36, C37), per-pane permission-mode design (E7, absorbs E5), task-group memory design (J15), workspace anchoring & linked folders (J16); addendum: E2E screen-capture harness C39–C43 over OpenTUI's headless test renderer (design in `../research/e2e-screen-capture.md`; C42 CI job dropped 2026-08-15 — local dev tool only); open design questions Q1–Q10; work streams W0–W6 | 12 | +25 |
| [`99-workspace-and-modes.md`](99-workspace-and-modes.md) | **Authoritative overlay** (2026-08-16, wins over 98 and below) — decision session: PD11 workspace materialization/anchoring/linking (lazy first-durable-act, git-root anchor, focus dirs + per-subpath MRU, smooth linking, clean re-key with versioned state layout — resolves 97 Q1–Q3/Q5, unblocks J16/J19); PD12 modes Plan·Recall·Agent (shift+tab, per-session resolution chain, Recall = read-only + proposal-gated memory curation; supersedes PD3 split-into-mode keys; E7 rescoped); PD13 arc-aware splits (regular split inherits arc, Split New Arc auto-names and binds the new session only) | — | — |
| [`100-visual-craft.md`](100-visual-craft.md) | **Authoritative overlay** (2026-08-16, wins over 99 and below) — the sexy pass: sixteen visual-craft items dispositioned to the r/designporn × r/programming bar. PD14 glyph tiers & capability ladder (Nerd Fonts enhancement-never-dependency, majors-first profiles, `keywork doctor`); PD15 first-class theme system (flavor = one readable file bundling palette/ramp/density/gaps/chrome/instrumentation; curated gallery incl. first-class light + omarchy-cockpit; live hot-swap; contrast floor); PD16 motion grammar drafted into `../design-language.md` ("motion lives in ink, never in geometry"; four tempos; ambient budget); PD17 cockpit + options-first context gauge on real flush/compaction thresholds; restraint enforcement principles. Tasks C48–C57; poster-gate not adopted, onboarding choreography parked | 10 | +19 |
| [`101-feedback-round-4.md`](101-feedback-round-4.md) | **Authoritative overlay** (2026-08-16, wins over 100 and below) — live-use feedback pass. Landed ledger: input-path crash containment + coalesced renders + crash journal, structural Dock·Main·Dock with idle-main panel and mouse-draggable dock edges, Hyprland-style H/J/K/L pane movement (D/U retired, C cycles), persisted session titles through the store, click-to-focus on session rows, fresh-start default layout. New tasks FR1–FR6: pane drag with rectangular drop previews, runtime endurance soak, entity nodes (arcs/workspaces/MCP-polish + color grammar), command trays & coverage audit, ChatGPT-subscription provider (`LIFT:openclaw`, ToS-gated) + cost capture (`LIFT:opencode`), arc edge chroma, tastiness pass, TUI-native tips, LSP the OpenCode way, subagent spawn transparency, enterprise-security scoping doc | 18 | +36 |
| [`104-the-page.md`](104-the-page.md) | **Authoritative overlay** (2026-08-16, wins over 103 and below where it speaks) — the page pass: PD18 transcript typography decided from rendered candidates. Width-tier grammar (broadsheet·column·clipping·masthead; type scale is a content scale), adaptive measure ⊕ density rail, markdown louder-with-simplicity, tonal ladder (`textMid`/`panelLift` landed as C58, `textFaint` broadsheet-reserved), block voice = density stamps (voice-is-provenance resolves 102's Q6 for the transcript), designed tool row, block-glyph masthead for tiny panes; "The page" section added to `../design-language.md`; C52 widened; addendum PD19 title-bar grammar (two-zone anatomy, lifecycle stamp via tile-fill states incl. finished-unseen hold-and-drain, real-estate priority order, C64); addendum PD20 titling pipeline (colon namespace `arc:session`, self-naming `title_session` tool + cheap-call fallback, retitle-on-pivot with title changes as session entries, slug display ladder, `fitTitle` landed in engine) | 8 | +15 |
| [`102-instrument-grammar.md`](102-instrument-grammar.md) | **Discussion capture** (2026-08-16, not yet authoritative) — instrument display: cost-with-lineage decided (pursue, flagship-shaming bar), changed-files-with-turn-provenance decided (pursue if robust; checkpoint-diff attribution is the feasibility finding), detail-slot lens grammar + model/effort provenance chip queued for a dedicated design session with anchors, open questions Q1–Q9, and sequencing sketch | — | — |
| [`103-dsh-influence.md`](103-dsh-influence.md) | **Scoping overlay** (2026-08-16, wins over 101 and below where it speaks) — DeepSeek Harness (dsh, MIT) research pass: A20 headless exit contract, A19 every gate & injection as session entries, E8 OS-enforced sandbox modes (phased E8a–c), A21 persistent shell sessions, E9 secrets at rest via OS keychain, A22 declared model capabilities; non-adoptions of record (plugin microkernel, web-first UI, messaging channels, patch-layering profiles); every task `OWN` until Q-DSH1 sanctions `LIFT:dsh`; directions (Code Mode post-M2, ACP dialect on P2, termination & budget policy, taint-first web access); open questions Q-DSH1–Q-DSH9 | 6 | +10 |
| [`98-chroma-and-arcs.md`](98-chroma-and-arcs.md) | **Authoritative overlay** (2026-08-15 vision pass 3, wins over 97 and below) — the work unit is named **arc**; PD8 chromatic depth (theme `ramp`, spawn-rank border sweep, arc anchor hues — chroma section added to `../design-language.md`); PD9 the funding ladder & arc cycle (session → arc layer → workspace vault → user global; arc airlock = fourth inbox door; distillation stamped `delivered:`), answering 97's Q6–Q8 and delivering J15; PD10 workspace multiplicity (reverses Q4 — multiple workspaces per root, compat layout, per-root MRU). Tasks C44–C46, J17–J19; addendum 2026-08-16 (the workflow round) — fifteen memory-workflow ideas dispositioned onto the ladder (signal capture J20, arc briefing J21 spec-first, point-of-action recall J22, return delta J23, cross-arc meta-distillation J24, gated global re-attestation J25, garden heat & epochs C47 options-first; open questions absorbed into J17/J18; 95's J8/J10/J13 amended; federation questions Q11–Q13 queued) | 13 | +27 |
| [`95-memory-and-skills.md`](95-memory-and-skills.md) | **Workstream J** — memory & self-healing skills: workspace/user scopes (J-D1), engine-core memory (J-D2), hybrid RRF retrieval (J-D3), Gardener curation, pre-compaction flush, memory pane, Hermes-style skill healing, write gating = provenance-gated optimism + airlock with curing-garden rendering (J-D4 resolved); atomic-note Obsidian-citizen vault + bi-temporal entity graph with PPR third retrieval leg (J-D5). Sources: OpenClaw (MIT), Hermes (MIT), HippoRAG (MIT), Graphiti (Apache-2.0, design), rosavera (Jordan's own); fifth-pass fault resolutions 2026-08-10 (sync self-reconciliation J14, recall citations J13, airlock instrumentation, session-staleness rungs, backpressure guarantee A18) | 15 | +36 |

**Total: 156 tasks, ~330 points** (after review + progress overlays; D14 MCP status dock
and workstream J added 2026-08-10; J13/J14/A18 from the fifth-pass fault review; C34/P2.6
from the external-surface posture; C35–C43/D15/E7/J15/J16 from the 2026-08-15 product
direction overlay and its screen-capture addendum; C44–C46/J17–J19 from the 2026-08-15
vision pass 3 — chroma & arcs, with J15 delivered by that overlay; J20–J25/C47 from its
2026-08-16 workflow-round addendum; C48–C57 from the 2026-08-16 visual-craft overlay; A19–A22/E8/E9 from the 2026-08-16 dsh-influence overlay).

**Milestone map — see `90-plan-review.md` (authoritative), current status in
`91-progress-and-feedback.md`:**
**M1** = M0 · A1–A17 · B1–B8 · C0–C7, C12, C19, C20 · D0 · E3, E4 ·
**M2** = C8–C11, C13, C14, C15a, C16–C18, C21–C23 · D1–D11 · E1, E2, E5, E6 (exit gate:
one keywork feature built *using* keywork) · **M3** = F1–F5 · G1–G6 · C15b · **P2** post-v1.

**ID authority:** these backlog files are canonical; the coarser IDs in `../tasks.md` are
superseded narrative.

**Release posture (Jordan, 2026-08-10):** keywork is **FSL-1.1-MIT** (`LICENSE.md`);
the repo **goes public at the M2 demo** — arriving as the tiling-pane harness, with CI
green and docs coherent as the publishing bar. **The launch screencast is
"zero-to-working in 60 seconds"**: install → onboarding → first agent turn → first undo,
one real-time minute — which makes onboarding polish (C19, D13) and packaging (G3)
launch-critical. The README one-liner leads **feel-led** (the terminal-video-game /
craft experience; Jordan wordsmiths the final line), with the tiling screenshot
adjacent so the feel claim is instantly grounded. Security order of record: WP-1..3 (93) land before all remaining
feature tracks; iteration 4 = workstream J + D14 in parallel after the P/B7 gates.
Visual vocabulary of record: [`../design-language.md`](../design-language.md).
