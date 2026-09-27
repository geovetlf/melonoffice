# @melonoffice/billing

The billing foundation ([ADR-0022](../../docs/adr/0022-billing-foundation.md)). It holds each organization's commercial relationship and decides which plan is in force. Entitlements resolves that plan into capabilities and limits. Server only, with no HTTP.

- `lifecycle.ts`: subscription statuses, their allowed transitions, `transition()` and `changePlan()` (both pure), and which statuses put a plan in force (`trialing`, `active`).
- `account.ts`: `openBilling()`, the account and first `active` subscription a new organization gets, written with it.
- `store.ts`: the read-only `BillingStore` port and a memory implementation for tests.
- `service.ts`: `createBillingService()`, with `billingOf(tenant)` for a resolved `TenantContext` and `currentPlan(organizationId)` for entitlements.

There is no payment processing, provider, webhook, credits or metering here. Card, bank and payment token data belong to the payment provider and are never stored.
