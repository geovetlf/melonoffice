# ADR-0185: a workflow runs by itself on a schedule (recurrence)

- Status: Accepted
- Date: 2026-10-08
- Amended: 2026-10-08, after review. A first step that asks for approval waits for a person under a standing approval (7); a claim is held for a lease (5); a save never plans a day the last run took (2); the standing permissions are checked at every occurrence (6); the delegation is built in the schedule's composition and handed to the runtime (9).
- Builds on: [ADR-0029](0029-runtime-guards.md) (runtime actor, idempotency), [ADR-0058](0058-commercial-follow-ups.md) (Cloud Tasks held until their time), [ADR-0071](0071-workflows-over-http.md) (a workflow's plan waits for a person), [ADR-0121](0121-automatic-sweep-of-abandoned-work.md) and [ADR-0183](0183-the-sweep-reads-past-waiting-work.md) (sweep), [ADR-0151](0151-tool-steps-run-in-plans.md) (step approvals), [ADR-0163](0163-the-approved-credit-budget-caps-a-plan.md) (budget), [ADR-0179](0179-workflow-lifecycle-and-reliability.md) (lifecycle, cancellation), [ADR-0180](0180-each-workflow-shows-its-runs.md) (a workflow's runs), [ADR-0184](0184-plan-tool-steps-that-write-data.md) (writes)
- Product decisions: Geovet, 2026-10-05 07:45Z.
  - B5: no fake recurrence before this block.
  - B8: a recurrence must not ask approval for the whole workflow on every run; approval follows each action's risk and policy.
- Product decision: Geovet, 2026-10-08 11:56Z: build recurrence on the existing Workflow, Plan, Run and Sweep; no second scheduler, runtime or plan engine.
- Terraform: none. It uses the existing Cloud Tasks queue (`execution_jobs`), the worker's invoker and the worker URL. Firestore gains one collection, `workflowSchedules`, read by a single-field range, so it needs no composite index. No migration. Prompts, models and providers: none.

## Context

Until now a workflow ran only when a person pressed «Iniciar ahora». A person planned it, approved the plan, and the conductor ran it (ADR-0071). Three checks are people-only:

- `WorkflowService.plan`;
- `PlanService.approve`;
- `PlanConductor.run`.

What already exists and is reused:

- **Timing.** Cloud Tasks holds a task until its time and delivers it to the worker behind the invoker check. This is used for follow-ups (ADR-0058), wait steps (ADR-0152) and the sweep (ADR-0121). A time more than 30 days ahead is reached in hops.
- **Recovery.** The sweep runs every 3 hours, self-chained on the same queue, and reads stale work with an index (ADR-0121, ADR-0183).
- **Running.** Every run is the plan path that already exists:
  - a workflow plan, idempotent by its request key;
  - a decision;
  - delegation;
  - step approvals, budget, cancellation and audit.
- **The runtime actor.** It acts as the person who started the work, with that person's current membership and permissions and never more (ADR-0029). It is audited as the system actor `runtime`, initiated by that person.

## Decision

1. **A schedule belongs to one workflow.** It is stored at `workflowSchedules/{workflowId}` and holds:
   - the organization;
   - its status, `on` or `off`;
   - the recurrence;
   - the business time zone;
   - the workflow version the person confirmed;
   - who confirmed it and when;
   - `nextRunAt`;
   - the last occurrence and its outcome;
   - a revision.

   A workflow keeps its own record and its own revision. A run never writes the workflow, so it never conflicts with a person editing it.

2. **A recurrence is bounded by construction.**
   - It runs daily, weekly on one or more weekdays, or monthly on a day from 1 to 28. It runs at a local time `HH:MM` in the business's time zone, read from the business profile when a person saves the schedule.
   - There is no "every N minutes".
   - At most one occurrence per workflow per local day, and one plan per occurrence. A save never plans the day the last run already took: a time changed later that day waits for tomorrow.
3. **Switching a schedule on is a person's standing approval (B8).**
   - The person must hold `workflow.manage`, `plan.create` and `approval.approve`.
   - It approves "this workflow, at this version, on this schedule".
   - The workflow must be active.
   - GIA and the runtime can never switch a schedule on, change it or switch it off.
4. **One occurrence is one Cloud Tasks task** on the existing queue, delivered to the worker at `POST /internal/workflow-schedules/run` with the body `{organizationId, workflowId, occurrence}`.
   - The API queues the first task when a person saves the schedule.
   - Each run queues the next one before it does anything else, as the sweep does.
   - A task for a time more than 29 days ahead arrives early and queues itself again.
5. **A run claims its occurrence once.** In one transaction it checks that the schedule is on and that `nextRunAt` is exactly this occurrence. It then moves `nextRunAt` to the next occurrence after now and records the occurrence as `claimed`.
   - A duplicate task, a second worker, or a task for an occurrence that a later save replaced finds nothing to claim and changes nothing.
   - A claim is held for a lease of 20 minutes (`SCHEDULE_LEASE_MS`), which outlasts a task's dispatch deadline (the runtime's job lease, 15 minutes by default). While the lease holds, another delivery of the same occurrence is refused with `in_progress` (503), so Cloud Tasks retries it later and it never runs beside the first.
   - Once the lease has lapsed, its worker is taken to have died. The same task takes the occurrence up again, because every step after the claim is idempotent: the plan's request key, the conductor's start, the recorded outcome.
   - If the previous occurrence was claimed, never finished, and its lease has lapsed by the time the next occurrence claims, the runner writes `workflow.schedule_run` with reason `abandoned` for the lost one. The chain goes on, and the card shows the next occurrence's outcome.
