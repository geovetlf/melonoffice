# ADR-0182: Automations lists plans and a workflow's runs a page at a time

- Status: Accepted
- Date: 2026-10-06
- Builds on: [ADR-0150](0150-every-plan-in-every-agents-work.md) (plans a page at a time), [ADR-0180](0180-each-workflow-shows-its-runs.md) (each workflow shows its runs)
- Product decision: Geovet, 2026-10-06 19:01Z and 19:40Z, autonomous cycle: the next functional layer of workflows and plans, on the existing engines, without needing him.
- Terraform: none. ADR-0150's index serves the organization's pages, with its fallback where the index is missing. A workflow's runs use ADR-0180's equality filters. Firestore: no new field, no migration. Prompts, models and providers: none.

## Context

ADR-0180 left a known limit: the Automations plans list and a workflow's "Ejecuciones" show at most the newest 100 plans. A workflow that runs often, or an organization with many plans, loses its older history from the screen, although every plan is still stored. ADR-0150 already reads an organization's plans a page at a time, newest first by creation and then id, but only the list of every agent's work uses it.

## Decision

1. **`GET plans` answers a page.**
   - It returns at most 100 plans (`MAX_PLANS_LISTED`), the window it had, newest first by creation and then id, plus `nextCursor`, which is `null` when nothing older remains.
   - `?cursor=` continues after the last plan of the previous page.
   - The cursor names the organization, the list it belongs to (the organization's plans, or one workflow's with `?workflowId=`) and the last plan's position. A cursor from another organization, from another list, or malformed is `400 invalid_cursor`.
   - Permissions and tenant checks are unchanged (`plan.read`).
2. **The organization's pages are ADR-0150's `PlanService.page`.** No second paging is added.
3. **A workflow's pages** come from `PlanService.pageForWorkflow`. It reads that workflow's plans with ADR-0180's two equality filters and pages them in the same order with the same rule (`pageOfPlans`). This is what `listForWorkflow` already read; it no longer stops at 100.
4. **The screen shows "Ver planes anteriores".** It appears under the plans list and under a workflow's "Ejecuciones" while `nextCursor` is set. It adds the next page below without repeating a plan. Loading and error states use the existing components.
5. **Other readers are unchanged.** The notifications and the office's motor read the first page, which is the newest 100 plans they read before.

## What did not change, and why

- **The first page is what `GET plans` returned before**, the newest 100, so a client that does not page sees no change.
- **A workflow's runs are still read whole and then paged.** Asking Firestore for one page of one workflow's plans in order would need a new composite index (`organizationId`, `workflowId`, `createdAt`), which is infrastructure. ADR-0180's read already worked this way.

## Tests

- `packages/planning`: `pageForWorkflow` returns only that workflow's plans in that organization, newest first, a page at a time, each once.
- `apps/api`, on memory and Firestore:
  - pages of the organization's plans and of one workflow's reach every plan once, newest first;
  - `nextCursor` is null at the end;
  - a cursor from another organization, from another list, or malformed is `400 invalid_cursor`;
  - another organization's plans are never returned.
- `apps/web`: "Ver planes anteriores" adds the next page of the plans list and of a workflow's runs, without duplicates, and disappears at the end.
