# Event System

MelonMotor's domain events (ADR-0066, ADR-0067) live in `packages/events`. An event is a fact with references only. Publishing one stores it and queues it, and the worker delivers it. It never runs anything by itself.

## Publish an event

1. Add the type to `EVENT_CATALOGUE` with:
   - its subject;
   - its `source`, the only part of MelonMotor that publishes it;
   - its fields: ids, codes, numbers, booleans and dates, never free text.
2. Publish from the code that caused it:
   - `publish(tenant, drafts)` for a person or GIA;
   - `publishRuntime(organizationId, initiatedBy, drafts)` for the runtime acting for a member;
   - `publishSystem(organizationId, drafts)` for a verified system source.
3. If the producer can retry, set `idempotencyKey` so a retry stores and delivers the event once.
4. If publishing throws `queue_unavailable`, the event is stored but not queued. Answer so that your own task is retried, with the same key.

## React to an event

Register an `EventSubscriber` in the worker's bus (`apps/worker/src/server.ts`) with:

- a stable `id`;
- the catalogue `types` it handles;
- a `handle` that works through the owning service, as the runtime, and dedupes on `event.id`.

To start a workflow or an agent task, don't write a new subscriber. Give the trigger router a `TriggerStarter` for that kind, backed by the engine that owns it.

## Where to look

| Question                           | Answer                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Was it stored?                     | `domainEvents/{eventId}`                                                        |
| Was it queued, delivered, retried? | `status`, `attempts`, `deliveredTo`, `lastError` on the record; logs `events.*` |
| Did it fail for good?              | status `dead`; audit `event.dead_lettered`                                      |
