# ADR-0028: Planner, delegation and workflow foundation

- Status: Proposed (Phase X5, pending Geovet's review)
- Date: 2026-09-27
- Builds on: [ADR-0019](0019-rbac-foundation.md), [ADR-0020](0020-audit-log-foundation.md), [ADR-0023](0023-credits-foundation.md), [ADR-0024](0024-execution-foundation.md), [ADR-0025](0025-departments-and-specialists.md), [ADR-0026](0026-tools-approvals-and-guardrails.md) and [ADR-0027](0027-ai-gateway-and-provider-registry.md)
- Open decisions it respects: D-7 (launch AI provider), D-12 (credit values), D-27 (role catalogue)

## Context

Executions (X1) had a `plan` mode and a `planning` status with nothing behind them. Specialists (X2), tools, approvals and guardrails (X3) and the AI Gateway (X4) existed, but nothing turned a request into structured work for several specialists.

X5 adds that, and only that: a plan model, a planner that proposes through the AI Gateway, a validation pipeline, delegation to child executions, and reusable, versioned workflows. **Nothing runs because a plan exists.** No scheduler, events, MCP, browser, real connector, real provider, GIA conversational layer, verification engine or long-running job is built. MelonOffice stays an AI virtual office: plans organise office work between specialists; nothing here builds or generates software.

## Decision

### The pieces

| Piece           | What it is                                                                                        | Where                          |
| --------------- | ------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Plan**        | Structured work for one planning execution: status, current version, delegations, decision.       | `packages/domain` `plan.ts`    |
| **PlanVersion** | Write-once content: request, steps, risk, approval need, estimate, source, SHA-256 digest.        | `packages/domain` `plan.ts`    |
| **Proposal**    | What a model (or a workflow) may say. Closed schema; it decides nothing.                          | `packages/planning` proposal   |
| **Validator**   | The pipeline that turns a proposal into a plan, or refuses it with a stage and a code.            | `packages/planning` validate   |
| **Planner**     | Objective → AI Gateway → proposal → validator → plan. Never calls a provider.                     | `packages/planning` planner    |
| **Delegation**  | Hands each specialist step of a ready or approved plan to its own child execution.                | `packages/planning` delegation |
| **Workflow**    | A reusable plan template, versioned and write-once, that instantiates through the same validator. | `packages/workflows`           |

There is one planner, one workflow definition model, and no second execution engine, router, gateway or agent engine: plans become X1 execution graphs, specialists stay X2 records, tools stay behind the X3 gate, and every model call goes through the X4 gateway.

### The pipeline

```
MODEL OUTPUT → SCHEMA → POLICY → PERMISSION → PLAN VALIDATION → PLAN
```

- **Schema.** The proposal is closed at every level. A field named like authority or a credential (`organizationId`, `approved`, `permissions`, `role`, `tenantId`…) is `authority_in_proposal`; any credential-shaped text anywhere is `secret_in_proposal`; any other unknown field (`credits`, `policy`…) or malformed value is `invalid_proposal`. Each step kind carries only its own fields. Contracts use the X3 schema language (`schemaProblem`).
- **Policy.** Tool steps: the exact tool version exists, is active, runs in this environment (unknown environment: none does), allows the specialist's department type, and its effective policy (X3 `effectivePolicy` with `DEFAULT_RISK_POLICY`) is not `denied`. Specialist and verification steps must declare a verification. A plan whose risk resolves to `denied` (critical) is refused.
- **Permission.** Specialist steps use X2 eligibility as it is: the specialist exists in the tenant's organization, is active, in its own active department, at its current version, and the user holds its permissions. A proposal may name a department only to repeat the specialist's own: `department_mismatch` otherwise. Tool steps: the performing specialist's version lists the exact tool version, and the user holds `tool.execute` and the tool's permissions.
- **Plan.** A tool step belongs to one specialist step (`performedBy`) and depends only on it or on its other tool steps; other steps never depend on a tool step; a condition references a step it depends on. Cycles, unknown and self dependencies are found by X1's own `checkGraph`.

What the proposal cannot decide, the system does: department, specialist version, tool contracts, approval needs and estimates. The model can only **raise** risk or ask for approval; it can never lower what a tool's risk requires.

### Plan lifecycle

```
draft → ready | approval_required → approved | rejected → executing → completed | failed
cancelled from any non-terminal status
```

Only validated plans are stored, so a new plan starts `ready` or `approval_required` (any step needing approval, or the plan's risk resolving to `approval_required`). `draft` is kept for a later editor.

### Approval

A plan approval follows X3's rule exactly: a user acting directly, holding `approval.approve`, never GIA (`gia_cannot_decide`), never the planner or the model. It is bound to one exact version: the user sends back the version and digest they saw, and anything else is `plan_version_mismatch`. The decision (who, when, version, digest) is recorded on the plan. A rejected plan cancels its execution (`plan_rejected`). Tool calls inside delegated work still get their own X3 approvals at the tool gate: approving a plan never approves a tool call.

### Storage

- `plans/{planId}`: status, current version, delegations, decision, revision. A plan's id is its planning execution's id, so one execution has at most one plan.
- `planVersions/{planId}_{version}`: written once with `create`; the content as canonical JSON next to its digest. A version whose content no longer matches its digest is refused when read, never shown, approved or delegated.
- Same pattern for `workflows/{id}` and `workflowVersions/{id}_{version}`.
- Every plan write is one transaction with its audit events. Single-field queries only: no composite index, no Terraform.

### Planner

`createPlanner().plan(tenant, { executionId, requestId, objective })`:

1. RBAC `plan.create` (new, owner only), before any model call.
2. The execution must be the tenant's, mode `plan`, status `planning`, owned by a specialist (the organization's planning specialist, e.g. in Dirección), and not a workflow's.
3. The context is the organization's eligible specialists as ids and codes (department type, main role, capabilities, tool versions). No organization id, user, secret or authority.
4. One `AIGateway.generate` call with capability `structured_output`, on the planning execution and its specialist. The gateway charges it like any other call (deny-by-default while D-12 is open).
5. The structured output goes through `PlanService.propose` (the pipeline). A refusal records `plan.proposal_refused` with its code and fails the planning execution; a denied or failed AI call fails it with the gateway's code. Nothing is stored in either case.
6. A plan that needs approval moves its execution to `waiting_approval`.

With empty provider catalogues (D-7) every planning call is denied today, by design; only tests reach the model path, with fake adapters.

### Delegation

`createDelegation().delegate(tenant, planId)`, server side only, needs `plan.create` and a plan that is `ready` (execution `planning`) or `approved` (execution `waiting_approval`, decision matching the stored version and digest):

1. Every specialist step is checked with X2 eligibility again, at the version the plan names. One ineligible specialist stops everything before any write.
2. The plan's non-tool steps become nodes of the planning execution (`addNodes`); this also locks the plan against a second delegation.
3. Each specialist step gets its own child execution: mode `execute`, `parentExecutionId`, the step's specialist assignment (checked again by X1's `AssignmentGuard`), a snapshot with the specialist's components plus `plan` (and `workflow`) versions, and a graph of its agent node plus its tool nodes. Children stay `pending`.
4. The plan becomes `executing` with its delegations; `delegation.created` per child and `plan.state_changed`.
5. The planning execution moves to `running`.

