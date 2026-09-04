# Workstream G: Anthropic Provider (late, gated)

> Deliberately last among providers, per the standing guardrail: **API-key / Agent-SDK only.**
> No subscription-OAuth, no Claude Code client impersonation, no ported login flows from any
> influencer. G2's review is a hard gate; G1 does not ship without it.

---

### G1 (2pt): Anthropic provider via official SDK
Adapter on the A1/A2 abstractions using the official `@anthropic-ai/sdk`: Messages API
streaming, tool use, usage extraction (incl. cache tokens), key from `ANTHROPIC_API_KEY` /
config only; prompt-caching support where the abstraction allows.
**Accept:** recorded-fixture tests; live smoke doc; model switching between Anthropic and
A14 providers mid-session works via the neutral message format.
**Strategy:** `OWN` against the official SDK. Nothing adapted from any influencer's Anthropic
code.

### G2 (1pt): Guardrail compliance review
Written checklist executed against the diff: zero OAuth code paths, zero references to
subscription endpoints/client-ID spoofing, no headers imitating Claude Code, key handling
never logged, docs state the API-key-only policy for users. Result recorded in
`docs/compliance/anthropic-review.md` with reviewer sign-off (the user).
**Accept:** checklist committed with all boxes checked and a grep-based CI guard (deny-listed
endpoint/header patterns) added so regressions fail CI.
**Strategy:** `OWN`.

---

## Ledger

### G1 + G2 · landed 2026-09-03 (uncommitted)

Built in the same round as the bots lane (106), from `24b83ee`, touching only provider,
inference, pricing, CLI-inference, shared-schema, and guardrail files.

- **`anthropic-messages` is the fourth protocol.** `Protocol` / `protocols` / `httpProtocols`
  in `engine/src/inference/types.ts` gain it, so the loopback-or-HTTPS transport rule (IR-17)
  and `register()` validation apply unchanged; `connections.<name>.protocol` accepts it in the
  shared schema (`connectionProtocols` exported beside the enum) so an Anthropic-compatible
  proxy is one hand-written registration, exactly as IR-15 intends.
- **`AnthropicProvider`** (`engine/src/providers/anthropic.ts`, `OWN`): `POST <endpoint>/messages`
  through the repo's `postForStream` + `sseJsonEvents`, headers `x-api-key` +
  `anthropic-version: 2023-06-01` (pinned constant) + `accept: text/event-stream`. The stream
  assembler yields text deltas live, completes each `tool_use` block at its
  `content_block_stop` (a new `ToolCallAssembler.take(index)` keeps block order exact), and
  carries every `thinking` / `redacted_thinking` block as a `redacted-thinking` part owned by
  `{provider, model}`, the same shape the Responses provider uses for encrypted reasoning.
  Usage merges `message_start` (input, cache creation, cache read) with the cumulative
  `message_delta` output count into the neutral `Usage`. Stop reasons `max_tokens` and
  `model_context_window_exceeded` fail the turn as `response cut off (<reason>)` (mirroring the
  Responses `incomplete` rule); `refusal` fails it too rather than posting an empty success;
  in-stream `error` events become `AnthropicApiError`, transient for `overloaded_error` /
  `api_error` / `rate_limit_error` so `RetryingProvider` retries them before any delta was
  shown. HTTP 429 / 529 / 5xx retry through the existing `retry-after` path.
- **`messages-wire.ts`** (`OWN`): system prompt plus system-role messages fold into one
  `system` string; user text and base64 images map to blocks; tool results ride in `user`
  turns as `tool_result` (with `is_error`); adjacent same-role turns merge; a non-object
  tool input left behind by another provider is sent as `{}` rather than rejected by the API.
  Prompt caching uses the top-level automatic `cache_control: {type: "ephemeral"}` (one
  breakpoint that walks forward as the conversation grows; documented as supported on every
  active model), not per-block breakpoints. `max_tokens` defaults to 32,000 and a
  registration's `decorations.body.max_tokens` overrides it.
