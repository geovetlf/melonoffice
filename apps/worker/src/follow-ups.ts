import {
  isConversationError,
  isFollowUpId,
  type FollowUpService,
  type FollowUpTask,
} from '@melonoffice/conversations';
import type { FollowUpId, OrganizationId } from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';

/** The only route that marks follow-ups due (C5, ADR-0058). It means "this one's time came". */
export const RUN_FOLLOW_UP_PATH = '/internal/follow-ups/run';

/**
 * How many times the queue delivers one task (the execution jobs queue's `retry_config`
 * `max_attempts` in Terraform, ADR-0032). On the last delivery a failure keeps the follow-up as
 * failed, so it never silently stays scheduled once the queue gives up.
 */
export const FOLLOW_UP_MAX_ATTEMPTS = 10;

/** Cloud Tasks' header with the number of earlier deliveries of this task (0 on the first). */
export const RETRY_COUNT_HEADER = 'x-cloudtasks-taskretrycount';

export interface FollowUpRunResult {
  readonly status: 200 | 400 | 503;
  readonly body: { readonly result: string; readonly code?: string };
}

export interface FollowUpHandler {
  run(request: unknown, retryCount: number): Promise<FollowUpRunResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exactly `{ organizationId, followUpId, schedule }`. */
function taskOf(request: unknown): FollowUpTask | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined;
  const keys = Object.keys(request).sort();
  if (keys.join(',') !== 'followUpId,organizationId,schedule') return undefined;
  const { organizationId, followUpId, schedule } = request as Record<string, unknown>;
  if (typeof organizationId !== 'string' || !UUID.test(organizationId)) return undefined;
  if (!isFollowUpId(followUpId)) return undefined;
  if (typeof schedule !== 'number' || !Number.isSafeInteger(schedule) || schedule < 1) {
    return undefined;
  }
  return {
    organizationId: organizationId as OrganizationId,
    followUpId: followUpId as FollowUpId,
    schedule,
  };
}

const answer = (status: FollowUpRunResult['status'], body: FollowUpRunResult['body']) =>
  Object.freeze({ status, body: Object.freeze(body) });

/**
 * The worker's follow-up handler: thin, like the job handler. It checks the request and hands it
 * to the follow-up service, which re-reads everything from Firestore. `200` is done (due, already
 * done, stale or ended); `503` asks the queue to deliver again, which is safe.
 */
export function createFollowUpHandler(options: {
  readonly followUps: Pick<FollowUpService, 'runDue' | 'failDue'>;
  readonly logger?: Logger;
  readonly maxAttempts?: number;
}): FollowUpHandler {
  const { followUps, logger, maxAttempts = FOLLOW_UP_MAX_ATTEMPTS } = options;
  return Object.freeze({
    async run(request: unknown, retryCount: number) {
      const task = taskOf(request);
      if (task === undefined) return answer(400, { result: 'invalid_request' });
      try {
        const result = await followUps.runDue(task);
        logger?.info('follow-up task', { result: result.kind });
        return answer(200, { result: result.kind });
      } catch (error) {
        const code = isConversationError(error) ? error.code : 'unavailable';
        logger?.warn('follow-up task failed', { code, retryCount });
        // The queue will not deliver it again: keep it as failed, for a person to reschedule.
        if (retryCount >= maxAttempts - 1) {
          try {
            if (await followUps.failDue(task)) return answer(200, { result: 'failed', code });
          } catch {
            // Storage is down too: the follow-up stays scheduled and the log says so.
            logger?.error('follow-up could not be marked failed', { code });
          }
        }
        return answer(503, { result: 'unavailable', code });
      }
    },
  });
}
