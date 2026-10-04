# ADR-0146: a step that asks a person before it runs, inside a running plan

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0026](0026-tools-approvals-and-guardrails.md) (approvals), [ADR-0070](0070-approved-plans-run.md) (running plans), [ADR-0075](0075-plan-conditions.md) (conditions), [ADR-0121](0121-automatic-sweep-of-abandoned-work.md) (the sweep), [ADR-0145](0145-following-advanced-workflow-steps-in-plans.md) (step states)
- Product decision: Geovet, 2026-10-04 04:36Z, "Saltar esa rama".
- Terraform: none. Firestore: one optional field on plans (`stepApprovals`), no index, no migration. Prompts: none.

## Context

The editor's "Ask me before this step runs" checkbox only meant that the whole plan was approved before anything ran. A plan never paused at that step. ADR-0075 left "waiting on an approval inside a running plan" open, and ADR-0145 recorded it as a product decision.

Geovet decided what a declined step means:

- Approved: the branch goes on.
- Rejected: the step is marked as rejected. It and every step that depends on it are skipped. The independent branches go on, and the plan is not failed. The result records what was skipped.
- Expired: treated as a rejection for that branch.
- Only a person with the permission approves. GIA never approves for a person, and there is no second approval system.

## Decision

1. **Which steps wait.** A specialist step marked `approvalRequired` that depends on another step waits for a person once the steps before it complete. A first step needs no second approval, because the plan's own approval comes right before it.
2. **The existing approval system, unchanged.**
   - The conductor asks through `createPlanStepApprovals` (`@melonoffice/approvals`), which uses the same service, repository, audit events and inbox as tool approvals.
   - The approval is bound to one plan version, its digest, the step and the step's child execution: tool `plan_step`, action `start_step`, a one-day TTL.
   - `plan_step` is reserved in the tool registry, so no tool can ever share these operations.
   - The approval service already refuses the runtime and GIA (`runtime_cannot_decide`, `gia_cannot_decide`) and requires `approval.approve`.
3. **The plan records it.** `Plan.stepApprovals` holds one entry per step: the approval id, when it was asked, and, once declined, why (`rejected`, `expired`, `cancelled` or `mismatch`) and when.
   - Each change is audited: `plan.step_approval_requested` and `plan.step_declined`.
   - A second request that lost a race is withdrawn, so a step has one approval.
4. **States.** `awaiting_approval` and `declined` join the conductor's step states.
   - A step after a declined step is `skipped`, under the same rule as after a check that stopped its branch.
   - A plan completes when every step is done, skipped or declined.
   - When a plan stops, the approvals still pending are withdrawn (`plan_ended`).
5. **Going on at once.**
   - When a person approves or rejects in the inbox, the API's existing `afterDecision` hook calls the conductor's new `resume`. It runs as the runtime of the person the step runs for, never as the person who decided, and within the approval's organization.
   - `resume` starts the approved step, or records the decline and skips its branch. It never decides a condition step: those stay with the worker's `advance`.
   - A failure there never changes the decision. The worker's next look at the plan catches up.
6. **Expiry.**
   - An expired approval is read as declined at the next look at the plan, and is then recorded as `expired`.
   - The existing 3-hour sweep (ADR-0121) no longer abandons a step that has not started while its plan runs. Such a step waits for the steps before it or for a person, and is not abandoned work. A stuck running step is still swept, and its plan then stops.
   - When the waiting step has an approval recorded, the sweep advances its plan. An approval nobody decided in time then skips its branch rather than failing the plan.
   - A person deciding after expiry is refused, as before (`approval_expired`).
7. **Fail closed.** A conductor without the approvals port fails a step that would wait (`step_approval_not_configured`) rather than run it unapproved.
8. **The screens.**
   - The plan shows "Waiting for your approval" with a link to Approvals.
   - It shows "Rejected" or "Not approved in time: this branch was skipped, the rest goes on" on the declined step, and "Skipped: an earlier step ended this branch" after it.
   - The approvals inbox lists the step as "Start a step of a plan" with its reason and impact.
   - The checkbox now means what its label says.

## Evals

No prompt, model context, routing, model or Agent Engine behaviour changes. An agent step that starts runs exactly as before, so no run is needed and V3 stays the baseline.

## Consequences

- Tests:
  - `packages/planning/src/conductor.test.ts`:
    - approve, then the branch goes on and the plan resumes and completes;
    - reject, then the dependent steps are skipped, the independent ones go on and the plan completes, audited once;
    - expiry;
    - several branches;
    - a root step covered by the plan's approval;
    - fail-closed without the port;
    - withdrawal on stop.
  - `apps/api/src/plans.test.ts`:
    - the step waits, asks once and shows in the inbox;
    - approval starts it at once;
    - rejection skips its branch and the plan completes without failing;
    - expiry;
    - the runtime and a role without `approval.approve` are refused;
    - another organization can neither see nor decide it;
    - audit events.
  - `apps/worker/src/sweeps.test.ts`: a step that has not started while its plan runs is never abandoned. One waiting for a person has its plan advanced, and one left behind after its plan ended is swept as before.
  - `packages/tools/src/tools.test.ts`: the registry refuses `plan_step`.
  - The web tests cover the plan screen and the inbox.
- A plan closed by a decision in the API does not publish `plan.finished`, which only the worker publishes. A person's own decision closed it.

## Open

- A never-started child of a skipped or declined step stays pending until its plan ends. It is not withdrawn (ADR-0075 Open). The sweep closes it a day after that, as before.
- An approval node (`kind: 'approval'`) is still not runnable. The step flag covers the decided behaviour.
- What is still to validate in DEV: a real plan with a step that asks, on the real worker. The tests cover memory and the emulator.
