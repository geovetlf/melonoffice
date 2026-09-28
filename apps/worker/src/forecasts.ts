import {
  isForecastError,
  isForecastId,
  type ForecastEngine,
  type ForecastId,
  type ForecastTask,
} from '@melonoffice/forecasting';
import type { OrganizationId } from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import { FOLLOW_UP_MAX_ATTEMPTS } from './follow-ups.js';

/** The only route that runs forecasts (ADR-0059). It means "run this queued forecast". */
export const RUN_FORECAST_PATH = '/internal/forecasts/run';

export interface ForecastRunResult {
  readonly status: 200 | 400 | 503;
  readonly body: { readonly result: string; readonly code?: string };
}

export interface ForecastHandler {
  run(request: unknown, retryCount: number): Promise<ForecastRunResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exactly `{ organizationId, forecastId, run }`. */
function taskOf(request: unknown): ForecastTask | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined;
  if (Object.keys(request).sort().join(',') !== 'forecastId,organizationId,run') return undefined;
  const { organizationId, forecastId, run } = request as Record<string, unknown>;
  if (typeof organizationId !== 'string' || !UUID.test(organizationId)) return undefined;
  if (!isForecastId(forecastId)) return undefined;
  if (typeof run !== 'number' || !Number.isSafeInteger(run) || run < 1) return undefined;
  return {
    organizationId: organizationId as OrganizationId,
    forecastId: forecastId as ForecastId,
    run,
  };
}

const answer = (status: ForecastRunResult['status'], body: ForecastRunResult['body']) =>
  Object.freeze({ status, body: Object.freeze(body) });

/**
 * The worker's forecast handler: thin, like the job and follow-up handlers. It checks the task
 * and hands it to the Forecasting Engine, which re-reads the forecast from Firestore. `200` is
 * done; `503` asks the queue to deliver again, which is safe (a completed forecast is not run
 * twice, and a charge is made once by its reference). On the queue's last delivery the engine is
 * told it is final: the labelled fallback may answer, or the forecast is kept as failed.
 */
export function createForecastHandler(options: {
  readonly engine: Pick<ForecastEngine, 'run' | 'fail'>;
  readonly logger?: Logger;
  /** The job queue's `max_attempts` (the same queue as jobs and follow-ups). */
  readonly maxAttempts?: number;
}): ForecastHandler {
  const { engine, logger, maxAttempts = FOLLOW_UP_MAX_ATTEMPTS } = options;
  return Object.freeze({
    async run(request: unknown, retryCount: number) {
      const task = taskOf(request);
      if (task === undefined) return answer(400, { result: 'invalid_request' });
      const final = retryCount >= maxAttempts - 1;
      try {
        const result = await engine.run(task, { final });
        logger?.info('forecast task', { result, retryCount });
        return answer(200, { result });
      } catch (error) {
        const code = isForecastError(error) ? error.code : 'unavailable';
        logger?.warn('forecast task failed', { code, retryCount });
        if (final) {
          try {
            if (await engine.fail(task, 'retries_exhausted')) {
              return answer(200, { result: 'failed', code });
            }
          } catch {
            logger?.error('forecast could not be marked failed', { code });
          }
        }
        return answer(503, { result: 'unavailable', code });
      }
    },
  });
}
