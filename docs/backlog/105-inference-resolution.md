# Inference Resolution — Binding Decisions (2026-08-20)

> **Authoritative overlay.** This record wins over `104` and every earlier planning document
> wherever it speaks. Its stable references are `IR-01` through `IR-19`; the file number may
> change, but those identifiers must not. A later change must name the affected `IR` identifier
> and explicitly amend or supersede it. Silence is not a supersession.
>
> **Central decision:** provider/model/protocol resolution is a durable engine capability.
> Onboarding, setup, the model picker, headless execution, session resume, and auxiliary model
> calls are clients of that capability.
>
> **Standing guardrails:** Anthropic remains API-key / Agent-SDK only, with no subscription
> OAuth or client impersonation. Pi and OpenCode may be adapted with attribution in `NOTICE`.
> Crush is not a source for code or design. The user commits.

## Reference contract

Use the stable identifier in discussion, implementation notes, tests, and later decisions.
“Implement IR-01 through IR-06,” “revisit IR-08,” and “this violates IR-13” are complete,
durable references. Each identifier owns exactly one decision boundary.

| Term | Meaning |
|---|---|
| `ProviderRegistration` | Runtime-wide provider identity, protocol adapters, authentication requirements, catalog source, and provider-specific extensions. |
| `ModelSpec` | Provider-qualified model identity plus declared protocol, context limits, modalities, tool support, and other request-shaping capabilities. |
| `InferenceBinding` | Immutable, executable resolution of one provider, one model, one protocol adapter, one credential handle, and one capability set for one operation. |
| Model reference | Canonical `provider/model` identity. Display aliases may be shorter, but persisted and engine-facing identities are qualified. |
| Availability | Whether a registration can currently produce a binding. Availability is not user preference. |

## IR-01 — Resolution is an engine primitive

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | The engine exposes provider registration, model resolution, binding, and typed resolution failures independently of every user interface. |
| Consequence | The TUI, CLI, setup flow, tests, resume path, and future server surface call the same resolver. No client reimplements precedence or protocol selection. |
| Supersedes | The current composition pattern in which CLI startup chooses one model-bound provider and injects it permanently into an agent. |

## IR-02 — Registration, specification, and binding are separate values

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | `ProviderRegistration`, `ModelSpec`, and `InferenceBinding` are distinct types with distinct lifetimes. A provider is not a model, and a model choice is not a live client. |
| Consequence | Catalog refresh can replace model inventory without mutating active calls. Credential rotation can affect later bindings without rewriting session history. Tests can resolve values without performing network I/O. |

## IR-03 — Registry scope is runtime-wide; selection scope is session-local

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | One engine runtime owns a shared provider registry. Each session owns its active model reference and resolves its own bindings from that registry. |
| Consequence | Multiple panes and sessions may use different models concurrently without duplicating provider configuration. A model change in one session cannot silently change another session. |

## IR-04 — A binding is immutable for an operation

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Every model-backed operation captures one immutable `InferenceBinding` before request construction and retains it until that operation reaches a terminal state. |
| Consequence | Config reloads, credential refreshes, catalog refreshes, and model switches affect only later operations. A streaming turn never changes provider, model, protocol, or capability rules halfway through. |

## IR-05 — The engine owns rules; the application owns effects

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | The engine owns normalized types, registry behavior, precedence, protocol dispatch, state portability, switching semantics, and typed outcomes. Application packages own config files, environment variables, OS credential stores, browser login, prompts, and provider-management UI. |
| Consequence | Engine tests remain deterministic and filesystem-free. The CLI composes effectful sources into registrations and credential handles. The TUI talks through a narrow port rather than importing storage or auth implementations. |

## IR-06 — Model identity is always provider-qualified

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Engine APIs and persisted session entries use canonical `provider/model` references. Bare model names are accepted only at trust boundaries as legacy or interactive input and must resolve unambiguously before entering engine state. |
| Consequence | `openai/gpt-5`, `broker/gpt-5`, and `local/gpt-5` cannot collide. Renaming a display label cannot corrupt resume behavior. Ambiguous bare names fail with candidates rather than guessing. |

