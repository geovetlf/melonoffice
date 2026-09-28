import {
  forecastOutcomeView,
  forecastViewOf,
  isForecastError,
  type ForecastEngine,
  type ForecastErrorCode,
} from '@melonoffice/forecasting';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

export const FORECAST_STATUS: Record<ForecastErrorCode, ContentfulStatusCode> = {
  unresolved_tenant: 403,
  organization_inactive: 403,
  permission_denied: 403,
  invalid_request: 400,
  metric_not_found: 404,
  metric_not_for_department: 409,
  frequency_not_supported: 409,
  horizon_out_of_range: 400,
  covariates_not_supported: 409,
  forecast_not_found: 404,
  forecast_model_unavailable: 503,
  forecast_price_not_set: 503,
  forecast_credits_insufficient: 409,
  forecast_limit_reached: 429,
  forecast_not_scheduled: 503,
  forecast_concurrency_conflict: 409,
};

const FIELDS = new Set([
  'metric',
  'entity',
  'frequency',
  'horizon',
  'department',
  'covariates',
  'wait',
]);

/**
 * The Forecasting Engine's routes (ADR-0059), under `/v1/organizations/:id/forecasts`. They are
 * MelonMotor's door to it: a department screen, a report or GIA ask here, never the model. A run
 * goes to the worker through the existing job queue; `wait: true` waits a bounded time for it.
 */
export function registerForecastRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly engine?: ForecastEngine },
): void {
  const { engine } = dependencies;
  const base = '/v1/organizations/:organizationId/forecasts';

  async function answer(
    c: Context<AuthEnv>,
    work: (engine: ForecastEngine) => Promise<{ body: object; status?: 200 | 202 | 400 }>,
  ): Promise<Response> {
    if (engine === undefined) return c.json({ error: 'forecasting_not_configured' }, 503);
    try {
      const { body, status = 200 } = await work(engine);
      return c.json(body, status);
    } catch (error) {
      if (!isForecastError(error)) throw error;
      return c.json(
        { error: error.code, ...(error.detail === undefined ? {} : { field: error.detail }) },
        FORECAST_STATUS[error.code],
      );
    }
  }

  app.get(
    `${base}/metrics`,
    withPermission('forecast.read', dependencies, (c, tenant) =>
      answer(c, async (e) => ({ body: { metrics: e.metrics(tenant) } })),
    ),
  );

  app.post(
    base,
    withPermission('forecast.run', dependencies, (c, tenant) =>
      answer(c, async (e) => {
        const body: unknown = await c.req.json().catch(() => undefined);
        if (
          typeof body !== 'object' ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).some((k) => !FIELDS.has(k))
        ) {
          return { body: { error: 'invalid_request' }, status: 400 as const };
        }
        const input = body as Record<string, unknown>;
        if (input.wait !== undefined && typeof input.wait !== 'boolean') {
          return { body: { error: 'invalid_request', field: 'wait' }, status: 400 as const };
        }
        const outcome = await e.request(tenant, {
          metric: input.metric,
          horizon: input.horizon,
          ...(input.entity === undefined ? {} : { entity: input.entity }),
          ...(input.frequency === undefined ? {} : { frequency: input.frequency }),
          ...(input.department === undefined ? {} : { department: input.department }),
          ...(input.covariates === undefined ? {} : { covariates: input.covariates }),
          wait: input.wait === true,
        });
        const running = outcome.status === 'queued' || outcome.status === 'running';
        return { body: forecastOutcomeView(outcome), status: running ? 202 : 200 };
      }),
    ),
  );

  app.get(
    `${base}/:forecastId`,
    withPermission('forecast.read', dependencies, (c, tenant) =>
      answer(c, async (e) => ({
        body: forecastViewOf(await e.get(tenant, c.req.param('forecastId'))),
      })),
    ),
  );
}