- **Thinking replay policy.** Owned thinking blocks are replayed only inside the current turn
  (assistant messages after the last `user`-role message, i.e. the live tool loop), unchanged
  and in order, which is what the API requires for tool use; earlier turns' thinking is dropped
  (documented as allowed outside tool use). Reason: on Claude Fable 5.1 the block signature is
  bound to the exact conversation prefix, and B7 compaction rewrites that prefix, so replaying
  older blocks would 400 on new accounts. Another model's blocks are never sent (IR-13).
- **Registration and surfaces.** Built-in `anthropic` (`cli/src/inference/builtins.ts`):
  `https://api.anthropic.com/v1`, default model `claude-haiku-4-5`, credential precedence
  `KEYWORK_ANTHROPIC_API_KEY` › saved key › `ANTHROPIC_API_KEY`, key page
  `platform.claude.com/settings/keys`. `adapters.ts` builds the provider from `api-key`
  material only and refuses `bearer` / SigV4 material by construction. `/connect` lists
  `Anthropic` as an API-key target (derived from the built-ins, no TUI change), verifies with
  `GET /v1/models` under `x-api-key` + `anthropic-version` (protocol-aware headers in
  `connections.ts`), and a saved row drafts back with its true protocol instead of the old
  chat-or-responses narrowing. The unconfigured hint names `KEYWORK_ANTHROPIC_API_KEY`.
- **Pricing** (`pricing.ts`, from `platform.claude.com/docs/en/about-claude/pricing`, read
  2026-09-03): `claude-fable-5-1` 10 / 50, cache write 12.50, cache read 0.25; `claude-fable-5`
  10 / 50 / 12.50 / 1; `claude-opus-5`, `-4-8`, `-4-7`, `-4-6`, `-4-5` 5 / 25 / 6.25 / 0.50;
  `claude-sonnet-5` 2 / 10 / 2.50 / 0.20; `claude-sonnet-4-6`, `-4-5` 3 / 15 / 3.75 / 0.30;
  `claude-haiku-4-5` 1 / 5 / 1.25 / 0.10 (USD per million tokens). `canonicalModelId` now also
  strips the `anthropic.` Bedrock vendor prefix and the dash-less `-YYYYMMDD` snapshot suffix.
- **G2.** `docs/compliance/anthropic-review.md` executed with evidence per box; sign-off line
  left for Jordan. `scripts/guardrail-patterns.json` gains `claude-code-beta-header`,
  `oauth-beta-header`, `bearer-anthropic-key` (each self-tested through `checks.test.ts`)
  and one `allowed` sample for the legitimate `x-api-key` + `anthropic-version` pair; no
  existing pattern changed. `README.md`, `docs/vision.md`, `docs/backlog/README.md`,
  `AGENTS.md` now state the posture in the present tense; `docs/live-smoke/anthropic.md`
  is the manual check with a real key.
- **Evidence.** `anthropic.test.ts` (block-ordered assembly with thinking + tool use + cache
  usage, header set, decorated `max_tokens`, cut-off, refusal, transient overload, 401 with the
  key provably absent from the error, current-turn-only thinking replay), `messages-wire.test.ts`
  (system folding, images, tool results and merging, input guard, empty parts, tools, and the
  mid-session switch: the same transcript rendered for chat-completions, Responses, and a
  different Claude model, with no owned state leaking), `adapters.test.ts` (transport build,
  bearer refusal), `runtime.test.ts`, `connections.test.ts`, `port.test.ts`, `pricing.test.ts`,
  `diagnostics.test.ts` (`sk-ant-` redaction), `checks.test.ts` (pattern self-tests).

