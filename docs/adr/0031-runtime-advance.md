# ADR-0031: Runtime advance(): one node at a time, and runtime authority

- Status: Proposed (Phase X6c, pending Geovet's review)
- Date: 2026-09-27
- Builds on: [ADR-0020](0020-audit-log-foundation.md), [ADR-0024](0024-execution-foundation.md), [ADR-0026](0026-tools-approvals-and-guardrails.md), [ADR-0027](0027-ai-gateway-and-provider-registry.md), [ADR-0029](0029-runtime-guards.md) and [ADR-0030](0030-execution-jobs-and-lease.md)
- Decisions it applies: D-X6-ACTOR, D-X6-START, D-X6-CANCEL, D-X6-VERIFY, D-X6-ATTEMPT, D-X6-JOB (Geovet, 2026-09-27) and the X6c authorization
- Open decisions it respects: D-7, D-12, D-27, credit reservation, CONFIDENTIAL/RESTRICTED data, sweeper, scheduler, heartbeat, human review, specialist review, refunds, retention, Company Context

## Context

X6a fixed who may do what to an execution, and X6b gave the runtime a unit of work with a lease. Nothing yet moved an execution forward. The pre-implementation audit also found two gaps:

- **N1.** `ExecutionService.changeStatus` and `changeNode` accepted any resolved tenant. A person, or GIA, could move running work (`running → verifying`, a node `→ completed`) without the runtime.
- **N2.** Node changes were not audited: only execution status changes were.

## Decision

### N1: only the runtime drives running work

- `ExecutionService` has two runtime-only methods, `runtimeChangeStatus` and `runtimeChangeNode`. Both refuse any tenant whose actor is not `runtime` (`actor_not_allowed`), and a context that was not resolved by tenancy (`unresolved_tenant`): the runtime context only exists through `resolveRuntimeTenant` (ADR-0029), so claiming `actor: 'runtime'` or copying a runtime context gives nothing. They refuse planning executions and cancelling (`cancel` stays the owner's, ADR-0029). They reuse the same model functions (`applyStatusChange`, `applyNodeChange`); nothing is duplicated.
- `changeNode` is removed. `changeStatus` keeps only the planning lifecycle (plan-mode executions, driven by the planner for its user) and withdrawing work that never started (`pending → cancelled`, used by delegation clean-up). For running work it is `actor_not_allowed` for everyone, the runtime included.
- `retryNode` and `markOutcomeUnknown` were already runtime-only (ADR-0029).
- **The tool gate is runtime-only.** `ToolGate.invoke` refuses any other actor with `runtime_only`, audited as `tool.execution_denied`. Planners, workflows and GIA reach tools through the runtime, never directly. This amends ADR-0026's list of callers; every other gate check is unchanged.
- No HTTP route changes. No route reaches `runtimeChange*`, the gate or `advance()`; `runtime_cannot_decide` and `gia_cannot_decide` are unchanged, and there is no admin bypass and no new permission or role.

### N2: every node change is audited in its own write

- A new action, `execution.node_changed` (category `execution`), records every node transition made by `runtimeChangeNode` and by the tool gate: the actor (`system/runtime`, initiated by the execution's user), the organization, the execution (`target`), the node (`nodeId`, a new field and the flat column `nodeId`), `transition.from` and `transition.to`, the failure code as `reason` for `failed`, the request id and the time. Never an input, an output or a secret.
- The event is written in the same repository update as the node change. If the event cannot be written, the change is not stored (tested with a failing audit store: the node stays `pending` and the tool or model is never called).
- Existing events keep their meaning: `execution.node_retried` and `execution.node_outcome_unknown` now also carry `nodeId`.

### `advance()`

`@melonoffice/runtime` exposes `createRuntime()` with three operations. None is wired to an HTTP route or a worker endpoint yet (X6d/X6e).

- **`advance(request)`**: the request is exactly a lease proof `{ jobId, leaseId, revision }` from `JobService.acquire`. Any other field (an organization, user, role, tenant, approval, `approved`, provider, model, node state or attempt) is `invalid_request`. Everything else is read from storage: the job, then its execution with the job's own organization, then the runtime context of the execution's user, whose membership is checked again.
- **`kickoff(tenant, executionId)`**: after the owner's `start`, queues the first ready node, once. Refused once any node moved.
- **`resume(tenant, executionId)`**: after a person decided the approval a node waits on, hands its queued job back to a worker. The approval must be decided and be for exactly this organization, execution, node, tool and tool version; the gate checks it again against the exact input digest when the node runs. Only a user or the runtime may call it; GIA cannot.

**One node per advance.** In order:

1. **Turn.** `JobService.turn(proof)` checks the lease (id, revision, server-clock expiry) and moves the job one revision ahead under the same lease. Of several deliveries of one proof, only one gets the turn; the others get `job_revision_mismatch` (or `job_terminal` afterwards) and return `duplicate` without touching anything, not even the audit log.
2. **Load.** The execution is read with the runtime context. An ended execution cancels its jobs and returns `execution_ended`. A planning execution is refused.
3. **The job's node**, by its stored state:
   - `pending`: run it, by type (below).
   - `running`: found running before this delivery ran it, so whoever ran it is gone. It is marked `outcome_unknown` and never run again.
   - `failed`: its one allowed retry (ADR-0029 rules A/B/C) as a new attempt with a new job, or the execution fails with the node's code. `outcome_unknown` and `timeout` are never retried: the execution stays as it is (`awaiting_resolution`) for a person.
   - `completed` / `skipped`: nothing to run; go on.
   - A node whose attempt is not the job's is refused (`job_attempt_mismatch`).
4. **Progress.** The next ready node (first in graph order whose dependencies are all completed or skipped) gets its job, queued before this job finishes, so a lost finish loses nothing. When every node is completed or skipped: `running → verifying`, then verification. A graph with nothing ready is `graph_blocked`, unless a node waits on resolution.
5. **Finish.** The job records how it ended.

**Node types.**

| Type                                                                  | What the runtime does                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool`                                                                | `ToolGate.invoke` only, with the input from the work source. The gate does authorization, guardrails, approval, the node's idempotency key and the node's state. `requires_approval` releases the job (`waiting_approval`). A denial fails the execution with its code.                            |
| `agent`                                                               | `pending → running` first, then `AIGateway.generate` only, with request id `job-{jobId}` (stable per job, so the gateway's credits reference is too) and the execution's own specialist. Completed: the node completes with output ref `ai_request/{requestId}`. Failed or denied: the node fails. |
| `parallel`                                                            | Graph logic only: `pending → running → completed`. Its branches then run one at a time.                                                                                                                                                                                                            |
| `condition`, `workflow`, `approval`, `verification`, `delay`, `event` | No defined behaviour yet: the execution fails with `node_type_unsupported`. Nothing is guessed.                                                                                                                                                                                                    |

**Ports.** The runtime works only through `RuntimeServices` (execution service, tool gate, AI gateway, job service, approval reads) built per correlation id, and three optional ports:

- `NodeWorkSource`: the tool input and the AI call content a node works on, which the execution only references. Its answers are content, never authority: a field the runtime sets (`requestId`, `executionId`, `nodeId`, `specialistId`) is refused (`invalid_work`). Absent: `input_unavailable`. Company Context will be read here once it exists.
- `VerificationSource`: `output_schema` or `checks` evidence. Absent: the execution stays `verifying` (`verification_pending`). Failing evidence fails it with `verification_failed`.
- `JobDispatcher`: hands a queued job id to a transport (X6d). Absent, jobs stay queued.

### Invariants

- No `completed` with a node pending, running, failed or cancelled, and not without recorded, passing evidence covering every completed node (ADR-0029, enforced by the model).
- No `verifying` until every node is completed or skipped; no path to `completed` that skips `verifying`.
- A completed, skipped or cancelled node is never run; a running node found at start is never run again; one delivery of one lease proof runs at a time.
- At most one retry, only for effect-free nodes or tools with an idempotency key, under the same key; never for `timeout` or `outcome_unknown`.
- Tools only through the gate; models only through the gateway. The runtime package depends on no provider SDK, adapter, credential, tool executor or repository (tested).
- The runtime cannot approve, reject, cancel or decide a plan; GIA cannot drive the runtime.
- A cancelled execution cancels its jobs; late results are discarded by the gate and by the execution model.

### Jobs (amends ADR-0030)

- **Turn**: `leased → leased`, same lease id, revision + 1, no event (it changes no state). Refusals other than a duplicate are audited as `execution.job_leased` denied.
- **Release**: `leased → queued`, audited as `execution.job_released` with the reason (`waiting_approval`). The job is leased again later under a new lease id.
- **Finishing after the runtime's own end**: a job may be finished when its execution ended `completed` or `failed` (the runtime ended it). A `cancelled` execution still cancels the job.

## Not in this change

No HTTP route, worker endpoint, Cloud Tasks, scheduler, sweeper, heartbeat, lease renewal, automatic re-queue, Terraform, IAM, deploy, staging or production change. No provider (D-7), credit rate (D-12), credit reservation, CONFIDENTIAL/RESTRICTED handling, role (D-27), human or specialist review, refund or retention. No Company Context, condition expressions, workflow, delay or event behaviour, and no store for AI output content.

## Consequences

- Running work moves only through the runtime, one node per job, with an audit event per node change.
- Lease duration must exceed the longest tool or model timeout; it belongs to the worker's deployment (X6d).
- Test changes the new architecture required: tests that moved running work with a user's `changeStatus`/`changeNode` now use the runtime methods or the owner's `cancel`; tool gate tests invoke with a runtime context, and user or GIA invocations now expect `runtime_only`; audit reconstruction and actor tests include `execution.node_changed`; the tenancy emulator test's expected audit document gained `nodeId: null`; the AI gateway test that stopped a running execution with `changeStatus` now uses the owner's `cancel`.
