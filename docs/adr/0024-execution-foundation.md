# ADR-0024: Execution foundation

- Status: Accepted (Phase X1; accepted by Geovet, 2026-09-27)
- Date: 2026-09-27
- Builds on: [ADR-0018](0018-tenancy-and-memberships.md), [ADR-0019](0019-rbac-foundation.md), [ADR-0020](0020-audit-log-foundation.md), and D-28 (a specialist is the agent)
- Numbering: ADR-0023 is taken by the credits foundation (PR #20).

## Context

The capability audit (2026-09-27) found no execution layer in MelonOffice. There are no execution records, states, graph or version snapshots. Every later capability needs one persistent, tenant-safe contract to write into: planner, specialists, tools, workflows, approvals, verification, observability and GIA.

X1 builds only that contract. It runs no AI, tool, job or workflow.

## Decision

### Package

`packages/execution` holds the domain rules and the service, with no HTTP and no Firestore:

- `model.ts` has the pure operations;
- `lifecycle.ts` has the status tables;
- `repository.ts` has the `ExecutionRepository` port and a memory implementation;
- `service.ts` has `createExecutionService`.

The Firestore implementation of the port lives in `apps/api`, like every other store (moved to the shared `packages/firestore` by [ADR-0030](0030-execution-jobs-and-lease.md)). The types are in `@melonoffice/domain`.

There is **no Agent entity**. Per D-28, the specialist is the agent. An execution only references it (`specialistId`, a node `owner`, and the version snapshot).

### Execution

An execution has these fields:

- `id`: a random UUID, globally unique;
- `organizationId` and `userId`: from the resolved tenant, never from input;
- `mode` and `status`;
- `input`: a reference to the task or message;
- `nodes`;
- `currentNodeId`;
- optional `parentExecutionId`, `workflowId` and `specialistId`, the last together with `specialistVersion` and `departmentId` ([ADR-0025](0025-departments-and-specialists.md));
- `requestId`: for correlation only;
- `versionSnapshot`;
- optional `result`, `failure` and `cancellation`;
- `revision`;
- `createdAt`, `updatedAt`, `startedAt` and `completedAt`.

**Data minimisation.** Inputs, outputs and results are _references_ `{ type, id }` to data kept elsewhere. An execution never holds prompts, bodies, headers, tokens or secrets. Unknown fields are dropped when it is built.

### Modes

The modes are `ask`, `plan`, `execute`, `review`, `debug` and `delegate`. They are internal execution modes, not UI buttons. X1 only records the mode. The rules each mode implies are enforced by the layers that come later; for example, `ask` never acts outside MelonOffice (guardrails).

### State machine

The 10 statuses are stored in lowercase, following the repository's convention for status codes: `pending`, `planning`, `waiting_approval`, `running`, `verifying`, `completed`, `failed`, `cancelled`, `paused` and `retrying`.

| From                               | To                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `pending`                          | `planning`, `waiting_approval`, `running`, `failed`, `cancelled`             |
| `planning`                         | `waiting_approval`, `running`, `paused`, `failed`, `cancelled`               |
| `waiting_approval`                 | `planning`, `running`, `failed`, `cancelled`                                 |
| `running`                          | `waiting_approval`, `verifying`, `paused`, `retrying`, `failed`, `cancelled` |
| `verifying`                        | `completed`, `retrying`, `failed`, `cancelled`                               |
| `paused`                           | `planning`, `running`, `failed`, `cancelled`                                 |
| `retrying`                         | `running`, `failed`, `cancelled`                                             |
| `completed`, `failed`, `cancelled` | nothing (terminal)                                                           |

- **`completed` is only reachable from `verifying`.** A step that ran is not a task that is done.
- **`failed` is terminal.** A future recovery policy retries by creating a new execution with `parentExecutionId` pointing at the failed one.
- **`cancelled` is terminal and reachable from every non-terminal status.** Nothing, including node changes and new nodes, can move a cancelled execution. Cancelling (or failing) cancels every unfinished node. The cancellation records when, who and a reason code.
- A refused change changes nothing. The errors are:
  - `execution_already_terminal`, when the execution has ended;
  - `invalid_execution_transition`, when the table does not allow the change;
  - `execution_concurrency_conflict`, when the execution is no longer in the status the caller gave as `from`.
- `failed` requires a failure code, and `cancelled` requires a reason code. Both use the audit reason format.

Real approval, verification, retry and pause behaviour is not built. X1 prepares only the states.

### Graph

The graph is a list of typed nodes: `agent`, `workflow`, `tool`, `approval`, `condition`, `verification`, `parallel`, `delay` and `event`. Each node has an id, type, label, status, `dependsOn`, and optionally `owner` (a versioned reference), `input`, `output`, `error`, `startedAt` and `completedAt`. A `tool` node also names its exact tool version and the approval it waits on ([ADR-0026](0026-tools-approvals-and-guardrails.md)).

Rules:

- Node ids are unique.
- Every dependency must exist in the graph.
- The graph must stay acyclic, which is checked on every change.
- A node starts only when its dependencies are `completed` or `skipped`.
- A running node becomes `currentNodeId`.
- There are at most 200 nodes.

Node statuses are `pending`, `running`, `completed`, `failed`, `skipped` and `cancelled`. The last four are final.

The graph is stored in the execution document, so an execution and its nodes always change together. An execution can be rebuilt from the execution, its graph, the node states and the audit log. No engine runs any node type yet.

### Version snapshot

The snapshot is `{ schemaVersion: 1, components: [{ kind, id, version }] }`. It is recorded at creation, frozen, and never changed afterwards.

It is a list of versioned references rather than one field per component, for two reasons:

- Components that do not exist yet (tools, policies, models) are added as new `kind`s, without inventing entities now.
- Stored executions keep their meaning as the list grows.

Each `kind` + `id` appears once.

### Persistence

The collection is `executions/{executionId}`. `organizationId` is a field that every read checks: another organization's execution is treated as absent.

Records are checked when they are read. A malformed status, mode, graph or snapshot is refused and never repaired. Reads are by id only, so no index or Terraform change is needed.

### Atomicity and concurrency

- **Create** runs in a Firestore transaction: `create` for the execution and `create` for its audit event.
- **Every change** reads the document, applies a pure change and writes it with its audit events, all in one transaction. The new state must be exactly one `revision` ahead.
- **Lost updates are impossible.** Firestore reruns the change on the fresh document when a concurrent write happened. The change then sees that the execution is no longer in its `from` status and fails with `execution_concurrency_conflict`. For example, `running → verifying` can never overwrite a concurrent `running → cancelled`.
- **Memory** gives the same guarantee by comparing revisions.
- **Audit failures** follow the existing policy: the event is written in the same transaction, so a change without its event is never stored.

### Tenancy and RBAC

- Every service method takes a `TenantContext` from `resolveTenant()`. Anything else is refused with `unresolved_tenant`.
- An organization suspended after the context was resolved is refused with `organization_inactive`.
- New permission `execution.read`, given to `owner`. There are no write, create or cancel permissions: no route writes, and creation is server-side only. No roles were added.

### API

The route is `GET /v1/organizations/:organizationId/executions/:executionId`, through `withPermission('execution.read')`.

It follows the project's convention: the path selects the organization, and membership authorizes it. A top-level `/v1/executions/:id` route would have to read the execution before tenancy ran, so a 403 versus a 404 would reveal whether an id exists.

| Case                                                                                                   | Response                                                  |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Another organization's execution, a missing id or a malformed id, within the caller's own organization | `404 execution_not_found` (identical)                     |
| An organization the caller does not belong to                                                          | `403 organization_forbidden`, the existing tenancy answer |

The response is a safe view: states, references, versions and graph. It never includes the request id, the revision, storage details or anything the execution does not hold. There is no create, change or cancel route (404). Query, headers and body are never read. Without a repository, the route answers `503 executions_not_configured` (fail closed).

### Audit

Two actions in category `execution`, with target type `execution`:

- `execution.created`;
- `execution.state_changed`, with a new structured field `transition { from, to }`, stored as the `transitionFrom` and `transitionTo` columns, plus the reason code for `failed` and `cancelled`.

Node changes are not audited: they are operational detail kept in the execution itself. Audit remains the security record, and the execution is the run history.

### Observability

`withCorrelation(logger, { requestId, executionId, nodeId })` in `packages/observability` binds well-formed ids to every log line. Malformed ids are dropped. No second telemetry stack is added, and there are no dashboards or metrics yet.

### Amended by ADR-0029

- An execution first reaches `running` only through a user's start (`execution.start`), except a planning execution delegated from `planning` or `waiting_approval`.
- `running → verifying` needs every node completed or skipped; `verifying → completed` needs a recorded, passing verification covering every completed node.
- Nodes record their `attempt` and, for external effects, their `idempotencyKey`; a failed node is retried only under ADR-0029's rules, never when its outcome is unknown.
- Cancellation by a person (`execution.cancel`) reaches the children of a planning execution.
- New audit actions: `execution.start_denied`, `execution.cancel_denied`, `execution.verification_recorded`, `execution.node_retried`, `execution.node_outcome_unknown`.

## Not in this change

AI, LLM calls, the AI gateway, providers, a real planner, the Agent Engine, specialist execution, skills, tools, MCP, browser automation, workflow execution, scheduler, events, real approval, guardrails, verification, memory, credits metering, cost, billing changes, connectors, UI, Terraform and Cloud Run changes.

## Consequences

- Later layers create and move executions only through `ExecutionService`, so tenancy, the state machine, cancellation and audit apply to all of them.
- Retry creates a new execution. History is never rewritten.
- Growing the snapshot or adding node types needs no migration.
