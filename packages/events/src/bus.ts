import { actorOf, type AuditActor } from '@melonoffice/audit';
import type { OrganizationId } from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import {
  checkEventCatalogue,
  checkEventData,
  EVENT_CATALOGUE,
  type EventDefinition,
} from './catalogue.js';
import { EventError, type DomainEvent, type EventDraft } from './model.js';
import type { EventOutbox, OutboxRecord } from './outbox.js';

/**
 * The event bus (ADR-0066): producers publish domain events to the outbox; the dispatcher
 * delivers each one to the subscribers of its type. Subscribers are code, registered when the
 * bus is built, never at runtime or from data. Delivery is at least once and each subscriber
 * handles an event at most once per success: a failure retries only the subscribers that
 * failed, with a bounded back-off, and an event that keeps failing is set aside as dead, never
 * dropped silently.
 *
 * An event is a fact. Reacting to it is each subscriber's own work, through its own service and
 * permissions; nothing here runs an action, calls a model or sends anything.
 */

export interface EventContext {
  /** Delivery round of this event, from 1. */
  readonly attempt: number;
}

export interface EventSubscriber {
  /** A stable code: the outbox remembers which subscribers already handled an event. */
  readonly id: string;
  /** The catalogue types it reacts to. */
  readonly types: readonly string[];
  handle(event: DomainEvent, context: EventContext): Promise<void>;
}

export interface DispatchSummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
}

export interface EventBus {
  /** Publishes what a person, GIA or the runtime caused, in their organization. */
  publish(tenant: TenantContext, drafts: readonly EventDraft[]): Promise<readonly DomainEvent[]>;
  /**
   * Publishes what a verified system source caused (a signed webhook, a due timer), for the
   * organization it was verified to belong to. Server code only.
   */
  publishSystem(
    organizationId: OrganizationId,
    drafts: readonly EventDraft[],
  ): Promise<readonly DomainEvent[]>;
  /** Delivers due events once; the worker calls it on a schedule or after a publish. */
  dispatch(options?: { readonly limit?: number }): Promise<DispatchSummary>;
  /** The subscribers of a type, in registration order. */
  subscribersOf(type: string): readonly string[];
}

export interface EventBusOptions {
  readonly outbox: EventOutbox;
  readonly subscribers?: readonly EventSubscriber[];
  readonly catalogue?: readonly EventDefinition[];
  /** Delivery rounds before an event is set aside as dead. */
  readonly maxAttempts?: number;
  /** Wait before the next round after `attempts` rounds, in ms. */
  readonly backoffMs?: (attempts: number) => number;
  readonly leaseMs?: number;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

export const EVENT_LIMITS = Object.freeze({
  draftsPerPublish: 50,
  dispatchBatch: 100,
  maxAttempts: 5,
  leaseMs: 60_000,
});

const SUBSCRIBER = /^[a-z][a-z_.]{0,63}$/;
const CORRELATION = /^[A-Za-z0-9_-]{1,100}$/;
const ERROR_CODE = /^[a-z][a-z_]{0,63}$/;

const defaultBackoff = (attempts: number) => Math.min(30_000 * 2 ** (attempts - 1), 3_600_000);

/** The failure as a code, never its message (which may hold content). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : 'subscriber_failed';
};

export function createEventBus(options: EventBusOptions): EventBus {
  const { outbox, logger } = options;
  const now = options.now ?? (() => new Date());
  const maxAttempts = options.maxAttempts ?? EVENT_LIMITS.maxAttempts;
  const backoffMs = options.backoffMs ?? defaultBackoff;
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
    const at = draft.occurredAt ?? now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new EventError('invalid_event', 'occurredAt');
    }
    return Object.freeze({
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      type: definition.type,
      version: definition.version,
      organizationId,
      occurredAt: at.toISOString(),
      actor,
      subject: Object.freeze({ type: draft.subject.type, id: draft.subject.id }),
      data,
      correlationId: draft.correlationId ?? null,
    });
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
    await outbox.append(events);
    return Object.freeze(events);
  }

  async function deliver(record: OutboxRecord): Promise<'delivered' | 'retried' | 'dead'> {
    const { event } = record;
    const attempt = record.attempts + 1;
    const done = new Set(record.deliveredTo);
    let lastError: OutboxRecord['lastError'] = null;
    for (const subscriber of byType.get(event.type) ?? []) {
      if (done.has(subscriber.id)) continue;
      try {
        await subscriber.handle(event, { attempt });
        done.add(subscriber.id);
      } catch (error) {
        lastError = { subscriber: subscriber.id, code: codeOf(error) };
        logger?.warn('events.subscriber_failed', {
          eventId: event.id,
          type: event.type,
          subscriber: subscriber.id,
          attempt,
          error: lastError.code,
        });
      }
    }
    const status = lastError === null ? 'delivered' : attempt >= maxAttempts ? 'dead' : 'pending';
    await outbox.settle(event.id, {
      deliveredTo: [...done],
      status,
      attempts: attempt,
      nextAttemptAt: status === 'pending' ? now().getTime() + backoffMs(attempt) : 0,
      lastError,
    });
    if (status === 'dead') {
      logger?.error('events.event_dead', { eventId: event.id, type: event.type, attempt });
    }
    return status === 'pending' ? 'retried' : status;
  }

  return Object.freeze({
    async publish(tenant: TenantContext, drafts: readonly EventDraft[]) {
      if (!isResolvedTenant(tenant)) throw new EventError('unresolved_tenant');
      return append(tenant.organizationId, actorOf(tenant), drafts);
    },

    async publishSystem(organizationId: OrganizationId, drafts: readonly EventDraft[]) {
      if (typeof organizationId !== 'string' || organizationId === '') {
        throw new EventError('invalid_event', 'organizationId');
      }
      return append(organizationId, { type: 'anonymous' }, drafts);
    },

    async dispatch(dispatchOptions: { readonly limit?: number } = {}) {
      const limit = Math.min(
        Math.max(1, dispatchOptions.limit ?? EVENT_LIMITS.dispatchBatch),
        EVENT_LIMITS.dispatchBatch,
      );
      const claimed = await outbox.claim({ now: now().getTime(), limit, leaseMs });
      const counts = { delivered: 0, retried: 0, dead: 0 };
      // One event at a time, in order: a subscriber sees an organization's events as they came.
      for (const record of claimed) counts[await deliver(record)] += 1;
      return Object.freeze({ claimed: claimed.length, ...counts });
    },

    subscribersOf: (type: string) => Object.freeze((byType.get(type) ?? []).map((s) => s.id)),
  });
}
