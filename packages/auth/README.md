# @melonoffice/auth

Answers "who are you?" for a request ([ADR-0016](../../docs/adr/0016-auth-and-identity-foundation.md)). It does not decide what the user may do: RBAC and entitlements do.

- `identity-platform.ts`: `createIdentityPlatformVerifier()`, which verifies Identity Platform ID tokens with `jose`.
- `users.ts`: the `UserDirectory` port and an in-memory implementation for tests. The Firestore implementation is in `apps/api` ([ADR-0017](../../docs/adr/0017-user-persistence-in-firestore.md)).
- `tenancy.ts`: the `MembershipDirectory` port and `resolveOrganization()`. The organization comes from memberships, never from the client.
- `authenticate.ts`: `authenticate()`, which turns a request into an `AuthenticatedContext`.
- `context.ts`: `AuthenticatedContext` and `actAsGia()`.

Server-only: it uses Node built-ins and must not be imported by browser code.
