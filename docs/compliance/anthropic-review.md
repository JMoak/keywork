# Anthropic Guardrail Review (G2)

> The hard guardrail of record ([`../vision.md`](../vision.md), [`../../AGENTS.md`](../../AGENTS.md)):
> Anthropic is **API-key / Agent-SDK only**. No subscription-OAuth of any kind, no Claude Code
> client impersonation, no ported login flows. This checklist is executed against every diff
> that touches the Anthropic provider, and the result is recorded here. G1 does not ship
> without it.

## Scope of the reviewed diff (2026-09-03, G1 landing)

| File | Role |
|---|---|
| `packages/engine/src/providers/anthropic.ts` | `AnthropicProvider`: `POST <endpoint>/messages`, SSE assembly, `anthropicHeaders`, `anthropicVersion` |
| `packages/engine/src/providers/messages-wire.ts` | neutral format to Messages API request mapping |
| `packages/engine/src/inference/{types,adapters}.ts` | `anthropic-messages` protocol; API-key-only material rule |
| `packages/cli/src/inference/{builtins,connections,runtime}.ts` | the `anthropic` built-in, `/connect` target, verification headers |
| `packages/engine/src/pricing.ts` | Claude rate rows |
| `packages/shared/src/config/schema.ts` | `connections.<name>.protocol` accepts `anthropic-messages` |
| `scripts/guardrail-patterns.json` | three new deny patterns (see below) |

## Checklist

Every box is checked with the command that proves it and the result observed on the diff.

- [x] **Zero OAuth code paths for Anthropic.** No authorize URL, token exchange, refresh, PKCE,
  device code, or callback listener exists anywhere under the provider or its wiring.
  Evidence: `rg -i "oauth|pkce|code_verifier|refresh_token|authorize" packages/engine/src/providers/anthropic.ts packages/engine/src/providers/messages-wire.ts` returns nothing.
  In `adapters.ts` the only credential kind the protocol accepts is `api-key`; `bearer`
  material (the Codex sign-in shape) is refused by construction with
  `anthropic-messages authenticates with an API key and nothing else`
  (test: `adapters.test.ts` "refuses bearer material for anthropic-messages").
- [x] **Zero subscription endpoints or client-ID spoofing.** The only Anthropic host in the
  tree is `https://api.anthropic.com/v1` (`builtins.ts`), and the only paths appended are
  `/messages` and `/models`. Evidence: `rg "anthropic\.com|claude\.ai|claude\.com" packages/`
  lists `api.anthropic.com/v1` and the console key page `platform.claude.com/settings/keys`
  and nothing else. No client id constant exists; `check:guardrails` denies the known Claude
  Code client id, the `claude.ai` and `console.anthropic.com` OAuth routes, the OAuth token
  endpoint path, and OAuth token prefixes on every file in the tree.
- [x] **No headers imitating Claude Code.** The provider sends exactly `content-type`,
  `accept`, `anthropic-version: 2023-06-01`, `x-api-key`, plus any registration decorations
  the user configured. No `user-agent`, no `x-app`, no `anthropic-beta`. Evidence:
  `anthropic.test.ts` "sends the key as x-api-key beside the pinned version header, never as
  a bearer token" asserts the header set; `check:guardrails` denies `x-app: cli`,
  Claude Code user agents, both Claude Code identifier spellings, and (new in this
  review) the `claude-code-<date>` beta header, the `oauth-<date>` beta header, and a
  bearer token built from an Anthropic key.
- [x] **Key handling is never logged.** The key lives in one private field and is read only
  when the request headers are built. It is never interpolated into an error: HTTP failures
  carry the server body and status (`transport.ts`), stream failures carry the server's
  error type and message. Evidence: `anthropic.test.ts` "never lets the key into an HTTP
  failure" asserts the key is absent from `String(error)`, `JSON.stringify(error)` and the
  stack after a 401 whose body names `x-api-key`; `diagnostics.test.ts` "scrubs
  anthropic-shaped keys wherever they appear" proves the diagnostics redactor catches the
  `sk-ant-` shape; the memory redactor's `sk-` shape rule already covered persistence.
