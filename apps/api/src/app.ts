import type { AuditService } from '@melonoffice/audit';
import type { AuthDependencies } from '@melonoffice/auth';
import type { Logger } from '@melonoffice/observability';
import { createAuthorizationService, type AuthorizationService } from '@melonoffice/rbac';
import type { TenancyStore } from '@melonoffice/tenancy';
import { Hono } from 'hono';
import { registerAuthRoutes, type AuthEnv } from './auth.js';
import { registerHealth } from './health.js';
import { registerTenancyRoutes } from './tenancy.js';

export const SERVICE_NAME = 'api';

export interface AppOptions {
  readonly logger: Logger;
  readonly version: string;
  /** Token verification and users. Absent: /v1 answers 503 (fails closed). */
  readonly auth?: AuthDependencies;
  /** Organizations and memberships. Absent: organization routes answer 503 (fails closed). */
  readonly tenancy?: TenancyStore;
  /** Where audit events go (ADR-0020). Absent: /v1 answers 503 (fails closed). */
  readonly audit?: AuditService;
  /** Role permissions (ADR-0019). Defaults to the built-in roles; tests may narrow them. */
  readonly authorization?: AuthorizationService;
}

type Env = AuthEnv;

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[\w-]{1,128}$/;

export function createApp({
  logger,
  version,
  auth,
  tenancy,
  audit,
  authorization = createAuthorizationService(),
}: AppOptions): Hono<Env> {
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
  registerAuthRoutes(app, auth, audit);
  if (auth !== undefined && audit !== undefined) {
    registerTenancyRoutes(app, tenancy, authorization, audit);
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    c.get('logger').error('unhandled error', { error });
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
