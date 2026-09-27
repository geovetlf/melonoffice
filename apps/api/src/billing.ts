import type { BillingService, OrganizationBilling } from '@melonoffice/billing';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Billing routes (ADR-0022). Read only: there is no payment, checkout, or way to change a plan,
 * status or subscription, because nothing real stands behind one yet. Tenancy picks the
 * organization from the caller's membership, RBAC checks `billing.read`, and only then is the
 * billing read, from the resolved tenant. Query parameters, headers and bodies are never read.
 */
export function registerBillingRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly billing: BillingService },
): void {
  const { billing } = dependencies;
  app.get(
    '/v1/organizations/:organizationId/billing',
    withPermission('billing.read', dependencies, async (c, tenant) => {
      const state = await billing.billingOf(tenant);
      if (state.status !== 'present') {
        c.get('logger').warn('billing unavailable', { reason: state.reason });
      }
      return c.json(toView(tenant.organizationId, state));
    }),
  );
}

/**
 * The public view: the subscription's plan reference and status, and whether its plan is in
 * force. Nothing about payment methods, providers or amounts exists to show, and what the plan
 * grants is at the entitlements route.
 */
function toView(organizationId: string, state: OrganizationBilling) {
  if (state.status !== 'present') {
    return { organizationId, status: state.status, reason: state.reason };
  }
  const { subscription } = state;
  return {
    organizationId,
    status: state.status,
    subscription: {
      id: subscription.id,
      plan: { id: subscription.plan.id, version: subscription.plan.version },
      status: subscription.status,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
    },
    planInForce: state.planInForce,
  };
}
