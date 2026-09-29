# ADR-0075: Plan conditions decided by the Decision Engine (WF-4)

- Status: Proposed (Geovet's continuous execution mode, 2026-09-29; roadmap block WF-4)
- Date: 2026-09-29
- Builds on:
  - [ADR-0028](0028-planner-delegation-and-workflows.md) (plans, proposals, workflows);
  - [ADR-0065](0065-decision-engine.md) (the Decision Engine and its workflow contract, `workflowStepOf`);
  - [ADR-0070](0070-approved-plans-run.md) (the plan conductor).
- Amends ADR-0070: `condition` steps with a decision are no longer refused before approval.
- Terraform: none. No new route, permission, collection, queue or index. One audit action.

## Context

WF-1 runs approved plans, but only their specialist steps. A plan with any other step is refused whole before approval (`plan_not_runnable`). ADR-0065 already defined how a workflow's condition node should use a decision: it names a decision type and the outcomes that let the workflow go on, and reads only the outcome and whether an approval is needed (`workflowStepOf`). Nothing evaluated it.

## Decision

### 1. A condition step names a decision

A `condition` step may carry `decision`, instead of the older `condition` (how another step ended):

```json
{
  "id": "gate",
  "kind": "condition",
  "label": "Can the agent offer a discount?",
  "dependsOn": ["research"],
  "decision": {
    "decision": "action.policy_check",
    "continueOn": ["allowed"],
    "input": { "action": "opportunity.offer_discount", "proposer": "agent", "discountPercent": 10 }
  }
}
```

- The proposal schema checks it closed:
  - `decision` is a decision type (`a.b`);
  - `continueOn` holds 1 to 10 distinct codes;
  - `input` holds at most 10 keys, each a short string (100 characters at most), a number or a boolean.
- Authority keys in the input are refused as authority, and credentials anywhere as secrets, like the rest of a proposal.
- A condition step has exactly one of `condition` and `decision`. A decision condition waits on at least one step.
- Workflows get this for free: their steps go through the same schema.
- The input is part of the plan version, so the person approves it with the rest (digest-bound).

### 2. The runtime decides it, through the Decision Engine

When every step a condition depends on has completed, the plan conductor's `advance` (runtime only) asks a `ConditionEvaluator`.

- In the worker, the evaluator is `planConditionEvaluator` over the same Decision Engine the API uses.
- The decision is made as the runtime of the person the plan runs for. Their membership, role and permissions apply, including `decision.evaluate`. It is audited as any decision (`decision.evaluated`).
- The result is read only through `workflowStepOf`:
  - `continue`: the steps after the condition may run;
  - `stop`: every step after it (and every step after those) is skipped, and the rest of the plan goes on;
  - `await_approval`: the plan stops with `condition_needs_approval`. A plan cannot wait for an approval yet, and an approval is never skipped;
  - a decision the engine refuses (unknown type, invalid input, a permission the person lacks, a decider not set up) stops the plan with `condition_failed`. The recorded result carries the engine's code, for example `condition_permission_denied`.
- Without an evaluator, a condition fails with `condition_not_configured`. A plan never goes on undecided.
- An error that is not a decision (storage unavailable) leaves the condition undecided, to be decided on the next advance.

### 3. The result is recorded once, on the plan

`Plan.conditions` holds one result per decided condition: the step, the result, the decision's id, type, version and outcome, or the failure code, and when.

- It is written in the same transaction as its audit event, `plan.condition_evaluated`. That event records the step (`nodeId`), the result or failure (`reason`) and the decision (`reference`).
- A second advance that finds a result reads it back and never decides again.
- Two advances racing may both ask the engine. Only the first result is kept, and both decisions stay on the audit trail.
- Stored plans are checked on read. A malformed result is refused, never repaired.

### 4. The planning execution shows it

- A decided condition's node completes, with the decision as its output, whether it continued or stopped.
- A skipped step's node is `skipped`.
- The planning execution's verification covers every completed node:
  - specialist steps by their child (`step_execution_completed`);
  - conditions by their decision (`condition_decided`).
- A skipped step's child execution never starts. It stays `pending` and can no longer start once the plan ends, like the steps after a failed one in WF-1, because the runtime never cancels (ADR-0029).

### 5. Answers across a condition

A step after a condition reads the answers of the steps before that condition. The condition has no answer of its own. `answeringSteps` looks through conditions to the specialist steps behind them.

### 6. Which decisions a condition may use in the worker

`CONDITION_DECISION_TYPES` in the worker lists them. Today it is `action.policy_check`, with Company Brain read only for company policies.

- These are the decision types whose data the worker reads, and none calls a model, so a condition spends no credits.
- Any other type stops the plan (`condition_unknown_decision_type`) rather than deciding on data the worker does not read.
- The worker's engine carries out no action (`configured` is false). The policy check reports that as a constraint, never as a different answer.
- In a plan, the runtime is the one preparing, so `proposer` must be `agent`. GIA's proposer needs a person asking directly, so that branch stops.

## Security and tenancy

- The plan, its version and every decision are read in the tenant's organization. The runtime tenant is re-resolved from the person, so a person who left the organization or lost the permission stops the plan, never widens it.
- The input is fixed when the plan is made and approved. No model output, request body or earlier answer reaches a decision's input.
- Nothing is carried out. A decision says what may happen, the plan only goes on or skips a branch, and an approval stops the plan.

## Consequences

- Workflows and plans can branch on company policy, with every decision explained and audited.
- Plans with `tool`, `approval`, `verification` or `parallel` steps, or with the older `condition` form, are still refused whole before approval.

## Open

- Waiting on an approval inside a running plan (the approval node, ADR-0026), instead of stopping.
- More decision types in the worker (`commercial.priorities` and `forecast.signal`) once their read ports reach it.
- Inputs taken from earlier steps' answers: they would need a closed mapping, never free text.
- Withdrawing the never-started children of skipped or stopped steps.
- The web editor shows condition steps as they are. It has no dedicated form for them yet.
- What is still to validate in DEV: an approved plan with a condition, on real Firestore and the real worker. The tests cover it in memory and on the emulator.
