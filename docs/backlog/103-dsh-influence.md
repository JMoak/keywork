# DeepSeek Harness Influence — Scoping Overlay (2026-08-16)

> Overlay from the dsh research pass (DeepSeek Harness, `dsh`, released 2026-08-13,
> MIT, TypeScript on the Cordis plugin microkernel). Where this file speaks it wins;
> where silent, [`101`](101-feedback-round-4.md) and below apply.
>
> **Licensing status (Q-DSH1, open):** dsh is MIT and therefore *eligible* as a
> `LIFT:dsh` source with attribution in `NOTICE`, but it is not yet on the sanctioned
> list in `AGENTS.md`. Until Jordan sanctions it, every task below is `OWN` (design
> from the published behavior, no source adaptation). Crush's status is unaffected.
>
> **Non-adoptions of record:** the full everything-is-a-plugin microkernel (opposite
> trade from D2's minimal core + blessed extensions), web-UI-first surface (inverse of
> D10), messaging channels (refused in ux-principles §4), profile patch-layering
> (its replace-not-merge semantics are the footgun D9's single typed schema exists to
> prevent). Subagent bridges to Claude Code/Codex touch the Anthropic guardrail
> perimeter: not before G1, and a dedicated decision then.

## Tasks, in priority order

### A20 (1pt) — Headless exit contract
`keywork run --headless "<task>"` (flag naming per existing D12/headless surface) runs
one session to completion, prints the final assistant message to stdout, exits 0 on
completion and 1 on failure, and mounts nothing else — no server, no TUI, no panes.
Failure = the turn ends in an error terminal state on the bus (provider failure after
retries, tool-loop abort, jail violation); a completed turn whose *content* reports
inability is still exit 0 (see Q-DSH2).
**Accept:** CI-style invocation in tests asserts stdout is exactly the final message
and exit codes match terminal bus states; JSON mode (`--json`) emits the same via the
existing event stream.
**Strategy:** `OWN` (D7's print mode already rides the bus; this is the contract).

### A19 (2pt) — Every gate and every injection as session entries
Widen D8's "reconstructable from the log" guarantee to the full dsh bar: permission
decisions (grant/deny/preset change), compaction events, mode flips (PD12 already
requires these via E5's rule), **and every context injection** — memory recalls,
skill loads, bootstrap content, subagent scheduling — append to the session JSONL as
first-class entries, so replay reconstructs *everything the model saw and every gate
it passed*. Injection entries carry provenance (scope, source note/skill id), which
is J13's recall-citation substrate landing in the log rather than only in the UI.
**Accept:** replaying a session containing an approval change, a compaction, and a
memory recall yields identical extension state; injection entries name their source;
entries are greppable with stable `type` names.
**Strategy:** `OWN`; extends Pi's entry vocabulary, format stays Pi-compatible.

### E8 (3pt — honestly bigger) — OS-enforced sandbox modes
Filesystem confinement as architecture, not confirmation dialogs. Three modes:
`read-only` · `workspace-write` (default; writes confined to workspace root + temp) ·
`full-access` (explicit, loud). **Fail-closed runner seam:** a platform runner must
return enforcing arguments or the spawn fails; silent bypass is forbidden (the
check-guardrails precedent, applied to process spawning).
Phased: **E8a** — the mode model + runner seam + fail-closed tests (platform-agnostic).
**E8b** — Linux enforcement (bwrap/Landlock; Linux-primary per 92). **E8c** — Windows
enforcement (restricted-token ACLs; serves textures T3). macOS Seatbelt rides later
with no task until demand.
**Accept (per phase):** escape attempts (write outside jail in workspace-write, any
write in read-only) fail at the OS layer, proven by tests that attempt them; a runner
returning no enforcement fails the spawn; `full-access` requires explicit config with
`.describe()` justification and renders loudly in the trust indicator (E2's honest-UI
rule).
**Strategy:** `OWN` design; `LIFT:dsh` for runner implementations if Q-DSH1 sanctions.
**Interlock:** PD12's Plan mode *may* bind to `read-only` (Q-DSH3); E2 presets and
sandbox modes are distinct dials until Q-DSH4 resolves.

## Directions recorded, no tasks yet

- **Code Mode** (post-M2, blessed-extension experiment): the model writes one
  TypeScript program against generated typed tool bindings instead of discrete
  round-trips; Bun executes it in-sandbox (E8 is therefore a prerequisite). Changes
  loop economics for batch work; permission story unresolved (Q-DSH5). No task until
  E8a exists and M2 ships.
- **ACP dialect on the P2 server** : the D7 server wrap adds Agent Client Protocol
  alongside HTTP/SSE, letting IDE clients (Zed et al.) mount keywork with no IDE
  plugin work. Rides P2, zero pre-P2 cost.
- **Framing lift (free):** document MCP servers as "trusted executable code running
  outside the jail" in the E/J docs — it's the crispest statement of the posture the
  config layer already enforces.

## Second pass (2026-08-16) — items under-weighted in round one

### A21 (1pt) — Persistent shell sessions
dsh's minimal preset runs a *persistent* bash: state (cwd, env, venvs, background
jobs) survives across tool calls. If keywork's core bash is per-call, agents pay a
re-setup tax every step. Verify current behavior; if per-call, add a persistent shell
session per agent turn-sequence with explicit reset, surviving state recorded in the
log (A19's vocabulary).
**Accept:** `cd` + activate-venv in call N is live in call N+1; `/reset-shell` (or
equivalent) returns to a clean state as a logged event; kill-tree on session end
(existing proc.ts precedent).
**Strategy:** `OWN`.

### E9 (2pt) — Secrets at rest via OS keychain
Community dsh ships encrypted credential vaults; keywork keys currently live in
plaintext user config. Store provider keys and `mcpServers.env` secrets in the OS
credential store (DPAPI/Credential Manager on Windows, Secret Service on Linux,
Keychain on macOS) with plaintext config as explicit opt-out; config references
secrets by name. Serves the existing "env is secrets, never logged" rule with
at-rest protection.
**Accept:** key round-trips through the platform store on Linux + Windows; config
file contains no secret material; opt-out is `.describe()`-justified.
**Strategy:** `OWN`.

### A22 (1pt) — Declared model capabilities, not discovery
dsh models are "text-only until config says otherwise" — no endpoint discovery.
Adopt the same honesty in the provider layer: modalities (`input: [text, image]`),
context ceiling, and tool-call support are explicit declarations in provider config,
validated by the schema; nothing is probed or assumed.
**Accept:** sending an image to a text-declared model fails fast with a config-shaped
error naming the missing declaration.
**Strategy:** `OWN`; D9-consistent.

### Direction — termination & budget policy (PD17-adjacent, options-first)
dsh's framing of "termination logic" as a first-class harness layer, plus the
community's budget-alert plugins, against keywork's "honest token/cost display"
anchor: a per-session/per-arc policy object (max turns, token/cost ceiling, stall
detection) whose trips are logged events and pane-visible, never silent. No task
until PD17's context gauge lands — the gauge is the display surface this would arm.

### Direction — web access as a blessed extension, taint-first
dsh's standard preset includes web search; keywork currently scopes **no web access
at all**. If it comes, it arrives as a blessed extension whose fetched content is
born-tainted (workstream J's provenance machinery), never as a core tool. Recording
the posture now so it doesn't arrive casually later (Q-DSH8 decides timing).

## Open questions (Q-DSH)

- **Q-DSH1 — sanction `LIFT:dsh`?** MIT, eligible; needs Jordan's explicit add to the
  AGENTS.md source list before any code adaptation. Decides E8's implementation
  strategy and future Code Mode economics.
- **Q-DSH2 — headless failure semantics.** Is exit 1 only for *harness* failure
  (proposed), or also when the agent self-reports task failure? Self-report requires
  parsing model output — fragile; proposal says no.
- **Q-DSH3 — does Plan mode imply `read-only` sandbox?** PD12 says read-only *toolset*;
  binding it to the OS mode makes it kernel-true but couples two subsystems. Proposal:
  yes once E8b lands on Linux, with toolset-only as the degraded tier.
- **Q-DSH4 — one trust vocabulary or two?** E2 presets (`careful/standard/open`) and
  sandbox modes (`read-only/workspace-write/full-access`) are different axes
  (approval friction vs. blast radius). Keep two dials with the status line showing
  both, or fold sandbox mode into the presets? Proposal: two dials, one indicator.
- **Q-DSH5 — Code Mode permissioning.** A generated program batches many tool acts;
  per-act gating defeats the point, blanket approval defeats the gate. Needs its own
  design session before any task is cut.
- **Q-DSH6 — Bun + bwrap/Landlock spike.** Verify the enforcement stack composes with
  Bun's spawn model on Linux and ConPTY flows on Windows before E8b/E8c are sized as
  written (a failed spike re-sizes E8 upward).
- **Q-DSH7 — auto-review tier between allow and ask?** Community dsh has tiered
  auto-approval (a policy/reviewer pre-screens risky actions). Does keywork's E2
  ladder ever want a reviewer tier, or is that complexity the thin-gate refusal
  exists to keep out? Proposal: not in v1; revisit with evidence from dogfooding.
- **Q-DSH8 — does keywork get web access at all, and when?** Currently unscoped
  anywhere. Proposal: post-M2 blessed extension, taint-first per the direction above;
  a harness whose agent can't read docs pages is a real gap, but it must not beat
  the taint machinery to the punch.
- **Q-DSH9 — ecosystem discovery.** dsh uses a GitHub topic + community awesome-list;
  keywork's omakase lean suggests a *curated* extension gallery instead of a
  marketplace. Decide at launch prep (G3/packaging), not before.
