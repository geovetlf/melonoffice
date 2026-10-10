# ADR-0187: A schedule's plan is released when its person may no longer plan

- Status: Accepted
- Date: 2026-10-10
- Builds on: [ADR-0029](0029-runtime-guards.md) (the runtime acts for the person, never more, and never cancels), [ADR-0185](0185-workflow-recurrence.md) (the standing permissions and the claim), [ADR-0186](0186-delegation-recovery-and-closure-of-off-schedules.md) (the closures this changes, and its limits)
- Product decision: Geovet, 2026-10-10 16:22Z, relayed by the project's coordinator in thread «Diagnóstico del Agent Engine»: a switched-off schedule's abandoned plans, approved ones included, are recovered or closed only under safe and auditable conditions, and a switch-off never cancels a live execution nor closes a plan before its recovery conditions are exhausted. A person who loses the permission to create plans stops holding a `creating` delegation, released once and audited, with no duplicate execution and no block of another organization. J1 stays blocked.
- Terraform: none. Migration: none. Index: none. The sweep's query now has one equality, which the automatic single-field index serves (decision 5).

## Context

ADR-0186 holds a plan whose person may no longer plan: a refusal of `permission_denied` leaves it as it is (its decision 6). Such a person keeps the schedule blocked. The next claim overlaps the stuck plan, and the sweep reads it again on every run, until the person gets the permission back.

The sweep's query for lapsed claims filtered on two fields, `status` and `last.outcome`, and ordered by the document id. Firestore may need a composite index for two equality filters with that order. The emulator does not enforce indexes, so the tests could not show whether DEV needs one, and ADR-0186's "no index" line was an inference from the emulator.

## Decision

1. **The runtime releases a schedule's plan whether or not its person may still plan.** `Delegation.abandon`, `PlanService.abandonScheduled` and `Delegation.closeFailed` apply the rules of ADR-0186 unchanged: the schedule's own plan, the same workflow, an earlier occurrence that superseded it (or the schedule switched off), the plan untouched since before the lease, and the status and delegation state that closure needs. The only change is that the runtime does not need `plan.create` to read the plan for these closures. A release creates, starts and executes nothing, so it needs no permission the runtime lacks. A person's own closures still require `plan.create`.
2. **The audit names the lost permission.** When the person may not plan at the release, the `plan.state_changed` event carries reason `permission_lost` in place of the schedule's reason (`schedule_abandoned` or `schedule_off`). Its reference stays `occurrence:<occurrence>`. A release made while the person may plan keeps the schedule's reason. The permission is read in the same request as the release, so the audit shows the person's state at that moment.
3. **A claim closes what its person left, then refuses what they may not do.** Every claim releases the earlier plans (ADR-0186, decision 5) before its checks. It then refuses the occurrence `not_allowed` when the person may not plan (ADR-0185, decision 6), and plans nothing, because planning still requires `plan.create`. The sweep settles an off schedule's plans the same way (ADR-0186, decision 7). Once the person may plan again, the next claim takes the normal path.
4. **`permission_denied` no longer holds a plan.** ADR-0186, decision 6 is amended: the runner holds a closure only for `plan_not_abandonable`, the plan changed within its lease or started meanwhile. Any other closure failure fails the occurrence, which the task retries.
5. **The sweep's query has one equality and no composite index.** `lapsedOff` reads the claims whose `last.outcome` is `claimed`, in document id order, from a cursor: `startAfter` the last id of the previous page. The automatic single-field index on `last.outcome` serves it, so no composite index is needed and Terraform is unchanged. The schedule's `status` and its lease are read from each record. Open claims are few: one per schedule whose claim has not finished. A page may hold fewer settleable schedules than its limit, but `next` is still returned while the page is full, so the walk reaches every settleable one. The in-memory store follows the same semantics.

## Limits

1. **A person who left the organization keeps a stuck `creating` delegation.** The runtime acts only through an active membership (ADR-0029). Each occurrence of such a schedule is recorded `not_allowed` and plans nothing, and the sweep holds the open plan: a switched-off schedule keeps it until the membership is restored or a person acts. Releasing it would act for someone who no longer belongs to the organization, which is a product decision for the owner, not one this change makes. Open for Geovet.
2. **A person who lost `plan.create` keeps the plans they made by hand.** The runtime closes only a schedule's plans, and a person's own closure needs `plan.create`, so nothing releases a plan made by hand. Nothing runs from such a plan. Open for Geovet: let the person cancel their own stuck plan without `plan.create`, or let the sweep release it too.
3. **The first DEV sweep is the index check.** The emulator does not enforce indexes, so DEV decides whether the new query runs without a composite index. If DEV asks for one, the sweep fails with the store's error and settles nothing until the index exists. The index would then be written as Terraform in a later change, and the owner applies it.
4. **A run reads every open claim on a page, not every settleable one.** A long run of held or on schedules takes more runs to reach a settleable one, as ADR-0186's limit 4 says.

## Tests

- `packages/planning/src/delegation-recovery.test.ts`: 17 cases, in memory and on the emulator, of which 6 are new. A person who loses `plan.create` releases a `creating` delegation of a schedule's plan, audited as `permission_lost`; the same for an approved plan that never started; concurrent releases, and any later release or cleanup, change the plan once; once the person may plan again the audit names the schedule's reason; a created delegation is never released, and another organization's runtime finds none of the plans; a person who lost `plan.create` closes none of her plans by hand.
- `packages/firestore/src/workflow-schedules.test.ts`: 2 cases, on the emulator. The query lists only the schedules that are off, even when on schedules fill the first page; it pages the lapsed schedules in workflow id order, leaves out a claim within its lease, and ends a walk on a page that is not full.
- `packages/workflows/src/schedule.test.ts`: 1 case on the in-memory store, with the contract of the emulator's: the read lists only the schedules that are off, even when on schedules fill the first page.
- `apps/worker/src/workflow-recurrence.test.ts`, in memory and on the emulator: case 53 now releases the stuck plan at the next claim as `permission_lost`, refuses that occurrence as `not_allowed`, and plans again once the permission returns. Cases 55 to 60 are new: the sweep releases a switched-off schedule's stuck plan as `permission_lost`; the sweep cancels an approved plan that never started, as `permission_lost`; two workers and the sweep release once; another organization's runtime finds none of the plans; a schedule switched off after the permission returned is audited as `schedule_off`; the sweep leaves an on schedule's lapsed claim to its next occurrence (60).
- Seeded faults: see the report that accompanies this ADR, with each fault, its test and the outcome. It is a manual check, not a mutation-testing run: the repository has no mutation tool.

## Consequences

- A person who loses `plan.create` no longer blocks their schedule. The next claim releases the stuck plan and refuses the occurrence until the permission returns, and the audit says why.
- The sweep's query needs no composite index, by the rule of decision 5. The emulator cannot prove that, so DEV's first sweep after the deploy does (limit 3).
- The residuals of ADR-0186 that remain are the ones above: a departed person (limit 1) and a person's own plans (limit 2).