## IR-07 — Selection precedence is deterministic

| Rank | Source | Rule |
|---:|---|---|
| 1 | Explicit invocation override | A CLI flag or equivalent call-site override applies to the requested session or operation only. |
| 2 | Current session selection | An in-memory selection, or the last persisted `model_change` when resuming, owns the session. |
| 3 | User default | The configured provider-qualified default applies when the session has no selection. |
| 4 | Sole available model | Exactly one bindable model may become the zero-config default. |
| 5 | No unique result | Resolution returns `unconfigured` or `ambiguous`; it never chooses by registry order. |

Credential presence changes availability, not the preference order above. Within the selected
provider, credential-source precedence remains the deliberate-source policy from `101`:
saved credentials and `KEYWORK_`-scoped overrides outrank ambient provider environment variables.

## IR-08 — Protocol is declared, never guessed or silently downgraded

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Protocol is part of `ModelSpec`. A provider may supply a default and a model may override it. `responses` is preferred where the endpoint truthfully supports it; `chat-completions` is an explicit compatibility protocol. |
| Consequence | Keywork does not probe by sending sacrificial requests, infer protocol from URL shape, or fall back from Responses to Chat after an error. A protocol error names the declared protocol and the corrective configuration. |
| Evidence | OpenAI’s current model guidance recommends Responses for reasoning models because it carries reasoning context across turns and can improve intelligence, cache utilization, and latency: [official OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model). |

## IR-09 — Responses has a generic core and explicit provider extensions

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | The engine contains one provider-neutral Responses codec for the interoperable surface. Provider-only fields, endpoints, headers, item rules, and authentication are decorators selected by the registration. |
| Consequence | A custom gateway does not inherit Codex-backend assumptions such as encrypted reasoning, special headers, or forced request fields. OpenAI-specific optimizations remain available without contaminating the generic protocol. |

## IR-10 — Catalog discovery is inventory, not capability inference

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | A provider may list model identifiers and display metadata through an explicit refresh. Capabilities that affect correctness remain declared in `ModelSpec`; discovery cannot silently invent them. |
| Consequence | Startup is side-effect free. Cached or configured inventory is immediately usable. Refresh failure preserves the last good catalog and reports stale state. Custom models must declare at least context window and tool-call support before normal agent use. |
| Amends | A22. “Declared capabilities, not discovery” remains binding; this record clarifies that safe inventory discovery is allowed. |

## IR-11 — Model switching is transactional and occurs between turns

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | A switch resolves and validates the target binding, rebuilds model-specific prompt material, appends `model_change`, then atomically swaps the session binding before the next turn. |
| Consequence | Any failure leaves the previous binding active and writes no successful change entry. An active stream must first finish or be explicitly interrupted. Neutral visible history is preserved; provider-private state follows IR-13. |
| Amends | C20. The picker is a client of this transaction and does not own switch behavior. |

## IR-12 — Session history records inference provenance

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | The first durable act in a nonempty session records its initial provider-qualified `model_change` immediately before the first user message. Every successful later switch records another. Resume resolves the last recorded selection. |
| Consequence | The no-empty-session-file invariant remains intact. Cost, context, debugging, and replay can identify the model in force for every turn. If the recorded model is unavailable, resume reports that exact failure and requires an explicit replacement; it never substitutes silently. |

## IR-13 — Provider-private state is namespaced and non-portable by default

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Opaque reasoning continuations, encrypted items, response handles, and similar state are stored as `provider-state` carrying provider, protocol, and model ownership. Request assembly includes them only when ownership matches the active binding. |
| Consequence | Visible transcript content, tool calls, and tool results remain portable across models. Private reasoning continuity is preserved only for a compatible owner. A model switch filters incompatible private state instead of leaking it or corrupting the request. |
| Supersedes | Unowned opaque `redacted-thinking` as a sufficient cross-provider storage contract. It may remain a presentation form, but persisted request state needs ownership. |

