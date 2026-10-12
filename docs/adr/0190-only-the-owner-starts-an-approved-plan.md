# ADR-0190: only the owner starts an approved plan

- Status: Accepted
- Date: 2026-10-12
- Builds on: [ADR-0019](0019-rbac-foundation.md) (permissions), [ADR-0070](0070-approved-plans-run.md) (an approved plan runs), [ADR-0146](0146-step-approvals-inside-running-plans.md) (step approvals inside running plans), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps in plans), [ADR-0179](0179-workflow-lifecycle-and-reliability.md) (an approved plan cut short starts when approved again)
- Decision: Geovet chose «Solo dueño» on 2026-10-12 (decision card, 02:21Z): a plan starts only when the person who planned it starts it.
- Terraform: none. Firestore: none. No migration, no index.

## Context

Approving a plan is the decision that starts it: the approval runs the plan's first steps, and the worker's conductor starts the rest (ADR-0070). Until now any person with `approval.approve` could approve a plan that someone else planned, and that approval also started it. Starting spends the credits the approved budget allows, so the person who planned the work should be the one who starts it.

## Decision

1. **Owner.** The owner of a plan is the person who created it (`createdBy`). A plan that a schedule runs (ADR-0185, ADR-0186) is started by the schedule and never goes through the approve route.
2. **Who starts.** Only the owner starts an approved plan. Starting covers the approval that starts a plan, and the resume of an approved plan that was cut short before it started (ADR-0179).
3. **Another approver.** Their approval is recorded like any other decision: same version and digest, audited as `plan.approved`. It does not start the plan. The response shows the plan as `approved`, and the owner starts it.
4. **Refusal.** Another approver who asks to start an approved plan gets `403 plan_start_not_owner`. Nothing runs, and nothing is recorded.
5. **Unchanged.** Step approvals (ADR-0146, ADR-0151) go through the approvals route and work as before. So do `plan.read`, `approval.approve`, the version and digest checks, the refusal of a plan with a step it cannot run, and reject.

## Consequences

- A plan approved by someone other than its owner stays `approved` until the owner starts it. The web app's text for that state is a separate change.
- A plan whose owner has left the organization cannot be started by anyone and stays `approved`. Who may start it, or cancel it, is not decided here and needs its own decision.
- `plan_start_not_owner` is a new planning error code, answered with 403.
- Code: `apps/api/src/plans.ts` (the approve route, its resume and decision paths), `packages/planning/src/errors.ts`, and the ADR-0190 tests in `apps/api/src/plans.test.ts`.
