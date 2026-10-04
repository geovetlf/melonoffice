# ADR-0157: a plan's trace

- Status: Proposed
- Date: 2026-10-04
- Builds on: [ADR-0117](0117-agent-memory-handoffs-notifications.md) (an agent task's trace), [ADR-0153](0153-failed-plan-steps-run-again.md) (a step's runs), [ADR-0155](0155-plan-step-states-and-failures.md) (where a plan failed)
- Authorization: Geovet, 2026-10-04 11:41Z, "MODO AVANCE MÁXIMO DEL MOTOR", priority 10: observability and the execution audit trail. It covers the plan, step, tool, state, times, result, error, approval and credits, and never logs secrets.
- Terraform: none. Firestore: no index, nothing written. Prompts: none.

## Context

An agent task has a trace (ADR-0117) covering its steps, tools, approvals, models, credits and audit trail. A plan had only its steps' current state (`GET plans/:id/steps`). Several questions needed reading executions, outputs and audit events one by one:

- which runs a step had and why each ended;
- what each step's model calls cost;
- which approvals were asked;
- when a wait ran;
- why the plan stopped.

## Decision

1. **One read.** `GET /v1/organizations/:organizationId/plans/:planId/trace`, with `plan.read`, reads the plan and its children as the person, through the same plan and execution services as its steps. Another organization's plan, or one the person may not read, refuses as for the plan itself.
2. **What it says.**
   - **Per step:** kind, label and dependencies, with the step's state by the plan engine's own rule. Its specialist or tool. Every run of it, first to last. Each run has its child, status, own failure code, times and duration, nodes and credits. The nodes use the agent task trace's shape: type, status, tool, approval, error, model, credits and times. Also its approvals (asked, declined and why), its wait, its decision's result, and its credits.
   - **For the plan:** where it stopped (its code, the step, and that step's own code). Credits in total, by step and by model. The last 50 audit events of the plan and of every child it had, with the step (`nodeId`), reason and reference.
3. **Nothing written, nothing private.** It reads and changes nothing. It holds codes, ids, times and numbers only. Answers, tool results, prompts, inputs and secrets are never in it.
4. **No second trace.** It reuses the agent task trace's pieces: its node shape, model and credit reading, durations and history limit.

## Evals

No prompt, model context, routing, model or agent behaviour changes, so no run is needed and V3 stays the baseline.

## Consequences

- One read per child for its outputs and audit history: a plan has at most a few dozen steps, each with at most 5 runs.
- Tests:
  - `packages/agents`: runs, where it stopped, credits, nothing private;
  - `apps/api/src/plans.test.ts`: over HTTP, with its state, runs and audit trail, in memory and Firestore.
