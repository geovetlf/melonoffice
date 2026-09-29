import { isForecastError, type MetricHistoryService } from '@melonoffice/forecasting';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';
import { FORECAST_STATUS } from './forecasts.js';

/**
 * Reports (ADR-0060), under `/v1/organizations/:id/metrics`: what was recorded for each metric of
 * the Forecasting Engine's catalogue, per day, week or month. Reading runs no model, charges
 * nothing and writes nothing; each metric also needs the permission of its records.
 */
export function registerMetricRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly metrics?: MetricHistoryService },
): void {
  const { metrics } = dependencies;
  const base = '/v1/organizations/:organizationId/metrics';

  async function answer(
    c: Context<AuthEnv>,
    work: (metrics: MetricHistoryService) => Promise<object>,
  ): Promise<Response> {
    if (metrics === undefined) return c.json({ error: 'reports_not_configured' }, 503);
    try {
      return c.json(await work(metrics));
    } catch (error) {
      if (!isForecastError(error)) throw error;
      return c.json(
        { error: error.code, ...(error.detail === undefined ? {} : { field: error.detail }) },
        FORECAST_STATUS[error.code],
      );
    }
  }

  app.get(
    base,
    withPermission('report.read', dependencies, (c, tenant) =>
      answer(c, async (m) => ({ metrics: m.metrics(tenant) })),
    ),
  );

  app.get(
    `${base}/:metricId`,
    withPermission('report.read', dependencies, (c, tenant) =>
      answer(c, async (m) => {
        const periods = c.req.query('periods');
        const frequency = c.req.query('frequency');
        const entity = c.req.query('entity');
        return m.history(tenant, {
          metric: c.req.param('metricId'),
          ...(frequency === undefined ? {} : { frequency }),
          ...(entity === undefined ? {} : { entity }),
          // A whole number stays one; anything else reaches the service as written and is refused.
          ...(periods === undefined
            ? {}
            : { periods: /^\d{1,4}$/.test(periods) ? Number(periods) : periods }),
        });
      }),
    ),
  );
}