- [x] **Credential precedence is the deliberate-source rule, unchanged.** `KEYWORK_ANTHROPIC_API_KEY`
  outranks the saved key, which outranks ambient `ANTHROPIC_API_KEY`, and an empty value
  counts as absent. Evidence: `runtime.test.ts` "registers anthropic from an API key only".
- [x] **`/connect` verifies with the same headers the provider sends.** The targets screen
  gains `Anthropic` as an API-key target; verification hits `GET /v1/models` with `x-api-key`
  and `anthropic-version` and no bearer header. Evidence: `connections.test.ts` "verifies the
  anthropic target with x-api-key and the version header, never a bearer token".
- [x] **User docs state the API-key-only policy.** `README.md` (environment table and the
  attribution paragraph), `docs/vision.md`, `docs/backlog/README.md`, `AGENTS.md`, and
  [`../live-smoke/anthropic.md`](../live-smoke/anthropic.md) all say it in the present tense.
- [x] **No influencer code.** `messages-wire.ts` and `anthropic.ts` were written from the
  public Messages API documentation (streaming, thinking, prompt caching, versioning pages,
  read 2026-09-03). `NOTICE` is untouched because nothing was adapted.
- [x] **CI guard strengthened, nothing weakened.** `scripts/guardrail-patterns.json` gains
  `claude-code-beta-header`, `oauth-beta-header`, and `bearer-anthropic-key`, each with a
  `flagged` sample that `scripts/checks.test.ts` proves is caught, plus one `allowed` sample
  (`x-api-key` beside `anthropic-version`) that proves the legitimate header pair passes.
  Existing patterns are byte-identical. `bun run check:guardrails` is green on the tree.

## Re-run 2026-09-06 (G4 visible thinking)

Diff scope: `packages/engine/src/providers/anthropic.ts` (a `thinking_delta` now also yields a
display-only `visible-thinking` delta), `packages/engine/src/providers/messages-wire.ts` (a
`thinking` request field added only when the request opts in), `messages.ts` / `provider.ts`
(the new part and delta), plus session, schema, and TUI files that never touch the wire.

- [x] **Zero OAuth code paths.** The G1 scan above, re-run over `anthropic.ts` and
  `messages-wire.ts`, still returns nothing.
- [x] **Zero subscription endpoints or client-ID spoofing.** `rg "anthropic\.com|claude\.ai|claude\.com" packages/`
  still lists only `api.anthropic.com/v1` and the console key page in `builtins.ts`.
- [x] **No headers imitating Claude Code.** The header set is untouched; the only request change is
  a body field (`thinking`), asserted absent by default in `anthropic.test.ts` "asks for
  thinking only when the request opts in and leaves the default body byte-identical". No
  `anthropic-beta` header was added (the `display: "updates"` beta was deliberately not used).
- [x] **Key handling is never logged.** No new code path reads the key; the 401 test still passes.
- [x] **Credential precedence, `/connect`, user docs, influencer code.** Unchanged by this diff;
  `NOTICE` untouched.
- [x] **CI guard.** `scripts/guardrail-patterns.json` untouched; the pattern self-tests in
  `scripts/checks.test.ts` pass. `bun run check:guardrails` reports no violations (run with
  `BUN_JSC_useRegExpJIT=false` on the reviewing machine, whose Bun 1.3.9 crashes in the
  regex JIT mid-scan; the repo pins Bun 1.3.14).

## Re-run 2026-10-02 (117 SW2 to SW6: the 5.5 generation, effort, tool search, progress, cache reasons)

Diff scope: `packages/engine/src/providers/anthropic.ts` (an `anthropic-beta` header computed from
the model, a 128k default `max_tokens` for the wide-output models, progress-update blocks, the
response id and `diagnostics` read off `message_start`), `packages/engine/src/providers/messages-wire.ts`
(`output_config.effort`, effort-only and `tool_addition` system messages in place, `thinking.display:
"updates"` while thinking is hidden, `diagnostics.previous_message_id`), the new
`packages/engine/src/providers/claude-models.ts` (one generation table for every feature cut),
plus `provider.ts`, `agent.ts`, `request-marks.ts`, pricing, session, and TUI files that never
touch the wire.

