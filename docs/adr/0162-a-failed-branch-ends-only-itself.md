# ADR-0162: a failed step ends only its own branch

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR-0070](0070-approved-plans-run.md) (the plan conductor), [ADR-0146](0146-step-approvals-inside-running-plans.md) (a declined step skips its branch), [ADR-0153](0153-failed-plan-steps-run-again.md) (retries), [ADR-0155](0155-plan-step-states-and-failures.md) (where a plan stopped)
- Product decision: Geovet, 2026-10-04 14:19Z, decision 4.
  - A failed branch is marked failed and only its dependents are skipped. Independent branches go on.
  - The plan does not fail only because an independent branch failed.
  - The result shows which branch failed and what was skipped.
  - Approvals keep their meaning: approved goes on; rejected or expired skips the step and its dependents.
- Terraform: none. Firestore: none. Prompts: none.

## Context

A step fails when its child failed or was cancelled, or when its check could not go on. Until now, the conductor stopped the whole plan at the first failed step. A plan with two independent branches lost the second branch's work because the first one failed.

## Decision

1. **A failed step ends its own branch.** It ends it like a stopped, declined or skipped step does. The steps that wait on it, directly or through others, are `skipped` and never start.
   - A step that will run again (ADR-0153) has not failed yet: its retry comes first.
   - Checks and waits on other branches are still decided and started. A failed step no longer holds them back.
2. **When the plan ends.**
   - **Every branch failed.** Each last step (one no other step waits on) failed, or was skipped because a step before it failed. The plan is `failed` at once, with the first failed step's code, as before. Nothing it could still run would reach a result, so nothing more starts, and the approvals still waiting for a person are withdrawn (`plan_ended`).
   - **Otherwise** the plan goes on until no step is left to run. It then `completed`s with the reason `branch_failed`, naming the first failed step and its child's own code.
   - A plan with no failed step completes as before.
3. **What shows the failed branch.**
   - The planning execution's graph marks each failed step's node `failed` with its child's own code, or with why it failed (`condition_failed`, `step_approval_not_configured`, …), as soon as it fails. Each change is audited (`execution.node_changed`).
   - The steps after it are `skipped`.
   - `GET /plans/:id/steps` and `GET /plans/:id/trace` show each step's state by the same rule.
   - `plan.state_changed` records `branch_failed` with the step and its cause.
4. **The planning execution still fails.** An execution completes only when every node completed or was skipped, with evidence (ADR-0029). That rule is not weakened. A plan that completes with a failed branch closes its execution as `failed` with `branch_failed`, pointing at the failed child. The plan's own status is what the person reads.

## Evals

No prompt, model context, routing or model changes. No run is needed and V3 stays the baseline.