6. **What a claimed occurrence does, in order.** Each outcome is recorded on the schedule and audited (`workflow.schedule_run`).
   - `missed`: it is later than 6 hours past its time, after downtime or a lost task. Nothing runs, and the next occurrence is the next one after now. Missed occurrences are never run one after another.
   - `workflow_not_active`: the workflow is paused or archived. An archived workflow's schedule is switched off at its next occurrence, and recorded so.
   - `version_changed`: the workflow has a version the person did not confirm. Nothing runs until a person confirms the schedule again.
   - `overlap`: an earlier scheduled plan of this workflow is still open, once the plans the schedule approved and never started are closed (decision 13). The new one never stacks on an open plan.
   - `not_allowed`: the person is no longer an active member, or no longer holds one of the three standing permissions (decision 3). The runner checks all three before it plans. If the approval itself is refused for that reason, the plan is left for a person and the occurrence is `not_allowed`.
   - `planned`: otherwise the workflow is planned as the runtime of the person who confirmed it, with the request key `schedule-<occurrence>`. The plan records its occurrence (`source.occurrence`, `Plan.workflow.occurrence`).
     - If the plan's risk is low or medium, the plan is approved with the standing approval: `decision.via = 'schedule'`, `decidedBy` the person who confirmed it. The conductor then runs it as that person's runtime.
     - If the risk is high or critical, the plan waits for a person, as every workflow plan did (ADR-0071). The outcome is `awaiting_person`.
   - `refused`: the plan was refused (for example an agent is unavailable). It is recorded, and the next occurrence is unaffected.
7. **Everything after planning is the existing path.**
   - A tool step's approval (ADR-0151, ADR-0184) and a step that asks for approval still wait for a person on every run (B8: approval follows each action). This holds for a first step too: a standing approval gives the plan, never a step's approval, and a first step has no earlier step whose approval would cover it.
   - A withdrawn or rejected approval skips its branch.
   - The approved estimate caps the run (ADR-0163).
   - The Credit Core refuses a step it cannot charge.
   - A person can cancel a scheduled plan as any other (ADR-0179).
   - A failed run never stops the schedule.
8. **Only the standing approval can use the runtime path.**
   - `PlanService.approveScheduled` approves a plan for the runtime only when all of these hold:
     - the plan came from a workflow occurrence;
     - its creator is the runtime's person;
     - its workflow and version are the schedule's;
     - its risk is at most medium.
   - `PlanConductor.run` accepts the runtime only for a plan whose decision is a standing approval by that same person.
   - Every other decision stays a person's.
9. **The worker plans a schedule's occurrence, and nothing else.** Until now the worker never planned (ADR-0070), and a test enforces it. A schedule's occurrence has no person present, and the worker is the only place a timed task arrives, so the worker now plans in exactly one file, `apps/worker/src/workflow-schedules.ts`.
   - It plans only the workflow version a person confirmed.
   - It uses the same workflow service, plan service and validator as the API, over the same repositories.
   - It never uses a planner or a model.
   - Its conductor delegates and starts only a plan whose decision is that person's standing approval.
   - The architecture test (`apps/worker/src/transport.test.ts`) names these imports one by one, and only for that file. Every other file of the worker is held to the old rule: it never names the workflows package in any form, and it takes only the planning names it took before.
   - The plan delegation is built in that file (`createScheduleDelegation`) and handed to the runtime as an option. The runtime never names the delegation, and only a schedule's start uses it.
10. **Recovery.** Each sweep run also reads schedules whose `nextRunAt` is more than 15 minutes past, oldest first (`workflowSchedules.nextRunAt`, automatic single-field index). It runs each of them as its task would. A lost task, a deploy, or a worker that was down are recovered within 3 hours; past 6 hours the occurrence is `missed`.
11. **Changing a schedule.**
    - Saving recomputes `nextRunAt` from now and queues its task; the old task finds nothing to claim.
    - Switching off clears `nextRunAt`.
    - Switching on again computes the next occurrence after now, never a past one.
    - A new workflow version needs the schedule confirmed again (`version_changed` until then).
12. **Screens.** The workflow's card in Automatizaciones shows:
    - its schedule in words, its next run in the business's time;
    - the last occurrence's outcome;
    - «Programar» to set it, «Cambiar programación» to change it, and «Desactivar programación» to switch it off.

    A plan made by the schedule says so. GIA's draft card no longer says repeats are unavailable; it still saves a manual draft, and a person sets the schedule.

