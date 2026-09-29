# ADR-0072: The LLM Router inside the AI Gateway

- Status: Proposed (Geovet's "LLM Router nativo en MelonMotor" brief, 2026-09-29; pending review)
- Date: 2026-09-29
- Builds on:
  - [ADR-0027](0027-ai-gateway-and-provider-registry.md) (the AI Gateway, registry, policies and router);
  - [ADR-0038](0038-vertex-ai-activation.md) (Vertex AI, Gemini 2.5 Flash-Lite, the credit rate).
- Works with [ADR-0073](0073-ai-usage-layer.md): every call the router serves emits the AI Usage Layer's event.
- Audit: [LLM-ROUTER-INTEGRATION-AUDIT.md](../architecture/LLM-ROUTER-INTEGRATION-AUDIT.md).
- Terraform: none in this change. DeepSeek in DEV will need a secret and one IAM binding, only after the owner's decision (see Open).

## Context

MelonMotor already had one AI Gateway with a router inside it (ADR-0027). Every model call goes through it, and only the Vertex AI adapter talks to a provider. The brief asks for a provider-agnostic router with routing policies, health-aware fallback, cost awareness and a second official provider (DeepSeek), without a second gateway, registry, credits system, event bus or tool executor.

## Decision

### 1. The router is extended in place

`routeModel` in `packages/ai-gateway` stays the only router, and the `AIGateway` interface does not change. GIA, the Agent Engine, the planner, Company Brain, conversations and the Decision Engine need no change.

### 2. Routing strategies

A model policy may set `strategy`, and a request may ask for one: `cost_optimized`, `balanced` (the default), `quality_first`, `latency_first` or `reliability_first`. A strategy only orders the models the filters kept. It never brings back a model a rule left out: capability, modality, context, output size, environment, sensitivity, allowed providers and models, budget and provider availability always apply first. The policy's preferred list stays first under every strategy.

| Strategy            | Order                                                       |
| ------------------- | ----------------------------------------------------------- |
| `cost_optimized`    | cheapest, then quality, then latency                        |
| `balanced`          | at least the requested quality (default standard), cheapest |
| `quality_first`     | best quality, then cheapest                                 |
| `latency_first`     | fastest, then cheapest                                      |
| `reliability_first` | healthy providers first, then model priority, then cheapest |

Ties break on the model's `priority`, then on its key, so routing is deterministic.

### 3. Provider health

A small tracker in the gateway learns from calls: three transient failures (timeout, network, rate limit, server error, unavailable) within a minute make a provider `unavailable` for 30 seconds, then `degraded` until a success. An unavailable provider is skipped in routing and in fallback. A refused request, bad credentials or a context overflow say nothing about the provider's health. The tracker is per process; no shared store is added.

### 4. Errors and fallback

A new error kind, `context_overflow`, is not retried on the same model but allows a fallback to a model with a larger context. Retries stay for transient errors only. `fallback: 'none'` is always respected.

### 5. Models and prices are configuration

Models gain optional `displayName`, `priority` and a cached-input price. Prices live in the model catalogue with their source and date, never in business logic. Cached input is charged at its own price only when the model has one; otherwise as normal input, never less. Costs are computed by the AI Cost Engine of ADR-0073.

### 6. DeepSeek, official API only

`packages/ai-deepseek` is DeepSeek's adapter over its official chat completions API (`https://api.deepseek.com`), with no SDK and no intermediary.

- Its key is read from Secret Manager through a `CredentialResolver`, from an `ai-*` secret whose reference is set in `DEEPSEEK_API_KEY_SECRET`. It is held in memory for five minutes, dropped when DeepSeek refuses it, and never logged.
- It is capped at `internal` data, because DeepSeek processes data outside Google Cloud. It is DEV only.
- Its prices are `unknown` until they are confirmed from DeepSeek's official price list, so the gateway refuses every call to it (`price_unknown`).
- Its reasoning text is never passed on. Every failure is classified, and DeepSeek's messages are never passed on either.
- It is registered only where `DEEPSEEK_API_KEY_SECRET` is set. Registering it allows nothing by itself: every current policy still names Gemini only, with no fallback.

### 7. Secrets

`createSecretManagerStore` takes the kind of reference it reads (`accepts`). Channel stores read `channel-*` secrets only; AI stores read `ai-*` secrets only. Neither can be pointed at the other's.

### 8. Telemetry

The gateway logs carry task type, department, routing strategy, retries, fallbacks, cached input units and estimated and actual cost. They never carry content or secrets.

## How to

- **Add a provider.** Write an adapter package like `ai-deepseek` (catalogue, adapter, tests), register it in `apps/api/src/ai.ts` and `apps/worker/src/server.ts` behind its own setting, and add a policy that names it. Aggregators are refused by the registry.
- **Add a model.** Add its definition to the provider's catalogue: capabilities, limits, quality, latency, environments, sensitivity and price (or `unknown`).
- **Change a price.** Edit the model's `pricing` with the new source and date. Nothing else changes.
- **Change routing.** Set `strategy` on a model policy, or let a request ask for one.

## Consequences

- Behaviour in DEV and elsewhere is unchanged: every call still reaches Gemini 2.5 Flash-Lite only.
- A policy that allows several models now gets cost- and health-aware routing and fallback.

## Open

- Which data may reach DeepSeek, its confirmed prices, and its secret and IAM binding in DEV (owner decision).
- Company, plan, department and user policy layers need storage; today policies are per agent and per kind of assisted call.
- Normalized tool calling (the Tool Gate stays the only executor) and `AIGateway.stream`: next phases.
- A credit hold before a call: the credits engine has none (ADR-0027).
