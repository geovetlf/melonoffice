# ADR-0086: Commercial authorization and persistence (Commercial Platform phase 2)

- Status: Proposed. Geovet decided on 2026-09-29:
  - 22:52Z "Ambas": both ways of bringing in customers;
  - 22:53Z "Admin y soporte": the role permissions;
  - 22:54Z "Solo plataforma": who creates accounts.
- Date: 2026-09-29
- Builds on:
  - [ADR-0085](0085-commercial-platform-architecture.md) (the commercial model)
  - [ADR-0019](0019-rbac-foundation.md) (RBAC)
  - [ADR-0020](0020-audit-log-foundation.md) (audit)
  - [ADR-0082](0082-ai-providers-platform-admin-only.md) (platform administrator)
- Terraform: none. There are three new Firestore collections, written only by the API. Every query is an equality on one or two fields, so no composite index is needed.

## Context

Phase 1 defined partner and agency accounts, their members and their customer relationships as a model with no storage and no routes. Phase 2 makes them real, and the brief sets the rules:

- the backend checks the authenticated user, then the commercial membership, then the relationship, then the target organization, then the permission;
- the existing RBAC and audit are extended, never duplicated;
- Direct SaaS does not change.

Geovet decided three things:

1. **Customers come in both ways.** Either the customer creates their own organization and its owner accepts the partner, or the partner creates it. Either way, the owner accepts before any access.
2. **"Admin y soporte".**
   - Admins run their team, invite or create customers, and see the summary, usage and billing a customer granted.
   - Support and managers only read the summary and usage.
3. **"Solo plataforma".** Only the platform administrator creates partner and agency accounts and names their first admin.

## Decision

1. **RBAC, extended.** The one permission catalogue gains:
   - `relationship.read` and `relationship.manage`, which the organization `owner` role holds;
   - `commercial.read`, `commercial.manage_members`, `commercial.invite_customer` and `customer.read_summary`, which no organization role holds.

   `COMMERCIAL_ROLES` is data, like `ROLES`:
   - `partner.admin` and `agency.admin` hold all four commercial permissions;
   - `partner.support` and `agency.manager` hold `commercial.read` and `customer.read_summary`.

   `createCommercialAuthorization().authorize(context, permission, access?)` is the same engine applied to a commercial context. It refuses, in order:
   - an unknown permission;
   - a context not issued by `resolveCommercialContext()`;
   - an unknown role;
   - a role of the other account type (`agency.*` in a partner);
   - a permission the role lacks;
   - for a read inside a customer, an access that belongs to another account (`cross_account`) or a scope the customer did not grant (`scope_not_granted`).

2. **Storage.** The collections are `commercialAccounts/{id}`, `commercialMemberships/{account}_{user}` and `customerRelationships/{account}_{organization}`.
   - Each write runs in one Firestore transaction with its audit events.
   - A write names the version it read (`updatedAt`); a stale one is `commercial_conflict`.
   - The account's limits (`customers`, `members`) are counted in the same transaction (`commercial_limit_reached`). An account without a limit can add nothing.
   - Stored records are checked when read, and a malformed one is refused, never used.

3. **Routes.**
   - **Platform administrator** (`PLATFORM_ADMIN_USER_IDS`), GIA never included:
     - `GET` and `POST /v1/platform/commercial-accounts` create an account with its limits and name its first admin (`{type}.admin`). A refusal is audited.
   - **Partner or agency**, under `/v1/commercial/accounts/:accountId`:
     - `GET` the account, its members and its customers. A customer's name is shown only where it granted `summary`, and pending invitations are listed.
     - `POST members` adds a person or changes their role. The role must be of the account's own type, and nobody changes their own role.
     - `POST members/:userId/revoke` removes a person. Nobody removes themselves.
     - `POST customers` invites an organization. The mode must fit the account type: an agency uses `agency`; a partner uses `direct`, `reseller`, `white_label`, `oem` or `enterprise`. The invitation is pending, within the limit, with one relationship per pair; an ended relationship may be invited again.
     - `GET customers/:organizationId` returns the summary (name, status, plan in force), only with the `summary` scope.
     - Every refusal is `commercial_account_forbidden`, `permission_denied` or `customer_forbidden`, and each is audited as `commercial.access`.
   - **The customer's owner**, under `/v1/organizations/:organizationId/commercial-relationships`, directly and never through GIA or the runtime:
     - list the relationships;
     - `accept` with the scopes they grant, at most those requested;
     - narrow the `scopes`;
     - `end` the relationship, which clears its scopes.
     - Each change names the version read and is audited with its status transition.

4. **Audit.** New actions: `commercial_account.created`, `commercial_membership.created` (with the role as `reference`), `commercial_membership.revoked`, `customer_relationship.created` (with the mode), `customer_relationship.updated` (with the transition) and `commercial.access` (denied).
   - New targets: `commercial_account`, `commercial_membership` and `customer_relationship`.
   - Events carry a new `commercialAccountId` field (a UUID, checked). Firestore stores it only when present, so older events read back unchanged.
5. **What does not change.**
   - `resolveTenant()`, organization memberships, `organizationCreators` and every organization route.
   - A commercial membership never opens a customer's own routes: memory, conversations, documents, credits.
   - No commercial route moves credits or changes billing.

## Consequences

- Security tests (API, memory and Firestore): 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14 and 15. The model and RBAC tests repeat 2 to 9 and 15.
  - 10 (white label) and 11 (domain) come with phase 3.
  - 12 (API consumer) comes with phase 5.
- **The partner-created customer ("Ambas", second way) is not in this change.**
  - The partner would have to name the customer's owner, and MelonOffice has no invitations yet, which are not approved.
  - The model already supports it: the relationship stays pending until that owner accepts, and the limit is the account's own.
  - It needs Geovet's approval of an owner invitation (by email) before it can be built.
- Inviting an organization tells the partner whether that organization id exists (403 versus 201). Ids are random UUIDs, the partner must already know one, and every attempt is audited.
- A member is added by user id, and the API does not yet check that the user exists. An unknown id only takes a place in the account's own limit.
- The owner accepts through the API; the screen for it comes with phase 4, with the partner and agency consoles.
- Reading a customer's usage and billing (the admin's "usage and billing") comes with the phase 4 console, as `customer.read_usage` and `customer.read_billing` on the same scopes.
- **DEV:** nothing to apply. For a platform administrator to create accounts, `platform_admin_user_ids` must hold their user id (ADR-0082).
