# @melonoffice/entitlements

The entitlements core ([ADR-0013](../../docs/adr/0013-entitlements-core.md)) and the plan and capability foundation ([ADR-0021](../../docs/adr/0021-entitlements-plan-and-capability-foundation.md)). It implements Plan → Entitlements → Limits → Features → Permissions ([ADR-0007](../../docs/adr/0007-plans-entitlements.md)). Server only.

- `registry.ts`: every entitlement key, its kind and its deny default. Feature keys are the capabilities; limit keys are the limits.
- `plans.ts`: the versioned plan catalogue and `DEFAULT_PLAN` (Emprendedor v1), the plan new organizations start on. Only Emprendedor is active; its commercial values are pending (D-12) and resolve to deny or zero.
- `resolve.ts`: `resolveEntitlements()`, which applies the plan, add-ons, audited overrides and company caps, in that order.
- `limits.ts`: `checkLimit()` and `checkScopedLimit()`.
- `service.ts`: `createEntitlementService()`, with `entitlementsOf()`, `hasCapability()` and `getLimit()` for a resolved `TenantContext`. It gets the plan in force from a `PlanSource` (billing, ADR-0022) and answers from the catalogue in code. It is separate from RBAC: a caller that needs both asks both.
- `authorize.ts`: `authorize()` from ADR-0013. No route uses it; RBAC (ADR-0019) and the entitlement service are asked separately instead (ADR-0021).

Code asks this package for a capability or a limit. It never compares plan names.
