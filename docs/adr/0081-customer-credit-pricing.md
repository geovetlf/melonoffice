# ADR-0081: Customer credit pricing kept apart from provider cost

- Status: Proposed (Geovet, 2026-09-29 17:20Z, after PR #88)
- Date: 2026-09-29
- Builds on: [ADR-0073](0073-ai-usage-layer.md) (cost engine and usage events), [ADR-0074](0074-ai-usage-ledger.md) (usage ledger and financial contract), [ADR-0080](0080-nvidia-provider.md) (NVIDIA).
- Terraform: none.

## Context

Geovet asked to keep two variables apart for every AI operation, of any capability:

- **providerCost**: what the operation costs MelonOffice. It comes from the Cost Engine's `CostResult` (`cost.actualMicroUsd`).
- **customerCreditCost**: what the customer is charged. It is recorded as `credits` on the usage event, and the credits ledger stays the only charge.

A call on NVIDIA's free endpoint has providerCost 0. For now its customerCreditCost is also 0, and no minimum is charged. The usage is still recorded in full. Later it must be possible to change customerCreditCost through a pricing policy, without touching any provider adapter.

Before this ADR, the gateway computed credits inline as `ceil(cost / rate)`. It was outside the adapters, but no policy seam existed and the event did not say which rule priced it.

## Decision

1. **`CustomerCreditPolicy`** lives in `packages/ai-usage`, next to the Cost Engine, and is capability-agnostic.
   - Its input is capability, provider, model, operation and providerCost.
   - It returns whole, non-negative credits.
   - `customerCreditsOf` checks the answer.
2. **The default is `providerCostCreditPolicy(rate)`**: providerCost at the approved rate (D-12, 1 credit = US$0.01), rounded up. This is exactly the previous behaviour, so 0 cost gives 0 credits.
3. **The gateway takes an optional `credits.policy`.** Without one, it uses the default at `credits.rate`, which is how the API and the worker run today. The policy prices both the pre-call estimate (routing and balance check) and the real charge.
   - A policy that cannot price a model keeps the call away from that model (`price_unknown`).
   - A policy that cannot price the real charge fails the call (`credits_charge_failed`), so it is never passed on unpriced.
4. **Every usage event records two new fields.** The ledger validates both.
   - `creditPolicy {id, version}`: which rule priced its credits.
   - `fallbackFrom`: the model first tried, when a fallback answered.

Adapters are unchanged and never price credits. No second cost engine, ledger, wallet or billing was created.

## What a usage event already carries

- **Capability, provider, model and operation:** capability, provider, model, modelVersion and operation.
- **Request id:** requestId.
- **Company and tenant:** attribution.organizationId.
- **User and actor:** attribution.userId and attribution.actor.
- **Agent:** attribution.specialistId.
- **Department and workflow:** attribution.departmentId and attribution.workflowId.
- **Execution or task:** attribution.executionId and attribution.taskType.
- **Usage in the capability's own units, tokens when they exist:** cost.usage.
- **Provider cost:** cost.actualMicroUsd, with costBasis and the pricing version.
- **Customer credit cost:** credits, with creditPolicy.
- **Time:** occurredAt.
- **Status:** outcome.
- **Fallback:** fallbackFrom.

The daily totals keep `costMicroUsd` and `credits` as separate sums. Together they tell AI that is free for MelonOffice apart from AI that is charged to the customer.

## Consequences

- A minimum charge, a price per capability, or a paid rule for a free provider is a new `CustomerCreditPolicy`, passed to the gateway. It needs no adapter or GIA change. Choosing one is a product decision (open).
- Failed calls are audited (`ai.request_failed`) and logged, but they are not usage events yet, because no usage is measured for them. This is open if the Financial Backend needs them.
