# ADR-0138: a recent sign-in for sensitive administration (S-1)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0014](0014-firestore-and-identity-platform-in-dev.md) (Identity Platform), [ADR-0082](0082-ai-providers-platform-admin-only.md) (platform administrators), [ADR-0091](0091-manual-commercial-operations-and-credit-grants.md) (manual commercial operations), [ADR-0098](0098-white-label-over-resellers-on-one-core.md) (white label and resellers)
- Decision: Geovet's product rule of 2026-09-30 05:56Z. A normal owner signs in and works with no extra codes. Sensitive administrators (platform, white label, reseller) may get stronger controls, preferring passkeys or biometrics to typed codes, starting with the lowest-friction secure option. Roadmap item "Seguridad de administradores", started 2026-10-03 23:49Z.
- Terraform: none. Firestore: none. Data migration: none.

## Context

Every API request carries an Identity Platform ID token. The token's `auth_time` is when the person last signed in. A refreshed token keeps it, so a browser left open stays signed in for days. Platform, white-label and reseller administrators can grant credits, suspend accounts, bind domains, create resellers and change who administers an account. An administrator's unattended browser, or a stolen refresh token, could do all of that with no new sign-in. The API verified `auth_time` and then dropped it.

## Decision

1. **Keep the sign-in time.** `VerifiedIdentity.authTime` and `AuthenticatedContext.authTime` carry the verified `auth_time`, in seconds. Operator tools and tests build contexts without it, and those never count as recent.

2. **One rule: `signedInRecently(context, now)`** (`@melonoffice/auth`) means the person signed in at most `SENSITIVE_SIGN_IN_MAX_AGE_SECONDS` ago, 30 minutes. GIA acting for a person never counts.

3. **Where it applies.** It covers changes only (every method but GET and HEAD), at the two existing checks, so no new permission system:
   - `platformAdminOf`: every `/v1/platform/*` change, such as commercial accounts, their status and limits, domain bindings and credit grants.
   - The commercial guard's `inAccount`: every change by a white-label or reseller member, such as resellers, members, invitations, customers and the account's brand.

   A business owner's own organization routes are not affected. Reads are never refused for this.

4. **The refusal.** 403 `reauthentication_required`, audited as a denial under the route's existing action (`credits.platform_grant`, `commercial.access`, …), with the reason, before anything changes.

5. **The web.** The platform screens and the partner console show "For your security, sign in again to make this change" and a button that signs out. The next sign-in sets a new `auth_time`, and the change goes through.

## Why 30 minutes, and why not codes

30 minutes covers one working session of administration without asking twice, and it stops a browser left signed in since yesterday. A typed one-time code for everyone is what the product rule rules out. Passkeys are the next step (S-2). They need Identity Platform's or a WebAuthn flow, and its own decision on enrolment and recovery. This check is what a passkey step-up will plug into: a fresh passkey assertion will count as a recent sign-in.

## Consequences

- An administrator who signed in long ago is asked to sign in again before a change, never before a read.
- Each refusal is in the audit log, with the person, the account and the permission.
- Tests: `packages/auth` (the rule, with and without a sign-in time, and GIA) and `apps/api/src/recent-sign-in.test.ts`, in memory and on Firestore. The API tests cover a platform grant refused and then allowed, every platform change, a white-label change and an owner who is never asked. The web tests cover the message and the sign-out.
