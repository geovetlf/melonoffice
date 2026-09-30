# ADR-0090: The partner and agency console, and brand screens (Commercial Platform phase 4b)

- Status: Proposed
- Date: 2026-09-30
- Builds on:
  - [ADR-0086](0086-commercial-authorization-and-persistence.md) (accounts, roles, customers)
  - [ADR-0087](0087-brand-config-and-domain-resolution.md) (brand levels)
  - [ADR-0088](0088-commercial-console-reads-and-screens.md) (usage and billing reads)
  - [ADR-0089](0089-customer-invitations-by-email.md) (invitations)
- Terraform: none. No API change: every route already existed.

## Context

Phases 2 to 4a and the invitations built the partner and agency layer in the API, but a partner's people had no screen: members, customers, invitations and brands could only be managed by calling the API. The owner's brand level could be set, but nothing showed it inside the app: the brand applied only on a host with an active custom domain.

## Decision

1. **The partner console, `/partner`.** It appears in the sidebar only for a person the API lists in at least one partner or agency account (`GET /v1/commercial/accounts`, their own only). With more than one account, they choose which. It has four parts:
   - **Customers**: the active customers, each named only where it granted `summary`, plus how many requests are waiting. Opening one shows only what it granted:
     - summary;
     - AI usage for the last 30 days, in operations and credits by capability;
     - billing, for admins only;
     - its white-label brand, for a partner's admin, only for a white-label customer that granted `branding`.
   - **Invitations** (ADR-0089): the account's invitations and their status.
     - An admin invites by email, with the mode and the scopes to ask for, none ticked by default and sensitive ones flagged.
     - The link is shown once with a copy button, since the API keeps only its hash.
     - Withdrawing asks first.
     - Each invitation shows when it was created and when it expires or expired.
     - `branding` is asked for only in white-label mode.
     - The API's refusals read as their own message (duplicate pending invitation, invalid email, no permission, limit, conflict, no longer pending); an unknown code is shown as it is. The console holds no authorization of its own: it hides what the role cannot do, and the API decides.
     - There is no company field: the recipient's company is the one they already belong to (ADR-0089).
   - **People**: the account's members. An admin adds a person by user id with one of the account's roles, or removes one after confirming.
   - **Brand**: the account's own level. Admins edit it; others see it.

   What each role may change is shown from the role's name, for the screen only; the API decides every step, as before.

2. **Brand forms edit what the app shows today**: the product name, the icon and the main color. Every other field of the level is kept exactly as stored, and each save names the version it read.
   - A color white text is not readable on is saved and said so, but not applied (ADR-0087).
   - Fields nothing shows yet (logo, assistant name, links, email texts) are not offered, so no field looks like it does something it does not.

3. **The owner's brand screen, `/settings/brand`**, for `brand.manage` (owner): the organization's own level. Anyone who reads the organization sees the form read-only.

4. **The organization's brand inside the app.** Once any level of the organization is stored (its own or its white-label partner's), the signed-in app shows the merged brand from `GET /v1/organizations/:id/brand`: the name in the sidebar and title, the icon and the readable main color. An organization with no stored level looks exactly as before. The host's brand (ADR-0087) still applies beneath it.

## Consequences

- Tests (web):
  - an admin opens a customer and sees only what it granted;
  - support never sees billing, invites, adds people or edits a brand;
  - a customer that granted nothing shows nothing;
  - an invitation asks only what was ticked and shows its link once;
  - withdrawing and adding people call the API as expected;
  - brand forms keep the other fields and name the version;
  - the organization's brand appears only once a level is stored.
- Direct SaaS is unchanged: without a commercial membership the console is not listed, and without a stored brand nothing changes.
- **Not in this change:**
  - Finding a person by email to add them: the account still needs their user id.
  - A partner's people who belong to no organization: the app still asks every signed-in person to create one before showing any page.
  - The brand in the app's other texts and GIA's name in its prompt.
  - Logo upload.
- **DEV:** nothing to apply.
