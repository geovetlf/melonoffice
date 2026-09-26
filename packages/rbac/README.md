# @melonoffice/rbac

Answers "what may you do in this organization?" ([ADR-0019](../../docs/adr/0019-rbac-foundation.md)). It does not decide who you are (`@melonoffice/auth`), which organization you act in (`@melonoffice/tenancy`) or what the plan allows (`@melonoffice/entitlements`).

- `permissions.ts`: the permission catalogue, the only place permission ids are defined.
- `roles.ts`: roles as named lists of permissions. `owner` lists each of its permissions.
- `engine.ts`: `createAuthorizationService()`, the `AuthorizationService` every caller uses. It denies by default and accepts only a `TenantContext` from `resolveTenant()`.

It knows nothing about HTTP. Server-only.
