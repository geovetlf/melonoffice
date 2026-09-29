# ADR-0066: Event System (MelonMotor EV-1)

- Status: Proposed; section 4 (polling delivery) replaced by ADR-0067 (queued delivery)
- Date: 2026-09-29
- Builds on:
  - ADR-0020 (audit actors);
  - ADR-0030 and ADR-0032 (jobs on Cloud Tasks);
  - ADR-0031 (the `event` node is refused until defined);
  - ADR-0065 (Decision Engine).
- Does not change: any app, route, worker, collection, index or Terraform. This is a library with no producer or subscriber wired yet.

## Context

The six-engine audit of 2026-09-29 found that MelonMotor has no domain events. Every engine calls the next one directly:

- a webhook calls the integration engine;
- the follow-up scheduler queues its own job;
- the audit log is read back as activity.

As a result, workflows have no triggers, the runtime refuses the `event` node, and nothing can react to "a customer wrote" or "a sale changed stage" without the code that caused it calling every interested part. Of the six engines audited, the Event System was the least complete (0.5/5).

## Decision

A new package, `@melonoffice/events`.

### 1. A domain event is a fact with references only

`DomainEvent` has these fields:

- `id`: `evt_` followed by 32 hex characters;
- `type` and `version`;
- `organizationId`;
- `occurredAt`;
- `actor`: the audit's actor, which is a person (direct or via GIA), the runtime for a person, or anonymous for a verified system source;
- `subject`: `{type, id}`;
- `data`;
- `correlationId`.

The `data` holds only the fields its catalogue entry declares, each of one kind: id, code, number, boolean or date. There is no free text, so no message, name, amount or document ever travels in an event. A subscriber reads what it needs through the service that owns it.

### 2. A closed catalogue

`EVENT_CATALOGUE` is data, like the tool and skill catalogues. It starts with:

- `conversation.message_received`
- `follow_up.due`
- `opportunity.stage_changed`
- `knowledge.document_ingested`
- `agent_task.finished`
- `decision.approval_required`

An unknown type is refused (`event_type_unknown`), both when publishing and when subscribing.

### 3. Publishing goes through an outbox

- **`publish(tenant, drafts)`** needs a resolved tenant and takes the organization and actor from it, so a producer cannot publish for another organization.
- **`publishSystem(organizationId, drafts)`** is for a source already verified to belong to that organization, such as a signed webhook or a due timer. It is server code only.
- A publish is all or nothing and holds at most 50 events.
- Events go to an `EventOutbox` port. The in-memory outbox defines its behaviour, and a Firestore outbox that writes in the producer's own transaction is later work.

### 4. Delivery is at least once, and idempotent per subscriber

- `dispatch()` claims due events with a lease (60 s), delivers each one to the subscribers of its type in order, and settles it.
- The outbox remembers which subscribers already handled an event. A retry repeats only the subscribers that failed, after a back-off (30 s doubling, at most 1 h).
- After 5 rounds the event is set aside as `dead` and logged, never dropped.
- A failure is kept as `{subscriber, code}`, never its message.
- Subscribers are code, registered when the bus is built, each with a stable id. There are no runtime or data-defined subscriptions.

### 5. Events never act

Publishing or delivering an event runs nothing by itself. Reacting is each subscriber's own work through its own service, with its permissions, approvals and audit. An event never carries an order to pay, send or delete.

## Consequences

- Engines can now be decoupled: a producer states a fact once, and workflows, agents, GIA and reports can each react on their own.
- Nothing is wired yet. EV-2 will:
  - add a Firestore outbox, with its rules and index through Terraform (plan, then Geovet's apply);
  - have the worker dispatch on a schedule or after a publish;
  - add the first producer (`follow_up.due` or `conversation.message_received`) and the first subscriber;
  - later, give the runtime an `event` node and workflows their triggers, in their own ADR.
- Events are not the audit log. The audit records what was done and by whom, for accountability. Events let other parts react. A change may do both.
