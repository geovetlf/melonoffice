# ADR-0101: Harness block 3: multi-step plans, limits, loops and hand-off

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0099](0099-melon-agent-harness.md) (Harness block 1), [ADR-0100](0100-harness-provider-preference-and-task-budget.md) (block 2), [ADR-0028](0028-planner-delegation-and-workflows.md) (planner), [ADR-0029](0029-runtime-guards.md) (runtime actor, cancel), [ADR-0043](0043-conversation-agent.md) (conversation hand-off), [ADR-0070](0070-approved-plans-run.md) (approved plans run)
- Terraform: none. Firestore: none (plans and executions are the existing collections). No new permission.

## Context

Geovet's Harness brief (§10-12, §19-22) asks for multi-step tasks, several agents per task, a cap on steps, depth, time and cost, loop detection, and a hand-off to a person. Blocks 1 and 2 marked complex planning and action tasks `multi_step` but still ran them as one agent task.

Everything needed to run a plan already exists: the planner (a request, then the AI Gateway, then a proposal, then the validation pipeline, then a stored plan), person-only approval bound to the version's digest, delegation to one child execution per step, and the conductor that runs them. What was missing:

- nothing sent a multi-step task to that planner;
- nothing capped a plan below the planner's own 50 steps;
- nothing noticed a plan that repeats itself;
- nothing stopped an agent's own work from starting another task;
- "this needs a person" had no single shape.

## Decision

### 1. Multi-step tasks go to the existing planner, and wait for a person

When the task is `multi_step`, a planner is configured and the person holds `plan.create`, `start` does not create an agent task. It:

1. creates a planning execution (mode `plan`) owned by the routed agent;
2. calls `Planner.plan`, which is the only path from a request to a plan;
3. returns verdict `needs_authorization` (reason `plan_awaits_approval`), with the plan's id, status and step count.

The plan validator the Harness uses has its own risk policy, `HARNESS_RISK_POLICY`: every plan needs a person's approval, whatever its risk, and critical work is refused. A model's plan runs nothing until a person has seen it. Approving it through the existing plan route runs it, one child execution per step, through the conductor (ADR-0070).

- The same idempotency key is the same planning execution and the same plan: the planner is not asked twice. The same key with another request is `idempotency_conflict`.
- The planning call uses sensitivity `confidential`, like agent tasks, so no provider limited to public data takes it.
- A person without `plan.create` (today everyone but the owner) keeps block 1's behaviour: one agent task, reason `multi_step_runs_as_single_task`. So does a server without a planner or an AI Gateway.

### 2. Limits, and loops

`HarnessLimits` holds `maxSteps` (default 8), `maxAgents` (default 4) and `maxDepth` (1). These are safety bounds, not prices, and they are configurable.

A plan is checked when the planner returns it:

- `too_many_steps`;
- `too_many_agents`;
- `loop_detected`: the same agent asked the same thing twice (labels compared with accents and case folded).

Cycles in `dependsOn` are already refused by the validator.

A plan that breaks a limit is cancelled before anyone can approve it, together with its planning execution, and the task goes to a person (`policy`).

Time and cost are bounded by what already exists, not by a new counter:

- every job has its lease and timeout (X6b);
- every model call has its deadline and its credit cap (ADR-0100);
- a person can cancel an execution and its plan's children at any time (X6a).

### 3. Depth

A task may be started by a person, or by GIA for a person. The runtime acts for an agent's own work; a task started as the runtime is refused with `depth_exceeded` before credits are read or anything is routed. So no chain of agents asking agents can form. The planner's plans are one level deep by construction: steps are delegated as child executions, and a child cannot plan.

### 4. HANDOFF_TO_HUMAN

`HandoffToHuman { type: 'HANDOFF_TO_HUMAN', reason, code }` is the one shape for "this now needs a person". The possible reasons are:

- `person_requested`: the person asked for a person;
- `missing_information`: the agent said what it needs and does not have;
- `authorization_required`: over budget, out of credits, or waiting for an approval;
- `repeated_error`: failed after the runtime's own retries, or nobody knows whether it ran;
- `plan_failed`: the planner could not make a plan, or its plan was refused;
- `policy`: a plan broke a limit or looped.

It appears in two places:

- the Harness's strategy, when the verdict is `handoff_to_human`;
- every agent task's view (`GET .../agent-tasks/:id`), derived from its status, failure code and the answer's missing items. A task a person cancelled, or whose approval a person rejected, stays with that person's decision, so it has no hand-off.

Only the decision and its reason are built here. Who the person is and how they are told stay with the surface: the inbox's hand-off for conversations (ADR-0043), the task's screen for agent tasks. No queue, assignment or notification system is added, and no screen changes.

### 5. API

- `POST .../harness/tasks` answers `plan` as an object (`mode`, and `id`, `status`, `steps` once planned) and `handoff`. It answers `202` when something was made: a started task or a plan waiting for approval.
- The agent task view adds `handoff`. The field is additive.

## Consequences

- A complex task now becomes a plan a person approves, instead of one long model call. Each step runs as its own agent's execution with its own verification, and the whole plan is capped and loop-checked before anyone can approve it.
- "Needs a person" has one shape across the Harness and agent tasks, ready for GIA and the screens to use.
- In DEV the planner still depends on the one approved model (Gemini 2.5 Flash-Lite). How well it plans is not measured yet.
- Block 4: the CRM as a context source for agent work, `agent.execution.*` events in the existing catalogue, and usage attribution per task.
