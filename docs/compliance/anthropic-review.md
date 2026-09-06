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

## Deviation of record

The overlay named the official `@anthropic-ai/sdk`. The landed provider uses keywork's own
transport (`postForStream`, `sseJsonEvents`, `RetryingProvider`) instead, for one retry story,
one redaction story, one `fetchFn` seam for fixtures, and no new dependency to pin. The SDK
remains an option; nothing in the guardrail depends on which one is used. Details in
[`../backlog/70-anthropic.md`](../backlog/70-anthropic.md).

## Sign-off

Reviewer of record: Jordan Moak.

- [ ] Reviewed and signed: ______________________ (date)
