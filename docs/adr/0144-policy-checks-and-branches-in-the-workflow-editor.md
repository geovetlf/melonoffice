# ADR-0144: policy checks and branches in the workflow editor

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0028](0028-planner-delegation-and-workflows.md) (workflows), [ADR-0071](0071-workflows-over-http.md) (Automations), [ADR-0075](0075-plan-conditions.md) (decision conditions in plans, WF-4)
- Terraform: none. Firestore: none. Prompts: none. API: one read-only field on each workflow step.

## Context

The workflow editor wrote only agent steps, one after another. The API already accepted every step kind, and plans could already run decision conditions (WF-4). A workflow with any other shape showed "can only be changed through the API".

Only two kinds of step can run today: agent steps and decision conditions (`RUNNABLE_STEP_KINDS`, ADR-0075). The worker decides a condition only with `action.policy_check` (`CONDITION_DECISION_TYPES`). Any other step kind makes the whole plan refuse approval.

## Decision

1. **A step is an agent step or a company policy check.** A check is a `condition` step with a decision (ADR-0075):
   - the type is always `action.policy_check`, the only one the worker decides;
   - it continues on `allowed` only, so a check that says "not allowed" or "needs approval" skips the steps that wait for it, and the rest of the plan goes on;
   - its input is fixed when it is written: the action, from the Decision Engine's catalogue as `GET .../decisions/actions` lists it, and an optional discount percentage. No model output or content reaches it.
2. **Each step waits for the earlier steps the person ticks**, so a workflow can branch: a step that does not wait for a check runs whatever the check says. A step may wait only for steps before it. Moving or removing a step drops waits that would point at a later or missing step. A check must wait for at least one step, as the planner requires.
3. **Nothing new on the server.** The browser sends steps. `checkWorkflowSteps` and the planner check them again as before. The API's workflow step view adds `decision` (type, `continueOn`, input), which holds only short codes and numbers, so a saved check can be shown and edited.
4. **What the editor still leaves to the API.** Tool, approval, verification and parallel steps, the older `condition` form, and decisions of any other type. A workflow with one of these is still shown with "can only be changed through the API", never rewritten.
   - Offering them would let a person build workflows that can never be approved.
   - Tool steps also need decisions about irreversible actions, tool risk and credits.

## Evals

This changes the web editor and one read-only field in the API. No prompt, model context, Agent Engine, routing, tool or policy changes. A check is decided by the existing Decision Engine without a model. No run is needed, and V3 stays the baseline.

## Consequences

- Tests:
  - `apps/api/src/plans.test.ts`: a workflow with a check and a branch is shown with its decision, planned and approved.
  - `apps/web/src/automations/automations.test.tsx`: writing a check and a branch, the rules on waits, editing a saved check without changing its shape, and a workflow the editor leaves to the API.
- Still open: the step kinds the runtime cannot run yet (ADR-0075 Open), and more decision types once the worker can decide them.
