import { actorOf, type AuditActor, type AuditService } from '@melonoffice/audit';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { createHash, randomUUID } from 'node:crypto';
import {
  checkEventCatalogue,
  checkEventData,
  EVENT_CATALOGUE,
  type EventDefinition,
} from './catalogue.js';
import { EventError, type DomainEvent, type EventDraft } from './model.js';
import type { EventOutbox, OutboxRecord } from './outbox.js';

/**
 * The event bus (ADR-0066, EV-2 ADR-0067):
 *
 *   producer → publish → outbox (stored) → queue (the runtime's Cloud Tasks queue)
 *            → worker `deliver` → subscribers → outbox (settled) → logs / audit
 *
 * Subscribers are code, registered when the bus is built, never at runtime or from data.
 * Delivery is at least once, and each subscriber handles an event at most once per success: a
 * delivery takes a lease on the event, runs only the subscribers that have not handled it yet and
 * records who did. A failed delivery is answered so the queue retries it; on the queue's last
 * attempt the event is set aside as dead, audited, and never dropped silently.
 *
 * An event is a fact. Reacting to it is each subscriber's own work, through its own service and
 * permissions; nothing here runs an action, calls a model or sends anything.
 */

export interface EventContext {
  /** Delivery of this event, from 1. */
  readonly attempt: number;
}

export interface EventSubscriber {
  /** A stable code: the outbox remembers which subscribers already handled an event. */
  readonly id: string;
  /** The catalogue types it reacts to. */
  readonly types: readonly string[];
  /**
   * Handles one event of one organization. It may run again for the same event if a delivery
   * ends between its work and the record of it, so it dedupes on `event.id`.
   */
  handle(event: DomainEvent, context: EventContext): Promise<void>;
}

/** What the queue carries: which event of which organization, nothing else. */
export interface EventDeliveryRef {
  readonly organizationId: OrganizationId;
  readonly eventId: string;
}

/** Hands a stored event to the queue that calls the worker's delivery route. */
export interface EventQueue {
  enqueue(ref: EventDeliveryRef): Promise<void>;
}

export type DeliveryResult =
  | { readonly kind: 'delivered'; readonly subscribers: number }
  | { readonly kind: 'already_delivered' }
  /** Dead before: the queue must not retry it. */
  | { readonly kind: 'already_dead' }
  | { readonly kind: 'not_found' }
  /** Another delivery holds it: retry later. */
  | { readonly kind: 'busy' }
  /** A subscriber failed: retry later. */
  | { readonly kind: 'retry'; readonly subscriber: string; readonly code: string }
  /** A subscriber failed on the last attempt: set aside. */
  | { readonly kind: 'dead'; readonly subscriber: string; readonly code: string };

export interface EventBus {
  /** Publishes what a person or GIA caused, in their organization. */
  publish(tenant: TenantContext, drafts: readonly EventDraft[]): Promise<readonly DomainEvent[]>;
  /**
   * Publishes what the runtime did for a member (a follow-up's time came, an agent task ended),
   * recorded as the runtime for that member. Server code only: the caller has verified that the
   * organization and the member are the record's own.
   */
  publishRuntime(
    organizationId: OrganizationId,
    initiatedBy: UserId,
    drafts: readonly EventDraft[],
  ): Promise<readonly DomainEvent[]>;
  /**
   * Publishes what a verified system source caused (a signed webhook), for the organization it
   * was verified to belong to, as no person. Server code only.
   */
  publishSystem(
    organizationId: OrganizationId,
    drafts: readonly EventDraft[],
  ): Promise<readonly DomainEvent[]>;
  /**
   * Delivers one queued event (the worker's route). `retryCount` is the queue's count of earlier
   * deliveries of this task.
   */
  deliver(ref: EventDeliveryRef, options: { readonly retryCount: number }): Promise<DeliveryResult>;
  /** The subscribers of a type, in registration order. */
  subscribersOf(type: string): readonly string[];
}

export interface EventBusOptions {
  readonly outbox: EventOutbox;
  /** Absent: events are stored as `pending` and not delivered (logged). */
  readonly queue?: EventQueue;
  readonly subscribers?: readonly EventSubscriber[];
  readonly catalogue?: readonly EventDefinition[];
  /** The queue's deliveries of one task; the last failed one sets the event aside. */
  readonly maxAttempts?: number;
  /** How long one delivery holds the event: at least the queue's dispatch deadline. */
  readonly leaseMs?: number;
  /** Records dead events (`event.dead_lettered`) in the audit trail. */
  readonly audit?: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

export const EVENT_LIMITS = Object.freeze({
  draftsPerPublish: 50,
  /** The runtime queue's `max_attempts` in Terraform (ADR-0032). */
  maxAttempts: 10,
  leaseMs: 60_000,
});

const SUBSCRIBER = /^[a-z][a-z_.]{0,63}$/;
const CORRELATION = /^[A-Za-z0-9_-]{1,100}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_:.-]{1,200}$/;
const ERROR_CODE = /^[a-z][a-z_]{0,63}$/;
const EVENT_ID = /^evt_[0-9a-f]{32}$/;

