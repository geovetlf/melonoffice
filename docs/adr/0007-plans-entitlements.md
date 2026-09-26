# ADR-0007: Plan → Entitlements → Limits → Features → Permissions

- Status: Accepted (D-25, closed by Geovet on 2026-09-26)
- Date: 2026-09-26

## Decision

| Layer        | Meaning                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan         | A versioned commercial package. Only **Emprendedor** is active at launch; **Empresa** and **Corporativo** exist only as disabled future configuration.   |
| Entitlements | What an organisation may use, resolved from plan, add-ons and audited overrides.                                                                         |
| Limits       | Optional numeric caps (absent = no cap): global, per department, specialists, credits, storage, users, etc. A company may lower them, never exceed them. |
| Features     | On/off capabilities, available only when released and entitled.                                                                                          |
| Permissions  | What a user may do (roles), intersected with the layers above.                                                                                           |

Rules:

- **No code compares or switches on plan names or plan ids.** Code asks for entitlements, limits, features and permissions. This is enforced by the lint rule `melonoffice/no-plan-name-comparison` (`packages/config/eslint-rules`).
- The plan never selects the Home mode (Animated or Static); that is a presentation preference.
- GIA can read and explain plans and propose allowed changes, but has **no authority** over plans, limits or permissions and no parallel authority path; anything it proposes goes through the same commands, authorisation, user confirmation and audit as a manual action.
- Activating Empresa or Corporativo later is a configuration change: no model rewrite, no duplicated logic, no plan-specific branches.

## Consequences

The entitlement resolver (a later phase) is the only place that knows about plans.
