# ADR-0017: User persistence in Firestore

- Status: Proposed (Phase 2B, pending Geovet's review)
- Date: 2026-09-26
- Builds on: [ADR-0014](0014-firestore-and-identity-platform-in-dev.md), [ADR-0016](0016-auth-and-identity-foundation.md)

## Context

ADR-0016 answers "who are you?" but left users in memory, so the deployed API answered `503 auth_not_configured`. This change answers "which internal record belongs to this identity?" and stores it in the dev Firestore database. Organizations remain tenancy's job.

## Decision

- **User model** (`packages/domain/src/user.ts`):

  | Field           | Meaning                                                                        |
  | --------------- | ------------------------------------------------------------------------------ |
  | `id`            | Internal `UserId`: a random UUID, never the email or the provider's id         |
  | `identity`      | `{ provider: 'identity-platform', subject }`, the token's `sub`; never changes |
  | `email`         | Copied from the last verified sign-in; contact data only, never an identifier  |
  | `emailVerified` | From the token; grants nothing (ADR-0016)                                      |
  | `createdAt`     | First sign-in                                                                  |
  | `updatedAt`     | Last change                                                                    |
  | `lastLoginAt`   | Last `POST /v1/me`                                                             |

- **Two collections** in the `(default)` database, both read and written only by the API:
  - `users/{userId}` holds the user document above. Times are Firestore timestamps.
  - `identities/{identityKey}` holds `{ provider, subject, userId, createdAt }`. It is the explicit link from one external identity to one user.
  - `identityKey` is the SHA-256 of `identity-platform` and the subject. Any subject gives a valid, fixed-length document id that carries no personal data.
  - Every access is a read of a known document id, so no index is needed.
- **Uniqueness.** `recordSignIn` runs in one Firestore transaction:
  1. It reads `identities/{identityKey}`.
  2. If the link exists, it reads the user and updates only `email`, `emailVerified`, `updatedAt` and `lastLoginAt`.
  3. Otherwise it creates both documents with `create`, which fails if the document already exists.

  Two concurrent first sign-ins cannot both succeed: one transaction commits, and the other retries and finds the first one's user. A link whose stored subject does not match is refused. An emulator test runs 10 concurrent sign-ins and gets one user and one link. The same test fails when the transaction is removed.

- **Idempotency.**
  - `POST /v1/me` answers `201` with the user the first time and `200` with the same user afterwards.
  - The id, identity and `createdAt` never change.
  - The request body is never read, so it cannot change the email, the id or the organization.
- **`GET /v1/me`** returns the caller's own stored user. The id comes from the verified context, never from the path, query, body or headers. A verified identity with no user gets `403 user_not_registered`.
- **Access control.**
  - The API uses the server client (`@google-cloud/firestore` 8.7.1) with its Cloud Run runtime identity. In dev, that identity already has `roles/datastore.user` (ADR-0014). No key is used.
  - Firestore security rules apply only to client SDKs, and MelonOffice has no client that talks to Firestore. No ruleset is released, which denies every client request (inferred from Firestore's default for databases created outside Firebase; not changed here).
- **Configuration per environment.**
  - The API turns auth on when `IDENTITY_PLATFORM_PROJECT_ID` is set, and uses that one project for both Identity Platform tokens and Firestore.
  - Terraform sets it to the environment's own project, and only where `firestore_and_auth` is on, which today means dev only. It is not a secret.
  - Staging and production do not change: they have no Firestore, no Identity Platform and no services.
  - Without the variable, `/v1` keeps answering `503 auth_not_configured`.
- **Tests run against the official Firestore emulator.** The same API tests run on both the in-memory and the Firestore directory. CI downloads emulator 1.22.0, checks its SHA-256 and requires it, so the Firestore tests can never be skipped there.

## Not in this change

- Tenancy, memberships, organizations, invitations, RBAC, the audit log, new entitlements, billing and admin roles.
- Deleting or disabling users, and syncing Identity Platform account changes other than on sign-in.
- Token revocation checks (ADR-0016).

## Consequences

- Dev needs one Terraform apply that adds the variable to the `api` service (1 to change). CD then keeps rolling out images without touching it.
- A new place that stores personal data (email) now exists. Retention and deletion rules come with the privacy work.
- A future second sign-in method links another `identities` document to the same user in the same way.