**Gate (lane-run, 2026-09-03):** `check:guardrails` ok, `check:prose` ok, `check:pins` ok,
biome clean on every file this lane touched, `tsc --build` clean on every file this lane
touched, vitest 26 files / 309 tests green across the provider, inference, pricing,
diagnostics, CLI-inference and scripts areas; the full suite ran 3259 passed / 1 skipped
with 9 failures all inside the bots lane's in-progress `agents → bots` rename
(`cli/src/{chat,commands,compose,compose-panes}.test.ts`), none in this lane's files.

### Deviations of record (decided by Jordan 2026-09-03 unless marked open)

1. **Official SDK deferred, reversible.** G1 said "via the official `@anthropic-ai/sdk`". The
   landed provider uses keywork's own transport instead: one retry / SSE / redaction story,
   the same `fetchFn` seam every other provider uses for fixtures, no new dependency to pin.
   Bedrock speaks the Converse API, not Messages, so there was no shared Messages mapping to
   hoist; `messages-wire.ts` is the one Messages mapping in the tree. Swapping the transport
   for the SDK later changes nothing in the guardrail or the neutral format. Jordan: fine,
   and if the SDK ever becomes friction it stays on the back burner.
2. **Thinking display.** The provider leaves thinking at the API default (`omitted`), so no
   thinking text is requested or shown; only signatures round-trip. **Jordan wants an option
   to enable and see thinking**; users find it valuable. That is task G4 below, a product
   feature spanning the conversation pane and every provider that can emit reasoning text.
3. **Prior-turn thinking is dropped** (see the replay policy above). Opus 5 keeps all prior
   thinking by default and would gain some cache and quality benefit from replay; that trade
   was made for compaction safety across every model. Jordan: fine.
4. **Default model is `claude-haiku-4-5`** (changed 2026-09-03 from `claude-sonnet-5`).
   Jordan: the per-provider default is the cheap, simple model, matching the `gpt-5-mini`
   pattern of the other built-ins. Nothing else changes: under IR-07 a built-in's default
   applies only when that provider's key is present (rank 4, sole available model), and with
   no credentials at all resolution stays `unconfigured` and onboarding points at `/connect`.
5. **`max_tokens` default 32,000**, within every current model's output ceiling; per-model
   ceilings are not modeled in `ModelCapabilities`. Jordan asked whether this is normal. It
   is a simplification: Pi and OpenCode both read a per-model output limit from a model
   registry (models.dev in OpenCode's case) and send that. keywork has no registry yet, so
   the flat cap is safe today (every listed model accepts 32,000) and becomes a per-model
   `maxOutputTokens` capability when a model table exists. Open, low urgency.
6. **The `/connect` protocol toggle** landed 2026-09-03 once the bots lane released
   `tui/src/connect-model.ts`: the toggle cycles through `connectionProtocols` in both
   directions and `connectionFacts` names any protocol other than chat-completions
   (`connect-model.test`: "cycles the protocol through every declared protocol in both
   directions", "names the anthropic-messages protocol as a fact"). Jordan: fine.
7. **Empty tool output** is sent as an empty `tool_result` content string, unverified against
   the live API for the empty case.

### G4 (2pt): Visible thinking, opt-in
A `thinking` option (`.describe()`-justified, off by default) that asks the model for reasoning
text where the protocol offers it and renders it in the conversation pane as a distinct,
collapsible part in `textMid` ink: Anthropic `thinking: { type: "enabled", budget_tokens }`
with `thinking_delta` streaming into a visible thinking part alongside the owned signature;
Responses `reasoning.summary` for OpenAI-shaped providers. Toggle live with `/thinking`
(session-scoped, recorded as a session entry so replay shows what was visible). Owned
signature handling and the replay policy above are unchanged; the visible text is display
only and never re-sent.
**Accept:** fixture streams with thinking deltas render a folded thinking part that expands on
a key; off by default produces byte-identical requests to today; the option round-trips
through config and `/thinking`; replay of a session recorded with thinking on shows it.
**Strategy:** `OWN`.
