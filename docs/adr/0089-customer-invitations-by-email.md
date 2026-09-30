# ADR-0089: Customer invitations by email

- Status: Proposed
- Date: 2026-09-30
- Builds on:
  - [ADR-0086](0086-commercial-authorization-and-persistence.md) (relationships and their owner's decision)
  - [ADR-0088](0088-commercial-console-reads-and-screens.md) (the owner's screen)
  - [ADR-0036](0036-web-identity-foundation.md) (sign-in with Identity Platform)
- Terraform: none. One new Firestore collection, read by id or by one equality, written only by the API. No index is needed.

## Context

A partner could ask an existing organization to become its customer only by knowing its id (ADR-0086). To bring in a company that is not on MelonOffice yet, Geovet approved invitations by email on 2026-09-30, with these rules:

- Nothing is granted automatically.
- The relationship is active only after its owner accepts, with exactly the scopes they tick, none by default.
- Invitations can be accepted, rejected, revoked and can expire. Every step is audited.
- The frontend never decides the tenant, the organization or the permissions.
- Nothing is duplicated.

The audit before building found:

- No invitations anywhere. `commercial.invite_customer` existed, for requests by organization id.
- No email provider. The "email" integration category has no adapter.
- Identity Platform already puts the email and whether it is verified into every token, and it can itself create accounts and send verification emails.

Geovet chose how the email goes out on 2026-09-30: **the link is copied**. The partner sees it once and sends it from their own email. A provider can be plugged in later.

## Decision

1. **`CustomerInvitation`**, at `customerInvitations/{id}`. It holds:
   - the account and the invited email (trimmed, lowercased);
   - the mode, the scopes asked for and who is billed;
   - its status and expiry (7 days);
   - who created it, and who decided it for which organization.

   The link's secret is 32 random bytes. **Only its SHA-256 hash is stored**, and neither the secret nor the email is ever recorded in the audit log.

2. **Statuses**: `pending → accepted | rejected | revoked | expired`. Only `pending` changes, once, on the version read.
   - Expiry is recorded the first time anyone looks at an invitation after its time: the account's list, the link, or a decision. There is no sweeper.

3. **The account's routes**, under `/v1/commercial/accounts/:id/invitations`:
   - `POST` invites. It needs `commercial.invite_customer` (admins only), a valid email, and a mode of the account's kind.
     - There is one pending invitation per email and account.
     - Pending invitations count against the account's customer limit.
   - `GET` lists them, with `commercial.read`, and never with the secret.
   - `POST …/:id/revoke` withdraws one.
   - Without a provider, the answer carries the secret once (`delivery: "manual"`) and the web builds the link `/invite#t=…`. An `InvitationMailer` port is ready: with one, the email goes out, `customer_invitation.sent` is audited, and the secret is not answered.

4. **The invited person's routes**, `POST /v1/invitations/lookup | accept | reject`. The secret goes in the body, never in a URL.
   - Only a person whose token carries the invited email, **verified**, may accept or reject. Anyone else is refused and audited.
   - The organization is **the one the person belongs to**, resolved from their own active membership. The request cannot name another.
   - With none, they create it first with the usual `POST /v1/organizations`. With more than one, it is refused.
   - Someone who holds `relationship.manage` there accepts with exactly the scopes they tick, a subset of those asked for. The relationship is active.
   - Anyone else sends it to their owner. The relationship is pending, and the owner decides in `/settings/partners` as before.
   - Accepting writes the invitation and the relationship in one transaction, with the account's customer limit and one relationship per pair checked there.

5. **Audit**: `customer_invitation.created | sent | accepted | rejected | revoked | expired`, target `customer_invitation`.
   - Accepting also records `customer_relationship.created`, plus `customer_relationship.updated` (pending → active) when the person decided.

6. **Web, `/invite`**. The link's secret is in the fragment, so browsers never send it to a server. It is moved to `sessionStorage` and removed from the address bar at once. The page walks the person through:
   1. sign in, or create the account (Identity Platform's `accounts:signUp`, no SDK);
   2. verify the email: Identity Platform sends its own verification email, and "I verified my email" takes a fresh token;
   3. create their company if they have none;
   4. decide: nothing ticked by default, sensitive scopes flagged, decline after confirming.

   Signing in with a pending invitation comes back to it.

## Consequences

- Tests:
  - API, on memory and Firestore:
    - only the invited person, verified, decides; another person or an unverified email is refused and audited;
    - the organization never comes from the request;
    - an owner grants nothing by default and never more than was asked for;
    - a non-owner sends it to the owner, and nothing opens until the owner accepts;
    - a person without a company creates one, then accepts;
    - decline, revoke and expiry close the link, and each is recorded once;
    - limits and duplicates are enforced;
    - the secret and the email appear in neither the store nor the audit.
  - Tenancy: the secret, the email check, expiry and who the invited person is.
  - Web: the link, the decision screen, the sign-in and sign-up paths, and the Identity Platform calls.
- Direct SaaS is unchanged. Sign-up appears only on the invitation page.
- **Still to come:**
  - The partner's screen to send an invitation and copy its link, in the partner console (phase 4b). Until then, invitations are sent through the API.
  - An email provider, when Geovet chooses one. It needs its key in Secret Manager and an apply.
- **DEV:** nothing to apply.
  - Identity Platform's email and password sign-in is already enabled (ADR-0014), and the web's browser key already reaches its service, which includes sign-up and the verification email.
  - To try the flow, the invited email must be real, so the verification email can be opened.
  - Still to confirm on the first try: that the verification email's link opens. It uses Identity Platform's default action page. If it does not, its address is set in the console's email templates.
