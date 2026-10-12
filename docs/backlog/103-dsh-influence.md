# DeepSeek Harness Influence: Scoping Overlay (2026-08-16)

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

### A20 (1pt): Headless exit contract
`keywork run --headless "<task>"` (flag naming per existing D12/headless surface) runs
one session to completion, prints the final assistant message to stdout, exits 0 on
completion and 1 on failure, and mounts nothing else: no server, no TUI, no panes.
Failure = the turn ends in an error terminal state on the bus (provider failure after
retries, tool-loop abort, jail violation); a completed turn whose *content* reports
inability is still exit 0 (see Q-DSH2).
**Accept:** CI-style invocation in tests asserts stdout is exactly the final message
and exit codes match terminal bus states; JSON mode (`--json`) emits the same via the
existing event stream.
**Strategy:** `OWN` (D7's print mode already rides the bus; this is the contract).

### A19 (2pt): Every gate and every injection as session entries
Widen D8's "reconstructable from the log" guarantee to the full dsh bar: permission
decisions (grant/deny/preset change), compaction events, mode flips (PD12 already
requires these via E5's rule), **and every context injection** (memory recalls,
skill loads, bootstrap content, subagent scheduling) append to the session JSONL as
first-class entries, so replay reconstructs *everything the model saw and every gate
it passed*. Injection entries carry provenance (scope, source note/skill id), which
is J13's recall-citation substrate landing in the log rather than only in the UI.
**Accept:** replaying a session containing an approval change, a compaction, and a
memory recall yields identical extension state; injection entries name their source;
entries are greppable with stable `type` names.
**Strategy:** `OWN`; extends Pi's entry vocabulary, format stays Pi-compatible.

### E8 (3pt, honestly bigger): OS-enforced sandbox modes
Filesystem confinement as architecture, not confirmation dialogs. Three modes:
`read-only` · `workspace-write` (default; writes confined to workspace root + temp) ·
`full-access` (explicit, loud). **Fail-closed runner seam:** a platform runner must
return enforcing arguments or the spawn fails; silent bypass is forbidden (the
check-guardrails precedent, applied to process spawning).
Phased: **E8a**: the mode model + runner seam + fail-closed tests (platform-agnostic).
**E8b**: Linux enforcement (bwrap/Landlock; Linux-primary per 92). **E8c**: Windows
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
  outside the jail" in the E/J docs; it's the crispest statement of the posture the
  config layer already enforces.

## Second pass (2026-08-16): items under-weighted in round one

### A21 (1pt): Persistent shell sessions
dsh's minimal preset runs a *persistent* bash: state (cwd, env, venvs, background
jobs) survives across tool calls. If keywork's core bash is per-call, agents pay a
re-setup tax every step. Verify current behavior; if per-call, add a persistent shell
session per agent turn-sequence with explicit reset, surviving state recorded in the
log (A19's vocabulary).
**Accept:** `cd` + activate-venv in call N is live in call N+1; `/reset-shell` (or
equivalent) returns to a clean state as a logged event; kill-tree on session end
(existing proc.ts precedent).
**Strategy:** `OWN`.

### E9 (2pt): Secrets at rest via OS keychain
Community dsh ships encrypted credential vaults; keywork keys currently live in
plaintext user config. Store provider keys and `mcpServers.env` secrets in the OS
credential store (DPAPI/Credential Manager on Windows, Secret Service on Linux,
Keychain on macOS) with plaintext config as explicit opt-out; config references
secrets by name. Serves the existing "env is secrets, never logged" rule with
at-rest protection.
**Accept:** key round-trips through the platform store on Linux + Windows; config
file contains no secret material; opt-out is `.describe()`-justified.
**Strategy:** `OWN`.
**Landed 2026-10-02.** New `shared/src/secrets/`: one `SecretVault` (store / lookup / forget)
over the platform CLIs with every call going through an injectable `CommandRunner`, no native
dependency. Windows seals with DPAPI (`ProtectedData`, CurrentUser) through
`powershell -NoProfile -EncodedCommand`, the value and the ciphertext travel as Base64 on
stdin/stdout, and the sealed blob lives in `~/.keywork/secrets/<name>.dpapi`; Linux and the
BSDs use `secret-tool store/lookup/clear` (value on stdin); macOS uses
`security add/find/delete-generic-password` (service `keywork`, account = the secret name).
`cli/src/auth-store.ts` writes `{"type":"vault","secret":"provider.<name>"}` into `auth.json`
and keeps the whole credential (api key or sign-in tokens) in the vault; a store that refuses
or is missing falls back to plaintext with one notice, an unreadable secret drops that
credential with a notice. `/connect` saves and removes through it (`ConnectionsDeps.secrets`,
wired in `inference-state.ts`), and so does the Codex token refresh. MCP `env` and `headers`
values written `secret:<name>` are revealed per server on connect (`McpRegistryOptions.reveal`,
`compose.ts`); a missing one shows as that server's `lastError` naming the secret. Opt-out:
top-level `secretStore: "plaintext"`, user layer only. Tests: `secrets/vault.test.ts` (Linux,
Windows and macOS through fake runners, plus one real DPAPI round trip that runs only on
win32), `auth-store.test.ts`, `connections.test.ts`, `mcp/registry.test.ts`. Deviations:
the PowerShell `CredentialManager` module path was not built (DPAPI is always present, and two
Windows backends would hide a secret written by one from the other); old plaintext `auth.json`
entries are read as before and not migrated; there is no `keywork secret set` command yet, so
on Windows an MCP `secret:` value can only be filled by keywork code (Linux and macOS users
can use `secret-tool` / `security` with service `keywork`); the Codex browser / device sign-in
in `setup.ts` still saves plaintext on first sign-in (its refresh goes to the vault). macOS
passes the value in argv because `security` takes it nowhere else.

### A22 (1pt): Declared model capabilities, not discovery
dsh models are "text-only until config says otherwise"; no endpoint discovery.
Adopt the same honesty in the provider layer: modalities (`input: [text, image]`),
context ceiling, and tool-call support are explicit declarations in provider config,
validated by the schema; nothing is probed or assumed.
**Accept:** sending an image to a text-declared model fails fast with a config-shaped
error naming the missing declaration.
**Strategy:** `OWN`; D9-consistent.

### Direction: termination & budget policy (PD17-adjacent, options-first)
dsh's framing of "termination logic" as a first-class harness layer, plus the
community's budget-alert plugins, against keywork's "honest token/cost display"
anchor: a per-session/per-arc policy object (max turns, token/cost ceiling, stall
detection) whose trips are logged events and pane-visible, never silent. No task
until PD17's context gauge lands; the gauge is the display surface this would arm.

### Direction: web access as a blessed extension, taint-first
dsh's standard preset includes web search; keywork currently scopes **no web access
at all**. If it comes, it arrives as a blessed extension whose fetched content is
born-tainted (workstream J's provenance machinery), never as a core tool. Recording
the posture now so it doesn't arrive casually later (Q-DSH8 decides timing).

## Open questions (Q-DSH)

- **Q-DSH1: sanction `LIFT:dsh`?** MIT, eligible; needs Jordan's explicit add to the
  AGENTS.md source list before any code adaptation. Decides E8's implementation
  strategy and future Code Mode economics.
- **Q-DSH2: headless failure semantics.** Is exit 1 only for *harness* failure
  (proposed), or also when the agent self-reports task failure? Self-report requires
  parsing model output, which is fragile; proposal says no.
- **Q-DSH3: does Plan mode imply `read-only` sandbox?** PD12 says read-only *toolset*;
  binding it to the OS mode makes it kernel-true but couples two subsystems. Proposal:
  yes once E8b lands on Linux, with toolset-only as the degraded tier.
- **Q-DSH4: one trust vocabulary or two?** E2 presets (`careful/standard/open`) and
  sandbox modes (`read-only/workspace-write/full-access`) are different axes
  (approval friction vs. blast radius). Keep two dials with the status line showing
  both, or fold sandbox mode into the presets? Proposal: two dials, one indicator.
- **Q-DSH5: Code Mode permissioning.** A generated program batches many tool acts;
  per-act gating defeats the point, blanket approval defeats the gate. Needs its own
  design session before any task is cut.
- **Q-DSH6: Bun + bwrap/Landlock spike.** Verify the enforcement stack composes with
  Bun's spawn model on Linux and ConPTY flows on Windows before E8b/E8c are sized as
  written (a failed spike re-sizes E8 upward).
- **Q-DSH7: auto-review tier between allow and ask?** Community dsh has tiered
  auto-approval (a policy/reviewer pre-screens risky actions). Does keywork's E2
  ladder ever want a reviewer tier, or is that complexity the thin-gate refusal
  exists to keep out? Proposal: not in v1; revisit with evidence from dogfooding.
- **Q-DSH8: does keywork get web access at all, and when?** Currently unscoped
  anywhere. Proposal: post-M2 blessed extension, taint-first per the direction above;
  a harness whose agent can't read docs pages is a real gap, but it must not beat
  the taint machinery to the punch.
- **Q-DSH9: ecosystem discovery.** dsh uses a GitHub topic + community awesome-list;
  keywork's omakase lean suggests a *curated* extension gallery instead of a
  marketplace. Decide at launch prep (G3/packaging), not before.

### E8 sandbox modes · options note · 2026-10-12

E8 sat at "scope first" from August until this note. It scopes the mode set, decides the seam,
and records what landed with it: the seam with `off` and the refusal path everywhere (E8a), and
`workspace` plus `isolated` on Linux through bubblewrap (E8b). Where it speaks it replaces the E8
entry above, including that entry's modes (`read-only` · `workspace-write` · `full-access`).
Nothing is adapted from dsh, sandbox-runtime or any other source; every line is `OWN`, so
Q-DSH1 doesn't bear on it.

**The seam.** `Sandbox` in `engine/src/sandbox/sandbox.ts` has one method:
`confine(launch) → launch`, where a launch is `{ file, args, cwd, env }`. It either returns the
launch to exec or throws `SandboxRefusal`. It never spawns: each launcher keeps its own spawn API
(`node:child_process` for bash, `Bun.spawn({ terminal })` for the pty, `SpawnLike` for language
servers) and gets its argv from the seam, so there's no path from a tool to a process that skips
it, and a refusal throws before any process or pty exists. `off` is the identity. The agent side
reads it through `ToolSandbox` (`session.ts`), which adds the one ask described below.

| Launcher | Runs under the mode | Why |
|---|---|---|
| `bash`, one-shot and persistent | yes | the agent's hands; the persistent shell is confined once, when it starts |
| language servers (114) | yes | the agent's edits start them, and a repo can run code through them (TypeScript server plugins from `node_modules`, rust-analyzer build scripts); 114's "spawns through the same runner seam" is now true |
| delegated child agents | yes | they compose through the same `buildAgent` and share the workspace's answer |
| terminal pane (pty and pipes) and `!cmd` shell escapes | through the seam, handed `off` | what you type is yours, the rule that already keeps typed lines out of the permission gate; following the mode instead is handing `composition.sandbox` to the `terminalPane` port and the shell-escape tools in `compose-panes.ts` (Q-E8-2) |
| prompt-template `` !`cmd` `` interpolation (`commands.ts`) | not wired | the user invoked the template and each command is asked through the gate (Q-E8-3) |
| MCP stdio servers | no | trusted executable code outside the jail (the framing above), configured from the user layer only; most need network and their own state, and their tools already ride the gate |
| keywork's own git (checkpoints, the SW13 change snapshots) | no | keywork itself, not a tool |

**The modes.**

| | `off` (default) | `workspace` | `isolated` |
|---|---|---|---|
| Writes land in | anywhere you can write | the workspace roots (cwd, anchor root, PD11 linked dirs), the git dir of a worktree or submodule that lives elsewhere, `/tmp`, `/var/tmp`, `$TMPDIR`, and the package caches that exist | the workspace roots and their git dirs; `/tmp` and `~/.cache` are private and vanish with the process |
| Network | open | open | none: its own namespace with loopback only |
| Host sockets (docker, the D-Bus session bus, ssh-agent, X11) | open | open | hidden (`/run` and `/tmp` are fresh) |
| keywork's own state (`~/.keywork`: keys, config, grants, sessions) | readable and writable | hidden | hidden |
| Other processes | reachable | not: own pid namespace, so `kill -9 -1` reaches only the sandbox, and killing the shell takes every descendant with it | same |
| Reads | everything | everything, `~/.ssh` and `~/.aws` included | everything, but nothing leaves through the command |

Package caches, fixed in keywork the way the trusted read bundle is (no option): `~/.cache` or
`$XDG_CACHE_HOME`, `~/.npm`, `~/.bun/install/cache`, `~/.cargo/registry` and `~/.cargo/git`,
`~/go/pkg/mod`, `~/.gradle/caches`, `~/.m2/repository`, the pnpm store, the yarn berry cache,
`~/.nuget/packages`. They're writable in `workspace` because a sandbox that fails `bun install` is
one users turn off on day one; in `isolated` they're read-only and `~/.cache` is a private tmpfs.

What `workspace` guarantees: every write the agent's shell makes is either one `/undo` can take
back (the workspace) or disposable (temp, caches), and the agent can't rewrite its own config,
grants or keys. What it doesn't: it's a guard against mistakes and casual injection, not a jail
for hostile code. Reads and the network are open, so a command can still send `~/.aws` somewhere;
host sockets are open, so `docker run -v /:/host` or `systemd-run --user` over the session bus
runs outside it; a command can plant a package in a cache that a later unconfined build runs.
Global installs, dotfile edits and `git worktree add ../x` fail with `Read-only file system`,
and the bash tool's description says so, so the model reads the failure correctly.

What `isolated` adds: nothing a command does survives outside the workspace, and nothing it
reads leaves the machine through the command. It can't stop the model itself from carrying what
it read: the tool result goes to the provider, and an MCP tool outside the sandbox could pass it
on. Package installs and `git push` fail by design. It's the mode for running code you don't
trust yet.

`container` is not a mode. A boxed keywork is agentbox (116): the harness, the credentials and
the network sit in a container, and inside it `sandbox` is `off` because nested user namespaces
are blocked there and the box is the boundary. A per-command docker mode would be a devcontainer
product (images, mounts, toolchains in the image) with the config surface D9 forbids.
`read-only` from the August plan is declined for now: Plan mode's read-only toolset (PD12, E5)
covers it at the gate, and Q-DSH3 stays open. `full-access` is `off`.

**Fail-closed, and what the user sees.** A mode the host can't enforce refuses; nothing degrades
quietly. The refusal is one line with the fact and the fix, for example
`sandbox workspace refused: bubblewrap isn't installed · install it (apt install bubblewrap, dnf
install bubblewrap) or set "sandbox": "off" in ~/.keywork/keywork.json`. It shows up four ways:

1. Once at composition, through the notice channel every surface already has (the pane notice,
   a `keywork chat` line, `keywork run:` on stderr, `keywork serve:` in the log).
2. In the status bar lead beside the preset word: `standard · sandbox workspace` when it holds,
   `standard · sandbox workspace refused` when it doesn't, and `standard · unconfined` once the
   user has waived it. That's Q-DSH4's "two dials, one indicator"; the preset word was already
   the lead.
3. In `keywork doctor` and `/doctor`: `sandbox · workspace · on · <what it promises>`, or
   `refused · <fact> · <fix>`, or with the mode off, what the host could run
   (`off · workspace and isolated refused here: windows has no sandbox keywork can use`, read
   live on this machine).
4. At the agent's first command, as an ask through the existing gate, so it rides the needs-you
   chrome, notifications and `GET /asks` with no new surface:
   `? unconfined {"why":"bubblewrap isn't installed"}  [y] allow  [n] deny`, after the notice
   `sandbox workspace can't run here: … · allow runs commands unconfined until keywork exits,
   deny keeps them refused`. Yes runs the agent's commands unconfined until keywork exits, every
   pane included; no keeps every command refused and returns the full line as the tool result.
   There's no `always`, the agent can't press `y`, and the answer is journaled as a
   `gate.permission` for the tool `unconfined`. Headless runs answer no and exit 4, and the
   exit notice reads `the sandbox can't run on this host and no one could allow running
   unconfined, so every command was refused · set "sandbox": "off" in ~/.keywork/keywork.json
   or run where the sandbox can`.

Why an ask at all: a refusal through the ask row needs two honest answers, and the only honest
second answer is "proceed without it". Without one, a user whose synced config says `workspace`
lands on a server without bubblewrap and turns the setting off everywhere, which is the outcome
this design exists to avoid. Strict refusal is one line away if Jordan prefers it (Q-E8-1).

**Platform reality.**

| | Linux | macOS | Windows |
|---|---|---|---|
| Primitive | bubblewrap (`bwrap`) | Seatbelt via `sandbox-exec` | none reachable from `node:child_process` |
| State here | built | refuses: `the macos sandbox isn't built yet` | refuses: `windows has no sandbox keywork can use`, points at WSL2 |

Linux, the evidence (read 2026-10-12 from Ubuntu, Codex and Claude Code docs and the util-linux
2.40 release notes; not run here):

| | bubblewrap | Landlock | seccomp |
|---|---|---|---|
| What it is | a CLI that builds mount, pid, ipc and net namespaces on unprivileged user namespaces | an LSM a process applies to itself, inherited across exec | a syscall filter |
| Stock Ubuntu 24.04 | on desktop (libgnome-desktop depends on it), absent on server; `kernel.apparmor_restrict_unprivileged_userns=1` blocks it (`setting up uid map: Permission denied`) until bwrap has an AppArmor profile with `userns`; the `bwrap-userns-restrict` profile ships disabled in the `apparmor-profiles` extras (25.04 enables it) | enabled in Ubuntu kernels since 22.04, no root, no install | in every kernel |
| Needs root | once, for the AppArmor profile on 24.04 (Codex and Claude Code document the same step) | never | never |
| From Bun or Node | spawn it like any binary | needs a pre-exec hook Node and Bun don't have: `bun:ffi` in product code (against 117-3), a native helper per arch, or `setpriv --landlock-access` (util-linux 2.40; Ubuntu 24.04 ships 2.39.3) | the same pre-exec problem; bwrap's `--seccomp` fd is the usual carrier |
| Covers `workspace` | yes | yes | no, it can't express paths |
| Covers `isolated` | yes, a net namespace | no: TCP only (ABI 4, kernel 6.7+), UDP and unix sockets stay open | partly, by socket family |
| Who ships it | Flatpak, Codex, Claude Code | Codex's original Linux sandbox | Codex and Claude Code, beside bwrap |

Pick: bubblewrap. It expresses both modes from `node:child_process` with no FFI, so product code
stays on `node:*`; the host setup it needs is the one Codex and Claude Code users already did;
and keywork proves it with a trial run (`bwrap --ro-bind / / --dev /dev --proc /proc
--unshare-pid --unshare-ipc [--unshare-net] --die-with-parent --chdir / -- true`, cached per
process) instead of trusting presence, the lesson the pty probe taught. Inside a container the
trial fails and the refusal says the container is the sandbox. Landlock is the zero-install
upgrade once `setpriv` 2.40 is the floor (E8d).

The launch, from `bubblewrapArgs`: `--ro-bind / /`, `--dev /dev`, `--proc /proc`, then every
writable and hidden path in depth order (shallow first, so a workspace under a hidden `/tmp` and
a `~/.keywork` inside a home-dir workspace both come out right) as `--bind p p` or `--tmpfs p`,
then `--unshare-pid --unshare-ipc`, `--unshare-net` for `isolated`, `--die-with-parent`,
`--chdir <cwd>`, `--`, the command. `isolated` also sets `TMPDIR=/tmp`. No `--new-session`: the
shell keeps its controlling terminal for job control, and the spawn's own `setsid` already
detaches it from keywork's terminal.

macOS: `sandbox-exec` with an SBPL profile is the primitive. Its man page has called it
deprecated since 10.12 (2016), but it's on every release since and both Codex and Claude Code
sandbox macOS through Seatbelt. Not built here: there's no Mac to verify a profile on, and an
unverified profile is worse than an honest refusal (E8c).

Windows: AppContainer and restricted tokens need `CreateProcess` with attribute lists, and job
objects need `SetInformationJobObject`; Bun exposes neither (the same gap the 117 reliability
floor hit with `taskkill`), so either needs FFI or a native helper, and Codex's Windows sandbox
needs an elevated one-time setup that creates sandbox users. "`workspace` by path policy in the
tool layer" was considered and declined: `read`, `write` and `edit` are confined to the workspace
by `confinedPath` in every mode already, and a shell can't be confined by parsing its command
line, so the mode would claim a guarantee it can't keep. Windows refuses both modes; WSL2 runs
the Linux runner.

**Sizes.**

| Task | Size | State |
|---|---|---|
| E8a: the seam, `off`, the `sandbox` key, the refusal ask, doctor and status | 2pt | landed |
| E8b: bubblewrap `workspace` and `isolated` | 2pt | landed, Linux behaviour verified by reading only |
| E8b-ci: run the Linux live tests on the ubuntu runner (install bubblewrap, allow userns) | 1pt | open; `ci.yml` belongs to another lane |
| E8c: macOS `sandbox-exec` runner | 2pt | open, needs a Mac |
| E8d: Landlock through `setpriv` once util-linux 2.40 is the floor | 2pt | watch |
| E8e: Windows | | declined until the runtime exposes job objects or AppContainer; WSL2 is the answer |

**Recommendation.** Ship the default `off`. Suggest `workspace` to Linux users once E8b-ci has
proven it on a real runner and a week of dogfooding hasn't produced a build it breaks; keep
`isolated` for code you don't trust. Flip no default before that: a sandbox that users switch
off because it broke their build is worse than none.

**What keywork declines.**

- A domain allowlist proxy (Claude Code's `allowedDomains`, sandbox-runtime's proxy): a config
  surface D9 forbids, and it only filters tools that honour proxy variables. `isolated` is all
  or nothing instead.
- Per-command escapes (Claude Code's `dangerouslyDisableSandbox` and `excludedCommands`, Codex's
  on-failure retry): models learn to retry unsandboxed after any failure. A command that has to
  run outside goes in the terminal pane, which is yours.
- `allowWrite` and `denyRead` lists: PD11 linked dirs are the one declared way to widen writes.
- A degrade-with-warning default and a `failIfUnavailable` switch: keywork has one behaviour,
  refuse and ask, so there's nothing to switch.
- Depending on `@anthropic-ai/sandbox-runtime` (Apache-2.0, the 117 scope-first spike): its
  value is the proxy and the Seatbelt profiles, keywork wants neither the proxy nor its config,
  and the bwrap arguments are a page of `OWN` code. Worth a second look for E8c, with
  attribution, if its profile is the fastest honest path on macOS.

**Decisions** (this lane, 2026-10-12; Jordan may reverse any):

1. One seam, `Sandbox.confine`, that every launcher gets its argv from; the agent's commands, the
   language servers and delegated children run under the mode, what the user types runs `off`,
   MCP servers and keywork's own git stay outside.
2. Three modes, `off` · `workspace` · `isolated`, as one user-layer key with `off` the default;
   `container` is agentbox, `read-only` waits on Q-DSH3.
3. A mode the host can't enforce refuses with one actionable line; the agent's first command
   asks once whether to run unconfined until keywork exits; headless answers no and exits 4.
4. The mode shows in the status bar beside the preset word, in `keywork doctor`, in the bash
   tool's description for the model, and in the refusal ask; not on every command's ask row.
5. Linux runs bubblewrap, proven by a trial run; macOS will run `sandbox-exec`; Windows refuses
   and points at WSL2.
6. The package-cache list and the hidden `~/.keywork` are fixed in keywork, like the trusted
   read bundle; linked dirs are the only way to widen writes.

**Open questions for Jordan.**

- **Q-E8-1** The unconfined escape: keep it (a yes runs the agent's commands unconfined until
  keywork exits; recommended) or strict (both answers refuse and the ask becomes a notice).
- **Q-E8-2** The terminal pane and `!cmd`: stay yours and unconfined (recommended) or follow the
  mode, so a pasted command an agent suggested is confined too.
- **Q-E8-3** Prompt-template `` !`cmd` `` interpolation: stay with the user (asked per command
  today) or follow the mode.
- **Q-E8-4** CI: add bubblewrap and `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` to
  the ubuntu job so the two live tests run; today they skip with the reason in the report.
- **Q-E8-5** Caches: the fixed list only, or also honour `CARGO_HOME`, `GOMODCACHE` and
  `npm_config_cache` when they point elsewhere.
- **Q-E8-6** Q-DSH3 again, now concrete: does Plan mode run its shell under `isolated`?
- **Q-E8-7** After E8b-ci and dogfooding, does Linux's default become `workspace`?

### E8a + E8b · ledger · landed 2026-10-12

**What landed.**

- `engine/src/sandbox/`: `sandbox.ts` (`Sandbox`, `Launch`, `SandboxRefusal` with `fact` and
  `remedy`, `unconfined`, `refusingSandbox`, the model note),
  `bubblewrap.ts` (`confinementPlan` reads the host on every launch: the caches that exist, a
  worktree's or submodule's git dir from its `.git` pointer and `commondir`; `bubblewrapArgs`
  orders mounts shallow first), `host.ts` (`sandboxFor(mode, scope, host?)`,
  `sandboxSupport(host?)`, the cached trial run, the refusal wording per platform and per trial
  failure), `session.ts` (`ToolSandbox`, `workspaceSandbox` holding one answer per workspace and
  the status word that follows it,
  `askGateUnconfined` riding `guard.confirm` with a synthetic `unconfined` call after the
  `mcp_elicitation` precedent).
- Launchers: `bashTool`, `persistentBashTool` and `ShellSession.run` take a `ToolSandbox`;
  `openInteractiveShell` and `probePtySupport` take a `Sandbox` (default `off`);
  `LanguagePortOptions.sandbox` confines server spawns and marks a refused server `failed` with
  the refusal as its detail and an `lsp.refused` log line; `SpawnLike` gained an optional `env`.
  `harnessSpawnOptions` folded into the bash launch.
- Config: `sandbox: "off" | "workspace" | "isolated"` with its `.describe()`; the project layer
  drops it by construction, pinned by a load test.
- Wiring: `composeWorkspace` builds the workspace sandbox once and posts the refusal notice;
  `buildAgent` hands every agent `forAgent(askGateUnconfined(guard))` and journals the answer as
  `gate.permission`; `main.ts` threads `config.sandbox` into chat, run and serve; the status bar
  lead appends the sandbox word; `keywork doctor` gains the `sandbox` row; `keywork run` adds the
  sandbox fix to the exit-4 notice when `unconfined` was refused; `docs/headless.md` says so.

**Tests.** `engine/src/sandbox/seam.test.ts` (the contract with a recording fake: bash spawns
what the seam hands back, refusal spawns nothing and leaves no marker, the persistent shell is
confined once and not at all when refused, the pipe shell refuses, the pty spawns the confined
argv and allocates no terminal when refused, the model note only when enforcing),
`host.test.ts` (off touches nothing; windows, macos, other platforms, no bwrap, a namespace
denial and any other trial failure each refuse with their wording; a passing trial confines;
`isolated` trials with `--unshare-net`), `bubblewrap.test.ts` (plans per mode with real temp
dirs, `XDG_CACHE_HOME`, worktree and submodule git dirs, exact argument order, `TMPDIR` for
`isolated`, and two live Linux tests that skip with the reason when bubblewrap is absent or
blocked: writes outside the workspace fail with a read-only file system, and `isolated` sees only
`lo` in `/proc/net/dev` and a private `/tmp`), `session.test.ts` (one ask per workspace, yes
runs unconfined, no and a throwing consent keep refusing, the call shape, the headless path that
prints nothing, a guard with no one to ask fails closed, the status word before and after a
yes and a no), `lsp/port.test.ts` (a refused sandbox
spawns no server and keeps the reason in the facts; a confining sandbox's launch is what spawns),
`shared/config/load.test.ts` (user layer only, the modes, `container` rejected),
`cli/src/sandbox.test.ts` (live on win32: `keywork run` with `sandbox: "workspace"` leaves no
marker, refuses `unconfined`, prints the reason first and the fix last, exits 4; a composed agent
asks `bash`, `unconfined`, `bash` and runs both commands after a yes; the status bar reads
`standard · sandbox workspace refused`; doctor rows for off, on, refused and a host that can't
sandbox), `tui/src/unconfined-ask.test.ts` (the ask row reads `unconfined {"why":…}`, remembers
nothing, shows no diff, and every built-in reason fits the 60-character clip).

**Evidence.** Bun 1.3.9 on Windows 11 with `bun x vitest run`: the sandbox, LSP, tools, load,
doctor, run, compose, compose-panes, chat, serve, serve-parity, main and tui terminal suites
green, the live Linux pair skipped with `bubblewrap is linux only and this host is win32`.
`tsc --noEmit` clean for shared, engine, tui and cli; `check:guardrails`, `check:prose`,
`check:contract` and `check:pins` ok; biome clean on every touched file apart from hunks other
lanes have in flight in `compose.ts` and `engine/src/index.ts`. `keywork doctor` run live printed
the `sandbox` row quoted above.

**Verified by reading only (this machine is Windows).** That each bwrap argument mounts as
intended, in this order, on a real kernel; the trial run's stderr against real bwrap output (the
strings come from vendor docs and bug reports); the `Read-only file system` wording a confined
write produces; `/proc/net/dev` showing only `lo` under `--unshare-net`; `killTree`'s process
group signal reaching processes inside the pid namespace; job control for a pty shell under bwrap
(only reachable if Q-E8-2 flips); the Ubuntu 24.04 package and AppArmor facts. Inferred, not
checked: GitHub's ubuntu runner lacks bubblewrap or blocks user namespaces, so the live pair will
skip there until E8b-ci.

**Deviations.** The consent is one per workspace process, not per session, so panes and children
don't each ask; the journal entry still says `scope: "session"`, the closest existing `AskScope`.
The waiver covers the agent's commands only: language servers keep the configured mode, so under
a refused mode they stay off for the session and `/doctor` shows why.
A headless sandbox refusal exits 4 but doesn't end the run at that call the way a gate decline
does: the refusal comes from inside the tool, and ending the run from a tool needs the 117 gate
`terminate` seam in `agent.ts`, which another lane owns.