## IR-14 — Auxiliary inference uses the same resolver

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Title generation, compaction, memory work, gardening, and future background inference request a binding from the same engine resolver for each operation. |
| Consequence | They do not capture the process-start provider. Initially they inherit the session binding unless explicitly configured. Future named roles such as `title` or `compact` extend resolution inputs; they do not create a second provider system. |

## IR-15 — Provider management is a durable product surface

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Keywork has one provider-management capability for adding, editing, verifying, refreshing, disabling, and removing built-in, broker, gateway, and local registrations. CLI and TUI expose the same operations through an application-owned port. |
| Consequence | A broker and a local server differ by registration data, protocol, and authentication—not by separate setup architectures. Verification and refresh are explicit user actions. Provider management never mutates session selection. The user-facing contract is fixed by CD-01 through CD-10 below. |

## IR-16 — Onboarding is a client, not a gatekeeper

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Onboarding teaches the core interaction grammar, including `/connect` and `/model`, but never invokes either command automatically. `/onboarding` always replays the teaching flow. Resetting onboarding clears only its completion or dismissal marker. |
| Consequence | Onboarding never owns provider state, model defaults, credentials, or resolution rules. An `unconfigured` empty state offers `/connect` and waits for the user to invoke it. A user can skip onboarding and configure inference later without entering a broken state. |
| Supersedes | D13’s credential-presence trigger, automatic provider flow, and implication that completing setup is what makes the app operational. |

## IR-17 — Custom endpoints are safe by construction

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Loopback HTTP is allowed for local inference. Remote custom endpoints require HTTPS unless the user explicitly enables an insecure transport option whose schema description states the credential and prompt-exposure risk. Secrets are referenced through credential handles and are never placed in engine values, session files, diagnostics, or provider catalogs. |
| Consequence | `localhost` workflows stay frictionless while LAN and internet gateways cannot quietly downgrade transport. Logs redact authorization material and sensitive headers. E9 remains the at-rest destination for stored secrets. |

## IR-18 — Resolution failures are typed and actionable

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | The resolver returns stable machine-readable outcomes for at least `unconfigured`, `ambiguous`, `unknown-provider`, `unknown-model`, `unavailable-credential`, `unsupported-protocol`, `missing-capability`, and `insecure-endpoint`. |
| Consequence | The TUI may open the relevant management action, headless mode may emit deterministic JSON and exit semantics, and tests assert codes rather than prose. Error messages name the failed reference and a concrete next action. |

## IR-19 — Migration preserves behavior without preserving accidental architecture

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Existing OpenAI-compatible, OpenRouter, OpenAI-Codex, mock, and later Anthropic integrations migrate behind registrations and bindings incrementally. Legacy config is normalized at the application boundary. |
| Consequence | Existing working credentials and model strings receive a compatibility path, but the engine does not retain a permanently model-bound `Provider` abstraction as public architecture. No provider expansion is required to land the resolver. |
| Amends | A14 becomes two explicit protocol paths under the shared registry rather than one vaguely “OpenAI-compatible chat-completions/responses surface.” Anthropic timing and auth guardrails are unchanged. |

## Connection-surface decisions

These records bind the user-facing clients of IR-15 and IR-16. Their stable identifiers are
`CD-01` through `CD-10`; later changes must name the identifier they amend.

## CD-01 — Saving a connection requires verification

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | A new connection, or an edit that changes endpoint, protocol, or authentication, becomes durable only after targeted verification succeeds. Rename and other presentation-only edits do not require network verification. |
| Consequence | Save failure leaves the draft editable and preserves any previously saved registration unchanged. A saved connection that later becomes unreachable remains configured and visible until the user edits, disables, or removes it; keywork records the exact timestamped failure without deleting state or claiming persistent liveness. |

## CD-02 — `/connect` has two aliases for now

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | `/connect` is canonical. `/setup` and `/new-provider` are executable aliases. No other connection aliases or hidden command keywords ship until use supplies evidence for them. |
| Consequence | Menus, hints, documentation, and receipts always display `/connect`. All three spellings enter the same state machine. Alias collision tests remain mandatory. |