Nothing runs: children are pending, and each tool node will still pass the X3 gate. Creating, validating, approving or delegating a plan consumes no credits.

### Estimates

Per specialist step with a token budget: the specialist's model policy, the gateway's own `routeModel`, `costMicroUsd` and `creditsFor`. Without a budget, a routable model, a known price or the credit rate, the estimate is `unknown` (`costMicroUsd` may be known while credits stay `null`). The plan's total is `estimated` only when every step's is. An estimate is never a charge or a reservation, and no price or rate is invented.

### Workflows

A workflow is a named list of plan step templates. A specialist step names a department type and a role (`assignee`), never a specialist, so one workflow means the same in every organization. Lifecycle `draft → active ⇄ paused → archived`. Versions are write-once; a change is a new version and earlier ones stay as they were.

`instantiate` binds each assignee deterministically to the first eligible specialist (by id) with that main role in a department of that type, then calls the same `PlanService.propose`: a workflow faces every check a model's proposal faces. The planning execution must record the workflow (`workflowId` and a `workflow` snapshot component at that version). Sequential steps, parallel groups, conditions, approvals, verification and retry policies are part of the contract; running them is a later phase.

Creating, versioning and activating workflows needs the new `workflow.manage` (owner only), server side only.

### Verification contract

Specialist and verification steps declare `verification`: a policy (`output_schema`, `human_review`, `specialist_review`, `checks`), an expected output code, an optional output schema and required check codes. X5 records it; the verification engine that enforces it is a later phase.

### RBAC

New permissions, all for `owner` only (no new role, D-27): `plan.read`, `plan.create` (checked by the planner and delegation on the server, never by a client route), `workflow.read` and `workflow.manage`. Plan decisions reuse `approval.approve`.

### Audit

Six actions, category `planning`, and targets `plan` and `workflow`:

| Action                  | Results         | When                                                          |
| ----------------------- | --------------- | ------------------------------------------------------------- |
| `plan.created`          | success         | A validated plan version is stored                            |
| `plan.proposal_refused` | denied          | A proposal failed the pipeline; the reason is the first check |
| `plan.approved`         | success, denied | A user approved a version, or was refused                     |
| `plan.rejected`         | success, denied | A user rejected a version, or was refused                     |
| `plan.state_changed`    | success         | Another status change, with from and to                       |
| `delegation.created`    | success         | A step was handed to a child execution                        |

A plan is recorded as the event's target (`plan`, its id); the audit `planId` and `planVersion` fields stay the billing plan of ADR-0021. No prompt, objective text, model output or step content is audited. Workflow definition changes are recorded on the workflow itself (who, when, version), not as audit events.

### Observability

New correlation keys: `planId`, `workflowId`, `workflowVersion`.

### API

Read and decide only:

- `GET /v1/organizations/:id/plans` and `/plans/:planId` (`plan.read`): the plan, and its current version with the digest to approve.
- `POST /v1/organizations/:id/plans/:planId/approve` and `/reject` (`approval.approve`): body exactly `{ version, digest }`.
- `GET /v1/organizations/:id/workflows` and `/workflows/:workflowId` (`workflow.read`).

There is no route that creates, runs, delegates or instantiates a plan or workflow. Another organization's plan or workflow answers like a missing one.

## Consequences

- Plans, delegation and workflows reuse X1–X4 without changing them; the X1 execution machine, X2 eligibility, X3 guardrails and X4 gateway are untouched.
- Delegation writes several documents in sequence (parent nodes, children, plan, parent status). A crash in between can leave pending children with no plan pointing at them; they run nothing, and the plan write is last and revision-checked. A saga or outbox belongs to the phase that runs work.
- Workflow binding picks the first eligible specialist by id: deterministic but simple; a smarter choice is a product decision.
- Plan approval is recorded on the plan, not as an X3 `Approval` document, because X3 approvals bind one tool call. The rules are the same.

## Not in X5

Running plans or workflows, scheduler, events, MCP, browser automation, real connectors or providers, production model, GIA conversational layer, verification engine, long-running jobs, credit reservation, plan editing and new plan versions from the client.
