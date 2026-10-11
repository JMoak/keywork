# keywork extensions

> One TypeScript file that receives an `api` object and registers what it wants: tools the
> model can call, slash commands, hooks on the agent's lifecycle, and replayable state in the
> session. Pi's extension design, lifted with attribution (see `NOTICE`). The engine half is
> `packages/engine/src/extensions/`, the authoring surface is `packages/extensions`, and the
> ledger of decisions is [`backlog/40-extensions.md`](backlog/40-extensions.md).

## Where extensions live

| layer | directory | loads when |
|---|---|---|
| project | `<workspace>/.keywork/extensions/` | the workspace is trusted (`keywork trust` or `/init`) |
| user | `~/.keywork/extensions/` | always |

A file (`.ts`, `.js`, `.mts`, `.mjs`) or a directory with an `index.*` is one extension, named
after its stem. Activation order is deterministic: project first, then user, alphabetical inside
a layer. A project extension shadows a user extension with the same name, so a repo can pin its
own version of something you also keep at home.

**Trust rule.** The project layer follows the MCP-server posture: an untrusted workspace never
imports a project extension. `/extensions` and `keywork extensions` print the refused directory
with the reason, so a fresh clone tells you what it would load once trusted.

## Writing one

```ts
import { defineExtension } from "@keywork/extensions";

export default defineExtension((api) => {
  api.registerTool({ name: "greet", description: "...", parameters: {...}, execute: async () => "hi" });
  api.registerCommand({ name: "hello", run: (args) => `hello ${args}` });
  api.on("tool_call", ({ call }) =>
    call.name === "bash" ? { action: "deny", reason: "not here" } : undefined,
  );
  return () => api.log.info("torn down");
});
```

`defineExtension` is the identity function with the right type; a plain default-exported
function works the same. The full example at
[`examples/extensions/shell-sentry.ts`](examples/extensions/shell-sentry.ts) registers one
tool and one command, gates `bash`, and keeps its count across restarts with a replayed entry.

The `api` object:

- `api.name`, `api.source` (`project`, `user`, or `inline` in tests)
- `api.log.info|warn|error(message, detail?)` rides the `extension.notice` bus event
- `api.on(hook, handler)` returns an unsubscribe
- `api.registerTool(tool)`: reaches the model's tool list through the agent's hooks seam. A name
  that clashes with a core tool or with another extension quarantines the registrant.
- `api.registerCommand({ name, description?, run })`: `/name` in panes and in `keywork chat`;
  a string returned from `run` is printed into the focused pane's feed
- `api.registerShortcut`, `api.registerFlag`: collected and listed, consumed by nothing yet
- `api.appendEntry(type, data?)`: writes one replayable entry into the session (below)

## Hooks: wired and typed-only

Thirty hooks are typed end to end in `Hooks` (`packages/engine/src/extensions/hooks.ts`), and
`api.on` infers payload and result per name. Nine are **wired** today and fire from the host:

| hook | fires |
|---|---|
| `session_start` / `session_end` | per session, with `reason` and `sessionId` |
| `turn_start` / `turn_end` | from `turn.started`, `turn.completed`, `turn.interrupted` (replays skipped) |
| `message_appended` | every message that enters the agent's history |
| `tool_call` | before the trust gate: return `{ action: "allow" }`, `{ action: "deny", reason }` or `{ action: "modify", arguments }`; extensions run in load order, the first deny wins and names its extension in the refused tool result, modifications chain |
| `tool_result` | after each tool finishes, with the call paired by id |
| `context` | return a string to append a fragment to the system prompt on every provider request |
| `custom_entry` | your own entries, live and on replay |

The other twenty-one (`session_before_fork`, `before_provider_request`, `model_select`,
`user_bash`, ...) are **typed only**: you can subscribe, nothing delivers yet. `wiredHooks` and
`typedOnlyHooks` are the exported lists, and a type-level check keeps every hook in exactly one.

## Containment and quarantine

An extension that throws or rejects, in activation, in any hook handler, in a command, or in
teardown, is **quarantined**: its tools, commands, shortcuts, flags and handlers are withdrawn,
later `api` calls go inert, and every other extension keeps running. A handler that outlives the
hook deadline (10s) is quarantined the same way. A module that fails to import (syntax error, no
default function) is quarantined in phase `load`. Quarantine is per process: fix the file and
restart (`/reload` is D4 in the backlog).

The bus carries an `extension.notice` for every quarantine and every `api.log` line
([`events.md`](events.md)). Where you see them:

- **panes**: `error` and `warn` land on the status bar as `<extension>: <message>`; `info` goes
  into the focused conversation's feed and is dropped when no pane is open. Load-time
  quarantines are summarized on the status bar at startup.
- **`keywork chat`**: `warn` and above on stderr, `info` as a quiet line.
- **`keywork run`**: `warn` and above on stderr as `keywork run: <extension>: <message>`;
  `info` is never printed.

`/extensions` in panes or chat, and `keywork extensions` from the shell, list every extension
with its layer, standing (`active`, `quarantined`, `deactivated`), the phase and reason when
quarantined, and how many tools and commands it registered.

## Replayable state

`api.appendEntry(type, data)` writes one `custom` session entry (`customType: "extension"`,
payload `{ extension, type, data }`) and then delivers `custom_entry` with `replay: false` to
the owning extension. On resume the host walks the session's active path and redelivers that
extension's entries with `replay: true` before `session_start` fires, so state rebuilds through
the same handler and side effects key off the flag. Entries on other branches, and entries owned
by other extensions, are never delivered.

## Per-session semantics

One host runs per workspace and sees every session pane. Sessions are tracked individually:

- `session_start` fires when a session attaches (reason `start` for a fresh one, `resume` when
  it already holds messages) and `session_end` when it is released (`switch`) or keywork exits
  (`exit`); both carry the `sessionId`.
- `appendEntry` targets the session whose turn is being handled. A hook dispatched from a
  turn, a tool call, a message or a replay is bound to that session's store. Outside any turn
  the entry goes to the sole open session, and with several open and none in flight it is
  dropped with a `warn` notice naming why.
- Replay on resume is per session as well: resuming session A redelivers only A's entries.

Your in-memory variables are per extension, not per session. If you track something per
session, key it by the `sessionId` you receive in `session_start` and in your own entries.

## Bots

A bot with a `tools:` allowlist sees only the allowed tools, extension tools included. An
extension tool reaches a bot only when the bot names it.
