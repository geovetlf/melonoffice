# ADR-0019: RBAC foundation

- Status: Proposed (Phase 2D, pending Geovet's review)
- Date: 2026-09-26
- Builds on: [ADR-0013](0013-entitlements-core.md), [ADR-0018](0018-tenancy-and-memberships.md)

## Context

Tenancy (ADR-0018) answers "which organization are you acting in?" and gives every membership a role name, `owner`. Nothing yet answers "what may you do there?". Every later route, MelonMotor action, GIA request, workflow and job needs that answer from one place, denying by default.

Each layer answers one question and does not answer another's:

| Layer        | Question                                      | Where                              |
| ------------ | --------------------------------------------- | ---------------------------------- |
| Auth         | Who are you?                                  | `packages/auth` (ADR-0016)         |
| Tenancy      | Which organization, through which membership? | `packages/tenancy` (ADR-0018)      |
| RBAC         | What may you do in that organization?         | `packages/rbac` (this ADR)         |
| Entitlements | What does the organization's plan allow?      | `packages/entitlements` (ADR-0013) |
| Audit log    | What happened?                                | Not built yet                      |

## Decision

- **Model:** User → Membership → Organization → Role → Permissions. RBAC reads the role from the tenant context's membership and nothing else.
- **Permission catalogue** (`packages/rbac/src/permissions.ts`). It is the only place permission ids are defined. Ids are `resource.action`, stable once used. Each has a resource, an action and a description. A permission is added only when something checks it, so today there is one:

  | Permission          | Resource     | Action | Meaning                                             | Checked by                              |
  | ------------------- | ------------ | ------ | --------------------------------------------------- | --------------------------------------- |
  | `organization.read` | organization | read   | See the organization and your own membership in it. | `GET /v1/organizations/:organizationId` |

- **Roles** (`packages/rbac/src/roles.ts`) are named lists of permissions, kept in code.
  - `owner` = `organization.read`, listed explicitly. There is no wildcard and no "allow everything".
  - Admin, manager and member are not created: nothing needs them yet. Adding one is a new entry in the same map, with no change to auth, tenancy, the API or the engine.
  - A role that lists a permission missing from the catalogue fails at startup.
- **Role names in memberships.** A membership's `role` is now typed as a name (`string`), and the Firestore adapter passes it through instead of rejecting unknown values. RBAC is the only place that interprets it, and an unknown name grants nothing. This changes no stored document; it makes an unknown role a clean `403` instead of a `500`.
- **Authorization engine** (`createAuthorizationService()`). It exposes the `AuthorizationService` interface with two methods:
  - `authorize(tenant, permission, resource?)` → `{ allowed: true }` or `{ allowed: false, reason }`.
  - `permissionsOf(tenant)` returns the tenant's permissions, as a copy. It can feed entitlements' `Principal.permissions`.

  It is pure, deterministic and has no HTTP.

- **Deny by default.** In order, it denies when:
  1. The permission is not in the catalogue (`unknown_permission`).
  2. The tenant context did not come from `resolveTenant()` (`unresolved_tenant`). Tenancy records every context it issues in a `WeakSet`. A copy, an edited context (another user, organization, membership or role) or a hand-built one is refused.
  3. The membership is not active (`inactive_membership`). Tenancy already refuses inactive memberships and suspended organizations before a context exists, so this is a second check.
  4. The role is not in the catalogue (`unknown_role`). Lookups use a `Map`, so names such as `constructor` are unknown too.
  5. A resource is given and belongs to another organization (`cross_tenant`).
  6. The role does not list the permission (`permission_denied`).
- **HTTP adapter** (`apps/api/src/authorization.ts`, `withPermission(permission, deps, handler)`). It only translates:
  - A missing or invalid token gets `401`, from authentication, before it runs.
  - A tenancy refusal gets `403 organization_forbidden`, unchanged from ADR-0018, so organizations cannot be enumerated.
  - An RBAC refusal gets `403 permission_denied`. The precise reason is logged, never returned.
  - The handler receives the resolved tenant and never reads the user, organization, membership or role from the request.
  - The permission argument is typed against the catalogue, so a route cannot name a permission that does not exist.
- **GIA.** The engine never looks at `actor`. GIA reaches a tenant only through `actAsGia()` → `resolveTenant()` with the user's own membership, and then gets exactly that user's permissions. There is no GIA role, bypass or system owner. Internal system actions, if ever needed, will need a separate, explicit identity designed then.
- **MelonMotor, workflows and jobs** will depend on the `AuthorizationService` interface, not on the API. None of them exists yet, so no integration is built; they will call `resolveTenant()` then `authorize()` exactly as the API does.
- **RBAC and entitlements stay separate.** The engine has no plans, features or limits. Entitlements' `authorize()` (ADR-0013) still takes the role permissions as input, so an action needing both asks RBAC for `permissionsOf(tenant)` and entitlements for the plan. Connecting them on a real action is left to the first action that needs a plan check.
- **Firestore:** no new collection, field or index. Roles and permissions live in code.
- **Terraform:** no change.

## Tests

- `packages/rbac`: the catalogue's shape; owner's exact permissions; a catalogue with an unknown permission is refused.
  - A decision matrix that goes through `resolveTenant` and `authorize` together: identity (Alice, Bob, Carol with no membership, GIA for Alice) × organization (own, other, missing) × membership status × organization status × role (owner, unknown, `constructor`) × permission (known, unknown, wildcard) × resource organization.
  - Forged contexts: a copy, and a changed organization, user, membership id, role or actor. Also determinism, GIA parity with the user, and that the set returned by `permissionsOf` cannot widen access.
- `apps/api`, in memory and on the Firestore emulator, for `GET /v1/organizations/:id`:
  - `401` with no token and with an invalid token.
  - `403` with a valid token and no membership, and with a suspended or revoked membership.
  - `403` for a role without the permission, and for an unknown stored role.
  - Client-sent membership, user and role values are ignored.
  - `200` for the owner.
- All Phase 2A–2C tests still pass, including cross-tenant isolation, `/health`, `/v1/me` and `/v1/me/organizations`.

## Pending decisions

1. The next roles (admin, manager, member) and their permissions, together with the endpoints that need them (member management, organization update).
2. Whether roles ever become configurable per organization (stored), instead of code.
3. A separate system identity for internal actions, if one is ever needed.
4. D-27 (role catalogue for specialists) is a different catalogue and remains open.

## Not in this change

The audit log, invitations, member management, admin screens, billing, plan checks on routes, and any Terraform or GCP change.

## Consequences

- Every new route inside an organization declares its permission through `withPermission`, and a new permission starts in the catalogue with its description.
- `/v1/me`, `/v1/me/organizations` and `POST /v1/organizations` act on the caller's own data or create a new tenant, so they need no organization permission.
