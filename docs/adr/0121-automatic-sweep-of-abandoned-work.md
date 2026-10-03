# ADR-0121: The automatic sweep of abandoned agent work (AE-8)

- Status: Proposed
- Date: 2026-10-02
- Builds on: [ADR-0029](0029-runtime-guards.md), [ADR-0032](0032-worker-and-job-transport.md), [ADR-0058](0058-commercial-follow-ups.md), [ADR-0070](0070-approved-plans-run.md), [ADR-0119](0119-bounded-work-and-plan-results.md), [ADR-0120](0120-stuck-agent-work.md)

## Context

ADR-0120 reads work that stopped moving as stuck, and left three things open for a sweeper:

- a trigger;
- an index;
- the owner's decision on whether the runtime may close work a person started.

Geovet authorized the sweep on 2026-10-02, with these conditions:

- close only work that is really abandoned, never a long task that is legitimately running;
- 24 hours is the maximum, and age alone is never a reason to close;
- tell the person in the app;
- start nothing and charge no credits;
- reuse the existing mechanisms.

## Decision

1. **What can be closed.**
   - Only an agent's task (`taskOf`) or a step of an approved plan (`planStepOf`).
   - A conversation agent's turn is out of scope. Its stop hook already hands the conversation to a person.
2. **Five states, one closed** (`classifyOpenWork`, `packages/agents/src/stale.ts`). The rules are checked in this order:
   - **closed**: the execution has ended. Never touched again.
   - **active**: a worker holds a live lease on one of its jobs, whatever its age. Also active: anything moved within 6 hours, or no time can be read.
   - **awaiting_approval**: it waits on an approval that is pending and has not expired. A person has up to 30 days to decide.
   - **awaiting_external**: it is `paused`, held on something outside the runtime. It is never even read.
   - **no_progress**: nothing moved for 6 to 24 hours. The person's screen says it may be stuck (ADR-0120). It is not closed.
   - **stuck**: none of the above, and nothing moved for more than 24 hours.

   Progress is the latest of these:
   - the execution's `updatedAt`;
   - every node's start and end;
   - every job's `updatedAt` and lease acquisition, which is the heartbeat the runtime already writes;
   - every approval's decision.

   An old execution with a recent heartbeat is active.

3. **Closing** (`Runtime.abandon`, as the runtime of the execution's own person, resolved with `resolveRuntimeTenant`):
   - **No context, no action.** If the person is no longer a member, or the organization cannot be resolved, nothing is written and the run counts it as `no_context`.
   - **Exactly as found, or nothing.** `ExecutionService.runtimeAbandon` moves the execution to `failed` only if its status and revision are still the ones the sweep read. Anything that moved in between is refused (`execution_concurrency_conflict`) and left alone.
   - **What is recorded.**
     - The failure is `{ code: 'stale_execution', ref: { type: 'execution_sweep', id: <slot> } }`.
     - The audit gets `execution.state_changed` and a new `execution.abandoned`, with the actor `system/runtime`, the transition and the reason: `lease_expired`, `approval_expired` or `no_progress`.
     - The sweep's record keeps, for each execution, when it was detected and when it was closed.
     - Nothing is deleted.
   - **After the close.** Its open jobs are cancelled, then the existing stop and end hooks run.
     - A task publishes `agent_task.finished`, and its person gets a new in-app notice, `task_abandoned`.
     - A plan step goes to the plan conductor, which fails the plan without starting another step. The plan's person gets `plan_failed` (ADR-0119).
     - The Harness reads `stale_execution` as no hand-off to a person, because the abandoned notice already tells them.
   - **No new work and no credits.** No node runs, and no model or tool is called. The end hooks only keep facts and memories of completed work.
4. **The trigger reuses Cloud Tasks; there is no Cloud Scheduler.**
   - Every 3 hours (8 small runs a day), one task on the existing execution jobs queue reaches `POST /internal/sweeps/run` on the worker. The body is `{ "slot": "sweep-YYYYMMDDtHH" }`.
   - The route sits behind the same invoker OIDC check as every job.
   - **Each run happens once.** It claims its slot in `executionSweeps/{slot}` inside a transaction, and a repeated delivery gets `already_swept`.
   - **The chain keeps going.** Each run queues the next slot first, so a failing run never ends the chain. Every worker start also queues the next slot if it is missing.
   - **Each slot is queued once.** A slot is reserved in the same document before it is queued.
   - A run reads at most 50 candidates per status and closes at most 100. The rest wait for the next run.
5. **One composite index**, `executions (status ASC, updatedAt ASC)`, in Terraform.
   - It serves the only cross-organization query, which reads one status, not updated for 24 hours, oldest first.
   - Until the index exists, the worker reads up to 500 executions per status without it and logs `firestore.index_missing`. Applying the index never has to come before the code.

## Not done

- **Conversation agent turns.** A person already takes over the conversation, so they are not swept.
- **Expired handoffs.** None is needed: an expired handoff is read as refused (ADR-0119).
- **A setting per organization.** The thresholds are platform safety defaults: 6 hours to show work as stuck, and 24 hours to close it.

## Consequences

- **Terraform in DEV:** exactly one resource to add, `google_firestore_index.executions_sweep[0]`, with 0 to change and 0 to destroy.
- **No migration and no new dependency.**
- **A new Firestore collection,** `executionSweeps`, written only by the worker. The worker already has Firestore access.
- **Cost:** 8 Cloud Tasks a day and a few small queries per run.
