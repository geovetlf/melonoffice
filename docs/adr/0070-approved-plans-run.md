# ADR-0070: An approved plan runs (WF-1)

- Status: Proposed (pending Geovet's decision card "¿Dejo que los agentes ejecuten los pasos de un plan cuando tú lo apruebes?", recommended option "Sí, WF-1")
- Date: 2026-09-29
- Builds on:
  - ADR-0028 (plans, delegation saga, workflows);
  - ADR-0029 (start, cancel, runtime tenant);
  - ADR-0031 (runtime `advance()`);
  - ADR-0043 (delegated start, agent outputs);
  - ADR-0063 (agent tasks).
- Amends:
  - ADR-0031 N1: a planning execution is now moved by the plan conductor, through two new runtime-only methods;
  - ADR-0028: "no route runs or delegates a plan". Approving is now what starts a plan.
- Amended by [ADR-0075](0075-plan-conditions.md): `condition` steps with a decision run (WF-4).
- Terraform: none. No new route that creates or delegates, no new permission, collection, queue or worker.
- Audit: MelonOffice-Workflow-Engine-Audit.md (project files, outside the repo).

## Context

Plans and workflows existed (ADR-0028), but nothing ran them. Approving a plan recorded the decision and stopped there:

- nothing delegated it;
- the delegated `plan_step` child executions had no work source;
- nothing closed the planning execution or the plan.

## Decision

### 1. Approving starts the plan

`POST /plans/:id/approve` works as before. In addition, when the API has a plan runtime (`planRuntime`, the same kickoff agent tasks use), it does the following after the decision is recorded:

1. Delegates the plan with the existing saga (ADR-0028), as the person who approved.
2. Starts every step that depends on no other step. Each start is the person's own `start` followed by `kickoff`, so the steps are queued for the worker.

The response is the plan in `executing`.

A plan runs whole or not at all. Before the decision, the route refuses a plan with any step other than `specialist` with `409 plan_not_runnable`, and the decision is not recorded. The refused steps are `tool`, `approval`, `verification`, `condition` and `parallel`, none of which has defined behaviour in a plan yet (ADR-0031). This way an approval never covers a plan that would stop halfway.

Without `planRuntime`, approving records the decision and nothing runs, exactly as before.

### 2. Each step is an agent task of the plan

A `plan_step` child runs on the existing runtime, one node at a time.

- **Work (`createPlanStepWork`).** A plan step uses the same prompt, answer shape, model policy (`agent_task`), Company Brain context and credits as an agent task (ADR-0063). The request is the plan's objective and the step's label.
- **Earlier answers.** A step also gets the answers of the steps it depends on, as data (`previous_step`). If one of those answers is missing, nothing is asked of the model (`input_unavailable`).
- **Binding.** The work is bound to the stored plan: the version pinned in the child's snapshot, this execution for this step, and this agent at this version. Anything else gets no work.
- **Verification (`createPlanStepVerifier`).** It uses the answer's shape (`output_schema`), and the answer is the step's result.
- **Routing.** The worker routes executions by kind: agent tasks, then plan steps (`planStepOf`), then conversation turns.

### 3. The plan conductor

`createPlanConductor` in `packages/planning` has two operations:

- **`run(person, planId)`.** Only a person acting directly may call it, and only on an `approved` plan. It delegates the plan and starts the first steps.
- **`advance(runtime, planId)`.** Only the runtime may call it, on an `executing` plan whose delegation is complete. It does the following:
  - A step that failed or was cancelled stops the plan. The planning execution goes to `failed` with `step_failed`, and the plan goes `executing → failed` (audited as `plan.state_changed`, reason `step_failed`). No other step starts. Steps that never started stay `pending`, because the runtime never cancels (ADR-0029).
  - When every step has completed, it mirrors each child on the planning execution's graph. Each node goes `pending → running → completed`, with the child execution as the output.
  - It then records verification with one `checks` check per step (`step_execution_completed`, evidence: the child execution), and completes the planning execution. The plan goes `executing → completed` (audited).
  - Otherwise, it starts every step whose dependencies have all completed. The start is the runtime's delegated start (ADR-0043) of the person's own execution, then `kickoff`.
  - A planning execution the person cancelled is left alone. The existing cascade already cancelled its children and the plan.

Both operations are idempotent: every change names the state it expects, and a change another call already made is read back.

The worker calls `advance` from a new runtime hook, `onEnded(tenant, execution, status)`. The runtime calls it after a completion or a failure is stored. If the hook fails, the execution that ended is not affected.

### 4. The runtime moves a planning execution only through the plan methods

`ExecutionService` gains `runtimePlanChangeStatus` and `runtimePlanChangeNode`:

- runtime only;
- only for `mode: plan` executions;
- never to cancel;
- same model rules as any execution (no `verifying` with a node unfinished, no `completed` without passing evidence);
- node changes audited as `execution.node_changed`.

`runtimeChangeStatus` and `runtimeChangeNode` still refuse planning executions.

### 5. The worker still never plans

The worker's architecture test used to forbid `@melonoffice/planning`. It now allows exactly three names from it: `createPlanConductor`, `planStepOf` and the `PlanRepository` type. No planner, validator, delegation or plan decision can be reached from the worker's code, and `@melonoffice/workflows` stays forbidden. The work methods never touch a plan, and the plan methods never touch work.

## Invariants

- Nothing runs without a person's approval of the exact plan version and digest. GIA and the runtime cannot approve or run a plan.
- One runtime, gateway, queue, worker and audit log. There is no second workflow engine: the conductor only decides when a child starts and when a plan is over.
- A step's model call goes through the AI Gateway with the agent's policy and credits. A plan step calls no tool.
- One organization only: every read goes through the tenant's organization.

## Open

- A plan that is `ready` (no step asks for approval) cannot be approved, so it does not run. A workflow's plan is always `approval_required` since [ADR-0071](0071-workflows-over-http.md); a planner's plan still can be `ready`.
- Tool, approval, condition, verification and parallel steps (WF-4 for `condition`, through the Decision Engine).
- There is no sweeper. If the end hook fails, the plan waits until another step ends. This is the same known limit as ADR-0031 and ADR-0067.
- There is no UI yet (WF-3). The API offers `GET /plans/:id/steps`: each step's state and, once it completed, its answer (`plan.read`).
- Workflows are reachable over HTTP since [ADR-0071](0071-workflows-over-http.md) (WF-2).
