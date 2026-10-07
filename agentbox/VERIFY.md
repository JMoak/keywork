# First-boot checklist

agentbox was written against keywork's source and each upstream's documentation. It has not
been booted, and Docker was not available where it was written, so `docker compose config` has
not parsed these files either. Work down this list once; delete each line as it passes, and
delete this file and the README banner when the list is empty. Lines marked **check** are
asserted by `box check`, so one command settles them.

## The launcher

- [ ] `box` on macOS and Linux shells (`sh`, not bash): `box init` inside a repo writes the
      path, uid, gid, git identity, `GITHUB_REPOS`, and a `TOOLS` line that matches the repo.
      The alias and a symlink both resolve the script's home. It has only run under Git Bash
      against a fake `docker`.
- [ ] Two `--env-file` flags: the box file overrides `.env`, and `COMPOSE_PROFILES` from `.env`
      still applies. `-p box-<name>` lets two boxes run side by side.
- [ ] `box aws` parses `aws configure export-credentials --format env-no-export` and recreates
      the agent with the new keys.
- [ ] `box denied` matches tinyproxy's refusal line (`filtered domain "..."`).

## Build

- [ ] `box config` accepts the model: included system files that join `default` with an alias
      and declare their own `<name>-out` network, next to a root file that marks `default` as
      `internal`.
- [ ] `box up` builds `agent`, `gate`, and `mcp-github`.
- [ ] `scripts/install.sh` runs as root with `KEYWORK_INSTALL_DIR=/usr/local/bin`, a release
      asset exists for the container's architecture, and the `harness` symlink runs keywork.
- [ ] mise honors `MISE_VERSION`, `MISE_INSTALL_PATH`, and `MISE_GLOBAL_CONFIG_FILE`, and
      `box check` lists the tools from `TOOLS`.
- [ ] `groupadd --non-unique` works with a Mac gid such as 20, and with a `BASE_IMAGE` that
      already has a uid 1000 user.

## The gate

- [ ] **check** An allowlisted domain is reachable, any other is refused, and there is no route
      around the gate. The last one is the real enforcement: the agent's network has no route
      out, not even for DNS.
- [ ] tinyproxy applies `FilterDefaultDeny` to `CONNECT` hosts and logs to stdout as its own
      user. `box logs gate` shows the allowed and the refused request.
- [ ] keywork is a Bun binary: its `fetch` honors `HTTPS_PROXY` for Bedrock and the `.box`
      suffix in `NO_PROXY` for MCP servers. A Bedrock turn streams through the gate.

## Boot

- [ ] `box exec agent cat /home/dev/.keywork/keywork.json` shows the merged config and
      `box exec agent keywork doctor` accepts it.
- [ ] **check** `/workspace` is writable, and files the agent creates are owned by you on a
      Linux host.
- [ ] The trust store, sessions, and caches live under `/home/dev` and survive
      `box down && box up`. The home volume picks up `dev` ownership on first mount.
- [ ] **check** `.git/config` and `.git/hooks` are read-only inside the box, on Docker Desktop
      for Mac and on Linux, while `git commit` still works.
- [ ] The `node_modules` and `.venv` volume recipe takes `dev` ownership from the directories
      the image pre-creates. `HUSKY=0` and `LEFTHOOK=0` keep `npm install` green in a repo
      that installs hooks from a `prepare` script.

## Systems

- [ ] **check** Every enabled system answers on `<name>.box:8080`, and git reaches origin
      through the broker with no token in the agent.
- [ ] `github-mcp-server` lives at `/server/github-mcp-server` in its image and runs on the
      `mcp-proxy` base image, which serves streamable HTTP at `/mcp`. `mcp-server-fetch`
      installs into the same base for `systems/web`.
- [ ] `mcp-atlassian` listens on all interfaces without a `--host` flag.
- [ ] Both servers show as connected in keywork's MCP pane and list tools.
- [ ] `git push origin HEAD` reaches a repo in `GITHUB_REPOS`, and a push to any other repo is
      refused with `pushes are limited to GITHUB_REPOS`. This covers the Caddy `expression`
      matcher syntax and `{$GITHUB_REPOS}` inside `path_regexp`.
- [ ] git honors the `insteadOf` rewrites from the included `gitconfig` for HTTPS and SSH
      style remotes.
- [ ] The template builds and serves (`uv sync --script`, FastMCP 4 `mcp.run` signature).

## A real turn

- [ ] **check** The environment holds no secret besides the known AWS gap below.
- [ ] A Bedrock turn completes with static keys, and again with credentials from `box aws`.
- [ ] `box run` calls any tool of an enabled system through its `<system>__*` rule, and
      the model gets a refusal for one that a later deny rule covers.
- [ ] The merged `keywork.json` lists the base rules first, then each enabled system's rule.
- [ ] A clone box (`box init https://github.com/acme/api`, then `BOX=api box up`) clones
      through the git broker, and a full run never touches your filesystem.

## Known gap: AWS keys in the agent

Every other credential lives in a broker. Bedrock cannot yet, because keywork derives the
Bedrock endpoint from the region alone and will not talk to a signing proxy.
[`docs/backlog/116-agentbox.md`](../docs/backlog/116-agentbox.md) AB1 is the task that closes
it. Until then: temporary credentials from `box aws`, a role limited to
`bedrock:InvokeModel*`, and the gate allows `bedrock-runtime.<region>.amazonaws.com` and no
other AWS host.