## CD-03 — Removing a connection removes its owned credential

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Removing a connection also deletes the saved credential owned exclusively by that connection. The confirmation names both durable objects before deletion. Environment credentials cannot be deleted, and a named credential still referenced by another connection is retained with that fact stated. |
| Consequence | The ordinary removal path leaves no orphaned connection-owned secret. Sessions retain historical provider/model provenance but require explicit repair before another turn can use the removed registration. |

## CD-04 — Connection and model selection are separate operations

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | `/connect` configures a provider registration. `/model` selects a provider-qualified model for a session. Neither command silently performs the other operation. |
| Consequence | A successful connection may offer an explicit Enter handoff to `/model`; it does not change the current session by itself. |

## CD-05 — Opening a surface performs no external discovery

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Opening `/connect`, `/model`, onboarding, or an inference empty state reads only built-in definitions, durable configuration, and cached inventory. It performs no port scan, loopback probe, heartbeat, authentication, verification, or catalog refresh. |
| Consequence | Selecting a target prepares an editor. Only a plainly labeled Enter action authorizes the exact external effect. Conventional local addresses remain editable defaults, never discovery targets. |

## CD-06 — Connection surfaces are neutral instruments

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Connection and model surfaces organize factual choices without recommendations, popularity labels, inferred preferences, or qualitative ranking. |
| Consequence | Rows may state topology, protocol, credential source, declared capabilities, user favorites, recency, and timestamped observations. Ordering is deterministic and late results never move the selected row. |

## CD-07 — Arguments prepare; Enter authorizes

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Interactive arguments such as `/connect ollama` or `/connect https://example.test/v1` prefill the same connection editor. They do not perform network or storage effects. |
| Consequence | Before Enter, the editor names the target, protocol, credential source, durable name, and exact action. `Esc` discards the draft without confirmation because no durable effect has occurred. |

## CD-08 — Connection state uses factual, temporal language

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Registrations are `configured`; verification and failures are timestamped observations. The UI does not persistently label stateless HTTP providers `online`, `offline`, `ready`, or `connected`. |
| Consequence | Saved rows can say `verified at`, `models reported at`, `credential saved`, or name an exact last failure. Verification is an explicit verb rather than background health monitoring. |

## CD-09 — The model handoff is explicit

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | After `/connect` verifies and saves a registration, the receipt offers `Enter choose a model` and `Esc done`. Enter invokes the real `/model` client. |
| Consequence | Even a sole reported model remains visible and requires explicit selection. Defaults continue to follow IR-07; connection does not mutate them. |

## CD-10 — Onboarding teaches verbs and waits

| Field | Binding record |
|---|---|
| Status | Binding |
| Decision | Onboarding and the unconfigured empty state teach `/connect` for configuration and `/model` for session selection, then wait for user action. |
| Consequence | No credential condition auto-opens a provider overlay. Resetting or replaying onboarding has no inference side effects. |

## Implementation gates implied by the record

| Gate | Decisions made real | Exit condition |
|---|---|---|
| `IR-G1` | IR-01 through IR-07, IR-18 | Registry, canonical refs, deterministic selection, typed failures, and fake-provider tests exist without TUI or filesystem dependencies. |
| `IR-G2` | IR-08 through IR-10, IR-13 | Explicit Chat and generic Responses adapters coexist; provider-private state filtering and catalog-refresh tests pass. |
| `IR-G3` | IR-03, IR-04, IR-11, IR-12, IR-14 | Two sessions can use different models; switching and resume are transactional and provenance-complete; auxiliary calls resolve per operation. |
| `IR-G4` | IR-15 through IR-17, CD-01 through CD-10 | CLI and TUI share provider-management behavior; `/connect` is neutral and effect-explicit; a loopback local model and a custom HTTPS gateway can be verified and saved; `/model` selects independently; removal handles owned credentials; onboarding replay/reset is side-effect free. |
| `IR-G5` | IR-19 | Legacy providers and config pass compatibility tests; old one-shot composition is no longer the architectural path. |

These gates are dependency order, not an estimate. Task sizing belongs in a later implementation
breakdown and must cite the `IR` decisions it satisfies.
