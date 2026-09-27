import { isAuthError, readBearerToken, type ServiceIdentityVerifier } from '@melonoffice/auth';
import type { Logger } from '@melonoffice/observability';
import { Hono } from 'hono';
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

  app.post(RUN_JOB_PATH, async (c) => {
    if (jobs === undefined) return c.json({ error: 'runtime_not_configured' }, 503);

    // Cloud Run only lets the invoker identity through; the worker checks the token again, so
    // a misconfigured service or a direct call never runs a job (defence in depth).
    const token = readBearerToken(c.req.header('authorization'));
    if (token === undefined || token === null) return c.json({ error: 'missing_token' }, 401);
    try {
      await jobs.invoker.verify(token);
    } catch (error) {
      if (isAuthError(error) && error.code === 'verifier_unavailable') {
        return c.json({ error: 'verifier_unavailable' }, 503);
      }
      c.get('logger').warn('job delivery unauthenticated', {
        code: isAuthError(error) ? error.code : 'invalid_token',
      });
      return c.json({ error: 'forbidden' }, 403);
    }

    const type = c.req.header('content-type') ?? '';
    if (!/^application\/json(;|$)/i.test(type)) {
      return c.json({ result: 'invalid_request', code: 'content_type' }, 400);
    }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      return c.json({ result: 'invalid_request', code: 'body_too_large' }, 400);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ result: 'invalid_request', code: 'invalid_json' }, 400);
    }
    const result = await jobs.handler.run(body, c.get('requestId'));
    return c.json(result.body, result.status);
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    c.get('logger').error('unhandled error', { error });
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
