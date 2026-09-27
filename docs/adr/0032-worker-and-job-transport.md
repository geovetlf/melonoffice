# ADR-0032: Worker and job transport (Cloud Tasks)

- Status: Proposed (Phase X6d, pending Geovet's review). The lease duration is provisional (option A below) until Geovet decides.
- Date: 2026-09-27
- Builds on:
  - [ADR-0012](0012-dev-deployment-on-cloud-run.md)
  - [ADR-0015](0015-least-privilege-terraform-planner.md)
  - [ADR-0029](0029-runtime-guards.md)
  - [ADR-0030](0030-execution-jobs-and-lease.md)
  - [ADR-0031](0031-runtime-advance.md)
- Decisions it applies:
  - **D-X6-JOB (Geovet, 2026-09-27): accepted.** "Usar Cloud Tasks como transporte de jobs. Pero: CLOUD TASKS ≠ fuente de verdad." Terraform is prepared as a plan, never applied by Claude.
  - The X6d authorization.
- Open decisions it respects:
  - D-7, D-12, D-27, D-9;
  - sweeper, scheduler, heartbeat;
  - credit reservation;
  - AI output storage and retention;
  - cancelling queued jobs at `cancel` time;
  - Company Context, verification sources.

## Context

X6c can advance an execution one node at a time from a lease proof. Two things were still missing:

- nothing delivered a job to a process that could lease it;
- the worker service was health-only, with no Firestore access.

## Decision

### Flow

```
job queued (Firestore, the source of truth)
  → JobDispatcher → Cloud Tasks task { jobId } with an OIDC token of `job-dispatch`
  → Cloud Run (private worker; IAM lets only `job-dispatch` and the deployer through)
  → POST /internal/jobs/run: token verified again in the app, body exactly { jobId }
  → JobService.acquire(jobId, workerId)  (lease: leaseId + revision + server-clock expiry)
  → Runtime.advance({ jobId, leaseId, revision })  (the only way a node moves)
  → ToolGate / AIGateway → verification → job finished, next job queued and dispatched
```

### The worker is thin

`apps/worker` has one working route, `POST /internal/jobs/run`. It means "run this job" and nothing else. There is no route to change a node, approve, complete or verify.

The handler does only this:

1. Checks that the body is exactly `{ jobId }`.
2. Takes the lease through `JobService.acquire`.
3. Passes only the lease proof to `Runtime.advance`.
4. Maps the result to HTTP.
5. Logs.

It imports only the job service, the runtime and logging. A test pins this list and checks that the handler calls no status, node, verification, approval, tool or model method.

Composition (`apps/worker/src/runtime.ts`) wires the existing services over the existing repositories. It builds nothing new:

- the job service (X6b);
- the execution service (X1/X6a);
- the tool gate (X3);
- the AI Gateway (X4);
- approvals;
- the runtime (X6c).

### Trust

The request is not trusted:

- Anything besides `jobId` is refused (`400`) before anything is read. That includes an organization, user, attempt, actor, lease, revision, approval or node field.
- The job, its execution, the organization, the user, the membership, the attempt and the node are all read again from Firestore by the job service and the runtime.
- The worker instance id is recorded on the lease as infrastructure. It is never an actor.
- Actions are audited as the runtime (`system/runtime`), initiated by the execution's user, exactly as in ADR-0029.

### Authentication

Two layers:

1. **Cloud Run IAM.** The worker is private. `roles/run.invoker` is held only by:
   - the deployer, for its health check;
   - `job-dispatch`, the service account Cloud Tasks signs OIDC tokens as.
2. **In the app.** The worker verifies the OIDC token again with `createServiceIdentityVerifier` (`packages/auth`). It checks:
   - Google's signature (RS256);
   - Google's issuer;
   - audience = the worker's URL;
   - a verified email equal to `job-dispatch`;
   - expiry and issue time.

   A misconfigured service or a direct call never runs a job. Without the runtime configuration, the route answers `503 runtime_not_configured` and reads nothing.

   Responses:
   - no token: `401`;
   - any other token: `403`;
   - Google's keys unavailable: `503`.

### Transport

- **Enqueueing.** `createCloudTasksDispatcher` creates tasks through the Cloud Tasks REST API with an access token from the metadata server. It needs no client library, key or credential of its own.
- **The task:**
  - the body is `{ jobId }`;
  - the OIDC token is for `job-dispatch`, with the worker URL as audience;
  - the dispatch deadline equals the lease.
- **No task name.** A job released while waiting for an approval goes back to the queue under the same id and must be deliverable again. Cloud Tasks keeps task names reserved long after a task ends. Duplicate tasks are harmless: the lease decides.
- **Failed hand-off.** A failed hand-off is logged by the runtime, as in X6c. The job stays queued in Firestore; see _Not in this change_.

### HTTP status and retries

Cloud Tasks retries every non-2xx answer, so the status says only whether delivering again can help:

| Answer                | When                                                                                                                                                                 | Cloud Tasks                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `200 advanced`        | `advance()` ran, whatever its outcome (`progressed`, `failed`, `duplicate`, `awaiting_resolution`, …)                                                                | done                                                                            |
| `200 refused`         | the job cannot run and never will:<br>• unknown<br>• terminal<br>• cancelled<br>• not this runtime's<br>• execution ended or not runnable<br>• organization inactive | done                                                                            |
| `409 retry_later`     | another worker holds a live lease (`job_lease_held`)                                                                                                                 | redelivers later; once the lease ends the job is finished (no-op) or taken over |
| `400 invalid_request` | the body is not exactly `{ jobId }`                                                                                                                                  | redelivers until the queue's attempt limit; nothing is read                     |
| `401` / `403`         | no token, or not the invoker                                                                                                                                         | redelivers until the limit; nothing is read                                     |
| `503`                 | storage failed, or the run threw                                                                                                                                     | redelivers; safe because of the lease, the revision and the node state          |

**Transport retries are not node retries.** Node retries keep ADR-0029's rules: at most one, never for `timeout` or `outcome_unknown`. A redelivery that finds a node `running` marks it `outcome_unknown` (X6c) and never runs it again.

Queue limits:

- 10 attempts;
- backoff 10 s to 600 s;
- 10 concurrent dispatches;
- 5 per second.

### Lease duration (DECISION REQUIRED; provisional option A)

A lease must outlast the longest call a node can make. Today that is a tool timeout of at most 10 min, and 60 s per model attempt.

- **A (provisional):** one fixed lease of 15 min. The worker's Cloud Run request timeout and the Cloud Tasks dispatch deadline are also 15 min. No heartbeat.
  - Simplest.
  - A crashed worker's job waits up to 15 min for takeover.
- **B:** a short lease plus heartbeat renewal.
  - Faster takeover.
  - More writes and moving parts.
- **C:** a lease per node, from its tool's timeout.
  - Faster takeover for short nodes.
  - Changes `acquire`.

The lease is configuration (`job_lease_seconds` in Terraform, `JOB_LEASE_MS` in the worker, 1 to 30 min), not code, so Geovet's decision needs no code change for A.

### IAM (least privilege; dev only)

| Identity                      | Grant                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker-run` (worker runtime) | `roles/datastore.user` (project)                            | Reads and writes the documents the runtime needs: `executionJobs`, `executions`, `approvals`, `auditLogs`, and reads of organizations, memberships, departments and specialists. Firestore IAM cannot be narrowed to collections for server identities. This is the smallest predefined role for documents: no admin, index, import/export or database deletion. The repositories enforce which collections are touched, as for the API. |
| `worker-run`                  | `roles/cloudtasks.enqueuer` on `execution-jobs` only        | Hands the next job to the queue.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `worker-run`                  | `roles/iam.serviceAccountUser` on `job-dispatch` only       | Creating a task with an OIDC token for `job-dispatch` requires acting as it.                                                                                                                                                                                                                                                                                                                                                             |
| `job-dispatch`                | `roles/run.invoker` on the worker only                      | The only identity Cloud Tasks delivers as. It has no other role.                                                                                                                                                                                                                                                                                                                                                                         |
| `github-planner`              | + `cloudtasks.queues.get`, `cloudtasks.queues.getIamPolicy` | To plan the queue (ADR-0015); read-only metadata.                                                                                                                                                                                                                                                                                                                                                                                        |

Staging and prod get none of this: everything is gated on `deploy_apps && firestore_and_auth`.

### Observability

Each delivery logs these steps with the request id, job id, worker id, lease id, attempt, outcome, code and duration:

- `job received`;
- `job claimed`;
- `job run`;
- `job refused`;
- `job lease conflict`;
- `job run failed`.

These are the fields for log-based metrics: received, claimed, succeeded or failed, lease conflicts, latency. Tool and model latency are already logged by the gate and the gateway. No token, body, input or output is logged.

No new observability infrastructure is added.

## Not in this change

- **Delivery gaps:**
  - No sweeper, scheduler, heartbeat, lease renewal or automatic re-queue.
  - A job whose hand-off to Cloud Tasks failed stays queued in Firestore until a sweeper exists (open decision).
- **Control plane (X6e):** no `kickoff`/`resume` wiring from the API, so nothing in dev enqueues a first job yet.
- **Missing sources:**
  - No production work source or verifier. A real node fails with `input_unavailable`, and an execution stays `verifying`; nothing is completed without evidence.
- **Blocked on open decisions:**
  - no AI output store;
  - no provider (D-7), credit rate (D-12) or credit reservation (every model call is denied);
  - no new node types;
  - no roles (D-27).
- **Deferred phases:** Company Context, Agent entity, GIA, Command Center, UI.
- **Infrastructure actions:** no staging or prod change, and no apply.

## Consequences

- A job reaches the worker only through the authorized transport and identity, and runs only under a live lease, through `advance()`.
- Duplicate, concurrent (2/5/10), stale, crashed and late deliveries cannot run a node twice or overwrite another worker's result. This is tested in memory and on the Firestore emulator.
- **Applying.** Geovet applies the dev plan. Until then the worker has no runtime settings and refuses every job with `503`.
- **Audience.** The OIDC audience is the worker's deterministic `run.app` URL, which Cloud Run accepts as an audience for its own service. This is to be confirmed on the first delivery in dev after apply.