- [x] **Zero OAuth code paths.** The G1 scan, re-run over `anthropic.ts`, `messages-wire.ts`, and
  `claude-models.ts`, returns nothing.
- [x] **Zero subscription endpoints or client-ID spoofing.** No host or path changed; the only
  appended path is still `/messages`.
- [x] **No headers imitating Claude Code.** Reworded per decision 117-1: the provider sends
  `content-type`, `accept`, `anthropic-version: 2023-06-01`, `x-api-key`, registration
  decorations, and, on models that take them, one `anthropic-beta` header naming public Messages
  API feature betas and nothing else. No `user-agent`, no `x-app`. The header is a function of
  the model id only (the set never changes inside a conversation, so it never costs a cache
  miss), and the full list of betas keywork sends is:
  - `inline-tools-2026-09-15` (tool definitions inside `tool_addition` blocks): Claude Opus 4.8
    and later Opus, Sonnet 5.5, Fable 5.1, Mythos 5.1.
  - `mid-conversation-output-config-2026-07-01` (per-message effort): Opus 5 and later Opus,
    Sonnet 5.5, Fable 5.1, Mythos 5.1.
  - `thinking-display-updates-2026-08-18` (progress updates while thinking is hidden): Opus 5.5,
    Sonnet 5.5, Fable 5 and later, Mythos 5.1.
  `compact-2026-09-04` is allowed by 117-1 and not sent: nothing in this diff uses it. Haiku 4.5,
  Sonnet 4.6 and earlier, Sonnet 5, and unrecognised ids get no beta header at all. Evidence:
  `anthropic.test.ts` "sends the public feature betas as one stable header and opens the 128k
  ceiling" (exact header string, no `authorization`), "sends no beta header to a model that needs
  none"; `claude-models.test.ts` "names only the public feature betas decision 117-1 allows".
  `check:guardrails` still denies the `claude-code-<date>` and `oauth-<date>` betas; the patterns
  are byte-identical.
- [x] **Key handling is never logged.** No new code path reads the key; the 401 test still passes.
- [x] **No forced `tool_choice`, no `budget_tokens` on the 5.5 generation.** keywork never sends
  `tool_choice`; thinking on a model with adaptive thinking is `{type: "adaptive"}` only.
  Evidence: `messages-wire.test.ts` "never sends a forced tool_choice or a thinking budget to a
  5.5-generation id" (Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1, thinking on and off, effort
  set and changed).
- [x] **Credential precedence, `/connect`, user docs, influencer code.** Unchanged; `NOTICE`
  untouched. Everything was written from the public effort, thinking, mid-conversation system
  messages, cache diagnostics, pricing, models, and deprecations pages (read 2026-10-02).
- [x] **CI guard.** `scripts/guardrail-patterns.json` untouched; `bun run check:guardrails` green.
- [ ] **Live smoke on a post-2026-08-31 key.** Not run (no key in the lane). The tool-search
  turn on Opus 5.5 in [`../live-smoke/anthropic.md`](../live-smoke/anthropic.md) step 6 is what
  proves or disproves the prefix-binding 400; the mock tests prove the wire shape only.

## Deviation of record

The overlay named the official `@anthropic-ai/sdk`. The landed provider uses keywork's own
transport (`postForStream`, `sseJsonEvents`, `RetryingProvider`) instead, for one retry story,
one redaction story, one `fetchFn` seam for fixtures, and no new dependency to pin. The SDK
remains an option; nothing in the guardrail depends on which one is used. Details in
[`../backlog/70-anthropic.md`](../backlog/70-anthropic.md).

## Sign-off

Reviewer of record: Jordan Moak.

- [ ] Reviewed and signed: ______________________ (date)
