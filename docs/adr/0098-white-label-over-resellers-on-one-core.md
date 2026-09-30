# ADR-0098: White label above resellers, on the same commercial core (C-6a)

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0085](0085-commercial-platform-architecture.md), [ADR-0086](0086-commercial-authorization-and-persistence.md), [ADR-0087](0087-brand-config-and-domain-resolution.md), [ADR-0093](0093-partner-member-invitations-with-consent.md), [ADR-0097](0097-only-grantable-customer-scopes.md)
- Terraform: none. Firestore: one new optional field (`parentAccountId`) on `commercialAccounts`; no migration.

## Context

Geovet's product rule (2026-09-30) sets three ways to sell now, on one MelonOffice core:

- Direct: MelonOffice → the owner's company.
- Reseller: MelonOffice → reseller → its customers. A reseller manages only its own customers.
- White label: MelonOffice → white label → its resellers and its own direct customers. The white label runs its resellers, customers, admins, brand and domains.

Other modalities (partner, OEM, embedded, enterprise, API) are prepared, not built. Commercial administration is not business-data access: private data needs explicit, scoped, audited permission.

We audited the commercial model of ADR-0085..0097 against that rule.

- It already covers a commercial account, its members and roles, its customers with the scopes each grants, its invitations, its brand and the platform's control.
- The gaps were three.
  - It had no "white label" or "reseller" account types; `partner` stood in for both.
  - It had no hierarchy between accounts.
  - Commercial membership did not require a verified email, unlike platform administration.

Nothing needed a second tenancy, wallet, billing, credits, audit or identity.

## Decision

Extend the existing model; duplicate nothing.

- **Account types.** `reseller` and `white_label` join `partner` and `agency`. Existing partner and agency accounts keep working unchanged. The platform creates only a reseller or a white label now.
- **Hierarchy.**
  - A reseller may carry `parentAccountId`: the white label it works under. It is set at creation and never changes.
  - Only a reseller has a parent, and only a white label is a parent. There are two levels, never more.
  - A white label's limits gain `resellers`: how many it may have. Without it, it cannot create any.
- **Who creates a reseller.**
  - A white label admin (`white_label.admin`, new permission `commercial.manage_resellers`) creates one.
  - Its limits may not exceed the white label's own. Each limit is checked against the white label's, and they are not added up.
  - Its first admin is invited by email (ADR-0093): the link is shown once, only its hash is stored, and they join by accepting it.
  - Account and invitation are created in one transaction, which also checks that the white label is active, reads its version and counts its open resellers against the limit.
- **What a white label may do with its resellers.**
  - It sees each one's name, status, limits, customer count and pending first admin.
  - It may suspend or reactivate one. Closing stays the platform's.
  - It never reaches a reseller's customers: each customer grants its scopes to the account it works with, and to no one above it.
- **Cascade.**
  - A reseller under a white label works only while that white label is active (`parentAllows`).
  - Suspending or closing the white label stops its resellers' consoles, its members' invitations and its brand, with nothing written to the children.
- **Modes.**
  - A white label's customers are `white_label`. So are those of a reseller under a white label: it sells under that brand.
  - A reseller on its own sells MelonOffice (`reseller`), and its console shows no brand section.
  - The API and the console share this one rule (`customerModesOf`).
- **Brand.**
  - For a reseller under a white label, the brand levels are: platform, then white label, then reseller, then a customer's own white-label brand, then the organization.
  - A suspended white label drops out of the chain.
- **Roles.** `reseller.admin`, `reseller.support`, `white_label.admin` and `white_label.support`. Support only reads. A role still works only in an account of its own type.
- **Verified email.** Every commercial context now needs a verified email, as platform administration already did. It is refused as `commercial_account_forbidden`, like every other refusal.

## Security: strong for admins, simple for owners

The auth audit (2026-09-30) found the following.

- Sign-in is email and password via Identity Platform.
- The API verifies the token and requires `auth_time`, but never checks how recent it is.
- There is no MFA, TOTP or WebAuthn code.
- Identity Platform's MFA offers SMS and TOTP only, not passkeys.

Proposed for Geovet's decision; not built here.

1. First, `auth_time` freshness for sensitive administrator writes (platform, white label and reseller admins): sign in again if the last sign-in is older than a set window. It needs no new provider and no codes.
2. Then passkeys (WebAuthn, the device's biometrics) as a step-up for those same administrators only, stored per user in Firestore and checked by the API.
3. A business owner keeps signing in and entering their office with no extra codes. No code-based MFA for everyone.

## Consequences

- Direct SaaS is untouched. Partner and agency accounts, their roles, customers and brands keep working.
- Isolation is proven by API tests over memory and Firestore:
  - White label A vs B.
  - Reseller 1 vs 2 and their customers.
  - A white label cannot read its reseller's customer.
  - Customer A vs B.
  - A suspended white label.
  - The mode rules.
- Tenancy unit tests cover `customerModesOf`, `parentAllows` and the verified-email rule.
- A commercial member with an unverified email loses the console until they verify it.
- Open for later: a white label's direct view of its resellers' usage totals (not asked for), `auth_time` freshness and passkeys (Geovet's choice), and whether older partner and agency accounts move to the new types.