/** The failure as a code, never its message (which may hold content). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : 'subscriber_failed';
};

/** The same organization, type and key always give the same id. */
export const eventIdFor = (organizationId: OrganizationId, type: string, key: string): string =>
  `evt_${createHash('sha256').update(`${organizationId}\n${type}\n${key}`).digest('hex').slice(0, 32)}`;

export const isEventId = (value: unknown): value is string =>
  typeof value === 'string' && EVENT_ID.test(value);

export function createEventBus(options: EventBusOptions): EventBus {
  const { outbox, queue, logger, audit } = options;
  const now = options.now ?? (() => new Date());
  const maxAttempts = options.maxAttempts ?? EVENT_LIMITS.maxAttempts;
  const leaseMs = options.leaseMs ?? EVENT_LIMITS.leaseMs;
  const catalogue = new Map(
    checkEventCatalogue(options.catalogue ?? EVENT_CATALOGUE).map((d) => [d.type, d]),
  );

  const byType = new Map<string, EventSubscriber[]>();
  const ids = new Set<string>();
  for (const subscriber of options.subscribers ?? []) {
    if (!SUBSCRIBER.test(subscriber.id) || ids.has(subscriber.id)) {
      throw new EventError('subscriber_invalid', subscriber.id);
    }
    ids.add(subscriber.id);
    if (subscriber.types.length === 0) throw new EventError('subscriber_invalid', subscriber.id);
    for (const type of new Set(subscriber.types)) {
      if (!catalogue.has(type)) throw new EventError('event_type_unknown', type);
      byType.set(type, [...(byType.get(type) ?? []), subscriber]);
    }
  }

  function build(
    organizationId: OrganizationId,
    actor: AuditActor,
    draft: EventDraft,
  ): DomainEvent {
    const definition = catalogue.get(draft.type);
    if (definition === undefined) throw new EventError('event_type_unknown', draft.type);
    const data = checkEventData(definition, draft.subject, draft.data ?? {});
    if (draft.correlationId !== undefined && !CORRELATION.test(draft.correlationId)) {
      throw new EventError('invalid_event', 'correlationId');
    }
    if (draft.idempotencyKey !== undefined && !IDEMPOTENCY.test(draft.idempotencyKey)) {
      throw new EventError('invalid_event', 'idempotencyKey');
    }
    const at = draft.occurredAt ?? now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new EventError('invalid_event', 'occurredAt');
    }
    return Object.freeze({
      id:
        draft.idempotencyKey === undefined
          ? `evt_${randomUUID().replace(/-/g, '')}`
          : eventIdFor(organizationId, definition.type, draft.idempotencyKey),
      type: definition.type,
      version: definition.version,
      organizationId,
      occurredAt: at.toISOString(),
      actor,
      subject: Object.freeze({ type: draft.subject.type, id: draft.subject.id }),
      data,
      correlationId: draft.correlationId ?? null,
      source: definition.source,
    });
  }

  const logged = (event: DomainEvent) => ({
    eventId: event.id,
    type: event.type,
    organizationId: event.organizationId,
    source: event.source,
    ...(event.correlationId === null ? {} : { correlationId: event.correlationId }),
  });

  /** Hands the stored events to the queue; those already queued are left alone. */
  async function enqueue(records: readonly OutboxRecord[]): Promise<void> {
    for (const record of records) {
      if (record.status !== 'pending') continue;
      if (queue === undefined) {
        logger?.warn('events.not_queued', { ...logged(record.event), reason: 'no_queue' });
        continue;
      }
      const { organizationId, id } = record.event;
      try {
        await queue.enqueue({ organizationId, eventId: id });
      } catch {
        logger?.error('events.queue_failed', logged(record.event));
        // Stored, not queued: the producer retries with the same key and it is queued then.
        throw new EventError('queue_unavailable');
      }
      await outbox.markQueued(organizationId, id, now().toISOString());
      logger?.info('events.queued', logged(record.event));
    }
  }

  async function append(
    organizationId: OrganizationId,
    actor: AuditActor,
    drafts: readonly EventDraft[],
  ): Promise<readonly DomainEvent[]> {
    if (drafts.length > EVENT_LIMITS.draftsPerPublish) {
      throw new EventError('invalid_event', 'drafts');
    }
    // All or nothing: one bad draft publishes none of them.
    const events = drafts.map((d) => build(organizationId, actor, d));
    const records = await outbox.append(events, now().toISOString());
    for (const record of records) {
      logger?.info('events.published', { ...logged(record.event), status: record.status });
    }
    await enqueue(records);
    return Object.freeze(records.map((r) => r.event));
  }

  async function deadLetter(event: DomainEvent, code: string): Promise<void> {
    logger?.error('events.dead', { ...logged(event), error: code });
    if (audit === undefined) return;
    try {
      await audit.record({
        action: 'event.dead_lettered',
        result: 'failure',
        actor: event.actor,
        organizationId: event.organizationId,
        target: { type: 'event', id: event.id },
        reason: code,
        source: 'api',
      });
    } catch {
      // The outbox keeps it as dead either way; the log says the audit could not.
      logger?.error('events.dead_audit_failed', logged(event));
    }
  }

  async function deliver(
    ref: EventDeliveryRef,
    deliveryOptions: { readonly retryCount: number },
  ): Promise<DeliveryResult> {
    if (!isEventId(ref.eventId)) return { kind: 'not_found' };
    const leaseId = randomUUID();
    const begun = await outbox.begin(ref.organizationId, ref.eventId, {
      leaseId,
      now: now().getTime(),
      leaseMs,
    });
    if (begun.kind === 'not_found') {
      logger?.warn('events.delivery_not_found', { eventId: ref.eventId });
      return begun;
    }
    if (begun.kind === 'busy') return begun;
    if (begun.kind === 'settled') {
      return begun.record.status === 'dead'
        ? { kind: 'already_dead' }
        : { kind: 'already_delivered' };
    }
    const { record } = begun;
    const { event } = record;
    // The store checked it; a subscriber still never sees another organization's event.
    if (event.organizationId !== ref.organizationId) return { kind: 'not_found' };
    const attempt = Math.max(record.attempts, deliveryOptions.retryCount + 1);
    logger?.info('events.delivery_started', { ...logged(event), attempt });
    const done = new Set(record.deliveredTo);
    let failure: { subscriber: string; code: string } | null = null;
    const subscribers = byType.get(event.type) ?? [];
    for (const subscriber of subscribers) {
      if (done.has(subscriber.id)) continue;
      try {
        await subscriber.handle(event, { attempt });
        done.add(subscriber.id);
      } catch (error) {
        failure = { subscriber: subscriber.id, code: codeOf(error) };
        // One subscriber's failure never holds back the others; only it is retried.
        logger?.warn('events.delivery_failed', { ...logged(event), attempt, ...failure });
      }
    }
    const status =
      failure === null ? 'delivered' : attempt >= maxAttempts ? 'dead' : ('queued' as const);
    const settled = await outbox.settle(event.organizationId, event.id, leaseId, {
      deliveredTo: [...done],
      status,
      lastError: failure ?? record.lastError,
      at: now().toISOString(),
    });
    // The lease ran out and another delivery took it: that one records the result.
    if (!settled) {
      logger?.warn('events.lease_lost', { ...logged(event), attempt });
      return { kind: 'busy' };
    }
    if (failure === null) {
      logger?.info('events.delivery_completed', {
        ...logged(event),
        attempt,
        subscribers: subscribers.length,
      });
      return { kind: 'delivered', subscribers: subscribers.length };
    }
    if (status === 'dead') {
      await deadLetter(event, failure.code);
      return { kind: 'dead', ...failure };
    }
    logger?.info('events.retry', { ...logged(event), attempt, ...failure });
    return { kind: 'retry', ...failure };
  }

  return Object.freeze({
    async publish(tenant: TenantContext, drafts: readonly EventDraft[]) {
      if (!isResolvedTenant(tenant)) throw new EventError('unresolved_tenant');
      return append(tenant.organizationId, actorOf(tenant), drafts);
    },

    async publishRuntime(
      organizationId: OrganizationId,
      initiatedBy: UserId,
      drafts: readonly EventDraft[],
    ) {
      if (typeof organizationId !== 'string' || organizationId === '') {
        throw new EventError('invalid_event', 'organizationId');
      }
      if (typeof initiatedBy !== 'string' || initiatedBy === '') {
        throw new EventError('invalid_event', 'initiatedBy');
      }
      return append(organizationId, actorOf({ actor: 'runtime', userId: initiatedBy }), drafts);
    },

    async publishSystem(organizationId: OrganizationId, drafts: readonly EventDraft[]) {
      if (typeof organizationId !== 'string' || organizationId === '') {
        throw new EventError('invalid_event', 'organizationId');
      }
      return append(organizationId, { type: 'anonymous' }, drafts);
    },

    deliver,

    subscribersOf: (type: string) => Object.freeze((byType.get(type) ?? []).map((s) => s.id)),
  });
}
