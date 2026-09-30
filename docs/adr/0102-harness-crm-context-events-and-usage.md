# ADR-0102: Harness block 4: CRM context, execution events and usage by plan

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0099](0099-melon-agent-harness.md), [ADR-0101](0101-harness-multi-step-limits-and-handoff.md) (Harness blocks 1 and 3), [ADR-0057](0057-gia-commercial-intelligence.md) (commercial insights), [ADR-0066](0066-event-system.md) and [ADR-0067](0067-event-persistence-and-delivery.md) (events), [ADR-0073](0073-ai-usage-layer.md) and [ADR-0074](0074-ai-usage-ledger.md) (AI usage)
- Terraform: none. Firestore: none. No new permission. No subscriber.

## Context

The Harness brief's last block (§23-26) asks for three things:

- the CRM as part of an agent's context;
- the task's life on the existing event bus;
- AI usage attributed to the task.

Block 1 already planned the CRM for tasks about customers, but no CRM source was set up, so nothing was read. The event catalogue had `agent_task.finished`, but nothing published it. Usage was attributed to each execution, but not to the plan that execution was a step of.

## Decision

### 1. The CRM as a context source

`createCrmContextSource` reads through the existing commercial insights (C4), as the person the task runs for.

It gives the agent counts and totals only:

- leads, customers and inactive contacts, and next actions;
- open, won and lost opportunities, open value and value won this month, and opportunities closing soon or quiet;
- open, overdue and today's follow-ups.

It gives no names, titles or records. An agent that needs a particular customer is given it by the task.

Each part is shown only when both of these are true:

- the agent's configuration lists that part's permission (`contact.read`, `opportunity.read`, `follow_up.read`);
- the person may read it, which the insights service checks again.

An agent with none of these permissions reads nothing. A read that fails says so; nothing stands in for it.

The worker reads it only when the Harness's context plan names the CRM, that is, a task about customers. Agent tasks and plan steps both read their context through the Harness's plan. Follow-ups are left out in the worker until its follow-up service can list them.

### 2. Events

The worker's end hook for agent tasks publishes, as the runtime for the person the task ran for:

- **`agent_task.finished`**: this event was already in the catalogue (ADR-0063). It carries `specialistId` and `outcome`.
- **`agent_execution.handoff`**: new. It carries `specialistId`, `reason` and `code`, and is published when the task now needs a person, by the same rule as the task view (ADR-0101).

Both events are keyed on the execution, so a repeated end hook stores each event once.

No subscriber is registered, so the events are stored and delivered, and they start nothing until a reaction is approved (ADR-0067). A failed publish never changes the task (the end hook is best effort).

The name is `agent_execution.*` rather than `agent.execution.*`, because catalogue types have exactly one dot.

### 3. Usage attributed to the plan

`AIUsageAttribution.parentExecutionId` is added. The AI Gateway sets it from the stored execution when a call is a plan step.

A multi-step task's AI usage is therefore its planning call (attributed to the planning execution) plus every step's call (attributed to the steps, with the planning execution as parent).

- The field is optional, so existing events are unchanged.
- The usage ledger validates it like the other ids.
- The daily totals and their dimensions are unchanged: no new dimension and no migration.

A single agent task was already attributed by `executionId`, agent, department and task type.

## Consequences

- An agent asked about customers now knows the business's commercial situation in numbers, within what both the agent and the person may read.
- The end of every agent task, and every task that needs a person, is on the event bus. A future notification or workflow trigger can react to it without a new producer.
- What a multi-step task cost can be totalled from the usage events.
- Not done here: a screen for hand-offs, and a subscriber that notifies someone. Both change the UX, which the brief keeps out.
