# Feature Candidates from the Broader Open-Source Ecosystem

Research pass surveying permissively-licensed coding agents and agent tooling **beyond Pi, OpenCode, and Crush**, to find additional features keywork could adopt. All licenses below were checked against the actual repos/docs on 2026-08-09 unless explicitly marked *unverified*.

**Rating key**

- **LIFT** — source is MIT/Apache-permissive; code could be adapted with attribution (note: Apache-2.0 code can be incorporated into an MIT project, but Apache's NOTICE/attribution and patent-clause obligations must be preserved for the copied portions).
- **REIMPLEMENT** — the idea is great, but the source's license (e.g. GPL) or language/stack means we build it ourselves from the observable behavior only.
- **WATCH** — interesting, not yet worth adopting.

---

## Standing licensing rules for keywork (restated)

- **Pi** ([earendil-works/pi](https://github.com/earendil-works/pi)) and **OpenCode** ([sst/opencode](https://github.com/sst/opencode)) are **MIT** — code may be lifted with attribution.
- **Crush** ([charmbracelet/crush](https://github.com/charmbracelet/crush)) is **FSL-1.1-MIT** — **ideas only, never copy its source**.
- **Never** integrate Anthropic subscription-OAuth. Anthropic access is **API-key / Agent-SDK only** (hard ToS guardrail for this project). This matters below: several surveyed tools advertise "use your existing subscription" flows — keywork must not copy that pattern for Anthropic.

---

## 1. Candidate feature table

| # | Feature | Source | License (verified) | Rating |
|---|---------|--------|--------------------|--------|
| 1 | Repo map — ranked codebase map fed as context | Aider | Apache-2.0 | LIFT (algorithm; Python source → likely reimplement in TS, design is documented) |
| 2 | Watch mode / `AI!` comment triggers in source files | Aider | Apache-2.0 | LIFT |
| 3 | Auto lint + test after every edit, with auto-fix loop | Aider | Apache-2.0 | LIFT |
| 4 | Auto-commit each AI change with sensible messages; undo via git | Aider | Apache-2.0 | LIFT (behavior; adapt to user preferences) |
| 5 | `/review` — read-only prioritized findings on a diff/commit/branch | Codex CLI | Apache-2.0 | LIFT |
| 6 | `/permissions` + visible active-sandbox indicator before actions | Codex CLI | Apache-2.0 | LIFT |
| 7 | `resume` — reopen a recent chat scoped to the current repo | Codex CLI | Apache-2.0 | LIFT |
| 8 | `exec` — non-interactive headless mode for scripts/CI | Codex CLI | Apache-2.0 | LIFT |
| 9 | Checkpointing — save/restore conversation + file state | Gemini CLI | Apache-2.0 | LIFT |
| 10 | Token caching + visible token-usage accounting | Gemini CLI | Apache-2.0 | LIFT |
| 11 | User-shareable extensions / custom commands | Gemini CLI | Apache-2.0 | WATCH |
| 12 | Recipes — parameterized, shareable workflow templates | Goose | Apache-2.0 | REIMPLEMENT (Rust source) |
| 13 | Plan/Act mode toggle (explore + strategize before executing) | Cline | Apache-2.0 | LIFT |
| 14 | File-level checkpoints with per-edit diff review/undo | Cline | Apache-2.0 | LIFT |
| 15 | Background terminal monitoring (watch long-running output, react to errors) | Cline | Apache-2.0 | LIFT |
| 16 | Custom modes (Code/Architect/Ask/Debug + user-defined) | Roo Code | Apache-2.0 (project discontinued 2026-05-15) | LIFT |
| 17 | Multi-buffer review pane — accept/reject per hunk or whole set, keyboard-driven | Zed agent panel | GPL-3.0-or-later | REIMPLEMENT |
| 18 | "Follow the agent" — editor jumps to files as the agent touches them | Zed agent panel | GPL-3.0-or-later | REIMPLEMENT |
| 19 | Restore Checkpoint button per agent message | Zed agent panel | GPL-3.0-or-later | REIMPLEMENT |
| 20 | Prompt-jump navigation (keys to hop between user prompts in a thread) | Zed agent panel | GPL-3.0-or-later | REIMPLEMENT |
| 21 | Message editing + queued messages with "steer" interrupt | Zed agent panel | GPL-3.0-or-later | REIMPLEMENT |
| 22 | ACP (Agent Client Protocol) compatibility as an external-agent surface | Zed / OpenHands ecosystem | Zed GPL; OpenHands MIT; protocol is an open spec | WATCH |
| 23 | Local/remote/cloud agent backends behind one UI | OpenHands | MIT | WATCH |
| 24 | Oracle/subagent + shareable-thread patterns | Amp (Sourcegraph) | **Unverified** — npm says "SEE LICENSE IN LICENSE.md"; assume proprietary | WATCH (ideas only until license verified) |
| 25 | Fuzzy-finder-everywhere for file/thread/command pickers (fzf-style) | fzf and similar | *Unverified in this pass* (commonly MIT — verify before lifting) | WATCH |
| 26 | Multiplexer UX: keybinding hint bar, floating panes, resurrectable layouts (zellij-style) | Zellij and similar | *Unverified in this pass* (commonly MIT — verify before lifting) | WATCH |

---

## 2. LIFT / REIMPLEMENT candidates in detail

### 2.1 Repo map (Aider — Apache-2.0)

Aider builds "a map of your entire codebase, which helps it work well in larger projects" — a ranked summary of files/symbols injected into context so the model can navigate large repos without reading everything. Fit for keywork: it is invisible infrastructure that makes a simple UI feel smart; no UI cost, big quality win. Aider is Python, so this is a design-lift (tree-sitter symbol extraction + PageRank-style ranking) reimplemented in TypeScript — the approach is fully documented and Apache-licensed if we ever port code directly.
Source: https://github.com/Aider-AI/aider, https://aider.chat/docs/repomap.html

### 2.2 Watch mode / `AI!` comments (Aider — Apache-2.0)

With `--watch-files`, aider monitors the repo for comments that start/end with `AI`, `AI!`, or `AI?`: plain `AI` accumulates instructions, `AI!` triggers edits, `AI?` asks a question — placed exactly where the change belongs, across multiple files, in any editor. This is the ultimate keyboard-first entry point: the user never leaves their editor, and keywork's pane can light up when work arrives. A file-watcher + comment-scanner is small to build in Bun.
Source: https://aider.chat/docs/usage/watch.html

### 2.3 Auto lint/test loop and git auto-commit (Aider — Apache-2.0)

Aider "automatically lint[s] and test[s] your code every time aider makes changes" and can fix what the linters/tests report; it also auto-commits each change with a sensible message so users "diff, manage and undo AI changes" with normal git tools. Fit: turns correctness and undo into ambient guarantees instead of UI chrome — very Omarchy. Keywork should make auto-commit opt-in and clearly labeled (this machine's own convention — users owning commits — is a live example of why).
Source: https://github.com/Aider-AI/aider

### 2.4 `/review` read-only review mode (Codex CLI — Apache-2.0)

Codex's `/review` analyzes "uncommitted changes, a commit, or a base branch" and reports "prioritized findings without modifying your working tree." Fit: a guaranteed-no-side-effects mode is a trust primitive, and it maps naturally to a dedicated keywork pane showing ranked findings the user can jump through by keyboard.
Source: https://developers.openai.com/codex/cli (→ learn.chatgpt.com/docs/codex/cli)

### 2.5 `/permissions` with visible sandbox state (Codex CLI — Apache-2.0)

Codex lets users "choose what Codex is allowed to do" with granular file-edit/command control, and displays the active sandbox before proceeding. Fit: permission state as an always-visible status-line element (not a buried setting) is exactly the kind of detail keywork values — the user should never wonder what the agent is allowed to do right now.
Source: https://developers.openai.com/codex/cli

### 2.6 Repo-scoped resume + headless `exec` (Codex CLI — Apache-2.0)

`codex resume` reopens "a recent chat from the current repository" — scoping session pickers to the cwd's repo is a small heuristic with outsized feel. `codex exec` runs non-interactively for "repeatable workflows and pipelines" — a headless mode makes keywork scriptable and testable from day one.
Source: https://developers.openai.com/codex/cli

### 2.7 Checkpointing + token accounting (Gemini CLI — Apache-2.0)

Gemini CLI checkpoints conversations so users can pause and resume "without losing context," and does token caching for efficiency. Fit: keywork should persist thread state cheaply and show token/cost honestly; Gemini CLI is TypeScript and Apache-2.0, so its implementation is directly studyable and adaptable with attribution.
Source: https://github.com/google-gemini/gemini-cli

### 2.8 Plan/Act toggle (Cline — Apache-2.0)

"In Plan mode, Cline explores your codebase, asks clarifying questions, and lays out a strategy"; the user then flips to Act mode (autonomous or per-action approval). Fit: a single keystroke toggling read-only-planning vs. executing is a crisp, keyboard-native safety model — simpler than a permissions matrix for everyday use.
Source: https://github.com/cline/cline

### 2.9 Checkpoints with per-edit diff review; background terminal monitoring (Cline — Apache-2.0)

Cline tracks changes with checkpoints so users can undo agent modifications, surfaces all edits as reviewable diffs, and monitors terminal output in real time — "catching compile errors and test failures as they occur while long-running processes continue in the background." Fit: the background-process monitor is a natural keywork pane (dev server in one pane, agent reacting to its stderr in another). Cline is TypeScript/Apache-2.0 — adaptable with attribution.
Source: https://github.com/cline/cline

### 2.10 Custom modes (Roo Code — Apache-2.0, discontinued)

Roo Code shipped Code/Architect/Ask/Debug modes plus user-defined Custom Modes, each a bundle of prompt, tool access, and behavior. The project was discontinued 2026-05-15 (repo recommends forks), but the Apache-2.0 code remains liftable. Fit: modes-as-keybindings (one key = one persona/toolset) suits keywork better than free-form config.
Source: https://github.com/RooCodeInc/Roo-Code

### 2.11 Recipes (Goose — Apache-2.0 — REIMPLEMENT)

Goose ships workflow "recipes" (e.g. `release_risk_check`): pre-built, shareable automation templates for common tasks, on top of persistent sessions and 70+ MCP extensions. Goose is Rust, so this is idea-transfer: a recipe = a checked-in file declaring prompt, inputs, and allowed tools, runnable via keywork's headless mode. Caution: Goose advertises using "existing subscriptions" for some providers — keywork must **not** replicate that for Anthropic (API-key/Agent-SDK only).
Source: https://github.com/block/goose

### 2.12 Zed agent-panel review UX (Zed — GPL-3.0-or-later — REIMPLEMENT, never copy source)

Zed's agent panel is the current high-water mark for keyboard-driven agent review, and every piece below must be **rebuilt from observed behavior only** (GPL):

- **Multi-buffer review pane** (`Ctrl+Shift+R`): "accept or reject each individual change hunk, or the whole set," with an optional single-file inline-diff mode.
- **Follow the agent**: a toggle (or holding `ctrl` on submit) makes the editor jump to each file as the agent "reads and edits files."
- **Restore Checkpoint** per message: "return your code base to the state it was in prior to that message" — invaluable after interrupting mid-edit.
- **Thread navigation keys**: `Ctrl+Alt+PageUp/Down` jumps between *user prompts* specifically — transcript navigation by semantic landmarks, not lines.
- **Editable messages + queued sends with "Steer"**: edit any prior message and resubmit; queued messages send after generation unless "Steer" interrupts at the next step.

Fit: this is keywork's ethos rendered in an editor — every review action has a key, the agent's activity is followable, and undo is one press away. Hunk-level accept/reject in an OpenTUI diff pane should be a flagship feature.
Source: https://zed.dev/docs/ai/agent-panel, https://github.com/zed-industries/zed

---

## 3. WATCH notes

- **Extensions/custom commands (Gemini CLI)** — valuable eventually; premature before keywork's core loop is stable.
- **ACP compatibility (Zed/OpenHands ecosystem)** — letting keywork host or be an external agent via the open Agent Client Protocol; Zed notes external agents lose steering/checkpoints, so the protocol is still uneven. Revisit once the spec matures.
- **OpenHands (MIT)** — local/remote/cloud backend switching "without losing focus" is interesting for a far-future keywork-server story; MIT means code is liftable if we go there. Source: https://github.com/All-Hands-AI/OpenHands
- **Amp (Sourcegraph)** — subagent/oracle and shareable-thread patterns are worth studying, but the npm package only says "SEE LICENSE IN LICENSE.md" and no open-source license was verified; treat as **ideas-only, proprietary until proven otherwise**. Sources: https://www.npmjs.com/package/@sourcegraph/amp, https://github.com/sourcegraph/amp-examples-and-guides
- **fzf-style fuzzy pickers / zellij-style hint bar and floating panes** — both are strong fits for keyboard-first multiplane UX (a persistent bar showing currently-valid keys is peak discoverability). Licenses were **not verified in this research pass** (fetches unavailable); verify `junegunn/fzf` and `zellij-org/zellij` licenses on the repos before lifting anything — until then, ideas only.

---

## 4. License notes per source (verified unless marked)

| Source | Repo / docs | License | Evidence |
|--------|-------------|---------|----------|
| Aider | https://github.com/Aider-AI/aider | Apache-2.0 | Repo license field/README |
| OpenAI Codex CLI | https://github.com/openai/codex | Apache-2.0 | Repo license field |
| Gemini CLI | https://github.com/google-gemini/gemini-cli | Apache-2.0 | Repo license field |
| Goose | https://github.com/block/goose | Apache-2.0 | Repo license field |
| Cline | https://github.com/cline/cline | Apache-2.0 | Repo README ("Apache 2.0 © 2026 Cline Bot Inc.") |
| Roo Code | https://github.com/RooCodeInc/Roo-Code | Apache-2.0 (project discontinued 2026-05-15) | Repo footer |
| Zed | https://github.com/zed-industries/zed | GPL-3.0-or-later (some Apache-2.0-marked components) | Repo licensing docs — **never copy source; reimplement only** |
| OpenHands | https://github.com/All-Hands-AI/OpenHands | MIT | Repo license field |
| Amp | https://www.npmjs.com/package/@sourcegraph/amp | **Unverified** ("SEE LICENSE IN LICENSE.md") | Assume proprietary; ideas only |
| fzf, Zellij | github.com/junegunn/fzf, github.com/zellij-org/zellij | **Unverified in this pass** | Verify on-repo before any lift |
| Pi | https://github.com/earendil-works/pi | MIT (project ground rule) | Lift with attribution |
| OpenCode | https://github.com/sst/opencode | MIT (project ground rule) | Lift with attribution |
| Crush | https://github.com/charmbracelet/crush | FSL-1.1-MIT (project ground rule) | **Ideas only — never copy source** |

**Apache-2.0 → MIT-project note:** lifting Apache-2.0 code into keywork is permitted but requires keeping the Apache license text/NOTICE attribution for the copied portions and respecting its patent-termination clause; pure MIT sources (OpenHands, Pi, OpenCode) need only copyright + license notice.

**Anthropic guardrail:** none of the "sign in with your subscription" auth flows seen in surveyed tools (e.g. Goose's subscription reuse, Gemini CLI's Google sign-in analog) may be replicated for Anthropic. Keywork's Anthropic integration is API-key / Agent-SDK only.
