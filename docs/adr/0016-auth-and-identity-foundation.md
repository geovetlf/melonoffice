# ADR-0016: Auth and identity foundation

- Status: Proposed (Phase 2A, pending Geovet's review)
- Date: 2026-09-26
- Builds on: [ADR-0013](0013-entitlements-core.md), [ADR-0014](0014-firestore-and-identity-platform-in-dev.md)

## Context

Phase 2 needs to know who makes each request before tenancy, RBAC, entitlements and the audit log can act on it. D-6 chose Identity Platform with email and password only. Each concern answers one question and must not repeat another's:

| Concern      | Question                                 | Where                              |
| ------------ | ---------------------------------------- | ---------------------------------- |
| Auth         | Who are you?                             | `packages/auth` (this ADR)         |
| Tenancy      | Which organization do you belong to?     | Memberships, next phase            |
| RBAC         | What can you do?                         | Later phase                        |
| Entitlements | What does the organization's plan allow? | `packages/entitlements` (ADR-0013) |
| Audit log    | What happened?                           | Later phase                        |

## Decision

- **Sign-in stays with Identity Platform.** The client signs in with email and password and sends the ID token as `Authorization: Bearer <token>`. MelonOffice stores no passwords or credentials and adds no other provider or MFA.
- **The API verifies tokens itself, with `jose`.** It checks, before trusting any claim:
  - an RS256 signature against Google's published keys, fetched and cached by `jose`;
  - issuer `https://securetoken.google.com/<project>` and audience `<project>`;
  - expiry, and that `iat` and `auth_time` are not in the future (5 s clock tolerance);
  - a non-empty `sub` of at most 128 characters;
  - sign-in method `password` only: anonymous, custom-token and other providers are rejected;
  - no Identity Platform tenant.

  `jose` 6.2.12 is a small, dependency-free JWT library, approved by Geovet on 2026-09-26. The Firebase Admin SDK would do the same checks but brings Firebase and Google Cloud clients the API does not otherwise need, so it is not used.

- **Stable internal user id.** A `User` has its own `UserId` and records the provider subject separately. The provider can change without changing every reference to the user.
- **Registration is explicit.** `POST /v1/me` creates the user for the token's subject, once. Every other `/v1` route needs a registered user and otherwise answers `user_not_registered`.
- **Identity comes only from the verified token.** No user id is read from the body, query or headers.
- **The organization comes from memberships, never from the client.** A client may send `x-organization-id` only to choose among its own organizations. Any other value, existing or not, gets the same `organization_forbidden`, so ids cannot be probed. A user with exactly one organization gets it without asking. Until tenancy adds memberships, no request has an organization, and routes that need one answer `organization_required`.
- **`AuthenticatedContext`** is `{ actor, userId, organizationId?, email?, emailVerified }`, frozen. It carries no permissions, plan or limits: RBAC and entitlements supply those from `userId` and `organizationId`.
- **GIA acts as the user.** `actAsGia(context)` returns the same user and organization with `actor: 'gia'` and accepts nothing else, so GIA cannot gain access. Governance actions stay denied to GIA by `authorize()` (ADR-0013).
- **Errors are fixed codes.**

  | Code                     | Status | When                                                    |
  | ------------------------ | ------ | ------------------------------------------------------- |
  | `missing_token`          | 401    | No `Authorization` header                               |
  | `invalid_token`          | 401    | Malformed header, bad signature, wrong project or claim |
  | `token_expired`          | 401    | Token past its expiry                                   |
  | `user_not_registered`    | 403    | Valid token, no MelonOffice user yet                    |
  | `organization_required`  | 403    | The route needs an organization and there is none       |
  | `organization_forbidden` | 403    | The chosen organization is not one of the user's        |
  | `verifier_unavailable`   | 503    | Google's signing keys could not be fetched              |

  401 responses carry `WWW-Authenticate: Bearer`. Only the code is logged, never the token.

- **The API fails closed.** Without auth dependencies, every `/v1` route answers `503 auth_not_configured`. `/health` is unaffected.

## Not in this change

- **User persistence.** Only the `UserDirectory` port and an in-memory implementation for tests exist, so the deployed API answers `auth_not_configured` on `/v1`. The Firestore implementation and the API's `IDENTITY_PLATFORM_PROJECT_ID` setting came later, in [ADR-0017](0017-user-persistence-in-firestore.md).
- Memberships, organizations, RBAC, the audit log, the web sign-in screen and entitlement checks on routes.

## Consequences

- A disabled or deleted Identity Platform account keeps a working token until it expires, up to one hour, because verification is local. Checking revocation needs the Admin API and is left for the persistence work.
- **Unverified email is not blocked (Geovet, 2026-09-26).** Users with an unverified email can register and sign in. `emailVerified` is carried in the context, and being verified grants no extra permission. Whether a verified email is required is a pending product decision. It must be made before any sensitive feature is enabled, and the rule will live in one place.
- Adding a sign-in method means adding it to the allowed list in `identity-platform.ts` and to Identity Platform in Terraform, in the same change.
