import {
  CAPABILITY_KEYS,
  LIMIT_KEYS,
  type EntitlementService,
  type OrganizationEntitlements,
} from '@melonoffice/entitlements';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Entitlement routes (ADR-0021). Read only: nothing here assigns or changes a plan. The route
 * sits under the organization, so tenancy picks the organization from the caller's membership,
 * RBAC checks `entitlement.read`, and only then are the entitlements read, from the resolved
 * tenant. Query parameters, headers and bodies are never read.
 */
export function registerEntitlementRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly entitlements: EntitlementService },
): void {
  const { entitlements } = dependencies;
  app.get(
    '/v1/organizations/:organizationId/entitlements',
    withPermission('entitlement.read', dependencies, async (c, tenant) => {
      const state = await entitlements.entitlementsOf(tenant);
      if (state.status !== 'active') {
        c.get('logger').warn('entitlements unavailable', { reason: state.reason });
      }
      return c.json(toView(tenant.organizationId, state));
    }),
  );
}

/**
 * The public view: the plan and what it grants, as state. Limits are ceilings, not usage; nothing
 * here says how much has been used. Unavailable entitlements carry only the reason, so a client
 * can never mistake them for a plan that grants nothing on purpose.
 */
function toView(organizationId: string, state: OrganizationEntitlements) {
  if (state.status !== 'active') {
    return { organizationId, status: state.status, reason: state.reason };
  }
  return {
    organizationId,
    status: state.status,
    plan: { id: state.plan.id, version: state.plan.version },
    capabilities: Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, state.values[key]])),
    limits: Object.fromEntries(LIMIT_KEYS.map((key) => [key, state.values[key]])),
  };
}
