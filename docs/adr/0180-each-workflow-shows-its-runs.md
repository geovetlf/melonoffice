# ADR-0180: each workflow shows its runs, and each plan names its workflow

- Status: Accepted
- Date: 2026-10-06
- Builds on: [ADR-0071](0071-workflows-over-http.md) (workflows over HTTP), [ADR-0150](0150-every-plan-in-every-agents-work.md) (plan listing), [ADR-0178](0178-saved-workflows-run-end-to-end.md), [ADR-0179](0179-workflow-lifecycle-and-reliability.md)
- Product decision: Geovet, 2026-10-06 19:01Z, autonomous cycle "Frente B": find the next real bottleneck for workflows and plans to be a solid capability, in particular a coherent UX between workflow, plan and execution, observability and multi-tenant isolation, on the existing engines.
- Terraform: none (the query uses equality filters only, served by Firestore's automatic indexes). Firestore: two optional fields on new plans, no migration. Prompts, models and providers: none.

## Context

After ADR-0178 and ADR-0179 a workflow runs end to end and its lifecycle is checked. An audit of what a person sees afterwards found the link between a workflow and what it did missing in both directions:

- **From a workflow, nothing leads to its runs.** The Automations screen lists the organization's latest 100 plans, each titled only by date and status ("Plan del 6 oct, 10:00 · Aprobado"). A person cannot answer "what did this automation do, with which version, and how did it end?". ADR-0179's text for an archived workflow ("Solo queda su historial") promises a history the screen does not show.
- **From a plan in the list, nothing says which workflow made it.** The workflow and version are on the plan's first version only (`PlanVersion.source`), so the list cannot show them without reading every version.
- **The API has no way to ask for one workflow's plans.** `GET plans` returns the organization's latest plans; any per-workflow view would have to fetch and filter them in the browser, and miss older ones.

## Decision

1. **A plan made from a workflow records which one, on the plan itself.** `Plan.workflow = { id, version }` is set when the plan is created from a workflow source and never changes: `checkNextPlan` refuses an update that changes or drops it, and `checkStoredPlan` refuses a malformed one. A plan from the planner has none. The plan version keeps `source` as before; this is a copy of the same fact where lists can read it.
2. **The plan repository lists one workflow's plans.** `listForWorkflow(organizationId, workflowId, limit)` returns that workflow's plans in the organization, newest first. In Firestore it queries `organizationId ==` and `workflowId ==`, two equality filters that need no composite index. Another organization's plans are never returned, whatever the id.
3. **`GET plans?workflowId=<id>` answers it**, under the same `plan.read` permission. A malformed id is `400 invalid_workflow_id`. Every plan view carries `workflow: { id, version } | null`.
4. **The Automations screen joins them.**
   - Each workflow has "Ejecuciones", its plans newest first: date, version and status. Choosing one opens the plan card as the plans list does.
   - An archived workflow shows them too, so "Solo queda su historial" is true.
   - The plans list names each plan's workflow and version ("«Seguimiento» · v2 · 6 oct, 10:00 · Aprobado").
   - Empty, loading and error states use the existing components.

## What did not change, and why

- **Plans made before this change have no `workflow` field.** They still appear in the organization's plans list and their card still says which version made them (from `source`), but not in a workflow's "Ejecuciones". Copying it onto them would be a data migration, which needs the owner's approval; DEV holds only test data.
- **No new engine, store or permission.** It is a field, a query and a view on the existing plan store, API and screen.
- **The plans list keeps its window of 100.** Paging it is a separate change.

## Tests

- `packages/planning`: a workflow plan records its workflow and version, a planner plan none; an update that changes or drops it is refused; `listForWorkflow` in memory returns only that workflow's plans in that organization.
- `packages/firestore`: the same on the emulator, with another organization's plan of the same workflow id never returned.
- `apps/api`: `GET plans?workflowId=` lists only that workflow's plans, refuses a malformed id, needs `plan.read`, and keeps other organizations out; every plan view carries `workflow`.
- `apps/web`: a workflow's "Ejecuciones" (list, empty and error states, opening a plan), an archived workflow's history, and the workflow and version in the plans list.
