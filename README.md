<div align="center">

# keywork

`░ ▒ ▓ █ ▓ ▒ ░`

**a coding-agent harness you play like an instrument.**

[quickstart](#quickstart) · [why keywork](#why-keywork) · [how it fits together](#how-it-fits-together) · [docs](docs/README.md) · [backlog](docs/backlog/README.md)

[![ci](https://github.com/JMoak/keywork/actions/workflows/ci.yml/badge.svg)](https://github.com/JMoak/keywork/actions/workflows/ci.yml)
[![license: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-8250df)](LICENSE.md)
[![bun](https://img.shields.io/badge/bun-1.3-f9f1e1?logo=bun&logoColor=14151a)](https://bun.sh)
[![typescript](https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![platforms](https://img.shields.io/badge/terminal-linux%20%C2%B7%20windows-2ea043)](#quickstart)

</div>

Split your terminal into panes, run an agent in each one, and fork a conversation the same
way you'd branch a repo. keywork treats driving coding agents like a game you actually get
good at: everything is on the keyboard, and the defaults look great before you've touched
a config file. What the agent is allowed to do is always on screen.

<!-- screenshot: tiled workspace (conversation + diff + session tree). launch-critical, lands with the M2 demo -->

## Why keywork

- **Everything is on the keyboard.** There's a leader key, and the palette doubles as live
  documentation, so you find things by looking instead of memorizing a cheat sheet. The
  moves you make constantly are single keystrokes. When an agent is mid-run, `Enter`
  steers it and `Alt+Enter` queues your next thought behind it.
- **Tiling is built in.** Split, rotate, zoom, focus. No tmux underneath, and Windows gets
  the real thing instead of an afterthought. Every pane is a live view onto the same event
  stream, whether it's showing the conversation, your files, the session tree, or MCP
  status.
- **Conversations fork.** A session is a JSONL tree. Branch an idea, label it, and if it
  fizzles, walk back and try again from the good part. File edits get git-snapshot `/undo`
  and `/redo`, so a bad agent turn costs you a keystroke instead of an afternoon.
- **You can see what it's allowed to do.** The trust level sits in the status line at all
  times, and one key moves it up or down. Rules are glob-scoped allow/ask/deny, per agent.
  The whole gate is itself an extension, so if you know better, swap it out.
- **The core stays small.** Four tools (`read`, `write`, `edit`, `bash`), a session engine,
  an event bus. That's it. Permissions, modes, theming, and code intelligence all ship as
  default-on extensions you can turn off or replace.
- **MCP doesn't eat your context.** Servers register tool names only, and full schemas load
  when a tool actually gets called. An idle server costs you basically nothing.
- **Zero config until you want config.** It looks good out of the box and follows your
  system theme. When you outgrow the defaults there's exactly one typed config file, and
  every new option we add has to justify its existence in writing before it lands.

## Quickstart

One line, nothing else to install:

```sh
curl -fsSL https://raw.githubusercontent.com/JMoak/keywork/main/scripts/install.sh | sh    # Linux · macOS
irm https://raw.githubusercontent.com/JMoak/keywork/main/scripts/install.ps1 | iex       # Windows
keywork
```

Every release ships a single-file binary per platform (Linux x64/arm64, Windows x64, macOS
arm64/x64) with SHA-256 checksums, and the installer verifies before it moves anything. Grab
one from the [releases page](https://github.com/JMoak/keywork/releases) by hand if you'd
rather; `keywork --version` tells you what you've got.

From source instead (needs [Bun](https://bun.sh) 1.3+):

```sh
git clone https://github.com/JMoak/keywork
cd keywork
bun install
bun link --cwd packages/cli
keywork
```

The first run walks you through hooking up a model provider, and `keywork setup` reruns it
whenever. It's plain API keys, nothing fancier:

```
KEYWORK_OPENROUTER_API_KEY or OPENROUTER_API_KEY         OpenRouter (one key, hundreds of models)
KEYWORK_OPENAI_API_KEY or OPENAI_API_KEY                 OpenAI (or any compatible endpoint)
AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION   Amazon Bedrock
```

Then:

```sh
keywork                       # tiled multi-session workspace
keywork run "fix the tests"   # one-shot headless run (--json for scripts and CI)
keywork sessions tree         # inspect and fork session trees
keywork trust                 # grant this workspace the next rung of trust
```

## How it fits together

Underneath, keywork is a headless engine that emits typed events on an internal bus, and
everything you see on screen is a subscriber. The TUI owns the tiling, and each pane
renders its own slice of the stream. We shaped the bus like a server API on purpose:
`keywork run --json` in a CI script rides the exact same events as the full workspace, and
when a real HTTP/SSE surface lands it will just wrap the bus that already exists.

Sessions land on disk as plain JSONL trees you can read with your own eyes, in a format
compatible with [Pi](https://github.com/earendil-works/pi)'s tooling. Grep them, diff
them, pipe them through whatever you already have.

## Status

keywork is under heavy construction and hasn't had its public launch yet. The workspace,
the engine, session trees, the trust gate, and the MCP host all work today and all have
tests behind them. Code intelligence and the memory system are in flight, and more
providers are coming. Nothing gets called done around here until `bun run check && bun
test` are green and the acceptance criteria in [`docs/backlog/`](docs/backlog/) are met.

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/vision.md`](docs/vision.md) | The ten binding design decisions (D1–D10) |
| [`docs/design-language.md`](docs/design-language.md) | The visual vocabulary: the `░▒▓█` density ramp, motion, the status line |
| [`docs/modes.md`](docs/modes.md) | Plan · Recall · Agent modes |
| [`docs/backlog/`](docs/backlog/README.md) | The canonical task list, in execution order |
| [`docs/README.md`](docs/README.md) | The research behind it all, and what we took from each influence |

## Development

```sh
bun install
bun run check   # types, dependency pins, guardrails, lint
bun test        # vitest
```

TypeScript is strict everywhere and dependencies are pinned exact. The code is written to
read top-down without needing comments, and if a change ships without tests it didn't
happen. [`AGENTS.md`](AGENTS.md) has the full conventions, and they apply to humans and
agents equally.

## Attribution & license

keywork borrows gratefully from two MIT projects,
[Pi](https://github.com/earendil-works/pi) and
[OpenCode](https://github.com/sst/opencode), and every adapted piece is credited in
[`NOTICE`](NOTICE). Anthropic models connect through an API key and the Agent SDK, and
that is the only way they ever will.

The license is [FSL-1.1-MIT](LICENSE.md): use it for anything short of building a
competitor, and each release converts to plain MIT after two years.
