import type { AuditService } from '@melonoffice/audit';
import type { AuthDependencies } from '@melonoffice/auth';
import { createBillingService, type BillingStore } from '@melonoffice/billing';
import { createEntitlementService, type EntitlementService } from '@melonoffice/entitlements';
import { createExecutionService, type ExecutionRepository } from '@melonoffice/execution';
import type { Logger } from '@melonoffice/observability';
import { createAuthorizationService, type AuthorizationService } from '@melonoffice/rbac';
import type { TenancyStore } from '@melonoffice/tenancy';
import { Hono, type Context } from 'hono';
import { registerAuthRoutes, type AuthEnv } from './auth.js';
import { registerBillingRoutes } from './billing.js';
import { registerEntitlementRoutes } from './entitlements.js';
import { registerExecutionRoutes } from './executions.js';
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
  /**
   * Billing accounts and subscriptions (ADR-0022), the source of each organization's plan.
   * Absent: billing and entitlement routes answer 503 (fails closed).
   */
  readonly billing?: BillingStore;
  /**
   * What organizations' plans allow (ADR-0021). Defaults to the plan catalogue in code, with the
   * plan from billing; tests may pass another catalogue.
   */
  readonly entitlements?: EntitlementService;
  /** Executions (ADR-0024). Absent: the execution route answers 503 (fails closed). */
  readonly executions?: ExecutionRepository;
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
  billing,
  entitlements,
  executions,
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
    if (tenancy !== undefined && billing !== undefined) {
      const billingService = createBillingService({ billing, organizations: tenancy });
      const dependencies = { store: tenancy, authorization, audit };
      registerBillingRoutes(app, { ...dependencies, billing: billingService });
      registerEntitlementRoutes(app, {
        ...dependencies,
        entitlements:
          entitlements ??
          createEntitlementService({ organizations: tenancy, plans: billingService }),
      });
    } else if (tenancy !== undefined) {
      const unavailable = (c: Context<Env>) => c.json({ error: 'billing_not_configured' }, 503);
      app.all('/v1/organizations/:organizationId/billing', unavailable);
      app.all('/v1/organizations/:organizationId/entitlements', unavailable);
    }
    if (tenancy !== undefined && executions !== undefined) {
      registerExecutionRoutes(app, {
        store: tenancy,
        authorization,
        audit,
        executions: createExecutionService({ repository: executions, organizations: tenancy }),
      });
    } else if (tenancy !== undefined) {
      app.all('/v1/organizations/:organizationId/executions/*', (c) =>
        c.json({ error: 'executions_not_configured' }, 503),
      );
    }
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    c.get('logger').error('unhandled error', { error });
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
