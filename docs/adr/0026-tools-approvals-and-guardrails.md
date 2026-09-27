# ADR-0026: Tools, approvals and guardrails

- Status: Proposed (Phase X3, pending Geovet's review)
- Date: 2026-09-27
- Builds on: [ADR-0008](0008-entity-model.md) (D-28), [ADR-0019](0019-rbac-foundation.md), [ADR-0020](0020-audit-log-foundation.md), [ADR-0024](0024-execution-foundation.md) and [ADR-0025](0025-departments-and-specialists.md)

## Context

ADR-0008 names tools as the last link of Department → Specialist → Role → Skills → Tools. X1 gave executions a `tool` node type, and X2 let a specialist's configuration list tool references, but there was nothing behind those references: no definition, no rule for when a tool may run, no human approval and no protection against unsafe input or output.

X3 builds the safe base for running tools. No real tool exists yet, and none is invented. There is no provider, AI, planner, workflow, MCP or browser here: only the contracts and the checks every later tool call must pass.

## Decision

### Six different things

| Concept        | What it is                                                                                         | Where                  |
| -------------- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| **Tool**       | A typed, versioned action MelonOffice can take: its schemas, risk, approval policy and limits.     | `packages/tools`       |
| **Skill**      | An internal capability of a specialist, which may use tools. Still a reference only (ADR-0008).    | `packages/domain`      |
| **Specialist** | The agent (D-28): who acts, in which department, with which tool versions allowed.                 | `packages/specialists` |
| **Execution**  | One unit of work and its graph; a `tool` node is one tool call in it.                              | `packages/execution`   |
| **Approval**   | A human's yes or no for exactly one tool call.                                                     | `packages/approvals`   |
| **Guardrail**  | A deterministic check that allows, denies or requires an approval before, and checks output after. | `packages/guardrails`  |

A tool is not a skill, a skill is not a specialist, a specialist is not an execution, an approval is not a guardrail. Each has its own package and none of them decides for another.

### The sequence

```
Execution → Authorization → Guardrails → Approval → Tool → Result → (future) Verification
```

The **tool gate** (`createToolGate`, in `packages/guardrails`) is the only code that runs a tool. For one node of one execution it:

1. resolves the tenant and refuses an inactive organization;
2. reads the execution, the node's exact tool version, and the specialist's eligibility right now;
3. runs the pre-execution guardrails; a denial changes nothing and is audited;
4. when the policy needs an approval: asks for one bound to this exact call, attaches it to the node and moves the execution to `waiting_approval`; once approved, it checks the approval covers this exact call;
5. moves the node `pending → running` in a transaction: only one caller can win;
6. calls the provider's executor with a safe context, within the tool's timeout and retry policy;
7. runs the post-execution guardrails on the output;
8. marks the node `completed` or `failed`, with its audit event in the same write.

It never marks the execution `completed`: a node that ran is not a task that is done, and verification (X5) comes between. There is **no HTTP route** that runs a tool: planners, workflows and GIA will call the gate on the server.

### Tool definition and versions

A tool has an id, a status and its versions. A version has:

- `toolId`, `version`, `nameKey` and `descriptionKey` (translated by the app, D-17), `category` and `action`;
- `mutating`: whether it changes anything;
- `inputSchema` and `outputSchema`;
- `permissions`: RBAC permissions the user must hold;
- `credentials`: `CredentialReference`s (provider and scopes), never values;
- `riskLevel` (`low`, `medium`, `high`, `critical`) and `approvalPolicy` (`auto`, `approval_required`, `denied`), with `approvalTtlSeconds`;
- `timeoutMs` (at most 10 minutes) and `retryPolicy`;
- `provider` (`internal` or `external`, and an id);
- `environments` it may run in, and optional `departmentTypes` it is limited to.

Rules:

- **Lifecycle.** `draft`, `active`, `paused`, `disabled`, `archived` (final), with the same transitions as specialists. Only `active` runs.
- **Versions are immutable.** Versions are numbered 1, 2, 3… and callers always name the exact version: there is no "latest". The registry is frozen once built, and refuses a definition that changes a version already published.
- **Catalogue in code.** Tools ship with the code that runs them, so the catalogue lives in code, like plans and departments. **It is empty**: no real tool exists yet. Tests use fixtures.

### Input and output schemas

The schema language is small and closed: string (with a required `maxLength`), number, integer, boolean, array (with a required `maxItems`) and object. Depth, size and length are bounded.

- **Objects are closed.** A property the schema does not list is refused.
- **Authority never comes from input.** Fields named like an organization, tenant, user, actor, role, permission, approval, execution, specialist, membership, session or authorization are refused at any depth, in schemas when a tool is registered and in values when it is called. The organization, user, specialist and approval always come from the tenant and the stored execution.
- **No credentials.** Fields named like a key, secret, token, password or credential are refused, and so are string values that look like one (bearer tokens, JWTs, private keys, and well-known API key formats).

### Authorization

A tool call needs, together:

- the user's RBAC permission `tool.execute`, plus every permission the tool version lists;
- the specialist to be eligible again at run time (ADR-0025), which includes the user holding every permission the specialist needs (D-25);
- the specialist's version to list this exact tool version;
- the specialist's department type to be allowed by the tool, when the tool limits them. Department limits are configuration on the tool, not code.

**GIA gets no bypass.** GIA acts for a user and passes exactly the same checks with exactly that user's permissions. GIA can cause an approval to be asked for, but can never approve or reject one: that needs the user acting directly.

### Risk and approval policy

Each risk level has a default policy. A tool's own policy can only make it stricter.

| Risk       | Default             |
| ---------- | ------------------- |
| `low`      | `auto`              |
| `medium`   | `auto`              |
| `high`     | `approval_required` |
| `critical` | `denied`            |

This is a safe default in configuration (`RiskPolicy`), not a product decision.

### Approvals

An approval has:

- `id` and `organizationId`;
- the **operation** it covers: organization, execution, node, specialist and specialist version, tool and tool version, action, and the SHA-256 digest of the input;
- `bindingDigest`: the SHA-256 of that operation in canonical form;
- `requestedBy`, `riskLevel`, `reason` and `impact` (stable codes), optional `estimatedCredits`;
- `status`, `requestedAt`, `expiresAt`, `decidedAt`, `decidedBy` and `revision`.

Rules:

- **Lifecycle.** `pending` → `approved`, `rejected`, `expired` or `cancelled`. Every other status is final. Approving twice, approving after a rejection and deciding after expiry are all refused.
- **Binding.** The gate rebuilds the operation from verified context and compares its digest with the approval's in constant time. An approval of another organization, execution, node, specialist version, tool, tool version, action or input never matches. An approval that is `approved` but past `expiresAt` no longer covers anything.
- **One per node.** A node gets at most one approval. After a rejection or expiry it cannot ask again; the execution decides what to do next (a later phase).
- **Who decides.** `approval.approve`, the user acting directly, and only in the approval's own organization. Refusals are audited.
- **No payloads.** An approval stores the input's digest, never the input. Its view shows neither digest.

### Guardrails

**Pre-execution.** `evaluatePreExecution` is deterministic and denies unless every check holds, in order:

1. the execution exists in the tenant's organization;
2. it is `running`, or `waiting_approval` on this node;
3. the node exists, 4. is a `tool` node and 5. is still `pending`;
4. the execution has a specialist, and 7. that specialist is still eligible;
5. the exact tool version exists, and 9. the tool is `active`;
6. the specialist's version lists that tool version;
7. the department type is allowed, when the tool limits them;
8. the user holds `tool.execute` and the tool's permissions;
9. the tool version allows this environment;
10. a tool that changes something does not run in the `ask`, `plan` or `review` modes;
11. an executor for the tool's provider is available;
12. the input matches the tool's closed schema;
13. the policy: `denied` denies, `approval_required` requires an approval, `auto` allows.

The answer is `allow`, `deny` with a stable reason, or `require_approval`.

**Post-execution.** The output must match the tool's closed output schema, with no authority fields and no value that looks like a credential. An output that fails is never passed on, and the node fails with `output_rejected`. Verification (X5) will extend this step.

### Executor contract and result

`ToolExecutor.execute(context, input)` runs one provider's tools. No executor exists yet. The context is built only from verified data:

- organization, execution, node, specialist and version, tool and version, action;
- the user and whether GIA was the channel;
- risk level, approval id, environment, request id and deadline;
- an **idempotency key** for mutating tools.

It holds no credentials: an executor resolves its `CredentialReference`s in secure infrastructure. The input it receives is a frozen copy.

The gate always answers a `ToolResult`, never an ambiguous exception:

| Status              | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `success`           | It ran and its output passed the post-execution guardrails.          |
| `failure`           | It ran and failed, or its output was rejected. A stable code.        |
| `denied`            | A guardrail or the approval refused it. Nothing ran.                 |
| `requires_approval` | A human must approve first. Nothing ran.                             |
| `timeout`           | It did not finish in time. Not retried: whether it acted is unknown. |

A provider's failure code is recorded only when it is a stable code; otherwise it is `tool_failure`. An executor that throws is `executor_error`, and its message is never recorded.

### Idempotency

- The node's `pending → running` move is a transaction. Two concurrent calls cannot both run a node, and a node that ran never runs again.
- Mutating tools get the key `SHA-256(executionId, nodeId, toolId, toolVersion)` to pass to their provider, so a retry changes nothing twice.

### Environment

A tool version lists the environments it may run in (`dev`, `staging`, `prod`). The gate must be given its environment explicitly. An unknown environment allows nothing, and dev never implies prod.

The API does not know its environment yet, and X3 does not wire the gate into the API or add an environment variable. The phase that brings the first real tool sets it.

### Audit

New `tool` actions, written in the same transaction as the change they record, or through the audit service when nothing else is written:

- `tool.authorization_checked`;
- `tool.execution_requested`, `tool.execution_denied`, `tool.execution_completed` and `tool.execution_failed`;
- `tool.approval_requested`, `tool.approval_approved`, `tool.approval_rejected`, `tool.approval_expired` and `tool.approval_cancelled`.

Events gain a structured `tool` field (id and version, stored as `toolId` and `toolVersion`) and an `approval` target. They never carry the input, the output, a credential or a provider message: only codes, ids and versions.

### Execution integration

- A `tool` node must name its exact tool version (`tool: {id, version}`), and only `tool` nodes may.
- A node records the `approvalId` it waits on or ran with. `attachApproval` refuses a second one.
- The node's `input` and `output` stay references: inputs and outputs are not stored in the execution.
- X1's state machine is unchanged. The gate uses the existing `running ↔ waiting_approval` transition.

### Observability

Log lines of a tool call carry `requestId`, `organizationId`, `executionId`, `nodeId`, `specialistId`, `toolId` and `toolVersion` (`withCorrelation`). Inputs and outputs are never logged.

### RBAC

Four new permissions, all given to `owner`:

- `tool.read`: see the catalogue;
- `tool.execute`: let an execution run a tool for you; checked by the gate, never by a route;
- `approval.read`: see the organization's approvals;
- `approval.approve`: approve or reject.

There is no `guardrail.read`: guardrail decisions are in the audit log and on the node. No new role: D-27 is still pending.

### API

| Route                                                                  | Permission         | Answer                                                                  |
| ---------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `GET /v1/organizations/:organizationId/tools`                          | `tool.read`        | `{ tools: [...] }`                                                      |
| `GET /v1/organizations/:organizationId/tools/:toolId`                  | `tool.read`        | one tool, or `404 tool_not_found`                                       |
| `GET /v1/organizations/:organizationId/approvals`                      | `approval.read`    | `{ approvals: [...] }`, newest first, at most 100                       |
| `GET /v1/organizations/:organizationId/approvals/:approvalId`          | `approval.read`    | one approval, or `404 approval_not_found`                               |
| `POST /v1/organizations/:organizationId/approvals/:approvalId/approve` | `approval.approve` | the approved approval; `409 approval_not_pending` or `approval_expired` |
| `POST /v1/organizations/:organizationId/approvals/:approvalId/reject`  | `approval.approve` | the rejected approval; `409` as above                                   |

- Nothing is read from the body, query or headers. Another organization's approval, a missing one and a malformed id all get the same 404.
- The tool view leaves out schemas, permissions, credential references and provider. The approval view leaves out both digests and the revision.
- There is no route that runs a tool, and none that creates an approval.
- Without an approvals store, the approval routes answer `503 approvals_not_configured`.

### Persistence

| Collection               | Holds                                  |
| ------------------------ | -------------------------------------- |
| `approvals/{approvalId}` | the approval, its operation and status |

- There is no tools collection (the catalogue is code) and no guardrail decisions collection.
- The list uses Firestore's automatic single-field index on `organizationId` and is sorted in the API. There is no new index and no Terraform change.
- Every read checks the organization and validates the record, including that the binding digest matches the operation. A malformed record is refused, never repaired.

## Not in this change

Real tools and providers (Google, Microsoft, Stripe, WhatsApp), MCP, browser automation and computer use, the AI Gateway and model router, Planner, Workflow Engine, scheduler, events, memory, Company Brain, GIA orchestration, verification, credential resolution, credits reservation for tool calls, wiring the gate into the API, a runtime environment variable, UI, and Terraform or Cloud Run changes.

## Consequences

- Every future tool, provider and agent runs through one gate with one set of checks. Adding a tool is a catalogue entry plus an executor; adding a provider is an executor.
- A human approval means exactly one call, and cannot be stretched to another execution, tool, version or input.
- Nodes rejected or expired stay blocked; how an execution continues after that is for the planner phase to decide.
