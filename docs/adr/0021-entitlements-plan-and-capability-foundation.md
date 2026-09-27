# ADR-0021: Entitlements, plan and capability foundation

- Status: Proposed (Phase 2F, pending Geovet's review)
- Date: 2026-09-27
- Plan source superseded by: [ADR-0022](0022-billing-foundation.md) (the plan now comes from the billing subscription, not from `Organization.plan`)
- Builds on: [ADR-0007](0007-plans-entitlements.md), [ADR-0013](0013-entitlements-core.md), [ADR-0018](0018-tenancy-and-memberships.md), [ADR-0019](0019-rbac-foundation.md), [ADR-0020](0020-audit-log-foundation.md)

## Context

ADR-0013 built the entitlement registry, the versioned plan catalogue and the resolver, but nothing tied them to a real organization. Organizations (ADR-0018) had no plan, and RBAC (ADR-0019) answers only what a member may do. Phase 2F connects an organization to its plan and answers what that plan allows, without billing and without merging it into RBAC.

## Decision

### Separate concerns

Each module answers one question, and a caller that needs several asks each one:

| Module       | Question                                                      |
| ------------ | ------------------------------------------------------------- |
| Auth         | Who is calling?                                               |
| Tenancy      | In which organization, through which membership?              |
| RBAC         | May this member do this? (permission)                         |
| Entitlements | Does this organization's plan include it? (capability, limit) |
| Audit        | What happened?                                                |
| Billing      | Not built. Who pays, and for what?                            |

There is no combined authorization engine. The `authorize()` function from ADR-0013, which combines permission and entitlement, stays in the package but no route uses it. A feature that needs a permission and a capability asks RBAC and the entitlement service separately; both must allow. Tests prove the four cases: permission without capability, capability without permission, and neither are denied; only both allows.

### Plan model: reuse ADR-0013

- The plan ids already in the repository are kept: `entrepreneur` (Emprendedor, active), `business` (Empresa, prepared) and `corporate` (Corporativo, prepared). Each has an id, a version, a status, visibility, purchasability and its entitlements. Display names and descriptions live in i18n when a screen needs them, not in the catalogue.
- **Capabilities** are the `feature` keys of the entitlement registry (for example `gia.text`, `automations.enabled`). **Limits** are its `limit` keys (for example `users.max`, `agents.max`). No capability or limit was invented for this phase: the catalogue is the registry, in code.
- Emprendedor still defines only `users.max = 1` (D-22). Every other value is pending (D-12), so every capability is off and every other limit is 0. Nothing here sets prices, credits, voice or payments.
- The catalogue is static and versioned in code. A change is a new version; an organization keeps pointing at the version it has.

### Assignment: Organization → plan reference

- The organization stores only a reference, `plan: { id, version }` (Firestore: a `plan` map on `organizations/{id}`). What the plan grants is read from the catalogue in code.
- `createOrganization()` requires the plan. The API passes `DEFAULT_PLAN` (Emprendedor v1). The client cannot choose it: `POST /v1/organizations` reads only `name`, and any `plan`, `planId`, `capabilities`, `entitlements` or `limits` in the body is ignored.
- The plan is written in the same Firestore transaction as the organization, the owner membership, the creator record and the creation's audit events.
- There is no magic fallback. An organization with no plan (only possible for records written before this change) is entitled to nothing (`plan_missing`). It is never treated as Emprendedor.
- There is no endpoint to change a plan: no upgrade, downgrade, trial or cancellation. Today a plan changes only through a reviewed change to the data. When Billing exists, it may become the authority that sets the reference; the entitlement service will not change, because it only reads the reference.

### EntitlementService (`packages/entitlements/src/service.ts`)

- `entitlementsOf(tenant)`, `hasCapability(tenant, capability)` and `getLimit(tenant, limit)`. No HTTP, deterministic for the same stored data, server side only.
- It accepts only a `TenantContext` issued by `resolveTenant()` (the same WeakSet check RBAC uses). The organization always comes from that context; no method takes an organization id.
- It re-reads the organization each call, so a suspended organization or a changed plan applies at once.
- Every answer is explicit. `unavailable` reasons: `unresolved_tenant`, `organization_inactive`, `plan_missing`, `plan_unknown`, `plan_inactive` (a prepared plan grants nothing). Per call: `unknown_capability`, `not_entitled`, `unknown_limit`. An unset limit is 0, never unlimited. Results are frozen.
- The package is now server only (it depends on tenancy); the lint rules forbid importing it from the web app.

### GIA

GIA has no entitlements of its own and no bypass (`giaUnlimited`, `giaPremium`, `giaAdmin` do not exist and are answered `unknown_capability`). The service ignores the actor: GIA acting for a user gets exactly that user's organization's answer.

### API

- `GET /v1/organizations/:organizationId/entitlements`, through `withPermission('entitlement.read')`: tenancy resolves the organization from the caller's membership, RBAC checks the permission, then the service answers. Query parameters, headers and bodies are ignored.
- `200` with `{ organizationId, status: 'active', plan: { id, version }, capabilities: { key: boolean }, limits: { key: number | 'unlimited' } }`. These are ceilings, not usage: nothing is metered or counted.
- `200` with `{ organizationId, status: 'unavailable', reason }` when there is no usable plan, logged as a warning.
- 401 and 403 exactly as other organization routes. Denials are audited as before (`tenancy.resolve`, `authorization.check`).

### RBAC

One permission is added to the catalogue, `entitlement.read`, and to `owner`. No role is added.

### Audit

- New action `plan.assign` (category `entitlements`, result `success`), recorded with the initial plan in the creation transaction, next to `organization.create` and `membership.create`.
- New structured event field `plan: { id, version }`, stored as `planId` and `planVersion`.
- Reading entitlements is not audited, like other allowed reads (ADR-0020).

## Not in this change

Billing, Stripe, payments, subscriptions, invoices, a credits wallet, metering, a usage ledger, overage, proration, trials, cancellation, plan administration, new roles, `limitMap` and `list` entitlements in the API, and any usage check. Terraform does not change: the plan is a field on an existing collection and needs no index.

## Consequences

- Every organization created from now on has an explicit plan, and every capability or limit question has one place to go.
- Organizations created before this change (dev only) answer `plan_missing` until their plan is set by a reviewed data change. Dev had no organizations after the Phase 2B cleanup, so none are expected.
- Enabling a capability for Emprendedor needs a D-12 decision and a catalogue change, never code that checks a plan id.
