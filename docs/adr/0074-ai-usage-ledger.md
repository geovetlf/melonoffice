# ADR-0074: The AI Usage Ledger and the Financial Integration Contract (U1)

- Status: Proposed (U1, the next block after [ADR-0073](0073-ai-usage-layer.md); pending Geovet's review)
- Date: 2026-09-29
- Builds on:
  - [ADR-0073](0073-ai-usage-layer.md) (the usage and cost contract, the AI Cost Engine);
  - [ADR-0023](0023-credits-foundation.md) (credits, the only charge);
  - [ADR-0061](0061-commercial-list-pagination.md) (paging, and reading without a missing index).
- Terraform: one Firestore composite index, `aiUsageEvents (organizationId, occurredAt desc)`, DEV only. **Not applied.** Until it exists the event list is read without it (at most 500) and `firestore.index_missing` is logged; the summaries need no index.

## Context

ADR-0073 gave every AI capability one usage event and one cost engine, but nothing kept the events. The owner needs to know what AI costs in total and per company, user, agent, department, workflow, task, capability, provider, model and single operation, and the future Financial Backend needs one contract to read.

## Decision

### 1. The ledger

`packages/ai-usage` `createAIUsageLedger(store)` is an `AIUsageSink`. It checks each event (codes and numbers only) and keeps it. In Firestore (`FirestoreAIUsageStore`), one transaction:

- creates `aiUsageEvents/{eventId}` once: the id comes from the operation, so a repeat changes nothing (`replayed`);
- adds the event to `aiUsageDays/{organizationId}_{YYYY-MM-DD}`, the organization's totals for that UTC day, so totals and events never disagree.

Each day holds totals (operations, cost, unpriced operations, credits) in total and by dimension (capability, provider, model, operation, actor, user, agent, department, workflow, task type), plus each capability's quantities in its own units. An operation whose price is unknown is counted as unpriced and never given a cost.

It charges nothing. The credits ledger stays the only charge; the event records the credits charged.

### 2. Who records

The AI Gateway, in the API and in the worker, records every completed model call through the ledger. Any future AI engine records through the same sink. A failed record never fails the call; it is logged.

### 3. The Financial Integration Contract

The Financial Backend reads two shapes, both in `@melonoffice/domain`:

- `AIUsageEvent` (ADR-0073), one per operation;
- `AIUsageSummary`: scope (an organization or `platform`), UTC day range, currency, totals, totals by every dimension, and quantities per capability.

A summary covers at most 92 days, so it reads a bounded number of day documents.

### 4. Who reads

- `GET /v1/organizations/:id/ai-usage?from=YYYY-MM-DD&to=YYYY-MM-DD` returns the organization's summary; the default is today (UTC).
- `GET /v1/organizations/:id/ai-usage/events?limit=&cursor=` returns its operations, newest first, 50 per page by default and at most 100.
- Both need the new permission `ai_usage.read`, which the owner role has. Another organization's usage is never read.
- The whole platform is an operator tool, never a route. `node apps/api/dist/ai-usage-report.js <from> [to]` is run by the owner in Cloud Shell with their own credentials. It prints the platform summary and totals per organization.

## Consequences

- Every Gemini call in DEV now leaves a usage event and updates its day's totals.
- A day's totals document is written by every call of that organization on that day. That is fine at today's volume; a busy organization would need sharded counters (not built).
- Content never enters the ledger: prompts, answers and customer data are not in the event.

## Open

- Apply the index in DEV (owner's word).
- A web view of AI usage and cost for the owner.
- The Financial Backend itself: billing, payments, expenses, revenue and margin reading this contract.
- Failed operations that providers still charge for: the event supports `failed`, but no engine emits it yet.
