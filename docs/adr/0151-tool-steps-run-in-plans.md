# ADR-0151: tool steps run in plans

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0028](0028-planner-delegation-and-workflows.md) (plans and delegation), [ADR-0070](0070-approved-plans-run.md) (running plans), [ADR-0146](0146-step-approvals-inside-running-plans.md) (a step that asks a person), [ADR-0026](0026-tools-approvals-and-guardrails.md) (tools, approvals and the Tool Gate)
- Authorization: Geovet, 2026-10-04 11:41Z, "MODO AVANCE MÁXIMO DEL MOTOR", priority 1: tool steps. Risk follows the existing classification (low and medium as their policy says, high needs a person, critical never runs); credits through the existing Credit Core.
- Terraform: none. Firestore: no migration, no index; two optional fields. Prompts: none.

## Context

A plan could contain `tool` steps (ADR-0028): the validator checked the tool, its policy, its assignment and the person's permissions, and delegation put a tool node in the child execution of the specialist step that uses it. But the conductor refused such a plan whole (`plan_not_runnable`), because a tool step had no input and no defined approval (ADR-0145, "Tool calls").

## Decision

The path is the one that exists: plan step → child execution → tool node → runtime → Tool Gate → tool executor → result → next step. Nothing new runs tools.

1. **Input fixed in the plan.** A tool step carries `input`: plain JSON (at most 8 levels and 16 KB), with no authority or credential names at any depth and no credential-looking text, and on tool steps only. The validator checks it against the tool version's own input schema (`policy:invalid_tool_input`) and stores it in the plan version, inside its digest, so the person approves exactly it. The Tool Gate checks it again, with all 17 of its checks, when the step runs. It is data: the organization, agent, approval and credentials always come from the server.
2. **Runnable.** `unrunnableStepOf` accepts a tool step whose tool and specialist step exist. Approval, verification and parallel steps, and conditions on how a step ended, are still refused.
3. **Approval before the step starts.** A tool step needs a person's approval when its tool's policy says so (high risk) or the plan asked for one. When its specialist step is ready, the conductor asks for that approval, first steps included, since the plan's approval never covers a tool call. It is the Tool Gate's own approval: the exact operation the gate rebuilds (child execution, tool node, tool version and action, digest of the plan's input), with the tool's risk, impact and time to decide (`createPlanStepApprovals(service, now, tools)`). The plan records it in `stepApprovals` under the tool step, with `performedBy` naming the specialist step. A specialist step starts only once every approval it waits for (its own, ADR-0146, and each of its tools') was given. Just before it starts, each tool approval is attached to its tool node (`attachPlanStepApproval`, audited as `execution.approval_attached`), where the gate still checks it covers the call.
4. **Declined.** A rejected, expired or withdrawn tool approval declines its specialist step, as in ADR-0146: that step and the steps after it are skipped, the other branches go on, the plan completes, and its other approvals still pending are withdrawn. A branch rejection is never a failure of the whole plan.
5. **Decisions.** Deciding a tool step's approval before its step started resumes the plan at once, as the runtime of the person it runs for. One the gate asked for on a step already running (its policy changed after planning) resumes that step like any other tool approval; a rejection there fails that step, as any tool call refused by the gate.
6. **Results.** The step's agent answers first, then its tool nodes run with the plan's input. A tool node completes only once the gate checked its output against the tool's output schema; the step's verification records that as `tool_output_valid` for each tool node. Passing a tool's output to later steps is a separate block.
7. **Credits.** Tools carry no price, so a tool call charges nothing. The step's AI call is reserved, settled and released through the Credit Core as before; without credits it does not run, and its tools never run after it.
8. **Where a step is.** The plan screen and the list of every agent's work read a step's approvals with `stepApprovalEntriesOf`/`stepApprovalOf`: waiting, awaiting approval, or declined with its reason. The sweep leaves such a step alone and advances its plan, so an approval nobody decided expires.

## Evals

No prompt, model context, routing, model or agent answer changes, so no run is needed and V3 stays the baseline.

## Consequences

- `PlanStep.input` and `PlanStepApproval.performedBy` are optional; plans written before have neither and read as before.
- Workflows reuse the proposal schema, so a workflow may carry tool steps with their input; the editor does not offer them yet.
- Tests: `packages/planning` (input rules, a running tool step, its approval, all of a step's approvals, a declined branch), `packages/execution` (attaching), `packages/agents` (the tool node's input and verification), `apps/api/src/plans.test.ts` (approve and reject over HTTP, in memory and Firestore).
