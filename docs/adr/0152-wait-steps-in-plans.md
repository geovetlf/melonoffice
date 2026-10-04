# ADR-0152: wait steps in plans

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0070](0070-approved-plans-run.md) (running plans), [ADR-0075](0075-plan-conditions.md) (decision conditions), [ADR-0121](0121-automatic-sweep-of-abandoned-work.md) (the sweep), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps)
- Authorization: Geovet, 2026-10-04 11:41Z, "MODO AVANCE MÁXIMO DEL MOTOR", priority 2: wait and delay steps, safe against restarts, duplicates, retries, several workers and lost leases, reusing Cloud Tasks with no parallel scheduler and with limits.
- Terraform: none. It reuses the worker's queue, invoker and URL. Firestore: no migration, no index, one optional field. Prompts: none.

## Context

A plan could only run the next step as soon as the steps before it ended. Waiting a set time before a step, for example "wait a day, then follow up", had no place in the engine.

## Decision

1. **A `wait` step.** `{ kind: 'wait', dependsOn: [...], wait: { seconds } }`, from 1 second to 7 days. It waits on at least one step, like a decision, and carries nothing else. Its node in the planning execution is the existing `delay` node type.
2. **Started once.** When the steps a wait depends on completed, the worker's conductor records it on the plan (`waits: [{ stepId, startedAt, until }]`) in one revision-checked write, with `plan.wait_started` (`reference`: `3600s`). A second or concurrent start finds it recorded and changes nothing. Its node runs.
3. **Woken by Cloud Tasks.** After recording, the conductor queues a task on the worker's own queue at `until` plus one second (`POST /internal/plans/wake`, body `{ organizationId, planId }` only, same invoker check). The handler reads the plan and its planning execution from Firestore and advances it as the runtime of that execution's person. A repeated, late or early task changes nothing, because the recorded `until` decides. A plan that is not running, or that the organization does not have, is left alone. A failure answers `503`, so the queue delivers again.
4. **Over.** Once `until` has passed, the wait counts as completed: its node completes with `{ type: 'plan_wait', id: <step> }`, the steps after it start, and the plan's verification records `wait_elapsed`. A wait never fails. One whose steps before it were stopped, declined or skipped is skipped with its branch.
5. **Safety net.** A wake-up that could not be queued is logged. The sweep (every 3 hours) advances the plan of a step left waiting when one of the plan's waits is over (`wait_over`). Any other advance of the plan, such as a step ending, also sees the wait over. Restarts, duplicates, retries and lost leases change nothing, because state lives only on the plan.
6. **Only where it can be woken.** The conductor starts a wait only when it has a way to wake the plan. That is the worker's conductor. The API's conductors (a person's `run`, the resume after an approval) never make a wait ready, because a wait always follows a step that ends in the worker.
7. **Where it shows.** The plan's version shows `wait: { seconds }`. Its steps show the wait as `waiting`, `delayed` (with `until`) or `completed`. Automations says "Waiting until …" and "Wait over", and the list of every agent's work names the `delayed` state.

## Evals

No prompt, model context, routing, model or agent behaviour changes, so no run is needed and V3 stays the baseline.

## Consequences

- No credits: a wait calls no model and no tool.
- Cloud Tasks holds a task for up to 30 days, so 7 days stays well inside its horizon.
- Tests: `packages/planning` (a wait between steps, once only, no start without wake-ups, limits), `apps/worker` (the wake-up handler and body, the sweep's `wait_over`), `apps/api/src/plans.test.ts` (the version and the step states, in memory and Firestore).
