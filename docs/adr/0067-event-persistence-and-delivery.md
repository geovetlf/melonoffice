# ADR-0067: Event persistence and delivery (MelonMotor EV-2)

- Status: Proposed
- Date: 2026-09-29
- Builds on:
  - ADR-0066 (domain events, catalogue, outbox port);
  - ADR-0032 (worker and Cloud Tasks queue);
  - ADR-0058 (follow-ups on the same queue);
  - ADR-0020 (audit).
- Replaces: ADR-0066 section 4 (a dispatcher polling the outbox).
- Terraform: none. It reuses the existing queue, worker, invoker and Firestore access, and it reads events by id only, so it needs no index.

## Context

EV-1 defined events and an in-memory outbox with a polling dispatcher, and nothing was wired. The runtime already has a worker and a Cloud Tasks queue that delivers jobs, follow-ups and forecasts with retries. A second queue, a polling loop or another job system would duplicate it.

## Decision

### 1. Flow

```
producer ─ publish ─▶ outbox (Firestore domainEvents/{eventId}, status pending)
                     ─▶ queue (the runtime's Cloud Tasks queue; body {organizationId, eventId})
                     ─▶ outbox (status queued)
queue ─▶ worker POST /internal/events/run (same invoker check as jobs)
      ─▶ bus.deliver: lease the event ─▶ run each subscriber not yet done ─▶ settle
      ─▶ 200 (delivered, already delivered, dead, not found) or 503 (retry, busy)
```

### 2. What is stored

`domainEvents/{eventId}` holds:

- the event: id, type, version, organizationId, occurredAt, actor, subject, data, correlationId, and `source`, which the catalogue gives for each type;
- its delivery record: status (`pending`, `queued`, `delivered`, `dead`), attempts, `deliveredTo`, leaseId, leaseUntil, lastError (`{subscriber, code}`), createdAt, queuedAt and settledAt.

`organizationId` and `type` are also top-level fields. Every read and write names the organization, and a document of another organization is "not found".

### 3. Idempotency

- **The producer.** A draft may carry an `idempotencyKey`. The event id is then `evt_` plus the first 32 hex characters of sha256(organization, type, key). A retried publish finds the stored event, and only a `pending` one is queued again. `follow_up.due` uses `{followUpId}:{schedule}`.
- **The queue.** Delivery is at least once. A delivery takes a lease on the event in a transaction and settles it only while that lease is still its own. Two deliveries of one event never run it at the same time. A delivered or dead event is not run again.
- **The subscriber.** `deliveredTo` means a retry runs only the subscribers that have not succeeded. A subscriber may still see an event twice if a delivery ends between its work and the record of it, so subscribers dedupe on `event.id`. The trigger router passes `{eventId}:{triggerId}` to the engine it starts.

### 4. Retries and dead letters

- A failing subscriber gets 503, so the queue retries with its own back-off (10 s to 600 s).
- The attempt number is the larger of the queue's retry count plus 1 and the record's attempts.
- On attempt 10, the queue's `max_attempts`, a failure sets the event aside as `dead`, records `event.dead_lettered` in the audit trail (reason = the error code), and answers 200.
- A dead event is never dropped and never retried by itself.

### 5. Observability

Existing structured logs:

- `events.published`
- `events.queued`
- `events.queue_failed`
- `events.not_queued`
- `events.delivery_started`
- `events.delivery_completed`
- `events.delivery_failed`
- `events.retry`
- `events.dead`
- `events.lease_lost`
- `events.delivery_not_found`

Each has the eventId, type, organizationId, source, correlationId and attempt, and never the data.

### 6. The first real event: `follow_up.due`

It is chosen because:

- it already exists as a fact, since the follow-up scheduler marks it due;
- its producer is already in the worker, on the same queue;
- it is idempotent by construction;
- it carries only ids: contactId, opportunityId, and assignedTo, which was added to the catalogue;
- GIA, agents, workflows, the Decision Engine and Company Brain can all react to "this follow-up's time came".

The worker's follow-up handler publishes it as the runtime for the member who scheduled it (`publishRuntime`), when the service returns `due` or `already_due`.

If publishing fails, the handler answers 503. The follow-up is already due, and the retried task finds it `already_due` and publishes the same event. On the queue's last attempt the task ends, and the loss is logged as `follow-up event lost`.

### 7. Consumers: an interface, not autonomy

- `createTriggerRouter` is the one EVENT → TRIGGER → WORKFLOW or AGENT subscriber.
  - The organization's triggers say what an event type starts.
  - The engine that owns the target starts it (a `TriggerStarter` for each kind), with its own permissions, approvals and audit.
  - Foreign or mismatched triggers are refused, and a kind with no starter is skipped.
- A Company Brain consumer is a subscriber that changes knowledge through the Brain service, with provenance `event:{id}`. The Event System stores no knowledge.
- **No subscriber is registered in production in EV-2.**
  - There is no trigger store yet.
  - No reaction to `follow_up.due` has been approved as a product decision.
  - Inventing one would be autonomy nobody asked for.
  - Today an event is stored, queued, delivered and recorded as `delivered`, and it starts nothing.

### 8. Security

- The task body carries `{organizationId, eventId}` only, and the route requires exactly those keys.
- The route has the same invoker OIDC check as jobs.
- The worker re-reads everything from the outbox.
- A delivery for another organization's event is `not_found` and runs no subscriber.
- `publishRuntime` records the runtime acting for a member, never the member.
- `publishSystem` records no person.

## Consequences

- Terraform: no change.
  - The queue `execution_jobs` and `worker_enqueuer` / `worker_acts_as_job_dispatch` already let the worker queue tasks to itself.
  - The worker already has `roles/datastore.user`.
  - Reads are by document id.
  - Expected DEV plan: "No changes".
- Known limits:
  - The lease uses the worker's clock, not a server clock like the job lease (ADR-0030). The lease equals the queue's dispatch deadline.
  - If the queue's last attempt finds the event busy (a delivery still holds it) and that delivery then crashes, the event stays `queued` with no task. There is no sweeper yet, the same accepted limit as X5 delegation.
  - Only the audit trail and the Firestore record show dead events. There is no screen yet.
- Next steps, each needing its own approval:
  - a trigger store and the first approved reaction, for example a workflow trigger on `follow_up.due`;
  - more producers (`opportunity.stage_changed`, `conversation.message_received`), writing the event in the same transaction as their change;
  - the runtime's `event` node.
