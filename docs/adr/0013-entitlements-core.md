# ADR-0013: Entitlements core

- Status: Accepted (Phase 2 approved by Geovet on 2026-09-26, first part)
- Date: 2026-09-26
- Builds on: [ADR-0007](0007-plans-entitlements.md)

## Decision

- **One package.** `packages/entitlements` holds the entitlement registry, the plan catalogue, the resolver, the limit checks and `authorize()`. It is pure TypeScript with no I/O and depends only on `@melonoffice/domain` types.
- **Typed registry, deny by default.**
  - Every entitlement key is declared once with its kind: feature, limit, per-scope limit or list.
  - Unset values resolve to off, zero or empty.
  - "No cap" must be written explicitly as `'unlimited'`. An absent limit is never read as unlimited.
- **Pending values stay unset.** The Emprendedor plan defines only what has been decided: owner only, `users.max = 1` (D-22). Every commercial value in D-12 (credits, storage, GIA voice, credit packs, add-ons, price, departments, roles, specialist ceilings) is left unset and so resolves to deny or zero. A test fails if a value is added without updating it, so each one needs an explicit decision.
- **Plans are versioned configuration.**
  - Emprendedor is `active`, `public` and `purchasable`.
  - Empresa and Corporativo are `prepared`, `hidden` and not purchasable, with no values.
  - A prepared plan grants nothing, and validation rejects a prepared plan that is public or purchasable.
- **Resolution order:** deny defaults → plan → add-ons → audited overrides → company caps.
  - Add-ons count only while `addons.allowed` is on and they have not expired.
  - Overrides need a reason and an approver.
  - A company can lower a limit but never raise it.
  - The result is frozen.
- **One authorization check.** `authorize()` allows an action only when all of these hold:
  - the principal belongs to the same organization;
  - the user's role permission is present;
  - the feature is entitled;
  - the release flag is on;
  - the item is in the allowed list;
  - the request stays within the limit.

  It denies when it cannot prove a requirement, for example when usage or scope is missing.

- **No parallel authority for GIA.** GIA and specialists act with the permissions of the user they act for. Actions marked `governance` (changing plans, entitlements, limits or permissions) are denied to them outright.
- **A fixture plan proves the engine works for more than one plan.** It exists only in tests and never ships. The key flows (invites, specialists, departments, voice and credit grant) run against both it and the launch plan.

## Not in this change

- RBAC role → permission mapping, memberships, auth, persistence, usage counters in Firestore, the audit log, API wiring and UI hooks. They come with the auth and tenancy work (D-6, D-10). `authorize()` receives the user's permissions and current usage from its caller.
- The caller must read usage and write the new usage in the same transaction (plan §11A.5).

## Consequences

- Activating Empresa or Corporativo later means filling in their values and changing their status. The code does not change.
- The lint rule `melonoffice/no-plan-name-comparison` covers this package too. The resolver is the only place that reads a plan.
