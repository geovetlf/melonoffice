# ADR-0071: Workflows over HTTP (WF-2)

- Status: Proposed (WF-2, continuing the approved Workflow Engine order; pending Geovet's review)
- Date: 2026-09-29
- Builds on:
  - [ADR-0028](0028-planner-delegation-and-workflows.md) (plans, delegation, workflows);
  - [ADR-0029](0029-runtime-guards.md) (runtime tenant, start, cancel);
  - [ADR-0070](0070-approved-plans-run.md) (an approved plan runs).
- Amends ADR-0028: workflows were server side only, with no client route. The owner now creates, versions, moves and plans them over HTTP.
- Terraform: none. No new collection, index, queue, worker or permission.

## Context

Workflows (ADR-0028) had a service and read-only routes, but nothing outside the server could create one or turn one into a plan. WF-1 made an approved plan run, so a workflow with no way to become a plan was the missing piece.

A plan with no step that asks for approval was `ready`. There is no approve action for a `ready` plan, so under ADR-0070 it never runs.

## Decision

### 1. A workflow's plan always waits for a person

`newPlan` makes a plan `approval_required` when any step or its risk needs a human, and now also whenever its source is a workflow. A workflow is a template: it never runs by itself, and the person who plans it approves the exact version and digest before anything starts (ADR-0070). A planner's plan keeps its rule.

### 2. Owner routes

All under `/v1/organizations/:organizationId/workflows`. Every body is exact: any other field is `400 invalid_request`.

| Route                | Permission        | Body               | Answer                                                     |
| -------------------- | ----------------- | ------------------ | ---------------------------------------------------------- |
| `POST /`             | `workflow.manage` | `{ name, steps }`  | `201` workflow, `draft`                                    |
| `POST /:id/versions` | `workflow.manage` | `{ name?, steps }` | `201` workflow at its new version                          |
| `POST /:id/status`   | `workflow.manage` | `{ from, to }`     | `200` workflow                                             |
| `POST /:id/plans`    | `plan.create`     | `{ requestKey }`   | `201` plan with its current version, or `422 plan_refused` |

Steps are checked by the existing workflow model (`invalid_workflow`, with the field path as `detail`). Status moves follow the existing lifecycle (`409 invalid_workflow_transition`). Another organization's workflow is `404 workflow_not_found`, like a missing one.

### 3. Planning a workflow (`WorkflowService.plan`)

Only a person acting directly may plan a workflow: GIA and the runtime get `permission_denied`. The workflow must be `active`. Then:

1. Every assignee is bound to an eligible agent, exactly as `instantiate` does (ADR-0028). One missing: `409 assignee_unavailable`, and nothing is created.
2. A planning execution is created: mode `plan`, input `{ type: 'workflow', id }`, the workflow id, and a snapshot with the workflow version. Its agent is the agent of the first assigned step. Its id comes from the idempotency key `workflow-plan:{workflowId}:{version}:{requestKey}`.
3. It moves `pending → planning`, and the workflow is instantiated on it, through the same validation as the planner's.
4. A refused proposal moves the execution to `failed` with `plan_refused` and the refusal (stage, reason, detail) as its reference. The answer is `422`.

The same `requestKey` for the same version gives the same plan or the same refusal, and creates nothing new. Concurrent repeats converge on one execution and one plan. A request whose execution ended without a plan answers `409 workflow_plan_ended`.

Nothing runs here. The plan waits in `approval_required` until the person approves it on the plan routes.

## Invariants

- Nothing a workflow produces runs without a person's approval of the exact plan version and digest.
- One validation pipeline, runtime, queue, worker and audit log. There is no second workflow engine.
- One organization only: every read and write goes through the tenant's organization.
- Every change is audited as before: `workflow.created`, `workflow.version_created`, `workflow.state_changed`, `execution.created`, `plan.created` or `plan.proposal_refused`.

## Open

- Web (WF-3): the Automations page (`/automations`) lists workflows and plans, plans an active workflow, shows a plan's steps and answers, and approves or rejects the exact version shown. Creating and editing workflow steps on the web is not built yet.
- `condition` steps through the Decision Engine (WF-4) and triggers (WF-5).
