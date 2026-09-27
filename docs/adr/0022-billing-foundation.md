# ADR-0022: Billing foundation, subscription and plan authority

- Status: Proposed (Phase 2G, pending Geovet's review)
- Date: 2026-09-27
- Builds on: [ADR-0018](0018-tenancy-and-memberships.md), [ADR-0019](0019-rbac-foundation.md), [ADR-0020](0020-audit-log-foundation.md), [ADR-0021](0021-entitlements-plan-and-capability-foundation.md)

## Context

ADR-0021 stored the plan reference on the organization and noted that Billing could later become the authority. Phase 2G adds the commercial model, a billing account and a subscription, and decides where the plan comes from. It builds no payment processing, credits or metering.

## Decision

### Boundary

| Module       | Question                                                                             |
| ------------ | ------------------------------------------------------------------------------------ |
| Auth         | Who is calling?                                                                      |
| Tenancy      | In which organization, through which membership?                                     |
| RBAC         | May this member do this?                                                             |
| Billing      | What commercial relationship does the organization have, and which plan is in force? |
| Entitlements | What does that plan include?                                                         |
| Audit        | What happened?                                                                       |

Billing decides the `PlanRef`. Entitlements resolves it into capabilities and limits. Billing copies no capability or limit, and entitlements picks no plan. Each is asked separately; there is no combined engine.

### Organization is the commercial unit

There is no billing per user. `packages/billing` holds the model and rules, with no HTTP:

- **BillingAccount** `{ organizationId, subscriptionId, createdAt, updatedAt }`. One per organization, keyed by the organization's id. It is needed because it is what guarantees "at most one current subscription": it points at the subscription in force, and Firestore `create` on its id refuses a second account. It is also where a future provider's customer id will live.
- **Subscription** `{ id, organizationId, plan, status, createdAt, updatedAt }`. Its own record, so a later subscription never overwrites an earlier one's history.
- **SubscriptionStatus**: `trialing`, `active`, `past_due`, `canceled`. The types live in `@melonoffice/domain` with the other entities.

### Lifecycle

`transition(subscription, to, at)` allows only:

| From       | To                     |
| ---------- | ---------------------- |
| `trialing` | `active`, `canceled`   |
| `active`   | `past_due`, `canceled` |
| `past_due` | `active`, `canceled`   |
| `canceled` | nothing (final)        |

It is pure and deterministic: it returns a new frozen subscription and never modifies the given one, so a refused transition (`invalid_transition`) changes nothing. Unknown statuses are refused. `changePlan()` works the same way and refuses a canceled subscription. The catalogue `SUBSCRIPTION_TRANSITIONS` is data; a status is added there with its transitions.

**Plan in force:** only `trialing` and `active`. `past_due` and `canceled` put no plan in force, so entitlements deny everything (`plan_missing`). Whether `past_due` gets a grace period is a pending product decision; until then the safe answer is deny.

### Plan authority and the transition from Phase 2F

The code allowed billing to become the only source now, without a migration, so it did:

- **Before (2F):** creating an organization stored `plan` on `organizations/{id}`, and entitlements read it there.
- **Now (2G):** creating an organization runs `openBilling(organization, DEFAULT_PLAN)`. That builds the account and an `active` subscription on Emprendedor v1, written in the **same Firestore transaction** as the organization, the owner membership, the creator record and the audit events. Entitlements gets the plan from billing through a small `PlanSource` port (`currentPlan(organizationId)`), which billing implements.
- `Organization.plan` was removed from the model and is no longer written. A `plan` field left on an organization document by 2F is ignored, so there is only one source.
- The plan is always the server's choice. `POST /v1/organizations` reads only `name`; any plan, status, subscription or account in the body is ignored.
- **Organizations without billing:** only those created while 2F was deployed can have none. They get `billing_missing` from billing and `plan_missing` from entitlements. No subscription is invented and nothing is granted. Giving them billing is a reviewed data change, if any exist (none are expected in dev).
- There is still no trial, upgrade, downgrade or cancellation operation. The lifecycle functions exist for the provider sync that will call them.

### Payment provider (future, not built)

No provider is integrated and no `BillingProvider` interface is created: there is no caller yet, and an interface without one would be guesswork. When a provider is chosen, the flow will be:

Provider → webhook → signature verification → idempotency by the provider's event id → billing domain (`transition`, `changePlan`) → entitlements (reads the new plan) → audit (`billing.subscription_changed`, `billing.subscription_canceled`).

**Payment data belongs to the provider.** MelonOffice never stores card numbers (PAN), CVVs, bank credentials or payment tokens, now or later. At most, it will store the provider's opaque customer and subscription ids.

### Tenant security

- `billingOf(tenant)` accepts only a `TenantContext` issued by `resolveTenant()`, and takes the organization from it. A suspended or revoked membership has no context. A suspended organization gets `organization_inactive`.
- Stored records are checked, not trusted. A subscription that is not the organization's, has an unknown status or a malformed plan is refused (`subscription_invalid` in memory; Firestore refuses the record on read). It is never repaired or used.
- Reasons: `unresolved_tenant`, `organization_inactive`, `billing_missing`, `subscription_missing`, `subscription_invalid`.

### RBAC

New permission `billing.read`, given to `owner`. No `billing.write`, `billing.admin` or `billing.manage`, since nothing needs them. No new role.

### API

`GET /v1/organizations/:organizationId/billing`, through `withPermission('billing.read')`. It returns:

- `{ organizationId, status: 'present', subscription: { id, plan, status, createdAt, updatedAt }, planInForce }`, or
- `{ organizationId, status: 'unavailable', reason }`.

There are no payment, checkout, subscription-change or webhook routes; they answer 404. Query parameters, headers and bodies are ignored. Without a billing store, the billing and entitlement routes answer 503 `billing_not_configured` (fail closed).

### Firestore

- `billingAccounts/{organizationId}`: `subscriptionId`, `createdAt`, `updatedAt`. The id makes one account per organization.
- `subscriptions/{subscriptionId}`: `organizationId`, `plan { id, version }`, `status`, `createdAt`, `updatedAt`. A separate collection keeps each subscription's history.
- The subscription is not duplicated inside the organization.
- Both are written with `create` in the organization's creation transaction. The application only reads them afterwards.
- No index and no Terraform change: they are read by id only.

### Audit

The existing AuditService records a new action, `billing.subscription_created` (category `billing`), with the subscription as target (new target type `subscription`) and its plan. It is written in the creation transaction, next to `organization.create`, `membership.create` and `plan.assign`. `billing.subscription_changed` and `billing.subscription_canceled` are not in the catalogue yet, because no code changes or cancels subscriptions; they will be added with the code that does. Reading billing is not audited, like other allowed reads.

## Not in this change

Stripe, Mercado Pago, PayPal or any provider; payment processing, checkout, invoices, taxes and refunds; cards; real webhooks; credits, wallet or ledger; metering, usage, overage or proration; real trials; a billing UI; new roles; Terraform changes.

## Consequences

- There is one source for the plan: the current subscription in billing.
- Entitlements is unchanged in what it resolves; only where the reference comes from changed.
- Activating a provider later means calling the existing lifecycle functions from a verified webhook, not changing entitlements.
