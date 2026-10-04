# ADR-0153: a failed plan step runs again

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0029](0029-runtime-guards.md) (retries inside an execution), [ADR-0070](0070-approved-plans-run.md) (running plans), [ADR-0146](0146-step-approvals-inside-running-plans.md) (a step that asks a person), [ADR-0152](0152-wait-steps-in-plans.md) (waking a plan)
- Authorization: Geovet, 2026-10-04 11:41Z, "MODO AVANCE MÁXIMO DEL MOTOR", priority 4: retries, timeouts and failure handling, consistent states, no parallel states, idempotent.
- Terraform: none. Firestore: no migration, no index, one optional field. Prompts: none.

## Context

A plan step may carry `retry: { maxAttempts, backoffMs }` (1 to 5 attempts, up to a minute apart). It was validated and stored, but nothing honoured it: one failed child failed the whole plan, even when the model's provider simply did not answer that time. The runtime never retries an agent node itself, because a model call is not effect-free (ADR-0029).

## Decision

1. **When.** A specialist step whose child failed runs again only when all of these hold:
   - the plan asked for more attempts than it had;
   - the child failed on its own agent's call, for a passing reason: `network`, `rate_limited`, `server_error` or `unavailable`;
   - nothing else in the child started, so no tool ran and nothing is done twice;
   - the step waits for no person, since their approval was bound to the child that failed.

   A refusal, a lack of credits, a policy, an invalid answer, an outcome nobody knows (`timeout`, `outcome_unknown`) or a cancellation never runs again. Without credits, nothing runs.

2. **A new child.** Each attempt is a new child execution of the same step: the same graph, specialist, versions, plan and parent, under its own deterministic id (key `plan:<plan>:step:<step>:attempt:<n>`). The specialist's eligibility is checked again first. The child that failed stays as it was, as the record of that attempt.
3. **Recorded first.** The attempt is written on the plan first (`attempts: [{ stepId, attempt, executionId, after, failure, recordedAt, notBefore }]`), in one revision-checked write with `plan.step_retried`. Its child is created after. So a cancellation reaches it even before it exists, and a concurrent retry finds the step already moved past the failed child and changes nothing. The cascade reads the plan again once it ended, so an attempt recorded meanwhile is cancelled too.
4. **Backoff.** The child starts no earlier than `notBefore`, the step's `backoffMs` after the attempt was recorded. Until then the step is `delayed`, the same state a wait step has, and the plan is woken at `notBefore` through the queue a wait uses (ADR-0152). With no backoff, it starts at once. The sweep advances the plan of an attempt left unstarted after its backoff.
5. **Only the worker.** Only the worker's conductor runs a step again, because only it can wake the plan. A person's `run` or a resume after an approval that finds a step to retry leaves the plan as it is for the worker, which always advances once a step ends. It never stops the plan.
6. **Spent.** Once the attempts are spent, or a later attempt fails for a lasting reason, the plan stops as before (`step_failed`). An attempt whose child can no longer be created (the specialist left, the plan's execution stopped) fails the step with `step_retry_unavailable`.
7. **One current child.** Everything that reads a step's child reads the current one, through `stepExecutionOf`: the conductor, the plan's graph and evidence, the step's answer for the steps after it, the plan's results and steps, and the list of every agent's work. The step shows which attempt it is on (`attempt`), and when a delayed one starts (`until`). Automations says "Failed for a passing reason: runs again at …" and "Attempt 2".

## Evals

No prompt, model context, routing, model or agent behaviour changes, so no run is needed and V3 stays the baseline.

## Consequences

- Each attempt's model call is reserved, settled and released through the Credit Core as any other. A plan that allows 3 attempts may use up to 3 calls for that step, which the person approved with the plan.
- Plans written before have no `attempts` and read as before. `delegations` keeps each step's first child.
- Tests: `packages/planning` (a retry after its backoff, attempts spent, lasting failures, no worker, cancellation, the rule itself), `apps/worker` (the sweep), `apps/api/src/plans.test.ts` (the step's state, attempt and time, in memory and Firestore).
