# ADR-0091: Manual partner operations and credit grants by the platform administrator (C-5a)

- Status: Proposed
- Date: 2026-09-30
- Builds on:
  - [ADR-0023](0023-credits-foundation.md) (the one Credits engine: wallet and append-only ledger)
  - [ADR-0082](0082-ai-providers-platform-admin-only.md) (platform administrators)
  - [ADR-0086](0086-commercial-authorization-and-persistence.md) (commercial accounts and their statuses)
  - [ADR-0088](0088-commercial-console-reads-and-screens.md) (the platform commercial screens)
- Terraform: none. No new collection and no new index.

## Context

Before any payment provider exists, MelonOffice sells by hand: a partner is agreed with outside the product, and credits are paid for outside it. The platform administrator could create partner accounts but not suspend, reactivate or close them or change their limits, and could not add credits to an organization at all. Platform routes checked only the `PLATFORM_ADMIN_USER_IDS` list, not whether the administrator's email was verified, and their audit events did not say in which role the person acted.

## Decision

1. **One platform administrator check, with a verified email.** `resolvePlatformAdmin` (tenancy) is the only way to get a `PlatformAdminContext`: the caller acts directly as a user, is on `PLATFORM_ADMIN_USER_IDS` and has a verified email. Otherwise it refuses with `platform_forbidden` or `platform_email_unverified` (403), before anything is read or changed. Every `/v1/platform/*` route uses it through `platformAdminOf`, and every refusal is audited. There is no MFA yet.

2. **Partner account operations reuse the existing status machine** (`active ↔ suspended`, either → `closed`, closed is final; no new status):
   - `POST /v1/platform/commercial-accounts/:id/status {status, expectedUpdatedAt, confirmName?}`. Closing requires `confirmName` to equal the account's name exactly (`close_not_confirmed`). Nothing is deleted: members, customer relationships, invitations and history stay as they are, and a closed or suspended account already stops working through `resolveCommercialContext`. Ids are never reused.
   - `POST /v1/platform/commercial-accounts/:id/limits {limits:{customers, members}, expectedUpdatedAt}`, with `members ≥ 1`; a closed account cannot change.
   - Both change the account only from the version read (`updatedAt`) in one transaction with their audit event (`commercial_account.status_changed`, `commercial_account.limits_changed`); a stale version is `commercial_conflict` (409).
   - Creating an account and adding a member now require the named user id to exist.

3. **Manual credit grants through the one Credits engine.** `CreditService.grantAsPlatform(admin, organizationId, {amount, referenceId, reason})` writes a normal `grant` ledger entry on the organization's existing wallet. It is not AI consumption, and there is no second wallet, balance, price or payment. `POST /v1/platform/organizations/:id/credit-grants {amount, reason, idempotencyKey}`:
   - `amount`: a whole number of credits, 1 to 10^12. `reason`: one of `manual_purchase`, `courtesy`, `support_compensation`, `testing` (codes, never free text). `idempotencyKey`: a UUID.
   - The organization must exist and be active, and have its wallet.
   - `GET /v1/platform/organizations/:id` shows its name, status and balance so the confirmation names the right company; it is audited as `platform.organization_read`.

4. **Idempotency.** The ledger reference is `platform-grant:{idempotencyKey}` and the entry id is derived from the organization and that reference, inside the ledger's transaction. The same key with the same amount and reason replays the first grant (200, `replayed: true`) and moves nothing; with a different amount or reason it is refused (`idempotency_key_reused`, 409). The key is per organization: the same key sent to another organization is another grant, so the screen makes a new key for every reviewed grant. The screen keeps an unanswered grant's key in the tab's session storage, so a double click, a lost answer or a refresh sends the same key again.

5. **Audit.** Every platform operation records the actor, `actorRole: 'platform_admin'` (a new optional audit field), the action, the target, the time, the result (`success`, `denied` or `failure`), a reason code for refusals, the request id and, for grants, the idempotency reference. Amounts stay in the ledger entry, which carries the admin as its actor, the reason and the time. No secrets, tokens or email addresses are recorded.

6. **Screens** in `/platform`: each account shows its status with Suspend or Reactivate, Change limits and Close (the exact name must be typed; the button stays disabled until it matches). "Add credits by hand" finds an organization by id, takes the amount and reason, asks for confirmation naming the organization, and shows the result or the API's refusal. No financial dashboard.

## Consequences

- Tests:
  - API, on memory and on the Firestore emulator: the account lifecycle, stale versions, limits, closing without the name, others refused (member, non-admin, unverified admin) with audited denials, grants replayed on retry and refused on key reuse, the validation matrix, only a verified administrator grants.
  - Firestore emulator: the commercial store (accounts, versions, isolation between accounts, suspended and revoked access, member and customer limits under concurrency, invitations accepted once) and the branding store (isolation per owner, version races, one binding per hostname).
  - Credits: `grantAsPlatform` refuses anything but a resolved administrator context and inactive organizations, and replays by reference.
  - Web: account actions from the version shown, closing only with the exact name, grants confirmed before sending, one key per grant, the same key on double click, lost answer and refresh.
- **Not in this change** (known gaps):
  - **P1: adding a member to a partner account needs no consent** from the person added (the user id must now exist, but they are not asked). An invitation with acceptance is the fix.
  - **P1: rate limiting** of platform routes and of grants per administrator.
  - MFA for platform administrators.
  - Payments, checkout, prices, commissions, revenue sharing, automatic subscriptions.
  - A daily or per-grant ceiling beyond the ledger's own maximum.
- **DEV:** nothing to apply. `PLATFORM_ADMIN_USER_IDS` must list an administrator whose email is verified.
