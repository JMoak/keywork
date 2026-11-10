# Decision 002: bounded campaign provider requests

Status: implemented transport boundary, 2026-11-10. Campaign quote admission and
reservation accounting are separate host responsibilities under backlog 123.

## Decision

Campaign calls supply `maxOutputTokens`, `retry: "never"`, and `openRouterRouting`
with an explicit provider allowlist and maximum prompt, completion, and request prices.
The first admitted transport is OpenRouter Chat Completions at its official HTTPS API
endpoint. A provider name or an OpenAI-compatible wire format alone does not establish
support. Other transports reject unsupported controls before dispatch.

`requestSupport` describes implemented request controls, not an unconditional dollar
guarantee. The host must admit the selected model, endpoint, rate categories, input bound,
and output-token semantics before reserving a call. Every dispatched request consumes its
own reservation. An acknowledgement failure leaves its external effect unresolved.

## Wire controls

- Pin one model without routing aliases, presets, or plugin variants.
- Set `max_tokens` to the smaller of the requested cap and configured output caps.
- Intersect the requested provider allowlist with any configured allowlist.
- Set `provider.allow_fallbacks: false` and `provider.require_parameters: true`.
- Apply the stricter requested and configured `provider.max_price` values.
- Disable transport retries and HTTP redirect following for the admitted attempt.
- Refuse body decorations that can replace prompt content, add tools or plugins, change
  models, or add uncounted schema and stop content. Preserve admitted sampling settings.

Prompt and completion `max_price` values are USD per million tokens. The request price
is USD per request. These filters are not total-call price limits and do not independently
bound every ancillary charge. Provider inference internals remain outside local control.

## Quote discovery and receipts

The public endpoint metadata route is
`GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints`. Its `data.endpoints`
records include `tag` for routing, `provider_name` for display, supported parameters,
context and completion limits, and `pricing` string values. Catalogue token rates use
USD per token, unlike request routing's per-million token filters. Conditional price
overrides and cache-write/read categories must be considered separately. An omitted
price field is not evidence of an explicit zero charge. The current transport emits
`max_tokens`; admission must require that supported parameter.

`onResponse` retains request and generation identity when available before later stream
failure. A done receipt can include requested model, served model/provider, request ID,
generation ID, finish reason, and `usageReported`. Missing or malformed counters never
become affirmative zero usage. Reported zero usage and reported zero cost remain valid.
Cache reads and writes are separated from uncached input; reasoning tokens are not added
again to a completion total that already includes them.

`usageReported` means valid counters were received. It does not alone prove terminal
completion, matching requested identity, or a complete bill. Acceptance and reservation
settlement must check the receipt and host admission policy. No exactly-once provider
effect or paid-provider behavior is claimed by mock transport tests.

## Implemented quote and metering admission

`OpenRouterQuoteCache` performs credential-free metadata GETs, deduplicates concurrent
lookups, and keeps quotes for at most five minutes (one minute by default). Expired data
never becomes a fallback when refresh fails. GPT-4, GPT-5, and GPT-6 model families are
admitted only with a matching live model record, GPT tokenizer, text output, and an OpenAI
endpoint supporting `max_tokens`. Model selection is preserved; admission failure never
substitutes a different model. Other provider/model contracts remain explicit extensions.

Reasoning and visible completion tokens share the output allowance. Request-level effort
is passed through. A `reasoning.mode` decoration is refused because it can select a
different billing mode. Mid-conversation effort changes require another transport contract.
Automatic GPT-5.6-and-later cache writes have a charge, so those models require an explicit
cache-write quote. Reservations use the highest admitted input/cache rate, not hoped-for
cache discounts. Declared sibling service tiers are excluded from a base provider route.

Recognized `min_prompt_tokens` pricing overrides reduce the admitted context envelope to
below the first threshold; this preserves the selected model while avoiding an unreserved
long-context price tier. Unknown pricing categories or conditional schemes are refused.
The input bound uses serialized text/function-tool request UTF-8 bytes plus explicit
framing allowances. It is recorded as a conservative tokenizer-specific engineering bound,
not a provider token-count response. Output allowance is reserved before dispatch.

`meteredCampaignProvider` writes the intent, reservation, and dispatch boundary before the
model call. It durably captures observed request identity and reported exposure, including
before stream failure. Incomplete terminal/usage or mismatched served identity becomes
unknown, preserving the larger of reserved and observed exposure. An accounted token-rate
estimate also retains its reservation. Only an attributed terminal response with reported
cost releases the corresponding reservation. A reported charge above the bound is recorded
and execution stops; local reservation logic cannot undo provider-side billing.

Public quote-only checks passed for `openai/gpt-6.1-terra`, `openai/gpt-6.1-sol`, and
`openai/gpt-4.1` on 2026-11-10. The first two were admitted with a 271999-token context
envelope below their first pricing tier. No paid inference or account credential was used.

## Evidence and sources

Focused fixtures cover request bounds, restrictive routing, unsupported transports,
single-attempt failures, identity before failure, and absent or malformed usage. Existing
OpenAI, Responses, Anthropic, Bedrock, retry, transport, and capabilities tests remain green.
No paid model calls were made. A credential-free public metadata GET verified the route
and fields above for `openai/gpt-4.1`; provider availability and prices remain live data.

- [Provider routing and maximum prices](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Endpoint metadata](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints)
- [Request parameters and output limits](https://openrouter.ai/docs/api_reference/parameters)
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Reasoning and combined output budgets](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Automatic and explicit cache-write charges](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

