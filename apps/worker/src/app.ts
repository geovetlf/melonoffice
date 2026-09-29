import { isAuthError, readBearerToken, type ServiceIdentityVerifier } from '@melonoffice/auth';
import type { Logger } from '@melonoffice/observability';
import { Hono, type Context } from 'hono';
import { RETRY_COUNT_HEADER, RUN_FOLLOW_UP_PATH, type FollowUpHandler } from './follow-ups.js';
import { RUN_EVENT_PATH, type EventHandler } from './events.js';
import { RUN_FORECAST_PATH, type ForecastHandler } from './forecasts.js';
import type { JobHandler } from './handler.js';
import { registerHealth } from './health.js';

export const SERVICE_NAME = 'worker';

/** The only route that runs work. It means "run this job" and nothing else (ADR-0032). */
export const RUN_JOB_PATH = '/internal/jobs/run';

/** A task body is `{ "jobId": "<uuid>" }`: far below this. Anything bigger is not a task. */
const MAX_BODY_BYTES = 1024;

export interface AppOptions {
  readonly logger: Logger;
  readonly version: string;
  /**
   * Runs jobs. Absent (no runtime configuration), every job delivery is refused with 503 and
   * nothing is read: the worker serves health only.
   */
  readonly jobs?: {
    readonly handler: JobHandler;
    /** Checks the caller is the job invoker service account, with this worker as audience. */
    readonly invoker: ServiceIdentityVerifier;
    /**
     * Marks follow-ups due when their scheduled task arrives (C5, ADR-0058), behind the same
     * invoker check. Absent: follow-up deliveries are refused with 503.
     */
    readonly followUps?: FollowUpHandler;
    /**
     * Runs queued forecasts (ADR-0059), behind the same invoker check. Absent: forecast
     * deliveries are refused with 503.
     */
    readonly forecasts?: ForecastHandler;
    /**
     * Delivers queued domain events (EV-2, ADR-0067), behind the same invoker check. Absent:
     * event deliveries are refused with 503.
     */
    readonly events?: EventHandler;
  };
}

type Env = { Variables: { logger: Logger; requestId: string } };

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w-]{1,128}$/;

export function createApp({ logger, version, jobs }: AppOptions): Hono<Env> {
  const app = new Hono<Env>();

  // Correlate every request with an id (reuse a well-formed incoming one) and log it.
  app.use('*', async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const requestId =
      incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    const requestLogger = logger.child({ requestId });
    c.set('logger', requestLogger);
    c.set('requestId', requestId);
    c.header(REQUEST_ID_HEADER, requestId);
    const started = performance.now();
    await next();
    requestLogger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });

  registerHealth(app, { service: SERVICE_NAME, version });

  /** The invoker's token and a small JSON body, or the answer that refuses the delivery. */
  async function delivery(c: Context<Env>): Promise<{ body: unknown } | { refused: Response }> {
    if (jobs === undefined) {
      return { refused: c.json({ error: 'runtime_not_configured' }, 503) };
    }
    // Cloud Run only lets the invoker identity through; the worker checks the token again, so
    // a misconfigured service or a direct call never runs a job (defence in depth).
    const token = readBearerToken(c.req.header('authorization'));
    if (token === undefined || token === null) {
      return { refused: c.json({ error: 'missing_token' }, 401) };
    }
    try {
      await jobs.invoker.verify(token);
    } catch (error) {
      if (isAuthError(error) && error.code === 'verifier_unavailable') {
        return { refused: c.json({ error: 'verifier_unavailable' }, 503) };
      }
      c.get('logger').warn('job delivery unauthenticated', {
        code: isAuthError(error) ? error.code : 'invalid_token',
      });
      return { refused: c.json({ error: 'forbidden' }, 403) };
    }

    const type = c.req.header('content-type') ?? '';
    if (!/^application\/json(;|$)/i.test(type)) {
      return { refused: c.json({ result: 'invalid_request', code: 'content_type' }, 400) };
    }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      return { refused: c.json({ result: 'invalid_request', code: 'body_too_large' }, 400) };
    }
    try {
      return { body: JSON.parse(raw) as unknown };
    } catch {
      return { refused: c.json({ result: 'invalid_request', code: 'invalid_json' }, 400) };
    }
  }

  app.post(RUN_JOB_PATH, async (c) => {
    const read = await delivery(c);
    if ('refused' in read) return read.refused;
    const result = await (jobs as NonNullable<typeof jobs>).handler.run(
      read.body,
      c.get('requestId'),
    );
    return c.json(result.body, result.status);
  });

  // A follow-up's scheduled task (C5): same invoker, same checks, its own small body.
  app.post(RUN_FOLLOW_UP_PATH, async (c) => {
    if (jobs?.followUps === undefined) return c.json({ error: 'follow_ups_not_configured' }, 503);
    const read = await delivery(c);
    if ('refused' in read) return read.refused;
    const retries = Number(c.req.header(RETRY_COUNT_HEADER) ?? '0');
    const result = await jobs.followUps.run(
      read.body,
      Number.isSafeInteger(retries) && retries >= 0 ? retries : 0,
    );
    return c.json(result.body, result.status);
  });

  // A queued forecast (ADR-0059): same invoker, same checks, its own small body.
  app.post(RUN_FORECAST_PATH, async (c) => {
    if (jobs?.forecasts === undefined) return c.json({ error: 'forecasts_not_configured' }, 503);
    const read = await delivery(c);
    if ('refused' in read) return read.refused;
    const retries = Number(c.req.header(RETRY_COUNT_HEADER) ?? '0');
    const result = await jobs.forecasts.run(
      read.body,
      Number.isSafeInteger(retries) && retries >= 0 ? retries : 0,
    );
    return c.json(result.body, result.status);
  });

  // A queued domain event (EV-2): same invoker, same checks, its own small body.
  app.post(RUN_EVENT_PATH, async (c) => {
    if (jobs?.events === undefined) return c.json({ error: 'events_not_configured' }, 503);
    const read = await delivery(c);
    if ('refused' in read) return read.refused;
    const retries = Number(c.req.header(RETRY_COUNT_HEADER) ?? '0');
    const result = await jobs.events.run(
      read.body,
      Number.isSafeInteger(retries) && retries >= 0 ? retries : 0,
    );
    return c.json(result.body, result.status);
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    c.get('logger').error('unhandled error', { error });
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
