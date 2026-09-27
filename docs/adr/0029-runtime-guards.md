# ADR-0029: Runtime guards: actor, start, cancellation, verification and attempts

- Status: Proposed (Phase X6a, pending Geovet's review)
- Date: 2026-09-27
- Builds on: [ADR-0019](0019-rbac-foundation.md), [ADR-0020](0020-audit-log-foundation.md), [ADR-0024](0024-execution-foundation.md), [ADR-0026](0026-tools-approvals-and-guardrails.md) and [ADR-0028](0028-planner-delegation-and-workflows.md)
- Decisions it applies: D-X6-ACTOR, D-X6-START, D-X6-CANCEL, D-X6-VERIFY, D-X6-ATTEMPT (Geovet, 2026-09-27)
- Open decisions it respects: D-7, D-12, D-27, credit reservation, CONFIDENTIAL/RESTRICTED data, sweeper, scheduler, refund policy, retention, specialist review, human review, final provider selection

## Context

X1 to X5 built executions, specialists, the tool gate, the AI Gateway, plans and workflows, but nothing runs them. X6 adds a runtime that will. Before it runs anything, the rules it must obey go in, so that the worker, job engine and Cloud Tasks transport of later X6 changes are built against fixed guards rather than add them afterwards.

The X6 pre-implementation audit found five gaps that X6a closes:

1. **Self-approval.** Approvals and plan decisions refused any actor other than `user`, but a runtime acting as the user would have been `user`, so it could have approved its own operation.
2. **Start.** Nothing said who may start an execution; any server code could move it from `pending` to `running`.
3. **Cancellation.** Cancelling a planning execution did not reach the child executions its delegation created.
4. **Verification.** X1 let an execution reach `verifying` and `completed` with nodes still pending, running or failed, and without any evidence.
5. **Attempts.** Nothing said when a failed node may run again, or that an unknown outcome must not.

## Decision

### Where the runtime sits

```
GIA / Brain → Planner → Plan / Workflow → Execution → Runtime → Job → Tool Gate / AI Gateway → Result → Verify
```

`packages/runtime` (a later X6 change) is **not** a second Brain, Planner, Workflow Engine, Orchestrator, Router, AI Gateway, Tool Engine or Credits Engine. It moves executions that already exist, one node at a time, through `ExecutionService`; tools only run behind the X3 gate, models only through the X4 gateway, credits only through the X4 credits port. It decides nothing a plan or a person has not already decided. X6a adds no runtime, worker, job engine, `runtime.advance()`, job collection, Cloud Tasks, Terraform, real tool or real AI execution: only the contracts below.

### D-X6-ACTOR: the runtime is its own actor

- `TenantContext.actor` is `'user' | 'gia' | 'runtime'`. `resolveRuntimeTenant(initiatedBy, organizationId, store)` resolves the membership of the user who started the work, exactly like `resolveTenant`, and marks the context `runtime`. RBAC gives it that user's permissions and no more (the engine never consults the actor), so the runtime can never do what the user cannot.
- The audit actor is `{ type: 'system', id: 'runtime', initiatedBy: <userId>, via: 'runtime' }`. Together with the execution target and the organization, every runtime event reconstructs user → runtime → operation → execution → organization. The Firestore columns `actorId` and `actorInitiatedBy` are added (null for other actors); `actorVia` is `runtime`.
- The field-less `{ type: 'system' }` of ADR-0020 is replaced by this one shape; nothing stored used it.
- **The runtime never decides for a person.** Approvals refuse it with `approval_forbidden` (reason `runtime_cannot_decide`), plan approval and rejection with `runtime_cannot_decide` (403). GIA stays refused (`gia_cannot_decide`). Both refusals are audited with the actor that tried. Human review does not exist yet; when it does, it follows the same rule.
- The tool gate passes `via: 'runtime'` to executors, so a provider can tell a runtime call from a direct one.

### D-X6-START: only a person starts

- New permission `execution.start`, owner only.
- `ExecutionService.start(tenant, id)`: `pending → running`, only for a user acting directly with `execution.start`. GIA, the planner, delegation, workflows and the runtime cannot start (`actor_not_allowed`, reasons `gia_cannot_start` / `runtime_cannot_start`); a user without the permission gets `permission_denied`. Refusals are audited as `execution.start_denied`; a start as `execution.state_changed` with reason `user_started`.
- The organization comes only from the resolved tenant; an execution of another organization, a malformed or a missing id are all `execution_not_found`, answered before permissions are asked.
- A second start returns the running execution and writes nothing; concurrent starts are serialized by the revision check, and every loser returns the winner's state. One `pending → running` event is ever recorded.
- A planning execution (`mode: plan`) is not started: it reaches `running` through its plan's delegation, and runs nothing itself. A child whose parent has ended (`execution_parent_ended`) and a terminal execution (`execution_already_terminal`) are not started.
- The model enforces it for every caller: an execution that has never started reaches `running` only through `startExecution`; `applyStatusChange` refuses it (`execution_not_started`), except the planning execution moving from `planning` or `waiting_approval` when delegated.
- `POST /v1/organizations/:organizationId/executions/:executionId/start` exposes it.

### D-X6-CANCEL: cooperative cancellation that reaches the children

- New permission `execution.cancel`, owner only.
- `ExecutionService.cancel(tenant, id, reason)`: only a user acting directly with `execution.cancel`; refusals audited as `execution.cancel_denied`. The runtime never cancels, through `cancel` or `changeStatus`.
- Cooperative: the execution is marked `cancelled` and its unfinished nodes cancelled (X1). Nothing is killed. Work still running finds the execution ended when it reports: the gate's final write fails with `execution_ended`, and any node change, verification, retry or start on a terminal execution is `execution_already_terminal`. A late result never revives the execution and never produces a second effect; it is discarded.
- The cascade: planning implements `CancellationCascade` (`createPlanCancellationCascade`). A planning execution's id is its plan's id, so its children are exactly the plan's delegations, whose ids are fixed at the claim, before they exist. The plan is cancelled with its execution (unless it ended, or its delegation is still `creating`), and each existing child is cancelled with reason `parent_cancelled`, recursively and to a bounded depth. Cancelling again changes nothing already cancelled and reaches any child created since. A delegation interrupted by the cancellation cannot finish under the cancelled parent, and a child that exists under an ended parent can never start.
- `POST /v1/organizations/:organizationId/executions/:executionId/cancel` with `{ reason }` (a stable code) exposes it.

### D-X6-VERIFY: no completion without evidence

- `running → verifying` needs every node `completed` or `skipped`. A node pending or running (`nodes_not_finished`), or failed or cancelled (`nodes_not_successful`), keeps the execution out.
- `ExecutionVerification` on the execution: `schemaVersion`, `executionId`, `result`, `verifiedAt`, `correlationId`, and one `NodeVerification` per completed node (`nodeId`, `policy`, `result`, `checks[]`), each check with a code, a result and a reference to its evidence. Only deterministic policies: `output_schema` and `checks`. `human_review` and `specialist_review` are refused (`verification_policy_not_available`) while human review and D-7 are open.
- `recordVerification` is runtime-only, only while `verifying`, once per pass (a second one is a conflict), and must cover every completed node and nothing else. Results are computed from the checks, never taken as given. A failed verification is recorded too, as evidence; it never completes. Entering `verifying` again starts a new pass without the old evidence.
- `verifying → completed` needs a recorded, passing verification of this pass that covers every completed node of a graph that is still all completed or skipped, with at least one completed node (`verification_required` otherwise). There is no bypass.
- Audited as `execution.verification_recorded` (reason `verification_passed` or `verification_failed`).

### D-X6-ATTEMPT: no generic retries

A node records its `attempt` (1 when absent, at most 2) and, for a tool with an external effect, the `idempotencyKey` it runs under, written at the commit point, before the effect. The key never includes the attempt. `retryNode` (runtime only, execution `running`, node `failed`) applies the rules in order:

- **C.** An unknown outcome is never re-run: a node failed with `outcome_unknown` (recorded by `markOutcomeUnknown` for a lost worker or a passed deadline) or `timeout` is refused (`retry_not_allowed`, `outcome_unknown`).
- At most one automatic retry (`attempts_exhausted`).
- **A.** A node with no external effect by construction (`condition`, `parallel`, `verification`) is retried.
- **B.** A `tool` node is retried only when it recorded an idempotency key: the gate sets one on every mutating tool, and the retry repeats it, so the provider applies the effect once. The gate refuses a start under a different key.
- Anything else, including agents (AI calls are charged) and read-only tools without a key, is refused (`external_effect`).

A retried node goes back to `pending` with its next attempt and keeps its key. Audited as `execution.node_retried` (reason: the rule) and `execution.node_outcome_unknown`. Concurrent retries converge on one attempt through the revision check.

### Company Context: the contract only

`packages/domain` `context.ts` separates four contexts that are never copies of one another: **company** (what the organization is and how it works, versioned), **conversation** (conversation memory), **execution** (what one execution was given and produced) and **user personal** (one user's own preferences). The Company Context sections are named (identity, description, industry, products, services, goals, priorities, structure, departments, processes, internal policies, preferences, markets, customers, constraints, relevant documents, knowledge) and point at stored content, never carry it.

An execution receives a Company Context as a `company_context` component of its version snapshot (`CompanyContextRef`: id and version), at most one per execution, so it always knows which company facts it ran with. The future chain is Company → Company Context → Context Engine → GIA/Brain → Planner → Specialist → Workflow → Execution. There is no Context Engine, store or API yet, and nothing duplicates memory, the Brain or the Planner.

## Not in this change

Runtime package, worker, job engine, `runtime.advance()`, job collections, Cloud Tasks, Terraform, real tool or AI execution, sweeper, scheduler, human or specialist review, credit reservation, refund policy, retention, Context Engine, new roles.

## Consequences

- Later X6 changes build the runtime on `resolveRuntimeTenant`, `ExecutionService` and the gate, and inherit these guards; they cannot start, cancel, approve or complete anything by themselves.
- Tests that moved executions `pending → running` with `changeStatus` now start them; tests that completed executions now finish their nodes and record a verification.
- An execution stuck with a node `running` after a crash stays so until something calls `markOutcomeUnknown`: the sweeper that would do it is still an open decision.
