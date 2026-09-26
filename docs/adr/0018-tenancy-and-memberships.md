# ADR-0018: Tenancy and memberships foundation

- Status: Proposed (Phase 2C, pending Geovet's review)
- Date: 2026-09-26
- Builds on: [ADR-0016](0016-auth-and-identity-foundation.md), [ADR-0017](0017-user-persistence-in-firestore.md)
- Changes part of ADR-0016: organization resolution moves from auth to tenancy.

## Context

Auth answers "who are you?" (ADR-0016) and users are stored in Firestore (ADR-0017). Nothing yet answers "which organization are you acting in?". Every later part of MelonOffice (departments, specialists, GIA, workflows, entitlements, the audit log) needs that answer, and needs it to come from server-side records, never from what a client sends. D-10 fixes the tenant as the organization, with no workspaces.

## Decision

- **Relation:** User → Membership → Organization. A membership is the only thing that connects a user to an organization.
- **Organization** (`packages/domain/src/tenancy.ts`):

  | Field       | Meaning                                                                |
  | ----------- | ---------------------------------------------------------------------- |
  | `id`        | Internal `OrganizationId`: a random UUID, never the name or an email   |
  | `name`      | Display name, 1–100 characters, trimmed and NFC-normalized; may repeat |
  | `status`    | `active` or `suspended`                                                |
  | `createdBy` | The creating user. History only: it grants nothing                     |
  | `createdAt` | Creation time                                                          |
  | `updatedAt` | Last change                                                            |

  No plan, billing, country or other commercial fields: the plan belongs to entitlements (ADR-0013) and is added when it is connected. No slug (see pending decisions).

- **Membership:**

  | Field            | Meaning                                                           |
  | ---------------- | ----------------------------------------------------------------- |
  | `id`             | `MembershipId`: `{organizationId}_{userId}`, one per pair         |
  | `organizationId` | The organization                                                  |
  | `userId`         | The user                                                          |
  | `status`         | `active`, `suspended` or `revoked`                                |
  | `role`           | A structural name only. Today only `owner` (D-22). No RBAC matrix |
  | `createdAt`      | Creation time                                                     |
  | `updatedAt`      | Last change                                                       |

- **Status semantics.** Only `active` grants access, and only in an `active` organization.
  - `suspended` membership: temporarily blocked, reversible, history kept.
  - `revoked` membership: removed, history kept. No way back is defined yet; it comes with invitations.
  - `suspended` organization: nobody can act in it, owner included.
  - No other values exist. A stored record with an unknown status or role is an error, never access.
- **Uniqueness is enforced by storage, not by a prior check.**
  - The membership document id is the pair, so Firestore cannot hold two memberships for one user and organization.
  - Creating an organization writes three documents in one transaction with `create`: the organization, the owner membership and `organizationCreators/{userId}`. `create` fails if a document already exists, so two concurrent requests from one user produce one organization. An emulator test runs 8 concurrent creations and gets exactly one of each document.
- **Resolution layer** (`packages/tenancy`, no HTTP):
  - `resolveTenant(auth, requestedOrganizationId, store)` returns a frozen `TenantContext { actor, userId, organizationId, membershipId, membershipStatus: 'active', role }`.
  - The requested id is only a selector. Access exists only when the store holds the caller's own membership for that organization, `active`, in an `active` organization. The user id always comes from the verified `AuthenticatedContext`.
  - Every refusal is `organization_forbidden`: an unknown id, a malformed id, another user's organization, a suspended or revoked membership, and a suspended organization. A client cannot tell them apart, so ids cannot be probed.
  - Malformed ids never reach storage.
  - There is no implicit "default organization": the caller always names it. A missing choice is `organization_required`.
  - The same function serves the API, MelonMotor, GIA, workflows and jobs.
- **GIA.** `actAsGia()` keeps the user; `resolveTenant` then applies the same membership check, so GIA reaches exactly the user's active organizations and nothing more. GIA cannot create organizations (`requires_user`). There is no global or cross-tenant path.
- **Auth no longer resolves organizations.** `MembershipDirectory`, `resolveOrganization`, `noMemberships`, `organizationId` in `AuthenticatedContext`, the `organization_*` auth codes, the `x-organization-id` header and `requireOrganization()` are removed. `GET /v1/me` and `POST /v1/me` no longer return `organizationId`; organizations are at `/v1/me/organizations`.
- **API** (all behind authentication; the user id is never read from the request):

  | Route                                   | Result                                                                        |
  | --------------------------------------- | ----------------------------------------------------------------------------- |
  | `POST /v1/organizations` `{ name }`     | `201` organization + the caller's owner membership. Other body fields ignored |
  | `GET /v1/me/organizations`              | The caller's active memberships in active organizations                       |
  | `GET /v1/organizations/:organizationId` | The organization and the caller's membership, through `resolveTenant`         |

  Errors: `invalid_organization_name` 400, `organization_limit_reached` 409, `organization_forbidden` / `organization_required` / `requires_user` 403. Without a tenancy store the routes answer `503 tenancy_not_configured`.

- **Firestore** (`(default)` database, read and written only by the API with its runtime identity):
  - `organizations/{organizationId}`: `{ name, status, createdBy, createdAt, updatedAt }`.
  - `memberships/{organizationId}_{userId}`: `{ organizationId, userId, role, status, createdAt, updatedAt }`.
  - `organizationCreators/{userId}`: `{ organizationId, createdAt }`.
  - Queries: documents by id, and `memberships where userId ==`, which uses Firestore's automatic single-field index. No composite index, no Terraform change and no new IAM: the API service account already has `roles/datastore.user` (ADR-0014).
  - Security rules: unchanged from ADR-0017. No client talks to Firestore.
- **Tests.**
  - `packages/tenancy`: models, name validation, concurrency, and the cross-tenant matrix: A in A allowed, A in B refused, B in B allowed, forged organization ids refused alike, a forged user id changes nothing, suspended and revoked memberships refused, suspended organization refused, GIA bounded to the user.
  - `apps/api`: every route runs against memory and the Firestore emulator, including the cross-tenant matrix over HTTP, plus Firestore-specific tests for the transaction, uniqueness and invalid stored values. Regression: `/health`, auth errors, `/v1/me` and fail-closed behaviour.

## Pending product decisions

1. **First tenant.** Implemented conservatively: an organization is created only by an explicit `POST /v1/organizations`, never automatically at sign-in, and each user can create one (`organization_limit_reached` after that). Whether sign-up should create it, and whether a user may create more, is a product decision.
2. **Slug.** Omitted. It would need its own uniqueness record, a character policy and a rename policy, and nothing uses it yet.
3. **GIA and organization creation.** Denied. Allowing it later is a decision for the GIA governance work.
4. **Retrying creation.** Not idempotent: a retry after a lost response gets `409`. The client recovers with `GET /v1/me/organizations`. An idempotency key can come later if needed.
5. **Status changes.** Suspending, revoking and reactivating have no endpoint yet; they come with admin and invitations.

## Not in this change

RBAC and permissions per role, the audit log, invitations, billing, advanced admin, plan assignment to organizations, the web sign-in or organization screens, and any Terraform or infrastructure change.

## Consequences

- Deploying this to dev needs no apply: the collections are created on first write. CD rolls out the new image on merge.
- Clients that read `organizationId` from `/v1/me` must use `/v1/me/organizations` instead. None exist yet.
- RBAC can build on `TenantContext.role` and the membership id without changing how tenancy resolves.
