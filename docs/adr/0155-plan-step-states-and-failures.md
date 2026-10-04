# ADR-0155: one state for waiting on a person, and where a plan failed

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0070](0070-approved-plans-run.md) (running plans), [ADR-0146](0146-step-approvals-inside-running-plans.md) (a step that asks a person), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps), [ADR-0153](0153-failed-plan-steps-run-again.md) (retries)
- Authorization: Geovet, 2026-10-04 11:41Z, "MODO AVANCE MÁXIMO DEL MOTOR", priorities 4 and 10: consistent states with no parallel ones (`WAITING_APPROVAL` among them), and an execution audit trail that says which step, which result and which error.
- Terraform: none. Firestore: none. Prompts: none.

## Context

A plan step can wait for a person in two ways:

- before it starts, for its own or its tools' approvals (ADR-0146, ADR-0151);
- after it started, when the Tool Gate asks about one of its tool calls (its policy changed after planning).

The first showed as `awaiting_approval`. The second showed as `running`, with no link to the approval, and the list of every agent's work called the plan's approval "pending" for it.

When a step failed, the plan stopped with `step_failed`. Nothing on the plan's graph or in the audit event said which step it was or why it failed: the step's node was left `pending` and then cancelled with the plan.

## Decision

1. **One state.** A step whose started child waits for a person is `awaiting_approval`, the same state as a step that waits before it starts. Its read shows the approval its tool call waits on, so Automations links to the inbox for it. The list of every agent's work no longer calls the plan's own approval pending for it. The conductor never withdraws such an approval when the plan stops, because it is the gate's, on the child.
2. **The graph follows.** A started step's node is `running` on the planning execution whether its child runs, waits for a person or failed. A step that stops the plan fails its node with its child's own code (for example `unavailable`). The planning execution's failure keeps its code (`step_failed`) and now points at the failed child (`ref`).
3. **The audit trail says where.** `plan.state_changed` to `failed` names the step (`nodeId`) and its child's own code (`reference`), next to the plan's reason (`reason`).

## Evals

No prompt, model context, routing, model or agent behaviour changes, so no run is needed and V3 stays the baseline.

## Consequences

Tests:

- `packages/planning`: the states, the failed node, the failure's reference and the audit event.
