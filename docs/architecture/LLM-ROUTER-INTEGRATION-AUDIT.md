# LLM Router: integration audit

Date: 2026-09-29. This audit read the repository at main `3657ca4`. It records only what the code does today.

## 1. Architecture found

MelonMotor already has one AI Gateway and one router inside it, from ADR-0027 (X4) and ADR-0038 (CV-5). Both live in `packages/ai-gateway`.

| Piece                       | Where                                                                                                  | What it does today                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI Gateway                  | `packages/ai-gateway/src/gateway.ts`                                                                   | Provides `generate` (an agent inside an execution) and `assist` (a person asking about one record). The pipeline runs: validate, authorize, policy, credits check, route, adapter call with retries and fallback, cost, credits consume, log, audit.                                                                                                                                                |
| Request contract            | `request.ts`                                                                                           | A closed `AIRequest` with capability, requirements (`structuredOutput`, `toolUse`, `streaming`, `minContextTokens`), quality, latency, cost and credit limits, output schema and sensitivity. Refuses secrets and authority fields in input.                                                                                                                                                        |
| Router                      | `router.ts` `routeModel`                                                                               | Deterministic filters: capability, modality, context and output size, structured output, tools, streaming, allowed providers and models, status, environment, sensitivity, quality, latency, cost limit and providers known to be down. It then sorts by the policy's preferred list, higher quality, lower cost, faster latency and id. It returns the chosen model plus the compatible fallbacks. |
| Provider and model registry | `registry.ts`                                                                                          | Official providers only: OpenRouter, Replicate, fal, Together and Hugging Face are refused by name. Credentials are held as references only, and every provider has exactly one adapter. Models declare capabilities, modalities, context window, max output, structured output, tools, streaming, quality, latency, pricing (with source and date), environments and maximum sensitivity.          |
| Model policies              | `policy.ts` and domain `ModelPolicy`                                                                   | Versioned configuration: allowed providers, models, capabilities and modalities, environments, maximum sensitivity, cost ceiling, latency, fallback (`none` or `compatible`), attempts, backoff and preferred models. A specialist names one policy (`policies.model`). Each kind of assisted call has its own fixed policy.                                                                        |
| Adapter contract            | `adapter.ts`                                                                                           | `ProviderAdapter` (`generate`, optional `stream`, `capabilities`, `health`). It classifies errors as `timeout`, `network`, `rate_limited`, `server_error`, `unavailable`, `authentication`, `invalid_request`, `content_policy` or `invalid_response`. `ProviderCredential` redacts itself. `CredentialResolver` is declared but not implemented.                                                   |
| Cost and credits            | `cost.ts`, `credits.ts`                                                                                | Cost in micro-USD from known prices only. `CREDIT_RATE` is 1 credit = US$0.01 (D-12). `AICreditsPort` uses the existing `CreditService` signatures (balance, consume, refund). There is no hold: a "reservation" is a balance check before the call.                                                                                                                                                |
| Only provider               | `packages/ai-vertex`                                                                                   | Gemini 2.5 Flash-Lite on Vertex AI (D-7), called over REST with the service identity from the metadata server, with no key. Text and JSON with a response schema. No streaming, no tools.                                                                                                                                                                                                           |
| Composition                 | `apps/api/src/ai.ts`, `apps/api/src/app.ts`, `apps/worker/src/server.ts`, `apps/worker/src/runtime.ts` | The registry holds Vertex AI only when its project and location are configured. Otherwise it is empty and every call is denied.                                                                                                                                                                                                                                                                     |

## 2. Current LLM calls

Every model call goes through the gateway. Only the Vertex adapter talks to a provider.

- `generate` is used by:
  - the runtime's agent nodes: conversation agents (ADR-0043), agent tasks (ADR-0063) and plan steps (ADR-0070), in `packages/runtime/src/runtime.ts`;
  - the planner, in `packages/planning/src/planner.ts`.
- `assist` is used by:
  - GIA chat (`packages/gia/src/service.ts`);
  - conversation assistance (`packages/conversations/src/assist.ts`);
  - Company Brain extraction (`packages/brain/src/extractor.ts`);
  - Decision Engine routing (`packages/decisions/src/deciders/routing.ts`).
- A search across apps, packages and infra for Gemini, Vertex, DeepSeek, OpenAI, Anthropic and Qwen found:
  - one provider call, in `packages/ai-vertex/src/adapter.ts`;
  - provider names used as configuration (policy references) in `apps/api/src/ai.ts`, `apps/api/src/operator.ts` and `apps/worker/src/server.ts`;
  - a worker test that forbids provider SDKs (`transport.test.ts`).

  No business package imports a provider.

