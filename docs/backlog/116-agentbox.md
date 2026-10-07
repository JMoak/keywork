# 116: agentbox

> **Kind:** scoping overlay (2026-09-17); nothing below is built. `agentbox/` at the repo root
> runs keywork in a Docker Compose box on Amazon Bedrock: an internal network with an
> allowlisting egress proxy, credentials held by broker containers, MCP systems as directories,
> and a `box` launcher that declares one box per repo from the developer's machine and proves
> each one sealed with `box check`. It needed no
> engine change to exist. These are the engine and release tasks it surfaced. Where it speaks
> it wins; it is silent on everything outside `agentbox/` and the tasks below.
>
> **Standing guardrails (unchanged):** every task is `OWN`. The box was first drafted around
> OpenCode in a separate repo; nothing from OpenCode or Pi source is adapted here. The user
> commits; agents never `git commit` or `git push`.

## Where the tree stands

`agentbox/` is drafted and statically checked, never booted; `agentbox/VERIFY.md` is the
first-boot checklist. The harness-neutral design (threat model, the three rings, host
declarations, comparison with the Claude Code and Codex sandboxes) lives in the
`containerized-coding-agents` repo at `docs/design.md`.

Facts from source that shaped it:

- The Bedrock catalog is open and `AWS_SESSION_TOKEN` is honored (`cli/src/inference/runtime.ts`,
  `engine/src/providers/bedrock/sigv4.ts`), so any model id works with temporary credentials.
- The MCP HTTP client speaks streamable HTTP (`engine/src/mcp/http.ts`), which is what sibling
  containers need.
- MCP servers and permissions are honored from the user config layer only
  (`shared/src/config/load.ts`), so a cloned repo cannot add a server. OpenCode needs an
  environment flag for the same guarantee.
- MCP tools register as `<server>__<tool>` with `mutates: true` (`engine/src/mcp/registry.ts`).
  Permission rules are exact-name lookups, and `--preset` replaces the configured rules for
  the run (`shared/src/trust/permissions.ts`, `cli/src/main.ts`).

## Tasks

### AB1 (2pt): Bedrock through a signing broker
Every credential in the box lives in a broker container except AWS, because the Bedrock
endpoint is derived from the region alone. Honor `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, the
variable the AWS SDKs define for this, from the process environment only. Config still cannot
supply a base URL, which keeps the reasoning in the `bedrockRegion` description intact: the
project layer has no way to redirect inference.
**Accept:** with the variable set, requests go to that origin with the same path and body; the
`http:` scheme is accepted only for this override; region validation is unchanged; the variable
in a project-layer file changes nothing, proven by a test; `agentbox/compose.yaml` gains the
`bedrock` broker service (`aws-sigv4-proxy`) and the agent loses its AWS keys.
**Open:** Q-AB1.

### ~~AB2 (1pt): honest denial hint for MCP tools~~
The headless denial hint (`cli/src/run.ts`, the `--preset open` advice) is wrong for an MCP
tool: `open` covers the four core tools, and `--preset` discards the allow entries that would
have helped. Name the fix that works: allow `<server>__<tool>` under `permissions.tools`.
**Accept:** a denied MCP call prints the exact rule to add; a denied core tool keeps today's
hint; the golden fixture for exit 4 is updated.
**Landed 2026-10-02 (with 117 SW15):** when any refused tool is an MCP tool, the notice prints
one ordered rule per refused tool, e.g. `add {"action":"mcp","resource":"github__get_issue",
"effect":"allow"} to the permissions list in ~/.keywork/keywork.json`; core-only refusals keep
the `--preset open` hint. The exit-4 golden stream carries only `refused` tool names, so it did
not change; `cli/src/run.test.ts` covers the plain-mode notice.

### ~~AB3 (2pt): allow a whole MCP server~~
Exact-name rules mean a box has to list every tool of every system before `keywork run` can
use them, and the upstream names drift. Let a rule cover one server.
**Accept:** the chosen form (Q-AB2) allows every tool of one server and nothing else; deny
still wins; `agentbox/systems/*/keywork.json` shrink to one line each.
**Landed 2026-10-02 (with 117 SW15):** `{"action": "mcp", "resource": "github__*", "effect":
"allow"}` covers one server and nothing else. Rules are ordered and the last match wins, so a
deny placed after the server rule still carves a tool out. Each system's `keywork.json` is one
rule line, and `agent/entrypoint.sh` now appends permission lists across fragments instead of
letting jq's `*` replace them.

### AB4 (2pt): a published image
`agentbox/agent/Dockerfile` installs keywork with `scripts/install.sh` at build time. Publish
`ghcr.io/<owner>/keywork:<tag>` from `release.yml` for linux x64 and arm64, so the box's
Dockerfile starts `FROM` it and a team can pin a digest.
**Accept:** the image is built from the same release binary, smoke-tested with `--version` and
`doctor`, and every action in the workflow is SHA-pinned.

### AB5 (1pt): first boot
Run `box check` and work down `agentbox/VERIFY.md` on a Mac and on a Linux host, fix what fails, and delete the
file and the README banner.

## Directions recorded, no tasks yet

- **Native mode and E8.** E8 ([`103`](103-dsh-influence.md)) confines spawned commands on the
  host. agentbox confines the whole harness in a container. They meet in the brokers: with the
  broker services published on loopback behind a per-box token, a host keywork under E8b would
  get the same credential-free access to Bedrock, git, and MCP systems that the boxed one has.
  No task until E8a exists.
- **`keywork box`.** A subcommand that writes `agentbox/` into a project and runs `box init` would
  make the box part of the product instead of a directory to copy. No task until AB5 passes.

## Questions for Jordan

- **Q-AB1:** is an environment-only endpoint override acceptable under the rule that config
  never supplies a Bedrock base URL? Proposal: yes. The environment is already the only
  Bedrock credential source, so it is already the trust root for this provider.
- ~~**Q-AB2:** which form for AB3: a `*` suffix in `permissions.tools` keys (`github__*`), or an
  `allow: true` on the `mcpServers` entry?~~ **Settled by 117-2 (2026-10-02):** neither; the
  ordered rule list's `mcp` action takes a `github__*` resource, one rule vocabulary for all
  tools.
- **Q-AB3:** should the harness-neutral design doc move into this repo (`docs/agentbox.md`)
  once the OpenCode variant stops being the team's daily driver?
