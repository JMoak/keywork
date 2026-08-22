# keywork headless contract

> The stable surface scripts and CI depend on: `keywork run` exit codes, the `--json` event
> stream, and what every command does without a terminal. Decided in
> [`backlog/108-survivability-and-launch-rail.md`](backlog/108-survivability-and-launch-rail.md)
> (A20, on top of 103's A20 and 105's IR-18). Golden fixtures live in
> `packages/cli/src/fixtures/headless/`, one per exit class; `run.test.ts` keeps them honest.

## `keywork run "<prompt>" [--json] [--preset <name>] [--model <ref>] [--session-dir <dir>] [--debug]`

Runs one session to completion and mounts nothing else: no server, no TUI, no panes.
Plain mode prints the final assistant message to stdout and everything else to stderr.
`--json` prints one JSON object per line to stdout and nothing else.

### Exit codes

| code | class | when |
|---:|---|---|
| 0 | `completed` | the turn reached `turn.completed`. Content that reports inability is still 0: exit codes describe the harness, never the model's self-report. |
| 1 | `failed` | the turn ended in `engine.error`: provider failure after retries, tool-loop abort, internal error. |
| 2 | `usage` | bad invocation: no prompt, unknown command or preset, or `panes` / `chat` / bare `keywork` without a terminal. |
| 3 | `unresolved` | inference resolution failed. The IR-18 `code` (`unconfigured` · `ambiguous` · `unknown-provider` · `unknown-model` · `disabled-provider` · `unavailable-credential` · `unsupported-protocol` · `missing-capability` · `insecure-endpoint`) rides in the payload. |
| 4 | `denied` | a tool call needed an approval nobody could give. The turn still ran to its end with that call refused; stderr names the tools and the fix. |
| 130 | `interrupted` | SIGINT or SIGTERM arrived mid-turn. The agent was interrupted and orphaned tool calls were settled; the session was persisted only when `--session-dir` was given (the `run.finished` line carries `saved`). |

### Permissions without a person

A headless run has no one to ask, so any tool call the active policy would *ask* about is
refused and recorded as a `gate.permission` with `gate: "headless"`. Your configured preset
still applies (`careful` · `standard` · `open`); to let a script mutate, say so for that run:

```sh
keywork run "fix the failing tests" --preset open --json
```

`--preset` is run-scoped and never persisted. Explicit `deny` rules are not asks: a policy
denial is a normal refused result and the run can still exit 0.

### The `--json` stream

Every line is a JSON object with a `type`. A bound run opens with `run.started`; every
invocation ends with exactly one `run.finished` carrying `outcome` and `exitCode`.

| event | payload |
|---|---|
| `run.started` | `cwd`, `provider`, `model` (string or `null`), `session` (id or `null` without `--session-dir`) |
| `turn.started` | `userText` |
| `turn.delta` | `delta`: `{type:"text", text}` · `{type:"tool-call", call}` · `{type:"redacted-thinking", part}` · `{type:"done", usage}` |
| `tool.started` | `call` (`callId`, `name`, `arguments`) |
| `tool.output` | `chunk`, optional `callId` |
| `tool.finished` | `callId`, `output`, `isError` |
| `gate.permission` | `decision`: `tool`, `callId`, `verdict` (`granted` · `denied`), `gate` (`policy` · `default` · `user` · `headless`) |
| `context.injected` | `injection`: `source` (`project-instructions` · `memory-bootstrap` · `memory-recall` · `skill` · `subagent`), optional `id`, `scope` |
| `turn.completed` | `message`, `usage` |
| `turn.interrupted` | `message` |
| `engine.error` | `message` |
| `run.finished` | `outcome`, `exitCode`, plus `message` (completed · denied · interrupted), `refused` (denied: `[{tool, callId}]`), `error` (failed · usage), or `failure` (unresolved: the typed IR-18 object) |

Bus events ride under their bus names with their bus payloads, so a CI script reads the
same events a pane does. The same events land in the session JSONL as Pi-compatible
`custom` entries (`permission_decision`, `context_injection`, …), so replay, the sessions
tree, and the stream agree.

Example (`completed`):

```jsonl
{"type":"run.started","cwd":"/work","provider":"openrouter","model":"qwen/qwen3","session":null}
{"type":"turn.started","userText":"hi"}
{"type":"turn.delta","delta":{"type":"text","text":"all done"}}
{"type":"turn.delta","delta":{"type":"done","usage":{"inputTokens":12,"outputTokens":3}}}
{"type":"turn.completed","message":{"role":"assistant","parts":[{"type":"text","text":"all done"}]},"usage":{"inputTokens":12,"outputTokens":3}}
{"type":"run.finished","outcome":"completed","exitCode":0,"message":"all done"}
```

## Without a terminal

`keywork` decides by whether both stdin and stdout are TTYs. The table is
`withoutTerminal` in `packages/cli/src/dispatch.ts`.

| command | without a terminal |
|---|---|
| `keywork` (bare) | refused, exit 2: no command given and no terminal attached |
| `panes` | refused, exit 2: panes needs a terminal |
| `chat` | refused, exit 2: chat needs a terminal |
| `run` | runs; `--json` streams one event per line |
| `sessions` | runs; fork cleanup confirmations are skipped, never assumed |
| `connect` / `setup` | runs; answers are read line by line from stdin |
| `init` / `link` | runs; confirmations are skipped, never assumed |
| `trust` / `untrust` / `doctor` / `help` / `--version` | run |
