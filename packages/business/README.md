# @melonoffice/business

What the business is: its profile ([ADR-0048](../../docs/adr/0048-business-profile.md)). Server only, with no HTTP.

- `catalogue.ts`: the kinds of business, as data, each with the order its departments are suggested in.
- `profile.ts`: the profile's fields and their checks (country ISO 3166-1, currency ISO 4217, IANA time zone).
- `repository.ts`: the `BusinessProfileRepository` port and a memory implementation.
- `service.ts`: `createBusinessProfileService()`, on a resolved `TenantContext`.
