# ADR-0150: every plan in the list of every agent's work

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0149](0149-plan-steps-in-every-agents-work.md), plan steps in the list of every agent's work
- Authorization: Geovet, 2026-10-04 09:18Z, "Autorizo eliminar el límite de los últimos 100 planes". DEV only, applied by Geovet; no migration and no other infrastructure.
- Terraform: one Firestore composite index on `plans`. Firestore: no migration, no new field. Prompts: none.

## Context

ADR-0149 read plan steps from the plan service's list, which holds the newest 100 plans (`MAX_PLANS_LISTED`). Steps of older plans were not listed, and the screen said so.

## Decision

1. **One index.** `plans`: `organizationId` ascending, `createdAt` descending (`google_firestore_index.plans`, DEV only through `firestore_and_auth`). Firestore adds the document id after it in the same direction, so a page of plans is `organizationId ==`, newest first, then id, a page at a time.
2. **Plans a page at a time.** `PlanRepository.page` and `PlanService.page` return an organization's plans newest first, strictly after a position (creation, id), with `hasMore`. Every plan is reachable; there is no window. `list` and its 100 plans for Automations are unchanged.
3. **A step's place is its plan's creation.** A step is placed by when its plan was created, then its execution id. This is the order the index gives, so pages are exact and stable. ADR-0149 placed it by the plan's approval, which no stored field orders without a new field and a backfill (a migration).
4. **Plans read in batches.** The step source reads plans 25 at a time and only as far as the page needs. Steps of plans created in the same instant are held until no later batch can add one, so their order by execution id is exact across batches.
5. **Without the index.** Until Geovet applies it, Firestore refuses the query. The repository then reads the organization's plans through the automatic single-field index, as `list` already does, pages them in memory and logs `firestore.index_missing` with `plans`. Nothing breaks before or after the apply.
6. **No window on screen.** `planStepsWindowed` and its notice are gone.

Permissions, tenant checks, fields, filters and the cursor are those of ADR-0148 and ADR-0149.

## Evals

No prompt, model context, routing, model or Agent Engine behaviour changes, so no run is needed and V3 stays the baseline.

## Consequences

- A step created when its plan was approved now sorts at the plan's creation, which can be earlier than tasks asked in between. Its own dates still show when it ran.
- The index costs Firestore storage per plan, which is small.
- Tests:
  - `apps/api/src/plans.test.ts`: plans past the newest 100 are paged, each once, newest first, and only the organization's own. Their steps are listed one page at a time. Both stores run this.
  - `infra/modules/environment/tests/environment.tftest.hcl`: DEV has the index with these fields, and an environment without Firestore has none.
