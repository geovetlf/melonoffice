# @melonoffice/tenancy

Decides which organization a request acts in ([ADR-0018](../../docs/adr/0018-tenancy-and-memberships.md)): User → Membership → Organization. It does not decide what the user may do there: RBAC and entitlements do.

- `tenant.ts`: `resolveTenant()`, which turns an `AuthenticatedContext` and a chosen organization into a `TenantContext`, only through an active membership in an active organization. Also `createOrganization()` and `listMyOrganizations()`.
- `store.ts`: the `TenancyStore` port. The Firestore implementation is in `apps/api`.
- `memory.ts`: an in-memory store for tests.
- `ids.ts`: organization and membership ids.

It knows nothing about HTTP, so the API, MelonMotor, GIA, workflows and jobs all use the same resolution. Server-only.
