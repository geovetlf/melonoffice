# ADR-0100: Harness block 2: preferred providers, fallback and task budget

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0099](0099-melon-agent-harness.md) (Harness block 1), [ADR-0072](0072-llm-router.md) (LLM Router), [ADR-0080](0080-nvidia-provider.md) (NVIDIA), [ADR-0081](0081-customer-credit-pricing.md) (customer credits)
- Terraform: none. Firestore: one optional field (`maxCredits`) on `agentTasks`; no migration, old tasks read as having no budget.

## Context

Geovet's Harness brief (§5-9, §27-29) asks for:

- dynamic model routing;
- NVIDIA as the first provider evaluated when it fits, never the only one;
- recorded fallback to another provider;
- a per-task budget with the existing Credits engine.

Block 1 (ADR-0099) already gives the router a strategy per task. What was missing:

- The router could prefer a model, but not a provider.
- A policy could not set a minimum quality.
- A task had no budget of its own.

## Decision

### 1. Preferred providers, in the existing policy and router

- `ModelPolicy.preferredProviders` lists providers to evaluate first, in order.
- The router orders by the policy's `preferred` models first, then by preferred providers, then by the routing strategy.
- A preferred provider is only an order. Its models are still left out by every rule: capability, modality, requirements, allowed providers and models, status, environment, data sensitivity, quality, latency, cost limit and availability. The models that remain are the fallback, in strategy order.
- There is no `if provider == nvidia` anywhere. NVIDIA becomes the first provider evaluated where a policy lists it.
- NVIDIA's registry entry is unchanged: DEV only, `public` data only, as its trial terms require.
- **This ADR changes no configured policy.** Which tasks may prefer NVIDIA is Geovet's decision (asked 2026-09-30). The agent tasks' data is `confidential`, so no policy could send it to NVIDIA today anyway.

### 2. A quality floor per policy

- `ModelPolicy.minimumQuality` sets the lowest quality any call under the policy may use.
- The router applies whichever is higher: this floor or the quality the call asks for.
- No configured policy sets one. With only Gemini 2.5 Flash-Lite (`basic`) approved, a floor would refuse calls.

### 3. Fallback

The gateway already falls back on transient errors when the policy says `fallback: 'compatible'`. It records `fallbackFrom` in the response, the audit and the usage event (ADR-0072, ADR-0081).

A fallback from a preferred provider is the same mechanism: the next candidate under the same policy, data rules and credits. Nothing new is recorded or built.

### 4. Task budget, in credits, with the Credits engine

- A task may carry `maxCredits`, a whole number from 1 up. It can be given:
  - to the Harness (`POST .../harness/tasks`);
  - to an agent directly (`POST .../specialists/:id/tasks`).
- The budget is stored on the task and is part of the task's identity. The same idempotency key with another budget is `idempotency_conflict`.
- The Harness caps each model call of the task (`AIRequest.maxCredits`) at what is left: the budget minus what the task's calls already spent.
  - Agent tasks make one call today, so the cap is the whole budget.
  - `spent` is the hook for block 3's multi-step tasks.
- The AI Gateway enforces the cap:
  - It tries only models whose estimated credits fit, so a cheaper model serves when the preferred one would exceed the cap.
  - When none fits, it refuses with `credit_limit_exceeded`, which becomes the task's failure code. Nothing is spent.
- Asking for more budget means asking again with a larger one. An "authorize and continue" step belongs to block 3's multi-step tasks.
- A budget above the balance is allowed, with reason `budget_above_balance`: the balance still limits every call.
- No second credits system, no hold, no price and no default budget are introduced. Default budgets per plan or company would need numbers only Geovet can set (D-12).

### 5. Costs

Provider cost stays the AI Usage Layer's (`cost.actualMicroUsd`, the usage event). Customer credits stay `CustomerCreditPolicy`'s.

The Harness adds no price. A provider with no known price stays refused, including a $0 one, per ADR-0081.

## Consequences

- MelonOffice can prefer a provider per policy and fall back automatically, with the fallback recorded. It can keep a task within a budget, reusing the router, the gateway and the Credits engine.
- The platform administrator's AI view (ADR-0082) shows `preferredProviders` and `minimumQuality` for each policy.
- Open for Geovet: which tasks and data NVIDIA goes first for, and whether plans or companies get default task budgets.
