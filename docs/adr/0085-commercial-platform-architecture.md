# ADR-0085: Commercial Platform architecture: one core, commercial layers above the tenant

- Status: Proposed (Geovet's brief "Commercial Platform / Multi-model B2B foundation", 2026-09-29 21:23Z). Phase 1 of 6.
- Date: 2026-09-29
- Builds on:
  - [ADR-0018](0018-tenancy-and-memberships.md) (tenancy)
  - [ADR-0019](0019-rbac-foundation.md) (RBAC)
  - [ADR-0020](0020-audit-log-foundation.md) (audit)
  - [ADR-0022](0022-billing-foundation.md) (billing)
  - [ADR-0023](0023-credits-foundation.md) (credits)
  - [ADR-0066](0066-event-system.md) (events)
  - [ADR-0081](0081-customer-credit-pricing.md) (customer credit policy)
  - [ADR-0082](0082-ai-providers-platform-admin-only.md) (platform administrator)
- Terraform: none.

## Context

MelonOffice must be able to sell and deliver the same product in six ways: Direct SaaS, Reseller, White Label, Managed AI (Agency), OEM (Embedded API) and Enterprise private instance. It has to do this without a second product, backend, billing, credits, AI Gateway, auth, tenancy, audit or RBAC.

### Audit of the repository (main `e2eb442`, 2026-09-29)

Nothing commercial exists yet. There is nothing to extend, and nothing is duplicated:

- **Partner, reseller, agency, white label, wholesale, commission, API consumer, API key for customers, OAuth, enterprise, dedicated, brand config, domain binding:** no code.
  - The only matches are unrelated. `agency` appears as a business type (ADR-0048) and a pipeline template (ADR-0054).
  - "API key" appears only as provider credentials in Secret Manager (AI Gateway) and the Identity Platform web key.
  - The Google OIDC `service-identity` verifier authenticates Cloud Tasks and nothing else.
- **Tenancy.** `Organization` is the tenant. `resolveTenant()` is the only way into an organization: an active membership in an active organization, with a single `organization_forbidden` answer.
  - `organizationCreators/{userId}` limits each user to creating one organization, atomically (Firestore).
  - Contexts are issued through a `WeakSet`, so a copied or edited context authorizes nothing.
- **RBAC.** Roles are data (`ROLES`, `owner` only, D-22). `authorize()` refuses any context not issued by `resolveTenant()`.
- **Platform administrator.** It is configuration (`PLATFORM_ADMIN_USER_IDS`, ADR-0082), never a company role, and it is used only by `/v1/platform/*`.
- **Billing.**
  - One `BillingAccount` and one current `Subscription` per organization.
  - Plans are versioned catalogue entries resolved by entitlements.
  - There is no pricing catalogue, and no price in code.
- **Credits.**
  - One wallet per organization, with an append-only ledger. `grant`, `consume` and `refund` are server-side only.
  - ADR-0081 separates provider cost (`cost.actualMicroUsd`) from the customer's credit cost.
- **Audit.** `AuditEvent.organizationId` is optional, so an event outside any organization already fits. Targets and actions are closed lists.
- **Events.** `DomainEvent.organizationId` is required: every event belongs to one organization.
- **Web.**
  - `AppShell` builds every API client from `workspace.organization.id`.
  - `/platform` exists for the platform administrator only.
  - "MelonOffice" appears in 14 English messages and in the web shell as the product name.

## Decision

1. **One platform, one core.** Partner and Agency are commercial layers above the organization. White Label, OEM and Enterprise are delivery modes of a customer relationship. None of them is a separate product, backend or engine.
2. **Entity hierarchy.**

   ```
   Platform (MelonOffice; platform administrator = configuration, ADR-0082)
     └── Commercial Account (type partner | agency)            ← new, never an organization
           ├── Commercial Membership (user, role, status)       ← new
           └── Customer Relationship (organization, mode, scopes, status)  ← new
                 └── Organization / Tenant (unchanged)
                       └── Users (memberships), departments, agents, data (unchanged)
   ```

   An organization with no relationship is Direct SaaS and behaves exactly as today. One organization may have more than one relationship, for example a reseller and an agency, each with its own scopes.

3. **Authorization boundaries.** Every access checks, on the server, the authenticated user, then the commercial membership, then the relationship, then the target organization, then the permission.
   - `resolveCommercialContext()` accepts a person only (not GIA, not the runtime) with an active membership in an active account. Every refusal is `commercial_account_forbidden`.
   - `customerAccessOf()` needs an active relationship between that exact account and that exact organization, and an active organization. Every refusal is `customer_forbidden`. Knowing an organization id grants nothing.
   - A commercial context is not a tenant context. It is issued through its own `WeakSet`, and RBAC refuses it inside any organization (`unresolved_tenant`). A partner never becomes a member of a customer by being its partner.
   - **Scopes** are explicit and empty by default: `summary`, `usage`, `billing`, `branding`, `support`, `knowledge`, `conversations`. Company memory and conversations are separate scopes, granted only by the customer.
   - A relationship starts `pending` and grants nothing until an owner of the customer accepts it (`acceptedBy`).
4. **Direct SaaS is unchanged.** `resolveTenant()`, organization memberships and `organizationCreators/{userId}` stay as they are.
   - A partner or agency does not get around the one-organization rule by creating organizations.
   - Phase 2 decides how a commercial account brings in a customer: the customer creates its own organization and accepts the relationship, or the account creates it on the customer's behalf under the account's own limit (`CommercialLimits.customers`). Either way it is audited, and `organizationCreators` keeps working for Direct SaaS.
5. **Roles.** Commercial roles are names stored on the commercial membership. The names are `partner.admin`, `partner.support`, `agency.admin` and `agency.manager`.
   - Phase 2 adds their permissions to the existing RBAC as data. It is not a second engine.
   - `platform.admin` stays configuration (ADR-0082). `platform.support`, `tenant.*`, `api.client` and `enterprise.admin` are added to the same catalogue when something needs them.
6. **Billing and credits ownership.**
   - The customer organization keeps its own `BillingAccount`, subscription and credit wallet. Consumption always belongs to the customer, and every movement goes through the existing ledger.
   - The relationship only records who is billed (`billing: customer | commercial_account`).
   - The account carries a pricing profile reference and a commission configuration. The commission model is `wholesale`, `commission` or `revenue_share`, in whole basis points. It has no default and no constant anywhere: an account without one has no commission.
   - MelonOffice revenue, partner revenue, customer consumption and provider cost stay separate. Consumption and provider cost already come from `ai-usage` and credits (ADR-0081). Charges and allocations are derived later from the same records and never mutate balances.
7. **Branding precedence** (phase 3): platform branding → commercial account branding → customer branding → white-label branding. Each level is written only by its owner. "MelonOffice" stays as the technical identity (package names, audit source, platform views).
8. **Domain resolution** (phase 3): domain → commercial or tenant context → brand config → application configuration.
   - A `DomainBinding` has the states `pending_verification`, `verified`, `active` and `disabled`.
   - Only an `active` binding resolves, and only to the account or organization that owns it.
   - DNS and certificates come later.
9. **OEM / API** (phase 5): an `ApiConsumer` is bound to its commercial account and/or organization on the server. The consumer never picks a tenant, and scopes, rate limits, metering and audit apply. Platform admin, commercial account, API consumer, application, organization, end user and service identity stay separate identities.
10. **Enterprise** (phase 6): a `DeploymentProfile` per customer, `shared → isolated → dedicated`. Company Brain, the AI Gateway, billing, credits and the Agent Engine do not change when a customer moves between profiles.
11. **Audit and events.**
    - Audit gains the commercial targets and actions in phase 2, when something performs them. `organizationId` stays optional, and a `commercialAccountId` field is added then.
    - `DomainEvent.organizationId` is required. Making it optional would break every subscriber, so commercial-scope events are not put on the event bus yet. When one is needed, it gets a compatible envelope (a scope field defaulting to the organization), decided in its own ADR.
12. **Persistence** (phase 2): only the collections needed, `commercialAccounts`, `commercialMemberships` and `customerRelationships`. Ids are derived from the pairs (`{account}_{user}`, `{account}_{organization}`), so there is one record per pair. No existing record changes and no migration is needed.

### Phase 1 (this change)

- `@melonoffice/domain`: `CommercialAccount`, `CommercialMembership`, `CustomerRelationship`, `CustomerMode`, `CustomerAccessScope`, `BillingRelationship`, `PricingProfileRef`, `CommissionConfig` and `CommercialLimits`. Commercial fields are optional where compatibility needs it.
- `@melonoffice/tenancy`:
  - `resolveCommercialContext()`, `customerAccessOf()` and `listCustomersOf()`;
  - the id helpers and parsers (name, scopes, commission);
  - the status transitions;
  - the `CommercialStore` interface and `InMemoryCommercialStore` for tests;
  - five new error codes, mapped to 400 or 403 in the API.
- Tests cover the brief's security cases this phase can answer: 2, 3, 4, 5, 6, 7, 8, 9, 14 and 15. Cases 1, 10, 11, 12 and 13 need phases 2, 3 and 5, and each of those phases adds its own tests.

## Consequences

- Nothing changes for any existing user, organization, billing account, wallet, document, conversation or memory. There are no writes, routes or screens in phase 1.
- Phase 2 needs these decisions from Geovet before code:
  - how a commercial account brings in a customer (point 4);
  - the permissions of each commercial role;
  - who creates commercial accounts (the platform administrator only is the proposed default).
- Pricing profiles and commission values are data that Geovet provides. None is invented.