## 3. Components reused, not duplicated

| Piece                                                   | Reused as it is                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| AI Gateway                                              | It is the entry point, and its router is extended in place.                                                              |
| Provider registry                                       | New providers register in the same registry.                                                                             |
| Credits and Financial Core                              | `AICreditsPort` over `CreditService`. No wallet, ledger or billing is added.                                             |
| Company Brain (`packages/brain`)                        | GIA and agents read it and put the context in messages. The gateway only carries messages; it stores nothing.            |
| Tool Gate (`packages/guardrails`)                       | It stays the only way a tool runs. No model call runs a tool.                                                            |
| Event System (`packages/events`)                        | It has no AI events, and none are needed: AI calls are audited (`ai.request_*`, `ai.provider_fallback`) and logged.      |
| Secret Manager (`packages/integrations/src/secrets.ts`) | Channel secrets are read through the metadata identity. An AI key is read the same way.                                  |
| Observability (`@melonoffice/observability`)            | Correlated logs carrying request, organization, execution, specialist, provider and model, with usage, cost and credits. |

## 4. Where the router goes

Everything stays inside `packages/ai-gateway`. It keeps the same `AIGateway` interface, so GIA, the Agent Engine, the planner, Brain, conversations and the Decision Engine do not change.

- **`router.ts`.** Routing strategies, set by the policy or asked for by the request, with the default `balanced`. Provider health comes from a small tracker in memory. The filters always apply before any strategy.
- **`registry.ts` and domain `ai.ts`.** New optional model fields: display name, priority and cached-input price.
- **`adapter.ts`.** A new error kind, `context_overflow`, and optional cached-input usage.
- **New `packages/ai-deepseek`.** The DeepSeek adapter, its catalogue, and the official API only. It is registered only where it is configured.

## 5. What must not be duplicated

- A second gateway, registry, policy store, wallet, ledger or credits engine.
- A second event bus or tool executor.
- Context storage in the router.
- A second secret store.

## 6. Migration plan

There is nothing to migrate: no business code calls a provider. Adding the router's features changes no caller. Every current policy pins Gemini 2.5 Flash-Lite with `fallback: none`, so production behaviour stays the same until a policy allows DeepSeek.

Order of the work:

1. **Router (this change).** Strategies, health, cached pricing, the context-overflow error kind, telemetry fields, and the DeepSeek adapter registered only when configured.
2. **DeepSeek in DEV.** After the owner decides which data may reach it: its API key in Secret Manager, IAM read access, configuration, and a policy that names it.
3. **Tool calling.** Normalized tool definitions and tool calls through the gateway. Each call is executed only by the Tool Gate.
4. **Streaming.** `AIGateway.stream`, charged at the end, with fallback only before the first chunk.

## 7. Risks found

- **DeepSeek and data.** DeepSeek processes data outside Google Cloud. Today GIA, agents, Brain and conversations send `confidential` data. Allowing any of them to use DeepSeek is a privacy decision, so DeepSeek is capped at `internal` until the owner decides.
- **DeepSeek facts could not be checked.** The official pricing page could not be read from this environment. Its price stays `unknown` until the owner confirms it; the gateway already refuses calls with an unknown price. Its context and output limits are set conservatively.
- **No credit hold.** The balance is checked before a call and charged after. Concurrent calls can spend slightly past the check. This is a known limit of the credits engine (ADR-0027).
- **Health is per process.** Each Cloud Run instance learns health on its own. That is acceptable at this scale, and no shared store is added.
- **Policy layers.** Policies are set per agent (specialist) and per kind of assisted call. Company, plan, department and user layers have no storage yet. A request can ask for a strategy, which only changes the order among models the policy already allows.

## 8. AI usage beyond language models

The owner's direction (2026-09-29): the LLM Router is one source of AI usage among many. Every AI capability (images, video, voice, documents, search, browser and those to come) must end in the same place: usage tracking, one AI Cost Engine, and a financial integration contract that the future Financial Backend reads. There is no universal unit, and a provider is not assumed to be a language model provider.

What this change adds for that, in [ADR-0073](../adr/0073-ai-usage-layer.md):

- the `AIUsageEvent` and `CostResult` contract in `@melonoffice/domain`;
- the AI Cost Engine in `packages/ai-usage`, with calculators per price shape (`unit_rates` covers any linear price per unit);
- the gateway pricing tokens through that engine and emitting one usage event per completed call.

The persistent usage ledger and its queries are the next block (U1).
