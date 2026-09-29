import type { OrganizationId } from '@melonoffice/domain';
import { isEventId, type EventBus } from '@melonoffice/events';
import type { Logger } from '@melonoffice/observability';

/** The only route that delivers domain events (EV-2, ADR-0067). It means "deliver this event". */
export const RUN_EVENT_PATH = '/internal/events/run';

export interface EventRunResult {
  readonly status: 200 | 400 | 503;
  readonly body: { readonly result: string; readonly code?: string };
}

export interface EventHandler {
  run(request: unknown, retryCount: number): Promise<EventRunResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exactly `{ organizationId, eventId }`: everything else is re-read from the outbox. */
function refOf(request: unknown) {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined;
  if (Object.keys(request).sort().join(',') !== 'eventId,organizationId') return undefined;
  const { organizationId, eventId } = request as Record<string, unknown>;
  if (typeof organizationId !== 'string' || !UUID.test(organizationId)) return undefined;
  if (!isEventId(eventId)) return undefined;
  return { organizationId: organizationId as OrganizationId, eventId };
}

const answer = (status: EventRunResult['status'], body: EventRunResult['body']) =>
  Object.freeze({ status, body: Object.freeze(body) });

/**
 * The worker's event handler: thin, like the job and follow-up handlers. `200` ends the task
 * (delivered, already delivered, set aside, or nothing to deliver); `503` asks the queue to
 * deliver it again, which is safe: the outbox's lease and record decide what runs.
 */
export function createEventHandler(options: {
  readonly events: Pick<EventBus, 'deliver'>;
  readonly logger?: Logger;
}): EventHandler {
  const { events, logger } = options;
  return Object.freeze({
    async run(request: unknown, retryCount: number) {
      const ref = refOf(request);
      if (ref === undefined) return answer(400, { result: 'invalid_request' });
      try {
        const result = await events.deliver(ref, { retryCount });
        if (result.kind === 'busy') return answer(503, { result: 'busy' });
        if (result.kind === 'retry') return answer(503, { result: 'retry', code: result.code });
        return answer(200, {
          result: result.kind,
          ...(result.kind === 'dead' ? { code: result.code } : {}),
        });
      } catch {
        // The outbox is out of reach: nothing ran or was recorded, and the queue delivers again.
        logger?.warn('event delivery unavailable', { retryCount });
        return answer(503, { result: 'unavailable' });
      }
    },
  });
}
