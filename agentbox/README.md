# agentbox

keywork in a box, for Mac and Linux. It runs on Amazon Bedrock, has a real Linux shell with
your project's toolchain, and is already connected to GitHub, Jira, and whatever internal
systems you wrap as MCP servers. It has no open route to the internet and holds no token for
any of those systems, so you can hand it work and stop watching.

> This has not been booted yet. `box check` automates most of the first boot, and
> [`VERIFY.md`](VERIFY.md) lists the rest.

## Once

```sh
alias box=~/src/keywork/agentbox/box   # in your shell profile

cd ~/src/my-repo
box init                               # reads your uid, git identity, repo, and tool versions
$EDITOR ~/src/keywork/agentbox/.env    # add the secrets; every line says what it wants
box aws                                # only if your AWS credentials are temporary
box up && box check
```

## Every day

```sh
cd ~/src/my-repo
box                                    # keywork, on this repo
box run "fix the failing tests and push a branch"
box sh                                 # the same shell the agent has
```

Edits land in your checkout as they happen, and you review them with the git tools you
already use. Each repo gets its own box, with its own toolchain, caches, and sessions. `box`
finds the right one from the directory you are standing in.

| when | run |
|---|---|
| Bedrock starts refusing requests | `box aws`, which refreshes temporary credentials from your host profile |
| an install or download fails | `box denied` shows what the gate refused; allow a domain in `gate/allowed-domains.txt` or the box's `GATE_EXTRA_DOMAINS`, then `box restart gate` |
| you changed `TOOLS`, `APT_PACKAGES`, or `.env` | `box up` |
| something feels off | `box check` |
| you are done for the day | `box down` (sessions and caches survive; `box down -v` wipes them) |
| anything else | `box <any docker compose command>`: `box logs agent`, `box ps`, `box config` |

`box` is sugar over plain docker compose, and the header of the script lists everything it does.

## What is running

```
        your machine                      one box per repo (docker compose)
  ┌──────────────────────┐    ┌───────────────────────────────────────────────┐
  │ ~/src/my-repo  ──────┼────┼─▶ agent      keywork, shell, toolchain          │
  │ .env (secrets) ──┐   │    │     │  internal network, no route out          │
  └──────────────────┼───┘    │     ├─▶ gate         allowlisted domains ──────┼─▶ registries, Bedrock
                     ├────────┼─────├─▶ git-github   adds the token ───────────┼─▶ github.com
                     │        │     ├─▶ mcp-github   holds the token ──────────┼─▶ GitHub API
                     └────────┼─────└─▶ mcp-jira     holds the token ──────────┼─▶ Jira
                              └───────────────────────────────────────────────┘
```

Four ideas carry the design:

1. **Credentials live in brokers.** Each token sits in one small container that uses it on the
   agent's behalf: `mcp-jira` for Jira, `mcp-github` for the GitHub API, `git-github` for git
   itself. keywork's config never holds a secret. The one exception today is AWS, which the
   agent still carries; [`VERIFY.md`](VERIFY.md) says what removes it.
2. **The agent has no route out.** Its only network is internal. The `gate` proxy forwards to
   the domains in `gate/allowed-domains.txt` and logs the rest as refused.
3. **A system is a directory.** `systems/jira/` holds the compose service that runs the MCP
   server and the `keywork.json` fragment that points keywork at it.
   `COMPOSE_PROFILES=github,jira` in `.env` switches systems on for both compose and the agent.
