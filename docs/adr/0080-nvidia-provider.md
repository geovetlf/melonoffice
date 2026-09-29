# ADR-0080: NVIDIA as an official provider behind the AI Gateway

- Status: Proposed (Geovet's NVIDIA NIM provider prompts, 2026-09-29, in continuous execution mode)
- Date: 2026-09-29
- Builds on:
  - [ADR-0027](0027-ai-gateway-and-provider-registry.md) (the AI Gateway and registry);
  - [ADR-0072](0072-llm-router.md) (the LLM Router, and DeepSeek as the pattern);
  - [ADR-0073](0073-ai-usage-layer.md) and [ADR-0074](0074-ai-usage-ledger.md) (the cost engine, usage and ledger);
  - [ADR-0076](0076-normalized-tool-calling.md) (tool calling);
  - [ADR-0077](0077-streaming.md) (streaming).
- Terraform: one optional variable, `nvidia_api_key_secret` (default null, DEV only). DEV plan: No changes until it is set.
- Detail: [docs/providers/nvidia](../providers/nvidia/README.md).

## Context

Geovet asked for NVIDIA (the API Catalog and NIM) as a first-class, multi-capability provider inside MelonMotor. It must not become a second gateway, router, cost engine, ledger, credits system or billing. It must not be assumed to be free, unlimited or allowed in production. Every claim must come from NVIDIA's official sources.

What NVIDIA's official sources say, read on 2026-09-29:

- **Free access.** Developer Program members get free hosted endpoints for prototyping, research, development and testing only. Production needs an NVIDIA AI Enterprise licence or a subscription ([NIM FAQ](https://docs.api.nvidia.com/nim/docs/product)).
- **Trial terms.** The hosted API runs under the NVIDIA API Trial Terms of Service (v. 2025-09-19). They allow internal testing and evaluation, not production. Usage deducts trial credits. NVIDIA may use inputs and outputs to improve its models, and may end access at any time.
- **Rate limits.** None are published for the hosted API.
- **API.** The hosted API is OpenAI-compatible at `https://integrate.api.nvidia.com/v1`: chat completions with streaming and tools, and model listing. Embeddings, speech (gRPC) and safety models exist, each behind its own interface.

## Decision

### 1. One more provider, one more adapter

`packages/ai-nvidia` holds NVIDIA's provider, its model and the adapter, like `ai-deepseek`.

**The adapter** is the only code that knows NVIDIA's format:

- chat completions over REST;
- the key from Secret Manager through the existing `CredentialResolver`;
- tools, and streaming with usage;
- reasoning switched off and any trace dropped;
- every failure classified, never thrown, and never carrying NVIDIA's words;
- a configurable https `baseUrl`, so a self-hosted NIM later is the same adapter.

**The registered model** is Nemotron 3 Nano 30B A3B, the one model whose card publishes every field the registry needs.

**The wiring.** API and worker register NVIDIA only when `NVIDIA_API_KEY_SECRET` is set.

### 2. Terms recorded, and enforced by the registry

A model may carry `terms`:

- `offering`: `free_endpoint`, `free_prototyping`, `paid`, `commercial_license`, `not_allowed`, `unavailable` or `unknown`;
- `production`: `allowed`, `not_allowed`, `requires_license` or `unknown`;
- `contentUse`: `not_used`, `may_be_used` or `unknown`;
- an https `source` and a `verifiedAt` date.

The registry refuses a model:

- registered for `prod` when its terms do not allow production;
- active while it is `not_allowed` or `unavailable`;
- given anything above `public` data when its provider may use or keep what it is sent.

NVIDIA's model is therefore `free_prototyping`, `requires_license` and `may_be_used`, which means DEV only and `public` data only.

### 3. Cost: provider cost is not customer price

NVIDIA's price is recorded as zero per token, with the NIM FAQ as its source. That is the provider's cost under free prototyping access, which spends NVIDIA's trial credits, not money.

The existing cost engine computes it, and the existing usage event records it (`provider: nvidia`, the model, units, cost). It reaches the ledger and the financial feed like any call.

Credits follow D-12 unchanged: real cost at 1 credit = US$0.01, rounded up. A $0 call therefore charges 0 credits. A minimum charge would be a product decision, and is not made here.

### 4. `Retry-After`, for every provider

- **Reading the header.** `ProviderOutcome` gains `retryAfterMs` on `rate_limited`. `retryAfterMsOf()` reads the header, as seconds or an HTTP date, capped at a day.
- **Waiting within a call.** The gateway waits `max(backoff, Retry-After)` before trying the same model again, within the policy's attempts. A wait over 10 seconds goes to the next compatible model instead.
- **Routing.** The health tracker leaves the provider out of routing until `Retry-After` has passed.

No fixed limiter is configured, because NVIDIA publishes no numbers.

### 5. Discovery reports, never registers

`listNvidiaModels()` reads `GET /v1/models`. `catalogueDrift()` reports registered models NVIDIA no longer serves, and a count of unregistered ones.

The registry stays the reviewed, versioned list. The catalogue size is never hard-coded, and nothing is scraped.

### 6. Not integrated, and why

| Capability            | Why not                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Embeddings            | The gateway has no embeddings operation, and Company Brain has no vector store. The trial terms also rule out company data. |
| Speech                | Riva uses gRPC with a function id, and MelonOffice has no voice path.                                                       |
| Safety models         | There is no moderation capability in the registry.                                                                          |
| Vision and multimodal | There is no media path to NVIDIA.                                                                                           |
| Structured output     | NVIDIA documents it for self-hosted NIM, not for the hosted endpoint.                                                       |

Each would extend the existing gateway when decided.

## Consequences

- NVIDIA takes part in routing wherever a call's requirements, data and environment allow it. Other compatible models follow it as fallbacks.
- Today no product call reaches NVIDIA. GIA, conversations, Company Brain, decisions and documents send `confidential` data under policies that pin Gemini, and that is intended under NVIDIA's terms.
- Nothing changes in DEV until the owner creates the key's secret and applies `nvidia_api_key_secret`.

## Open

- **Production.** It needs a commercial path (a hosted subscription with an unpublished price, or NVIDIA AI Enterprise), data terms that do not let NVIDIA use content, and the owner's decision.
- **A live check and benchmark** in DEV with a real key, run by hand (`src/live.test.ts`).
- **Extracting the shared OpenAI-compatible translation** that DeepSeek and NVIDIA now both carry.
- **Embeddings, speech, safety and vision** through the gateway, if decided.
- **Customer credits for $0-cost calls**, which is a product decision.
