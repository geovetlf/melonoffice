# ADR-0192: an orphaned plan is only cancelled, and nobody starts it

- Status: Accepted
- Date: 2026-10-12
- Builds on: [ADR-0019](0019-rbac-foundation.md) (permissions and roles), [ADR-0029](0029-runtime-guards.md) (cancellation is a person's and cooperative), [ADR-0070](0070-approved-plans-run.md) (an approved plan runs), [ADR-0179](0179-workflow-lifecycle-and-reliability.md) (cancelling a plan withdraws its step approvals), [ADR-0181](0181-who-ended-a-plan-and-why.md) (who stopped a plan), [ADR-0190](0190-only-the-owner-starts-an-approved-plan.md) (only the owner starts an approved plan)
- Decision: Geovet chose «Solo cancelar» on 2026-10-12 (decision card) for a plan whose owner has left the organization: the organization owner may cancel it, and nobody may start it.
- Terraform: none. Firestore: none. No migration, no index, no new permission or role.

## Context

ADR-0190 made the plan's owner the only one who starts an approved plan. A plan that someone else approved waits for its owner. If the owner leaves the organization, nobody can start it, so it stays `approved` with no one to end it. ADR-0190 left open who may cancel such a plan.

## Decision

1. **Cancel.** The organization owner (the `owner` role) cancels it through the cancellation that already exists: `POST /v1/organizations/:organizationId/executions/:executionId/cancel`, which needs `execution.cancel`. The owner role holds that permission (ADR-0019). Nothing is added to RBAC.
2. **Start.** Nobody starts it. The start check of ADR-0190 refuses everyone who did not plan it, the organization owner included, with `403 plan_start_not_owner`. A creator who has left cannot call the API at all.
3. **Other roles.** A role without `execution.cancel` is refused with `403 permission_denied`, and the refusal is audited as `authorization.check` with result `denied`.
4. **Another organization.** A cancellation sent through another organization's path does not find the execution there: `404 execution_not_found`.
5. **Audit and idempotency.** As for every cancellation. The plan's change is audited as `plan.state_changed` (approved to cancelled), with the person who cancelled as the actor. Its step approvals are withdrawn with reason `plan_cancelled` (ADR-0179). A repeated cancellation answers the same and writes nothing more.
6. **Active owners.** A plan whose owner is still in the organization is unchanged: its owner starts it, as before (ADR-0190).

## Consequences

- These rules already held before this decision, through the owner role's `execution.cancel` and ADR-0190's start check. This change adds the tests that pin them (the ADR-0192 block in `apps/api/src/plans.test.ts`) and this record. No product code changes.
- The organization owner can cancel any plan in the organization, orphaned or not, because `execution.cancel` does not check who planned the work. This ADR does not narrow that. Limiting the owner to orphaned plans would be a new decision.
- If the organization owner has also left, nobody can cancel the plan. That case is not decided here.
