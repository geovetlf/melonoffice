# ADR-0094: Partner and agency members without a company of their own (C-5d)

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0090](0090-partner-console-and-brand-screens.md), [ADR-0093](0093-partner-member-invitations-with-consent.md)
- Terraform: none. No API change.

## Context

After ADR-0093 a person can join a partner or agency account without belonging to any organization. The API already serves the console to them (every console route checks the commercial membership, not an organization), but the web gate sent every signed-in person with no organization to "Create your organization", so a freelance support person had to invent a company to reach `/partner`.

## Decision

- `ProtectedRoute` takes what to show a signed-in person with no organization. The app gives it a view that asks the API which commercial accounts the person belongs to (`GET /v1/commercial/accounts`, only active memberships of active accounts).
- At `/partner`, a member sees the console on its own page, with "Create my own company" and "Sign out". Anywhere else, they see the usual "Create your organization" form with a line saying they are part of an account and a button to open the console.
- Someone in no account (or when the API does not answer) sees only the usual form, even at `/partner`. Nothing is inferred in the browser: the list comes from the API, and every console request is authorized there as before.

## Consequences

- Joining an account by invitation leads straight to its console, with no company of one's own.
- Such a person has no office, GIA, credits or departments; those stay tied to an organization.
- Tests: the web app offers the console to a member without a company, opens it, and still lets them create one; someone in no account is not offered it, even at its address.
