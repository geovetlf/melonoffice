import {
  isDecisionError,
  type DecisionEngine,
  type DecisionErrorCode,
} from '@melonoffice/decisions';
import { isForecastError } from '@melonoffice/forecasting';
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';
import { FORECAST_STATUS } from './forecasts.js';

const STATUS: Record<DecisionErrorCode, ContentfulStatusCode> = {
  unresolved_tenant: 403,
  unknown_decision_type: 404,
  invalid_input: 400,
  permission_denied: 403,
  not_configured: 503,
};

const FIELDS = new Set(['type', 'input']);
const TYPE = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/**
 * The Decision Engine's routes (DE-1, ADR-0065). Each decides as the person asking, explains
 * why and is audited; none prepares or runs anything.
 *
 * - `GET .../decisions/actions`: the actions GIA may prepare for the person, each with its
 *   condition (the person confirms, or an approval), what it may spend and, when it is not
 *   offered, why.
 * - `GET .../decisions/types`: the decision types and whether the person may ask each here.
 * - `POST .../decisions` with exactly `{ type, input? }`: one decision. Context a server caller
 *   already read (GIA's) is never accepted from a request: the engine reads it as the person.
 */
export function registerDecisionRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly decisions: DecisionEngine },
): void {
  const { decisions } = dependencies;
  app.get(
    '/v1/organizations/:organizationId/decisions/actions',
    withPermission('gia.ask', dependencies, async (c, tenant) =>
      c.json({ actions: decisions.listActions(tenant, 'gia') }),
    ),
  );
  app.get(
    '/v1/organizations/:organizationId/decisions/types',
    withPermission('decision.evaluate', dependencies, async (c, tenant) =>
      c.json({ types: decisions.listDecisionTypes(tenant) }),
    ),
  );
  app.post(
    '/v1/organizations/:organizationId/decisions',
    withPermission('decision.evaluate', dependencies, async (c, tenant) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => !FIELDS.has(k))
      ) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      const { type, input } = body as Record<string, unknown>;
      if (typeof type !== 'string' || !TYPE.test(type)) {
        return c.json({ error: 'invalid_request', field: 'type' }, 400);
      }
      try {
        const decision = await decisions.evaluateDecision(tenant, {
          type,
          ...(input === undefined ? {} : { input }),
          requestId: c.get('requestId'),
        });
        return c.json({ decision });
      } catch (error) {
        if (isDecisionError(error)) {
          return c.json(
            { error: error.code, ...(error.field === undefined ? {} : { field: error.field }) },
            STATUS[error.code],
          );
        }
        // What a decision reads is read as the person: a forecast of another organization is
        // not found, exactly as on the forecasting routes.
        if (isForecastError(error)) {
          return c.json({ error: error.code }, FORECAST_STATUS[error.code]);
        }
        throw error;
      }
    }),
  );
}
