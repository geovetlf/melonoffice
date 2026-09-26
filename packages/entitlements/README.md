# @melonoffice/entitlements

The entitlements core ([ADR-0013](../../docs/adr/0013-entitlements-core.md)). It implements Plan → Entitlements → Limits → Features → Permissions ([ADR-0007](../../docs/adr/0007-plans-entitlements.md)).

It is pure TypeScript, with no I/O.

- `registry.ts`: every entitlement key, its kind and its deny default.
- `plans.ts`: the versioned plan catalogue. Only Emprendedor is active; its commercial values are pending (D-12) and resolve to deny or zero.
- `resolve.ts`: `resolveEntitlements()`, which applies the plan, add-ons, audited overrides and company caps, in that order.
- `limits.ts`: `checkLimit()` and `checkScopedLimit()`.
- `authorize.ts`: `authorize()`, the single check that combines role permission, entitlement, release flag, allowed list and limit.

Code asks this package for a capability or a limit. It never compares plan names.
