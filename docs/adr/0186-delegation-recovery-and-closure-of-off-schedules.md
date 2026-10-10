# ADR-0186: a schedule's stuck delegation is recovered, and an off schedule's open plans are closed

- Status: Accepted
- Date: 2026-10-10
- Builds on: [ADR-0185](0185-workflow-recurrence.md) (decision 13 and its limits), [ADR-0029](0029-runtime-guards.md) (the runtime never cancels), [ADR-0070](0070-approved-plans-run.md) (the conductor starts an approved plan), [ADR-0121](0121-automatic-sweep-of-abandoned-work.md) and [ADR-0183](0183-the-sweep-reads-past-waiting-work.md) (the sweep)
- Product decision: Geovet, 2026-10-10 09:07Z, in thread «Diagnóstico del Agent Engine»: recover stuck delegations (`creating` and `failed`) without duplicating or reactivating work, and close from the sweep the approved plans of disabled or archived schedules, with the rules of ADR-0185.
- Terraform: none. Migration: none. Index: none. The sweep's query was amended by [ADR-0187](0187-release-of-a-schedule-plan-when-its-person-may-not-plan.md) to one equality and the document id as its order, which the automatic single-field index serves. The emulator does not enforce indexes: it confirms the query's results, not that DEV accepts it without a composite index. DEV confirms that on the first sweep after the deploy.

## Context

A schedule's plan is delegated in two steps: its planning execution is marked as delegated, then each specialist step gets a child execution with a deterministic id. Two states of that delegation could hold a schedule for good, and both were visible as `overlap` on every later occurrence:

- **A `creating` delegation** whose attempt stopped before its children were all made. `PlanService.abandonScheduled` refuses a delegated plan, and `cancel` refuses `creating`, so nothing closed it.
- **A `failed` delegation** whose cleanup an interrupted attempt left open: the plan is `failed`, but its planning execution still waits for a person. `PlanConductor.run` refuses a failed plan before it reaches the delegation, so nothing finished the cleanup.

ADR-0185 also left the open plans of a switched-off schedule with no one to close them when its claim had died: no later claim runs for an off schedule, and the sweep read only due schedules.

## Decision

1. **Recovering a `creating` delegation (planning, runtime only).** `Delegation.abandon` fails the delegation of a schedule's own plan with `delegation_abandoned`, when all of these hold, in the plan's transaction:
   - the plan is the schedule's (`decision.via = 'schedule'`), of this workflow, in its occurrence, approved, and `creating`;
   - the schedule moved past the occurrence (`reason` `schedule_abandoned`, the occurrence claimed next is later), or the schedule is off (`reason` `schedule_off`, with no occurrence);
   - the plan has not changed since the lease instant (`untouchedBefore`).

   It writes one `plan.state_changed` event with the reason and the occurrence, then runs the cleanup. Nothing ran, since a `creating` delegation has no running child. The children it made stay `pending`, as a schedule's always do (ADR-0029, ADR-0185).

2. **Finishing a failed delegation's cleanup (planning).** `Delegation.closeFailed` finishes the cleanup of a failed delegation: the planning execution fails, and a person's children are cancelled. It is idempotent, and it never starts or reactivates work. The runtime closes only a schedule's plans. `PlanConductor.run` finishes a failed plan through it and reports the occurrence as `planned`, instead of starting it.
3. **The runtime never cancels.** The cleanup skips a child for the runtime, and only a person's cleanup cancels children (ADR-0029). A failure of the runtime's cleanup is retried by the next claim.
4. **Races are settled by the transaction.** Every change of the cleanup is guarded in its own transaction:
   - a delegation another attempt already failed is read back fresh, and nothing is written twice;
   - an execution another attempt already closed is accepted once it is terminal, and refused (retried) otherwise.
5. **Every claim closes what the occurrence before it left open (runner).** Once an occurrence claims its time, before any check (`missed`, `workflow_not_active`, `version_changed`, `not_allowed`, `overlap`), the runner closes the earlier occurrences' open plans through the rules above, and finishes every earlier failed delegation, oldest first. So a paused, late or refused occurrence closes them too. If the person can no longer be resolved, nothing is closed from there, and a later claim looks again.
6. **Held plans hold the claim.** A refusal of `plan_not_abandonable` (the plan changed within the lease, or started) leaves the plan as it is. A person who may no longer plan does not hold it: the runtime releases it, audited as `permission_lost` ([ADR-0187](0187-release-of-a-schedule-plan-when-its-person-may-not-plan.md), decisions 1 and 2). Any other failure of a closure fails the occurrence, which the task retries. A failed cleanup of an earlier delegation is logged and left to the next claim (decision 3).
7. **An off schedule's open plans are closed from the sweep.** The sweep reads the schedules that are off, whose last claim was taken and whose lease has lapsed (`lapsedOff`). It reads them a page at a time, in workflow id order: each page starts after the last id of the one before, up to `SCHEDULE_RECOVER_PAGES` (10) pages of `SCHEDULE_RECOVER_LIMIT` (50) a run. A cursor by id, not an offset, keeps a schedule settled on one page from shifting the next. Nothing takes such an occurrence up again, so the sweep settles it: every plan the schedule made, of any occurrence, is closed with reason `schedule_off`:
   - an approved, undelegated plan is cancelled;
   - a `creating` delegation is failed (decision 1);
   - a failed delegation's cleanup is finished (decision 2);
   - an executing plan goes on as it is, and a plan a person decided is not the schedule's to close.

   Then the lost occurrence is recorded as `abandoned`. A held plan leaves the claim for a later sweep.

