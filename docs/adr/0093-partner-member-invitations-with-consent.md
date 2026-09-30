# ADR-0093: Partner and agency members join only by accepting an invitation (C-5c)

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0089](0089-customer-invitations-by-email.md) (invitation links), [ADR-0090](0090-partner-console-and-brand-screens.md) (partner console), [ADR-0092](0092-request-limits-on-sensitive-routes.md)
- Terraform: none. One new Firestore collection, queried by equality only; no index.

## Context

The closing audit left one P1 consent gap: a partner or agency admin could add any MelonOffice user to their account by user id, without that person agreeing. A person could end up acting for a commercial account they never chose.

## Decision

- An admin (`commercial.manage_members`) invites a person by email with one of the account's roles: `POST /v1/commercial/accounts/:accountId/member-invitations`. The answer carries the secret once; only its SHA-256 hash is stored in `memberInvitations/{id}`. There is no email provider: the admin copies the link (`/join#t=…`) and sends it themselves. One pending invitation per email; pending invitations count against the account's member limit.
- The person opens the link, signs in or creates their account, and verifies their email. No company of their own is needed to decide. `POST /v1/member-invitations/lookup` shows the account, its type and the role; `accept` and `reject` take the token and the invitation's `updatedAt`.
- Accepting checks, in order: the signed-in person has a verified email equal to the invited one; the invitation is pending and not expired; the version matches; the account is active; the person is not already an active member; the member limit. Then the membership and the invitation's new status are written in one transaction, audited as `member_invitation.accepted` and `commercial_membership.created`.
- `POST .../member-invitations/:id/revoke` withdraws a pending invitation. Created, rejected, revoked and expired invitations are audited (`member_invitation.*`).
- `POST /v1/commercial/accounts/:id/members` now only changes an active member's role (audited `commercial_membership.updated`, `expectedUpdatedAt` required). Adding a new or former member answers 409 `member_invitation_required`. Removing a member is unchanged.
- The lookup, accept and reject routes count against the `invitation_token` request limit of ADR-0092.
- The web keeps the join secret apart from a company invitation's (`melonoffice.memberInvitation` in `sessionStorage`), sends a person who signs in with one pending back to `/join`, and after joining opens `/partner`. The console's People section invites by email, shows the link once, and lists pending invitations with Withdraw.

## Consequences

- Nobody becomes a member of a commercial account without accepting, signed in with the invited email verified.
- The hash, token and other people's data never leave the API; the lookup answers only the account's name and type, the role, the status and the dates.
- A member with no company of their own reaches the console without creating one: [ADR-0094](0094-partner-members-without-a-company.md).
- Tests: API on memory and the Firestore emulator (invite, lookup, accept, reject, revoke, wrong or unverified email, limits, inactive account, already a member, role changes only by invitation); web (console invite and withdraw, join decision and refusals, link kept apart).
