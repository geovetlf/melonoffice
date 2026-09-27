# @melonoffice/jobs

Execution jobs with lease ([ADR-0030](../../docs/adr/0030-execution-jobs-and-lease.md)): the pointers the runtime will work from. One job runs one node of one execution at one attempt, and one worker owns it at a time. It runs nothing itself. Server only, with no HTTP and no Firestore.

- `model.ts`: pure operations: deterministic ids (`jobIdFor`), `newJob()`, `acquireLease()`, `checkLeaseHolder()`, `finishJob()`, `cancelJob()`, the state machine (`JOB_TRANSITIONS`) and the checks every write and read passes (`checkNextJob`, `checkStoredJob`).
- `repository.ts`: the `JobRepository` port (writes the job and its audit events together, one revision at a time) and a memory implementation for tests. The Firestore one is in `@melonoffice/firestore`.
- `service.ts`: `createJobService()`: `enqueue` and `get` on a resolved `TenantContext`; `acquire` and `finish` for a worker, which gives only a job id and its own instance id; `cancelForExecution` once an execution ended.
- `errors.ts`: stable codes (`job_not_found`, `job_lease_held`, `job_lease_expired`, `job_lease_mismatch`, `job_revision_mismatch`, `job_attempt_mismatch`, `job_forbidden`…).

A job never carries input, output, a tenant, a user or a credential: authority and data are read again from the stored execution.
