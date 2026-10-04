# ADR-0156: a workflow's structure is checked when it is saved

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0028](0028-planner-delegation-and-workflows.md) (plans and workflows), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps), [ADR-0152](0152-wait-steps-in-plans.md) (wait steps)
- Authorization: Geovet, 2026-10-04 11:41Z, "MODO AVANCE MÁXIMO DEL MOTOR", priority 11: Workflow Engine validations.
- Terraform: none. Firestore: none. Prompts: none.

## Context

When a workflow version was saved, its steps were checked only against the proposal schema: field types, sizes, and no authority in them. Everything else waited until the workflow was planned:

- whether each kind carries what it needs (a wait its time, a tool step its performer);
- whether a tool step waits only on its own specialist's work;
- whether a step depends on a tool step;
- whether the graph has a cycle or names a step it does not have.

So a workflow that every plan of it would refuse could be saved and activated, and failed only when someone planned it.

## Decision

1. **One check.** The plan validator's structural stage is now a pure function, `checkStepStructure`: the shape each kind needs, then the dependencies and the graph, with X1's own graph check. It reads nothing and decides nothing about specialists, tools or permissions, which stay per organization with the validator. The validator uses the same code as before.
2. **On save.** Creating a workflow or saving a new version runs it after the proposal schema. A workflow's specialist steps name an assignee instead of a specialist, so the check does not ask for a specialist on them. A refusal is `invalid_workflow` with the field (`steps.1.wait`) or the reason (`invalid_dependency`, `invalid_tool_dependency`, `invalid_performer`, `plan_cycle`, `unknown_dependency`), as for other invalid steps.
3. **Kinds.** Approval, verification and parallel steps are still accepted in a workflow, as before. Their plans are refused when run (`plan_not_runnable`), and whether a template may hold them is not decided here.
4. **Stored versions.** Versions saved before are read as they are: the check runs on writes only.

## Evals

No prompt, model context, routing, model or agent behaviour changes, so no run is needed and V3 stays the baseline.

## Consequences

Tests:

- `packages/workflows`: each refusal, and that a valid template, waits included, is kept.
