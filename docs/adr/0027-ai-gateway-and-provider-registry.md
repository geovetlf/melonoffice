# ADR-0027: AI Gateway and provider registry

- Status: Accepted (Phase X4; accepted by Geovet, 2026-09-27)
- Date: 2026-09-27
- Builds on: [ADR-0008](0008-entity-model.md) (D-28), [ADR-0019](0019-rbac-foundation.md), [ADR-0020](0020-audit-log-foundation.md), ADR-0023 (credits foundation, PR #20), [ADR-0024](0024-execution-foundation.md), [ADR-0025](0025-departments-and-specialists.md) and [ADR-0026](0026-tools-approvals-and-guardrails.md)
- Open decisions it respects: D-7 (launch AI provider), D-12 (credit values)

## Context

Specialists (ADR-0025) will think with AI models, and a future GIA will too. Without a single entry point every caller would pick providers, hold keys, retry and count cost in its own way, and nobody could say which model answered what or what it cost.

X4 builds that entry point and nothing that calls it: no planner, workflow, scheduler, events, MCP, browser, GIA orchestration, memory, company brain or real tool. The launch provider is still decision D-7, so **no real provider, model or price is registered**; every test uses fake adapters.

## Decision

### The pieces

| Piece                 | What it is                                                                                        | Where                          |
| --------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------ |
| **AI Gateway**        | The only way to call a model: checks, routes, calls, retries, falls back, accounts and audits.    | `packages/ai-gateway` gateway  |
| **Provider**          | An official provider API: capabilities, modalities, environments, sensitivity, credential ref.    | `packages/domain` `ai.ts`      |
| **Model**             | One exact model and version of a provider: what it does, limits, quality, latency, pricing.       | `packages/domain` `ai.ts`      |
| **Provider registry** | Providers → models → the one adapter of each provider, checked and frozen.                        | `packages/ai-gateway` registry |
| **ProviderAdapter**   | Code that talks to one provider's API. Gets a credential reference, never a value.                | `packages/ai-gateway` adapter  |
| **Model policy**      | Configuration: which providers and models, environments, sensitivity, cost, fallback and retries. | `packages/ai-gateway` policy   |
| **Router**            | Deterministic choice among compatible models. No AI chooses the AI.                               | `packages/ai-gateway` router   |

### The sequence

```
Tenant → Request check → RBAC → Execution → Specialist → Policy → Route → Credits check
      → Adapter (retry, timeout) → Response check → (fallback) → Charge → Audit and log
```

`createAIGateway().generate(tenant, request)` always answers with one of three results, never an ambiguous exception:

- `completed`: the output, the provider and model that answered, the adapter, model and policy versions, usage, latency, finish reason, estimated and actual cost, credits and attempts, and `fallbackFrom` when another model than the first chosen answered;
- `failed`: every compatible model was tried and none answered; the code is the last provider error kind;
- `denied`: refused before any provider was called, with the reason.

### Where authority comes from

The `AIRequest` carries **no** organization, user, role, credential, provider key or API key. Every object in it is closed: a field it does not know is `invalid_request`, and a field named like authority or a credential (`organizationId`, `apiKey`, `token`…) is `authority_in_input`.

- The organization and user come from the resolved `TenantContext`.
- The specialist, its version and department come from the **stored execution**; a request naming another specialist is `specialist_mismatch`.
- The execution must be `planning`, `running` or `verifying`.
- The specialist must still be eligible right now (ADR-0025): active, in an active department, and holding only permissions the user holds. GIA acting for a user gets exactly that user's permissions.
- The caller needs the new RBAC permission `ai.generate` (owner only, D-22; no new role, D-27).
- Credentials come from secure infrastructure through a `CredentialResolver` port, as `CredentialReference`s (provider and scopes). A resolved value is a `ProviderCredential` that prints as `[redacted]` in JSON, strings and logs.

### No secrets in, no secrets out

Prompt text and metadata are scanned for credential shapes (API keys, bearer tokens, JWTs, private keys) and refused with `secret_in_input` before anything else. A provider answer is checked before anyone sees it: only `text` and `structured` output, sane usage, a known finish reason, and no credential shapes; otherwise it is an `invalid_response`. Provider error messages are never logged, audited or returned. This is a heuristic, not a full DLP.

### Official provider APIs first

Every provider is `access: 'official'`. The registry refuses aggregators and intermediaries by id or name (OpenRouter, Replicate, fal.ai, Together, Hugging Face). A model may not claim a capability or sensitivity its provider lacks, and every provider needs exactly one adapter able to do what the provider claims.

`AI_PROVIDER_CATALOGUE` and `AI_MODEL_CATALOGUE` are **empty** until D-7. Adding the launch provider is a catalogue entry, an adapter and a model policy; nothing else changes.

### Capabilities and modalities

Capabilities: `text_generation`, `reasoning`, `structured_output`, `image_generation`, `image_understanding`, `audio_understanding`, `transcription`, `speech`, `embeddings`. Modalities: `text`, `image`, `audio`, and `document` (a stored PDF, added by [ADR-0079](0079-document-text-reading.md)). Media is passed by reference (type and id), never inline.

### Data sensitivity

`public` < `internal` < `confidential` < `restricted`. A request states its sensitivity; the policy, the provider and the model each have a maximum, and a request above any of them is `sensitivity_not_allowed`. The default policy stops at `internal`: anything more sensitive needs a policy that allows it and a model cleared for it.

### Routing

The router filters in a fixed order and the first step that rules out the last candidate is the reason: capability, modality, requirements (context, output tokens, structured output, tool use, streaming), allowed providers, allowed models, model and provider status, environment, sensitivity, quality, latency, cost limit, availability. With no models at all the reason is `no_model_available`.

Candidates are then sorted by the policy's `preferred` list, higher quality, lower estimated cost, faster latency, then provider and model id. The same inputs always give the same order.

### Environments

The gateway runs in one `DeploymentEnvironment`. An unknown one denies every call (`environment_unknown`). A policy, provider and model each list their environments; `dev` never implies `staging` or `prod`.

### Retries, timeouts and fallback

- Each attempt has a deadline (`timeoutMs`, 60 s by default). A timeout is a `timeout` error.
- Only `timeout`, `network`, `rate_limited` (429) and `server_error` (5xx) are retried, up to the policy's `maxAttempts` (1–5), with linear backoff.
- With `fallback: 'compatible'`, the next candidate is tried after a transient error, an `authentication` error or an `invalid_response`. `invalid_request` and `content_policy` stop at once: another model would not help. With `fallback: 'none'` only the first candidate is tried.
- Every fallback is audited (`ai.provider_fallback`, with the model and the one it replaced) and logged.
- Each call has an idempotency key derived from the organization and the request id, so a provider can deduplicate retries.

### Cost and credits

- A model's pricing is `known` (USD micro-dollars per million input and output tokens, with its source and date) or `unknown`. **No price is invented.**
- Before the call the gateway estimates the most it can cost: the input estimate plus `maxOutputTokens`. A model with an unknown price is never chosen while there is a cost limit, and never charged.
- Credits reuse the Credits engine of ADR-0023 through `AICreditsPort`, whose signatures are those of `CreditService`. **There is no second credits engine.** The states `estimated`, `reserved`, `consumed`, `refunded`, `failed` and `free` are contracts. `reserved` is a balance check today, not a hold; a real reservation extends the ledger later (X8).
- The actual cost, from the provider's reported usage, is charged once under the ledger reference `ai:{requestId}`, whatever the retries. A charge that fails fails the call.
- Credit values are D-12 and pending, so there is **no default credit rate**. Without credits and a rate, every call is denied (`credits_not_configured`); with no priced model, `price_unknown`.
- Billing stays separate: it decides the plan, never an AI call's consumption.

### Audit

Three actions in a new `ai` category (ADR-0020):

| Action                 | Result  | When                                                      |
| ---------------------- | ------- | --------------------------------------------------------- |
| `ai.request_denied`    | denied  | Refused before any provider was called; `reason` says why |
| `ai.provider_fallback` | success | Another model is tried; `model` and `previousModel`       |
| `ai.request_failed`    | failure | Every compatible model failed, or the charge failed       |

Audit events gain `model` and `previousModel` (provider and model id), stored as four new nullable columns. Prompts, outputs, credentials and provider messages are never audited. A completed call is logged, not audited, to keep the audit trail for decisions.

### Observability

Every log line of a call carries the request, organization, execution, node and specialist ids, and once chosen the provider and model (`provider/model`). A completed call logs status, attempts, latency, input and output units, cost and credits. Usage is logged as units because the logger redacts any key named like a token.

### Versions

Every completed answer names the adapter version, the exact model version and the policy id and version, so any answer can be traced to what produced it.

### Persistence and infrastructure

No new collection, index or Terraform change. There is no HTTP route that calls a model: the gateway is server-side, for the planner, workers and GIA of later phases.

## Not in this change

The launch provider and real adapters (D-7), credit values (D-12), streaming (the contract exists; no caller), a credit hold, health-based routing from live probes, rate limiting per organization, content moderation beyond the checks above, and any planner, workflow, GIA or tool that uses the gateway.

## Consequences

- Every model call, from any specialist or GIA, has one set of checks, one audit trail and one way to count cost.
- Adding a provider is a catalogue entry, an adapter and a policy, with no change to callers.
- Until D-7 and D-12 are decided the gateway refuses every real call. That is deliberate.