8. **Audit.** Every change is one `plan.state_changed` event with the actor the runtime of the person who confirmed the schedule, the target plan, the transition, the reason and the occurrence as its reference: `schedule_abandoned` when a later occurrence supersedes the plan, `schedule_off` when the schedule is off. The lost occurrence is recorded in `workflow.schedule_run` as `abandoned`.
9. **One clock.** The worker passes its clock to the schedule's delegation, as to every other service it wires. A delegation's instants are the ones the lease is measured against. Before this, the delegation stamped the wall clock, so a plan could look newer than its lease in any clock but the real one.

## Limits

- The sweep reaches an off schedule through its last claim, while that claim is still open. A claim that finished with an earlier plan still approved behind it is closed by the next claim of that schedule, and a schedule that never claims again would leave that plan approved. The flows of ADR-0185 leave no such plan: a claim that finishes has run its own plan, and an earlier plan is at least a local day older than the next claim, past its lease. It is recorded here as the residual of ADR-0185 decision 13, rather than papered over.
- A hand-made plan of a person who may no longer plan has its `creating` delegation released by the sweep ([ADR-0187](0187-release-of-a-schedule-plan-when-its-person-may-not-plan.md), decision 6). Its approved plans that never started are not released (ADR-0187, limit 2). A departed person's plans stay as they are (ADR-0187, decision 7). A schedule's stuck delegation is released at once (ADR-0187, decision 1).
- A failed delegation's cleanup is retried once per claim. A workflow with many failures reads one parent execution per failure on every claim, after the plan read it already makes. A marker on the plan is the follow-up if that grows.
- The sweep reads at most 500 lapsed off schedules a run: 10 pages of 50, in workflow id order, and every run starts again from the first page. A schedule the sweep holds (its person left or may no longer plan, or a plan is within its lease) keeps its place in that order and is read again by each run, so more than 500 held schedules before a settleable one would keep it unread until they settle. Nothing is closed or lost meanwhile; a cursor kept across runs is the follow-up if that happens.
- A claim reads the workflow's plans twice: once for the closures, then for the overlap check, which sees them. Each read grows with the workflow's plan count, as ADR-0185 notes.
- Only a schedule's own plans are closed. A person's plans are never closed here, whatever their state.

## Tests

- `packages/planning/src/delegation-recovery.test.ts`: 11 cases here and 6 for the permission lost ([ADR-0187](0187-release-of-a-schedule-plan-when-its-person-may-not-plan.md)), all in memory. A `creating` delegation is failed only when superseded, untouched within the lease, the schedule's, and of the right kind (including a schedule switched off, which supersedes nothing); a person's delegation is never failed by the runtime; concurrent abandons fail it once; a cleanup another attempt finished is accepted and written once; a created or completed delegation is never abandoned; a delegation that failed for another cause stays with `closeFailed`; an interrupted cleanup is finished and never reactivated; the runtime leaves a child pending while a person's cleanup cancels it; another organization finds no plan.
- `packages/firestore/src/workflow-schedules.test.ts`: 2 cases, on the emulator. The sweep's query lists only the schedules that are off, even when on schedules come first in the page order; it pages the lapsed off schedules in workflow id order, leaves out a claim within its lease, and ends a walk on a page that is not full.
- `apps/worker/src/workflow-recurrence.test.ts`, cases 38 (its dying worker now fails at the plan read, where the closure is made) and 40 to 54, and 55 to 59 for [ADR-0187](0187-release-of-a-schedule-plan-when-its-person-may-not-plan.md) (53 changed there), in memory and on the emulator:
  - a closure made at the claim survives a worker that dies after it (40);
  - a switched-off schedule closes its open plan once the claim lapses, not before, with reason and occurrence (41);
  - an archived workflow's next occurrence, run by the sweep, closes the plan before it and switches the schedule off (42);
  - a plan that started is never closed by a switch-off or an archive (43);
  - two workers and the sweep settle a switched-off schedule at once: one closure, one run recorded (44);
  - a person's cancel races the sweep: one transition (45);
  - a stuck `creating` delegation is failed at the next claim, its child stays pending, and the next occurrence runs (46);
  - a stuck `creating` delegation of a switched-off schedule is failed by the sweep with its reason (47);
  - an interrupted cleanup is finished by the next claim, and never reactivated (48);
  - repeated sweeps and redeliveries add no plan, child or closure (49);
  - two workers and the sweep reach a stuck delegation's next occurrence at once: one failure, one plan (50);
  - another organization's runtime finds none of the schedule's plans (51);
  - an interrupted failure is finished when the schedule is switched off (52);
  - a person who loses `plan.create` has the stuck plan released at the next claim, as `permission_lost`, and the occurrence refused `not_allowed` until they may plan again (53, changed by ADR-0187);
  - fifty off schedules whose person has left, ahead of a settleable one in id order, fill the sweep's first page: the second page settles that one, and the held ones keep their claim (54).

The seeded-fault check that backs these tests is recorded in the report that accompanies this ADR, with each fault and whether a test caught it. It is a manual check, not a mutation-testing run: the repository has no mutation tool.
