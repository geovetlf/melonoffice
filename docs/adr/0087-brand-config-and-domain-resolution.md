# ADR-0087: Brand configuration and domain resolution (Commercial Platform phase 3)

- Status: Proposed
- Date: 2026-09-29
- Builds on:
  - [ADR-0085](0085-commercial-platform-architecture.md) (points 7 and 8: branding precedence, domain resolution)
  - [ADR-0086](0086-commercial-authorization-and-persistence.md) (commercial authorization)
  - [ADR-0048](0048-business-profile.md) (the customer's facts)
- Terraform: none. There are two new Firestore collections, read by id and written only by the API. No index is needed.

## Context

The brief asks for one `BrandConfig` that a partner can use to sell MelonOffice under its own brand, and a `DomainBinding` that resolves `domain → commercial or tenant context → brand → application configuration`. DNS and certificates come later: first the abstraction and the resolver.

The audit on main `f2c8204` found nothing to reuse for a brand:

- the web hardcodes the name in `index.html`, `app.name` and `app.logo`, and about fifteen texts;
- the colors are tokens in `@melonoffice/ui`;
- the customer's country, currency and time zone already live in its business profile.

## Decision

1. **`BrandConfig`** (`@melonoffice/domain`, checked by `@melonoffice/branding`). Every field is optional:
   - names: `brandName`, `productName`, `assistantName` and `agentNaming` (singular and plural);
   - images: `logoUrl` and `faviconUrl`, https only and without credentials (uploads come later);
   - colors: `primaryColor` and `secondaryColor`, as `#rrggbb`;
   - texts: `login` (title, message), `email` (sender name, footer) and `notifications` (sender name);
   - `supportContact` (email, phone, https url) and `links` (legal, privacy, terms; https);
   - `defaultLanguage` (`en` or `es`, kept equal to the product's languages by a test);
   - the customer's facts: `company` (legal name, address, website), `timeZone`, `currency` and `country`. They reuse the business profile's checks.

   Unknown fields are refused. A refusal names the field, never the value. Typography is not included: the product has one type scale, and a font choice would need its own loading rules.

2. **Precedence.** `effectiveBrandOf(organization)` applies:
   1. platform (`PLATFORM_BRAND` in code: MelonOffice, GIA and its colors; no links or contacts, none invented);
   2. the partner's own brand, only while the organization is an active white-label customer of an active partner, and only when that is its one white-label relationship;
   3. the customer's own level: its business profile's facts, then its brand configuration;
   4. the white-label level the partner set for that customer, only while the customer grants `branding`.

   Each level fills or replaces the one before it, and groups merge key by key. A partner never sets the customer's facts: the commercial levels refuse them. A reseller or agency customer keeps MelonOffice's brand. "MelonOffice" stays the technical identity.

3. **Who writes each level.** Each level is written by its owner only, with the version it read (`expectedUpdatedAt`, stale is `brand_conflict`), and audited as `brand_config.updated` in the same transaction.
   - The organization's owner writes the customer level: new permission `brand.manage`, a person only.
   - A partner's or agency's admin writes their account's level: `commercial.manage_brand`.
   - A partner's admin writes one white-label customer's level: `customer.manage_brand`. It needs an active relationship of that very account, mode `white_label`, and the `branding` scope, which `createCommercialAuthorization` checks. Every refusal is `customer_forbidden`, audited.
   - Support and managers only read. An agency does no white label.

4. **`DomainBinding`**, at `domainBindings/{hostname}`, one per hostname.
   - A binding has a target (one commercial account or one organization), a status and who created it.
   - Hostnames are lowercase, with at least two labels, no port and no IP address.
   - Statuses: `pending_verification → verified → active → disabled → pending_verification`. Nothing skips verification.
   - Only the platform administrator registers a domain, for an existing active target, and moves it along its statuses. Both actions are audited, including refusals.
   - "Verified" is the administrator's word for now. A DNS TXT check replaces it when DNS comes.

5. **Resolution.** `resolveDomain(host)` resolves only an `active` binding of exactly that hostname, and only to its own active target. Everything else (unknown, pending, verified, disabled, malformed, or a suspended target) resolves to the platform.
   - An organization target gets its effective brand.
   - An account target gets platform plus the account's own level.
   - **It authorizes nothing.** Every request still resolves its organization from the signed-in person's own membership. A domain chooses a look, never access.

6. **API.**
   - `GET /v1/public/brand?host=` is the only route without a signed-in person. It answers the context type and the presentation fields: names, images, colors, login, support and links. It never answers an id, a company fact or email texts.
   - Owner routes: `GET` and `PUT /v1/organizations/:id/brand`.
   - Partner and agency routes: `GET` and `PUT /v1/commercial/accounts/:id/brand`, and `GET` and `PUT …/customers/:organizationId/brand`.
   - Platform routes: `GET` and `POST /v1/platform/domain-bindings`, and `POST …/:hostname/status`.

7. **Web.** At start-up the page asks the API for its host's brand. A host with an active domain shows:
   - its product name in the title, the sign-in heading and the sidebar;
   - its favicon;
   - its main color, only when white text on it stays readable (WCAG AA 4.5:1).

   Every other host looks exactly as before.

## Consequences

- Security tests (API, memory and Firestore):
  - **10**: White Label A cannot modify White Label B, through either account's path, as support, or as the other customer's owner;
  - **11**: Domain A cannot resolve to Tenant B. It resolves only when active, only to its own target; the hostname is taken once; lookalikes resolve to nothing; a resolved domain grants no access.

  Unit tests cover precedence, the checks and the resolver.

- Nothing changes for an organization without a brand or a domain. No existing record changes and no migration is needed.
- **Not in this change:**
  - Real DNS verification and certificates, and serving a custom domain. Cloud Run domain mapping or a load balancer is infrastructure, with its own Terraform and its own approval.
  - CORS for a custom domain. The API allows only `webOrigins`, so a custom domain's page cannot call the API until its origin is allowed. That comes with serving the domain.
  - Using the brand in the app's texts: about fifteen texts still say MelonOffice, GIA's name in its prompt, email and notification senders. That comes with the phase 4 console.
  - Logo upload: an https address only.
  - Screens to edit a brand or a domain. That is the phase 4 console; phase 3 is API only, besides applying the public brand.
- **DEV:** nothing to apply. The public route is live with the API. Every host resolves to the platform until the platform administrator activates a binding.