13. **A stale plan is closed by the occurrence that moves past it (ADR-0185 §13).** Once a later occurrence is claimed, no task can start an earlier occurrence's plan: the claim refuses its retries, and a late task is `missed`. So a plan the schedule approved and never started, from an earlier occurrence, is closed before the overlap check, by the run that claims the next occurrence. A sweep recovery of that occurrence runs the same code path.
    - Only plans that are `approved`, decided by the schedule (`decision.via = 'schedule'`), never delegated (no `delegationState` and no delegations), from an earlier occurrence, and not changed within the lease (20 minutes) are closed. A running plan, a plan waiting for a person, and a plan a person decided are never closed here.
    - The closure is one transaction on the plan, with its guard read inside it (`PlanService.abandonScheduled`, runtime only). A plan started, cancelled or changed meanwhile is refused with `plan_not_abandonable`, left as it is, and the run reads the plans again. Any other failure fails the occurrence, which Cloud Tasks retries; a closure that ran once changes nothing the second time.
    - The closure is audited as `plan.state_changed` with reason `schedule_abandoned` and the occurrence as its reference. The plan keeps `workflow.occurrence`, so every closed plan still names the occurrence that made it.

## Limits

- One schedule per workflow.
- The earliest occurrence is the next one after now.
- At most one plan per workflow per day.
- Late occurrences are never replayed.
- The overlap check reads every plan of the workflow on each occurrence, not only the newest 100. This is one read per occurrence, and it grows with the workflow's plan count; an index on open plans is the next step if that grows.
- An occurrence whose every retry fails is audited as `abandoned` when the next occurrence claims, and the plan it left approved and never started is closed then (decision 13). Until that claim, the plan stays approved and the card shows the last outcome. For a monthly schedule that can be a month.
- A switched-off or archived schedule leaves its last such plan approved: no later claim closes it. Closing those from the sweep needs a query on schedules that are off, which the index does not serve yet; that is the follow-up.
- A plan still waiting for a person's decision blocks later occurrences until that person decides it, as does a plan whose delegation is `creating` or `failed`: a half-made delegation is finished or failed only by its own occurrence's run, so it waits for delegation recovery. The schedule never decides for a person and never cancels a delegation it did not finish.
- A plan whose every step was declined ends `nothing_ran`, for any plan and not only a scheduled one. That is the planning rule as it now stands, and it is noted here because the schedule relies on it.

`automations.runsMonthly` is not enforced (D-12 is frozen). The structural bound above is the protection against a burst of runs.

## Tests

- `apps/worker/src/workflow-recurrence.test.ts`: the 34 cases (68 runs), in memory and on the emulator, through the worker's own composition (the runner, the conductor, the sweep). The cases cover the first and second occurrence, switching off and on, editing, time zones and daylight saving, a late and a missed occurrence, a new version, two deliveries at once and two workers, a retry inside the lease (held) and after it (taken up), a restarted worker, an ambiguous delivery whose work ran once, a delivery held while its first is in flight (case 26), cancellation, a step approval required and withdrawn, a first step that asks for approval under a standing approval (case 25), a decline that ends the run as `nothing_ran`, no credits, a refused run followed by a good one, tenant isolation with forged tasks, audit, the sweep's recovery after downtime, a paused or archived workflow, the bound of one plan per day, a time changed later the same day (case 27), and a person who lost the approval's permission (case 28), and an occurrence whose retries all fail, audited as abandoned when the next one runs (case 29). Decision 13 is covered by cases 30 to 38: an approved plan whose occurrence exhausts its retries is closed when the next one claims, and that one runs and is not held as an overlap (30); a running plan is never closed, and a plan changed within the lease is refused by the service, while a retry keeps the plan of its own occurrence (31, 31b); two workers and the sweep reach one occurrence at once, with one plan and one closure (32); a person's cancel races the closure, and the plan transitions once (33); the closure is audited with its reason, actor and occurrence (34); another organization's runtime cannot close the plan (35); a sweep and a redelivery after the closure add no plan, execution or closure (36); a normal recurrence closes nothing (37); a worker that dies after claiming leaves the closure to the one that resumes it (38).
- `apps/worker/src/workflow-writes.test.ts`, cases 4 and 4b (ADR-0184): a timed-out write is answered late only once the test releases it, so the order is fixed by the test, not by a timer; the write count and the request count are checked again after the late answer. Case 4b cancels the plan before that answer lands, and the answer changes nothing.
- `packages/workflows/src/schedule.test.ts`: the recurrence's exact fields, next occurrences in the time zone, the audit code, queueing in hops, and the service's permissions and tenant isolation.
- `packages/planning/src/planning.test.ts`: `approveScheduled` (runtime only, the same workflow and version, risk up to medium, the person's own plan) and the occurrence on the plan. The overlap read beyond the newest 100: the service's full read returns all 101 plans of a workflow, while a list shows 100.
- `apps/api/src/plans.test.ts`: the schedule routes, exact bodies, the three permissions, another organization's workflow.
- `apps/web/src/automations/workflowSchedule.test.tsx`: setting, changing, turning off, the read-only view, a stale version, a scheduled plan's label, and a refused save.

Limits and screens shown in the card are the ones above. Where a line of this ADR and the code differ, the code is the record, and this ADR is updated with it.
