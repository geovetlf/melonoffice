# @melonoffice/runtime

The execution runtime ([ADR-0031](../../docs/adr/0031-runtime-advance.md)): moves an execution forward one node at a time, from a job whose lease a worker holds. Server only, with no HTTP, no Firestore and no provider.

- `runtime.ts`: `createRuntime()`:
  - `advance(proof)`: takes exactly a lease proof `{ jobId, leaseId, revision }`; runs the job's node or finishes what an earlier delivery left, then queues the next node or verifies.
  - `kickoff(tenant, executionId)`: queues the first node after the owner's start, once.
  - `resume(tenant, executionId)`: hands a job back to a worker once its node's approval was decided.
- `ports.ts`: `RuntimeServices` (execution service, tool gate, AI gateway, job service, approval reads), `NodeWorkSource`, `VerificationSource` and `JobDispatcher`.
- `errors.ts`: stable codes (`invalid_request`, `actor_not_allowed`, `approval_pending`, `approval_mismatch`…).

Tools run only through the tool gate and models only through the AI gateway. The runtime has no authority of its own: it acts as the `runtime` for the user who started the execution, re-resolved from storage every time. It cannot approve, reject or cancel.
