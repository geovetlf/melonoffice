# Architecture

```
GIA · agents · workflows · Company Brain      (ask for a capability; never name a provider)
        ↓
AI Gateway (packages/ai-gateway)              checks, policy, credits, audit, usage — the only one
        ↓
LLM Router (routeModel)                       capability, modality, context, sensitivity,
        ↓                                     environment, policy, budget, health, then strategy
Provider registry                             Vertex AI · DeepSeek · NVIDIA
        ↓
NVIDIA adapter (packages/ai-nvidia)           the only code that knows NVIDIA's API
        ↓
https://integrate.api.nvidia.com/v1/chat/completions   (NVIDIA's official hosted API)
```

## What was reused, not rebuilt

| Need                            | Existing piece                                                        | What changed                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| AI Gateway                      | `packages/ai-gateway`                                                 | A provider's `Retry-After` is honoured, see below.                                                                        |
| Router                          | `routeModel`                                                          | Nothing. NVIDIA competes like any model: capability, sensitivity, environment, policy, budget, health, then strategy.     |
| Provider and model registry     | `createProviderRegistry`                                              | Models may record their **terms** (`AIModelTerms`), and the registry enforces them.                                       |
| Cost engine                     | `packages/ai-usage` (`createAICostEngine`, LLM calculator)            | Nothing. NVIDIA's price is a zero price with its source.                                                                  |
| Usage ledger and financial feed | `AIUsageEvent` → `aiUsageEvents` / `aiUsageDays` (ADR-0073, ADR-0074) | Nothing. Every NVIDIA call emits the same event, with provider `nvidia` and its model.                                    |
| Credits                         | `packages/credits` through `AICreditsPort`                            | Nothing. The same credit rule (D-12) applies.                                                                             |
| Secrets                         | Secret Manager `ai-*` references, `aiProviderKeysFromSecrets`         | Nothing. A new `NVIDIA_API_KEY_SECRET` setting.                                                                           |
| Health                          | `createProviderHealthTracker`                                         | A 429's `Retry-After` keeps the provider out of routing until then.                                                       |
| Retry and fallback              | The gateway's attempt loop and `fallback: 'compatible'`               | The wait is the larger of the policy's backoff and `Retry-After`. A wait longer than 10 s goes to the next model instead. |

There is no NVIDIA router, gateway, cost engine, ledger, wallet or billing.

## Additions

- **`AIModelTerms` on a model.** The fields are `offering`, `production`, `contentUse`, `source` (https) and `verifiedAt`. The registry refuses a model:
  - registered for `prod` when its terms do not allow production;
  - active while its offering is `not_allowed` or `unavailable`;
  - given anything above `public` data when its provider may use or keep what it is sent.
- **`ProviderOutcome.retryAfterMs`.** An adapter passes on the provider's `Retry-After` on a 429. `retryAfterMsOf()` reads the header, either seconds or a date, capped at a day.
- **The `packages/ai-nvidia` package:**
  - `catalogue.ts` holds the provider, the model and its terms;
  - `adapter.ts` translates chat completions, tools and streaming;
  - `discovery.ts` reads `GET /v1/models` and reports drift.
- **Wiring.** Both `apps/api` and `apps/worker` register NVIDIA only when `NVIDIA_API_KEY_SECRET` is set.
- **Terraform.** An optional `nvidia_api_key_secret` variable, default null and DEV only. It grants read on that one secret to the api and worker runtime identities and sets the env var.

## Why the router does not pick NVIDIA just because it costs $0

A model is a candidate only if it passes every hard filter first:

- the capability, the modalities, the context and output size;
- structured output, tool use and streaming, when the call needs them;
- data sensitivity, the environment, and the policy's allowed providers and models;
- the cost ceiling, latency, and current health.

Only then does the strategy order the candidates. `balanced` means the cheapest of at least standard quality.

So NVIDIA is chosen only for a call that NVIDIA's terms allow: public data, in DEV, under a policy that allows it. Such a call gets the cheapest compatible model, and the other compatible models follow it as fallbacks. Today every product policy pins Gemini, so no product call reaches NVIDIA.
