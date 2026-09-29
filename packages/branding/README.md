# @melonoffice/branding

How the product presents itself, and which domain shows which brand ([ADR-0087](../../docs/adr/0087-brand-config-and-domain-resolution.md)). Server only, with no HTTP.

- `config.ts`: `parseBrandConfig()`, the brand fields and their checks. Only the customer's own level sets its facts (company, time zone, currency, country).
- `domains.ts`: hostnames, domain targets and the binding statuses (`pending_verification`, `verified`, `active`, `disabled`).
- `repository.ts`: the `BrandRepository` port and a memory implementation. Firestore's is in `@melonoffice/firestore`.
- `resolve.ts`: `PLATFORM_BRAND`, `effectiveBrandOf()` (platform → partner → customer → white label), `accountBrandOf()` and `resolveDomain()`. A resolved domain chooses a look, never access.
