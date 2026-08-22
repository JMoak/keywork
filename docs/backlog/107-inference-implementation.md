# Inference Resolution — Implementation Breakdown & Ledger (2026-08-21)

> **Implementation overlay** for the binding `IR-01`–`IR-19` / `CD-01`–`CD-10` record in
> [`105-inference-resolution.md`](105-inference-resolution.md). This file sizes the work the
> record deferred ("task sizing belongs in a later implementation breakdown and must cite the
> `IR` decisions it satisfies") and keeps the landed ledger. Where this file and 105 disagree,
> 105 wins; this file may only *add* the how.
>
> **Standing guardrails unchanged:** Anthropic is API-key / Agent-SDK only and still has no
> provider wiring before G1; Pi/OpenCode lifts carry `NOTICE` attribution; Crush is not a source;
> the user commits.

## Stream 1 tasks (sized; all `OWN`)

| Task | Pts | Decisions | Landed |
|---|---:|---|---|
| **IR-T1 — engine registry & typed resolution** · `engine/src/inference/{types,references,registry}.ts`: `ProviderRegistration` / `ModelSpec` / `InferenceBinding` as distinct values; canonical `provider/model` references with bare-name resolution that fails on ambiguity; deterministic rank-1..5 precedence; frozen bindings; typed outcomes `unconfigured · ambiguous · unknown-provider · unknown-model · disabled-provider · unavailable-credential · unsupported-protocol · missing-capability · insecure-endpoint`, each with `message` + `nextAction`; loopback-or-HTTPS transport rule; registrations validated at `register()`. Filesystem-free tests. | 3 | IR-01, IR-02, IR-03, IR-04, IR-06, IR-07, IR-17, IR-18 | ✅ 2026-08-21 |
| **IR-T2 — protocols as declared data; adapters; owned private state** · `engine/src/inference/adapters.ts` (`providerFor(binding, {vault})`: chat-completions / responses / bedrock-converse dispatch, credential *material* resolved through an app-owned `CredentialVault` by handle, retry + declared-capability gate applied once); `OpenAiCompatibleProvider` takes `authHeaders`/`extraBody` (OpenRouter host-sniff retired into the registration's `decorations`); `OpenAiResponsesProvider` takes a `baseUrl` and tags `redacted-thinking` parts with `owner {provider, model}`; `responses-wire` sends owned reasoning only to its owner (unowned legacy state passes). | 2 | IR-05, IR-08, IR-09, IR-13, IR-19 | ✅ 2026-08-21 |
| **IR-T3 — `connections` config + app composition** · `shared` schema `connections.<name>` = `{ endpoint, protocol?, credential? (none · saved · env:VAR), models?, insecureTransport?, enabled? }` with `.describe()` justifications (D9); `cli/src/inference/{builtins,runtime,observations,verify,port,connections}.ts`: built-ins (openrouter, openai, openai-codex, bedrock) + connections become registrations; deliberate-source credential precedence kept (KEYWORK_ scoped › saved › ambient); reported inventory cached in `~/.keywork/connections.json` with `verifiedAt` / `modelsReportedAt` / `lastFailure`; `resolveProvider` one-shot catalog deleted. | 2 | IR-05, IR-10, IR-15, IR-17, IR-19, CD-08 | ✅ 2026-08-21 |
| **IR-T4 — session-local binding, transactional `/model`, provenance** · `composeAgents` builds each agent on the provider its spec names; `MemoryFlush` follows the provider in force per session (IR-14 initial rule); `SessionStore.appendModelChange` / `modelSelection`; attachments expose `modelReference` + `recordModel`; the first durable act writes `model_change` before the first user message; resume passes the recorded selection as the session's rank-2 input and a failed resolution surfaces the typed failure in the pane without substituting; `/model` switches only between turns (busy ⇒ refused), re-resolves through the factory, records `model_change`, then swaps the agent. Titles use the pane's own provider. | 3 | IR-03, IR-04, IR-11, IR-12, IR-14 | ✅ 2026-08-21 |
| **IR-T5 — `/connect` · `/model` · onboarding as clients** · TUI `InferencePort` + `ConnectionsPort` (`tui/src/inference-port.ts`), `ModelPicker` (neutral rows: reference · protocol · credential source · declared/reported; available first, then alphabetical), `ConnectModel` state machine (targets → editor → verifying → receipt/failed; remove-confirm → removed), overlays in `app.ts`, commands `/model [ref]`, `/connect [target\|url]` with aliases `/setup` `/new-provider`; opening performs no network; the editor names target, protocol, credential source, durable name, and the exact Enter action; Esc discards; receipt offers `Enter choose a model · Esc done`; removal deletes the owned key and names both objects, retains env credentials and says so. CLI `keywork connect` (alias `setup`) drives the same port; `onboardIfNeeded` auto-setup removed; unconfigured pane teaches the two verbs and waits; headless `run --json` emits `resolution.failed` with the typed code. | 3 | IR-15, IR-16, CD-01–CD-10 | ✅ 2026-08-21 |

**Gate status:** `IR-G1` ✅ · `IR-G2` ✅ · `IR-G3` ✅ · `IR-G4` ✅ (local loopback and custom HTTPS gateway verify + save through one editor) · `IR-G5` ✅ (legacy `apiKeys` and env credentials still resolve; the model-bound `Provider` is no longer the composition path).

## Hand-editable shape (the Jordan case)

```json
{
  "connections": {
    "ollama":   { "endpoint": "http://localhost:11434/v1", "models": ["qwen3:30b"] },
    "lmstudio": { "endpoint": "http://localhost:1234/v1" },
    "gateway":  { "endpoint": "https://gw.example/v1", "credential": "env:GW_KEY", "protocol": "responses" }
  }
}
```

`/model lmstudio/<id>` or `/connect lmstudio` → Enter (one `GET /models`) → `/model` lists what it reported.

## Deviations of record (flag for Jordan)

- **IR-10 capability floor.** Reported/unlisted models bind with the existing undeclared floor
  (`text`, `toolCalls: true`, no `contextWindow`) rather than being refused until declared; the
  `models` glob declarations still gate images and refuse `toolCalls: false`. Reason: refusing
  every local model until hand-declared contradicts D9's "undeclared = floor" and the zero-ceremony
  local flow this stream exists for. Revisit if IR-10 is meant literally.
- **IR-13 owner granularity.** Owned reasoning items are filtered on a `{provider, model}` match
  exactly as written. If the Codex backend accepts encrypted reasoning across its own models, a
  switch between two codex models now drops that continuity; if it rejects a `function_call` whose
  reasoning item is missing for *historical* turns, that switch fails the next request. Unverified
  against the live API; unowned (pre-2026-08-21) items pass through untouched.
- **Zero-config default is stricter.** Two credentialed providers no longer pick the first by
  catalog order (IR-07 rank 5): `keywork` asks for `/model` or a `"model"` default.

## Follow-ups (not blocking)

- `/connect` for `openai-codex` stays terminal-only (browser/device sign-in) and bedrock stays
  env-driven; both appear as saved rows with their credential source.
- `keywork chat` still binds once at start (no `/model` in the debug REPL).
- A22/E9: saved keys still live in `auth.json` (0600); E9 keychain is the at-rest successor.
- Named auxiliary roles (`title`, `compact`) extend `ResolutionRequest` later (IR-14 second half).
