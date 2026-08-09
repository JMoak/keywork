# Workstream G — Anthropic Provider (late, gated)

> Deliberately last among providers, per the standing guardrail: **API-key / Agent-SDK only.**
> No subscription-OAuth, no Claude Code client impersonation, no ported login flows from any
> influencer. G2's review is a hard gate — G1 does not ship without it.

---

### G1 (2pt) — Anthropic provider via official SDK
Adapter on the A1/A2 abstractions using the official `@anthropic-ai/sdk`: Messages API
streaming, tool use, usage extraction (incl. cache tokens), key from `ANTHROPIC_API_KEY` /
config only; prompt-caching support where the abstraction allows.
**Accept:** recorded-fixture tests; live smoke doc; model switching between Anthropic and
A14 providers mid-session works via the neutral message format.
**Strategy:** `OWN` against the official SDK. Nothing adapted from any influencer's Anthropic
code.

### G2 (1pt) — Guardrail compliance review
Written checklist executed against the diff: zero OAuth code paths, zero references to
subscription endpoints/client-ID spoofing, no headers imitating Claude Code, key handling
never logged, docs state the API-key-only policy for users. Result recorded in
`docs/compliance/anthropic-review.md` with reviewer sign-off (the user).
**Accept:** checklist committed with all boxes checked and a grep-based CI guard (deny-listed
endpoint/header patterns) added so regressions fail CI.
**Strategy:** `OWN`.
