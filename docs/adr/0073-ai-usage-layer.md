# ADR-0073: The AI Usage Layer: one usage and cost contract for every AI capability

- Status: Proposed (Geovet's "AI Usage Financial Architecture" direction, 2026-09-29 06:58Z to 07:01Z; pending review)
- Date: 2026-09-29
- Builds on:
  - [ADR-0023](0023-credits-foundation.md) (credits, the only charge today);
  - [ADR-0027](0027-ai-gateway-and-provider-registry.md) (the AI Gateway);
  - [ADR-0072](0072-llm-router.md) (the LLM Router, the first source).
- Terraform: none. Nothing is stored yet: the usage ledger is the next block (U1).

## Context

MelonOffice will use many kinds of AI, not only language models: images, video, audio and music, speech in both directions, voice, documents and OCR, vision, embeddings and search, browser and computer use, avatars, 3D, presentations and code. Each has its own unit of consumption and its own pricing: tokens, images, seconds, characters, pages, queries, actions, sessions, often with a resolution or tier.

The future Financial Backend must answer what AI costs in total and per company, user, agent, department, workflow, task, capability, provider, model and single operation. It must not need a new financial system for each new capability. The LLM Router is one source of usage among many.

## Decision

### 1. One contract, in `@melonoffice/domain`

- **`AIUsageEvent`**: one operation's usage. It carries its attribution, capability, provider, model and version, operation, outcome, `CostResult`, credits charged, the engine that served it and the request id. Its id is deterministic, so a repeat is the same event. It holds no content and no secrets.
- **`AIUsageAttribution`**: organization, user, actor (user, GIA, runtime or system), agent (specialist), department, workflow, execution (task), task type and subject. Only what is known is set; nothing is inferred.
- **`AIUsage`**: quantities in the capability's own units (`{ unit, quantity }`, e.g. `input_tokens`, `images`, `seconds`, `characters`, `pages`), plus the dimensions the price depends on (e.g. `resolution: 1080p`). No universal unit.
- **`AIServicePricing`**: a model's or service's price as configuration. It lists unit rates (optionally per dimension), the calculator that reads them, and the version, effective date and source. It can be `unknown`.
- **`CostResult`**: capability, provider, model, operation, usage, units, estimated and actual cost, currency, pricing version, pricing effective date and cost basis.

A capability is an open id, not a closed type. `AI_USAGE_CAPABILITIES` lists the ones named so far.

### 2. One AI Cost Engine, calculators per price shape

`packages/ai-usage` holds the engine. It knows no unit; calculators do.

- `unit_rates` prices anything linear per unit. It sums exactly and rounds up once, so nothing is under-charged by rounding. It picks the most specific rate matching the usage's dimensions.
- A capability whose price has another shape registers its own calculator in the same engine; it does not add an engine.
- An unknown price, or a unit the price does not list, gives no cost (`price_unknown`), never a guess.

Language models are priced through it: their token prices and counts become unit rates and quantities (`input_tokens`, `cached_input_tokens`, `output_tokens`). The gateway's `costMicroUsd` now calls the engine, and every existing cost is unchanged.

### 3. Every engine emits the same event

An engine that serves an AI capability emits an `AIUsageEvent` to an `AIUsageSink`. The AI Gateway (the LLM Router) is the first: it emits one event per completed call, attributed with the execution, agent, department, workflow and task type, or with the record a person asked about. A failed emit never fails the call. A denied call emits nothing.

The flow for any capability is: capability → provider → model or service → operation → usage units → provider cost → financial integration. Adding a capability means registering the capability, provider, model or service and pricing, adding a calculator only if the price shape is new, and emitting the event.

### 4. What stays as it is

The existing credits ledger stays the only charge. The event records the credits charged; it does not charge. No second billing, credits or telemetry system is added.

## Consequences

- Any new AI engine (image, video, voice and so on) reports usage and cost in the same shape as language models, with no financial code of its own.
- Until U1, the gateway takes a sink but none is wired in the API or worker, so events go nowhere yet. Logs and audit keep recording each call as before.

## Next (U1, [ADR-0074](0074-ai-usage-ledger.md))

- A persistent, append-only AI usage ledger per organization that the sink writes to, idempotent by event id.
- Queries by every attribution dimension, capability, provider and model.
- The Financial Integration Contract the Financial Backend reads.
- It needs a Firestore collection and composite indexes (Terraform, DEV only, applied only on the owner's word).