4. **The box is declared from your machine.** `box init` copies values (tool versions, git
   identity, uid, the repo's GitHub name) into `boxes/<name>.env`. No file, key, or cache is
   shared.

## Make it yours

| you want | do this |
|---|---|
| your project's toolchain | `TOOLS=node@22.11 python@3.12` in `boxes/<name>.env`; `box init` proposes it from the repo |
| your devcontainer's environment | `BASE_IMAGE=` any Debian or Ubuntu based image |
| a system package | `APT_PACKAGES=postgresql-client` in `boxes/<name>.env` |
| a database or cache for your tests | the `postgres` recipe in `compose.override.example.yaml` |
| dependencies that stay in the box (faster on a Mac, safer everywhere) | the `node_modules` recipe in the same file |
| other repos as read-only context | the `/references` recipe |
| a dev server reachable from your browser | the `door` recipe |
| the agent reading web pages | add `web` to `COMPOSE_PROFILES`, after reading the note in `systems/web/compose.yaml` |
| any Bedrock model | `AGENT_MODEL=bedrock/<id>`; there is no list to maintain |
| the agent on its own clone, with nothing shared | `box init https://github.com/acme/api`, then `BOX=api box` |

## Add a system

```sh
cp -r systems/_template systems/deploys     # then replace SYSTEM with deploys in its files
```

1. `systems/deploys/compose.yaml`: the MCP server as `mcp-deploys`, profile `deploys`, alias
   `deploys.box`, listening on 8080, with its own secrets under `environment:`. It joins
   `default` so the agent can reach it and its own `deploys-out` so it can reach the real
   service.
2. Root `compose.yaml`: add `- systems/deploys/compose.yaml` under `include:`.
3. `.env.example` and your `.env`: add its variables, and add `deploys` to `COMPOSE_PROFILES`.
4. `box up && box check` reports `deploys answers on deploys.box:8080`.

| you have | do this | example |
|---|---|---|
| an image that speaks MCP over HTTP | use it directly | `systems/jira` |
| a server that only speaks stdio | wrap it with `mcp-proxy` | `systems/github`, `systems/web` |
| an internal API and no server | write a few tools with FastMCP | `systems/_template/server.py` |
| a protocol the agent's own tools speak | a small proxy that adds the credential | `git-github` in `systems/github` |

## Permissions

The agent runs with the same rules as keywork's `open` preset: it reads, writes, and runs
commands without asking, because the box is the boundary.

MCP tools ask by default. `box run` has nobody to ask, so keywork would refuse the call,
name the tool, print the rule that allows it, and exit 4. Each system's `keywork.json`
carries one rule that lets its whole server through:

```json
"permissions": [{ "action": "mcp", "resource": "deploys__*", "effect": "allow" }]
```

The entrypoint appends every enabled system's rules after the agent's base rules. Rules are
ordered and the last match wins, so to keep one tool out, add a deny after the allow:

```json
"permissions": [
  { "action": "mcp", "resource": "deploys__*", "effect": "allow" },
  { "action": "mcp", "resource": "deploys__delete_*", "effect": "deny" }
]
```

Skip `--preset` on a run: it replaces the configured permissions for that run, these rules
included.

keywork only honors MCP servers and permissions from the user config layer, which the
entrypoint rebuilds inside the container on every boot. A repo you clone cannot add a server
or loosen a rule.

## What the box protects and what it does not

`box check` proves the first three from inside the agent container.

- **Your machine.** The agent sees `/workspace` and its own home volume. It runs without root
  or Linux capabilities, and there is no Docker socket.
- **Your machine, later.** `.git/config` and `.git/hooks` are read-only inside the box, so the
  agent cannot leave behind something git would run on the host. Everything else it writes
  shows up in `git status`. Review it as you would a stranger's pull request. Files your
  `.gitignore` hides are the blind spot: the `node_modules` recipe keeps that directory inside
  the box, and a clone box removes the shared tree altogether.
- **Your code.** The agent can only reach allowlisted domains, and `git push` only reaches the
  repos in `GITHUB_REPOS`. An allowlist narrows the ways out and does not close them: a package
  registry that accepts uploads is still a registry.
- **Your credentials.** Jira and GitHub tokens never enter the agent. The AWS keys do, so use
  temporary ones (`box aws`) with a role limited to `bedrock:InvokeModel*`.

The reasoning, the threat model, and the comparison with the Claude Code and Codex sandboxes
are written up once, harness-neutral, in the `containerized-coding-agents` repo's
`docs/design.md`.
