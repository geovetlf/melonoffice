# ADR-0088: Customer usage and billing reads, owner and platform screens (Commercial Platform phase 4a)

- Status: Proposed
- Date: 2026-09-30
- Builds on:
  - [ADR-0086](0086-commercial-authorization-and-persistence.md) (Geovet's "Admin y soporte" and "Solo plataforma")
  - [ADR-0087](0087-brand-config-and-domain-resolution.md) (domains)
  - [ADR-0074](0074-ai-usage-ledger.md) (the AI usage ledger)
  - [ADR-0022](0022-billing-foundation.md) (billing)
- Terraform: none. No new collection and no index.

## Context

Phase 4 is the partner and agency console, its backend and a minimal UI. Two things come first:

- Geovet decided that admins see a customer's summary, usage and billing, and support and managers see summary and usage. Phase 2 built only the summary.
- Every decision so far can only be taken through the API. The owner accepting a partner, and the platform administrator creating accounts and domains, both need screens before anyone can try this in DEV.

The partner and agency console itself (members, customers, brand) is phase 4b.

## Decision

1. **Two new commercial permissions**, in the one RBAC, each bound to a customer scope in `createCommercialAuthorization`:
   - `customer.read_usage` needs the `usage` scope. All four roles hold it.
   - `customer.read_billing` needs the `billing` scope. Only admins hold it.

   A missing scope is `scope_not_granted`; another account's customer is `cross_account`. Both are audited as `commercial.access` and answer `customer_forbidden`.

2. **`GET /v1/commercial/accounts/:id/customers/:organizationId/usage?from=&to=`** reads the one AI usage ledger's summary for that customer. It answers operations and credits, in total and by capability. It never answers who used them, which agent or department, provider, model or internal cost.
3. **`GET …/customers/:organizationId/billing`** answers who is billed (`billedTo`, from the relationship) and the subscription: plan, status and whether the plan is in force.
   - Billing gains one read, `subscriptionOf(organizationId)`, next to `currentPlan`, over the same checked read.
   - Nothing here moves credits or changes billing.
4. **The owner's screen, `/settings/partners`.** It appears in the sidebar for `relationship.read`.
   - It lists requests and relationships with each account's name, kind, mode and status.
   - A request is accepted with only the scopes the owner ticks. Nothing is ticked at first, and the scopes offered are only those asked for.
   - Company memory, conversations and support are marked as the company's own content.
   - Active scopes can only be narrowed.
   - Declining or ending asks for confirmation first.
   - Without `relationship.manage` the screen shows everything and changes nothing.
5. **The platform administrator's section in `/platform`:**
   - Create a partner or agency account with its first admin and limits. "Use my id" fills in the administrator's own user id.
   - Register a domain for an organization or an account.
   - Move a domain only along the statuses the API allows: verified before active.

   The API's refusal code and field are shown as they come.

## Consequences

- Tests:
  - API, on memory and Firestore: usage and billing only with their scopes; support reads usage, never billing; no provider, model, cost or person in the answer; bad dates are 400; refusals are audited.
  - RBAC: the new permissions and their scopes.
  - Billing: `subscriptionOf`.
  - Web: the owner's decisions and the platform forms.
- Nothing changes for an organization without relationships. The new sidebar entry is shown only to owners.
- **Still to come (phase 4b):**
  - the partner and agency console: account, members, customers, customer summary, usage and billing, brand;
  - the owner's brand screen.
- **Still waiting on Geovet:** a partner creating its customer's organization needs owner invitations by email, which are not approved (ADR-0086).
- A first admin is chosen by user id: MelonOffice has no lookup by email yet.
- **DEV:** nothing to apply. For `/platform` to show these tools, the platform administrator's id must be in `platform_admin_user_ids` (ADR-0082).
