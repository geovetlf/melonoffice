# ADR-0030: Execution jobs with lease, and shared Firestore repositories

- Status: Proposed (Phase X6b, pending Geovet's review)
- Date: 2026-09-27
- Builds on: [ADR-0017](0017-user-persistence-in-firestore.md), [ADR-0020](0020-audit-log-foundation.md), [ADR-0024](0024-execution-foundation.md) and [ADR-0029](0029-runtime-guards.md)
- Decisions it applies: D-X6-JOB (Geovet, 2026-09-27, X6b authorization)
- Open decisions it respects: D-7, D-12, D-27, credit reservation, CONFIDENTIAL/RESTRICTED data, sweeper, scheduler, refund policy, retention, specialist review, human review, final provider selection

## Context

ADR-0029 fixed the rules the runtime must obey. Before a worker can run anything, two pieces are missing:

1. **A unit of work that one worker owns at a time.** Nothing described "run node N of execution E, attempt A", who holds it, until when, or how a second delivery, a crashed worker or a cancelled execution is handled.
2. **Repositories the worker can use.** Every Firestore repository lived in `apps/api`. A worker would have needed a copy, with its own tenancy checks and serialization.

X6b adds both and nothing else. It runs no node.

## Decision

### Shared Firestore repositories (`packages/firestore`)

- Every Firestore repository moved from `apps/api/src/*-firestore.ts` to `@melonoffice/firestore`. The moved files are `approvals`, `audit`, `billing`, `credits`, `departments`, `executions`, `plans`, `specialists`, `tenancy`, `users` and `workflows`, with their emulator tests and the emulator helper (`@melonoffice/firestore/testing`). Only their imports changed in the move. The API imports them from the package; a worker will import the same code.
- `fromAuditDocument` (reading a stored audit event back) moved from the API's test helper into the package, next to `toAuditDocument`.
- Ports stay in their domain packages (`ExecutionRepository`, `JobRepository`…), which never depend on Firestore. `@melonoffice/firestore` is server only, with no HTTP dependency; the lint rule that keeps server packages out of the web app lists it.

### The job (`@melonoffice/jobs`, `executionJobs/{jobId}`)

A job is a pointer: run one node of one execution at one attempt. It never carries user input, output, a tenant, a user, a credential, a secret or a copy of the execution. Authority and data are always read again from the stored execution.

| Field                                  | Meaning                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `id`                                   | Name-based UUID of organization, execution, node and attempt                              |
| `organizationId`                       | Copied from the stored execution at creation, never from a caller                         |
| `executionId`, `nodeId`                | The work                                                                                  |
| `attempt`                              | The node's attempt (ADR-0029), read from the stored node, never chosen by a caller        |
| `state`                                | `queued`, `leased`, `succeeded`, `failed` or `cancelled`                                  |
| `lease`                                | `leaseId`, `workerId`, `acquiredAt`, `expiresAt`: the current or last lease               |
| `idempotencyKey`                       | `job:{executionId}:{nodeId}:{attempt}`: a delivery key for a transport, not an effect key |
| `correlationId`                        | The request that created the job; carried to every event and log line                     |
| `retryOf`                              | The previous attempt's job, for attempt 2                                                 |
| `leaseCount`                           | How many times it was leased; more than one means an owner lost its lease                 |
| `outcome`                              | A stable code and at most a reference, once terminal                                      |
| `revision`                             | Increases by exactly one with every change                                                |
| `createdAt`, `updatedAt`, `finishedAt` | Server times                                                                              |

- **One job per unit of work.** `jobIdFor(organization, execution, node, attempt)` is deterministic (`nameBasedUuid`, the same construction as delegated execution ids). Creation is a transaction that reads first and uses `create`: a retry or a concurrent create returns `exists` and writes nothing, not even an event. A retried node (attempt 2) is another job, whose `retryOf` names the first.
- **The organization is never taken from a caller.** `enqueue` accepts exactly `{ executionId, nodeId }`; any other field (an organization, a user, an attempt, a lease, a payload, a credential) is `invalid_job`. The organization comes from the resolved tenant and the stored execution.

### State machine

```
queued ──► leased ──► succeeded
   │         │  ▲──┐  failed
   │         │     │  (leased → leased: takeover after expiry, new lease id)
   └─────────┴──► cancelled
```

- `succeeded`, `failed` and `cancelled` are terminal: nothing moves a job out of them.
- `checkNextJob` checks every write: the protected fields (`id`, `organizationId`, `executionId`, `nodeId`, `attempt`, `idempotencyKey`, `correlationId`, `retryOf`, `createdAt`) are unchanged, the revision is exactly one ahead, the transition is allowed, `leaseCount` never decreases, and the result passes `checkStoredJob`.
- `checkStoredJob` refuses a stored job with any field the model does not know, an id that does not match its organization, execution, node and attempt, an inconsistent lease or outcome. A refused record is never repaired or used.

### Lease

- **Acquire** (`acquire(jobId, workerId)`): the worker gives only the job id and its own instance id. The service reads the job, then the execution with the job's own organization, then resolves the runtime context of the execution's user (`resolveRuntimeTenant`, ADR-0029), which checks the user's current membership again. It refuses, without changing the job:
  - an ended job (`job_terminal`, `job_cancelled`);
  - a missing execution or a user who can no longer act (`job_forbidden`);
  - a node whose attempt is not the job's (`job_attempt_mismatch`), or that is no longer pending or running (`node_not_runnable`);
  - a live lease held by anyone (`job_lease_held`).
    A job whose execution ended is cancelled instead (`job_cancelled`). Otherwise, in one transaction, it takes the lease with a new random lease id and an expiry from the server clock (`leaseMs`, required configuration). The worker gets a frozen claim: the job, a lease proof (job id, lease id, revision) and the runtime context.
- **Write** (`finish(claim, outcome)`): only the current, live holder. In one transaction, the lease id must be the job's (`job_lease_mismatch`), the revision the one leased (`job_revision_mismatch`) and the lease unexpired by the server clock (`job_lease_expired`). The claim's context must be the resolved runtime context of this job's organization and execution user (`job_forbidden`), and it is resolved again. An ended execution cancels the job instead (`job_cancelled`). The outcome is exactly `{ result, code, ref? }`.
- **Takeover.** After expiry, another worker may take the job: new lease id, `leaseCount` + 1. The old holder's proof no longer matches, so it can never write again.
- **Cancellation.** `cancelForExecution(tenant, executionId)`, for a user or the runtime holding `execution.cancel`, cancels every unfinished job of an execution that ended. Ids are deterministic, so every job an execution can have is found without a query. Idempotent.
- **Serialization.** Firestore re-runs a transaction whose job changed after it was read, so two workers can never both take a lease. The memory repository reads, decides and writes without awaiting in between, which serializes the same way.
- **Clocks.** Every time comes from the service's server clock. No time, organization or tenant from a caller is used.

### Idempotency

- The job's `idempotencyKey` deduplicates delivery. It is not the key of an external effect: that remains the node's `idempotencyKey`, set by the tool gate (ADR-0029). An infrastructure retry (a redelivery, a takeover) is not an effect retry; X6c will run effects under the node's key.

### Actor, permissions and audit

- No new role and no new permission (D-27): `enqueue` uses `execution.start`, `cancelForExecution` uses `execution.cancel`. GIA cannot create or cancel jobs (`actor_not_allowed`). The runtime keeps every ADR-0029 limit: it cannot approve, decide plans, review, or skip guardrails or verification; nothing here changes that.
- Four actions in the existing `execution` category: `execution.job_enqueued`, `execution.job_leased` (success or denied), `execution.job_finished` (success, failure, or denied) and `execution.job_cancelled`. Changes are written in the job's transaction; refusals through the audit service. Events carry a structured `job` field (`id`, `nodeId`, `attempt`, `leaseId`), stored as the flat columns `jobId`, `jobNodeId`, `jobAttempt` and `jobLeaseId` (ADR-0020), and the job's `correlationId` as `requestId`. Worker actions are recorded as the system actor `runtime` initiated by the execution's user. The source stays `api`: no new audit source is invented.
- Log lines carry `organizationId`, `executionId`, `nodeId`, `jobId`, `attempt`, `leaseId`, `workerId` and `correlationId` (`withCorrelation`), never an input, an output or a secret.

### Company Context compatibility

Company Context (identity, industry, products, structure, departments, goals, processes, policies, communication preferences, language, currency, timezone, location, markets, jurisdictions, documents, integrations, permissions and operational information) will be a persistent, structured, versioned record of the organization, read in the chain Company Context → GIA → Planner → Specialist selection → Workflow → Execution → Verification → Policies/Permissions/Security. It is not a session variable or conversation memory, and it is not implemented here.

The contracts stay compatible with it: a job carries no context, only a pointer, so it will run with whatever context the execution names. An execution already freezes the versions it runs with in its version snapshot, where a `company_context` component and version can be added without changing the job, its id or its lease.

## Not in this change

No node is executed. There is no `advance()`, AI Gateway call, tool gate execution, worker endpoint, Cloud Tasks queue, scheduler, sweeper, heartbeat, new control-plane route, Terraform change, deploy, or staging or production change. Lease duration and its renewal belong to the worker's deployment (X6d). Nothing re-enqueues an expired job: a sweeper is an open decision.

## Consequences

- The API and a future worker share one implementation of every Firestore repository.
- Later X6 changes run nodes from a claim: they cannot pick the organization, the user or the attempt, and a worker that lost its lease cannot write.
- Test changes the new architecture required: the emulator tests moved with their repositories (paths only), and the tenancy emulator test's expected audit document gained the four `job*` columns as `null`.
