# ADR-0159: workflow step kinds, and tool steps that only read

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR-0144](0144-policy-checks-and-branches-in-the-workflow-editor.md) (writing workflows), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps), [ADR-0156](0156-workflow-structure-checked-on-save.md) (structure checked on save)
- Product decision: Geovet, 2026-10-04 14:19Z, "DECISIONES DE PRODUCTO APROBADAS", decisions 1 and 2.
- Terraform: none. Firestore: none. Prompts: none.

## Context

A workflow could hold seven kinds of step. A plan runs only four of them: an agent, a tool that agent uses, a policy check and a wait. Approval, verification and parallel steps, and conditions on how another step ended, were saved and then refused when the plan ran. A plan's tool step could also name any tool the agent listed, including one that changes data, reaches an external provider or needs a credential.

Geovet decided:

- Workflows hold agent, tool, check and wait steps.
- Approval is a setting of a step ("requires approval before it runs"), never a step of its own.
- There is no `parallel` step. Independent branches already run side by side.
- Tool steps in v1 only read, inside MelonOffice: the Company Brain and the organization's own data. Nothing that sends, publishes, pays, changes external data, can't be undone or depends on an external provider.

## Decision

1. **Workflow kinds.** Saving a workflow, or a new version of one, refuses with `invalid_workflow`:
   - any step whose kind is not `specialist`, `tool`, `condition` or `wait` (`steps.N.kind`);
   - a `condition` step that names how another step ended instead of a decision (`steps.N.condition`).

   Approval stays `approvalRequired` on the step.

2. **Read-only tool steps.** The plan validator refuses, at its policy stage, a tool step whose tool version is `mutating`, has a provider of kind `external`, or needs any credential (`tool_not_read_only`). This holds for every plan, whether it comes from a workflow or from the planner. The Tool Gate still checks everything else when the step runs.
3. **Stored data.** Workflow versions and plans saved before keep their steps and are read as they are. A plan with a step it can't run is still refused when it runs (`plan_not_runnable`).
4. **The planner's prompt is unchanged.** It still names the other kinds. Changing its text would be a prompt change (ADR-0133), so that is left for a separate decision. Its proposals with those kinds are refused when run, as before.

## Evals

No prompt, model context, routing, model or agent behaviour changes, so no run is needed and V3 stays the baseline.

## Consequences

Tests:

- `packages/workflows`: each refused kind, a condition on how a step ended, and approval as a step setting.
- `packages/planning`: a mutating tool, an external one and one with a credential are refused; a read-only tool that asks for approval is planned and approved as before.
