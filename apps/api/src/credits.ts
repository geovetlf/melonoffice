import type { CreditBalance, CreditService } from '@melonoffice/credits';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Credit routes (ADR-0023). Only the balance can be read: there is no route that grants,
 * consumes, refunds or adjusts credits, and none that lists the ledger. Tenancy picks the
 * organization from the caller's membership, RBAC checks `credits.read`, and only then is the
 * wallet read, from the resolved tenant. Query parameters, headers and bodies are never read.
 */
export function registerCreditRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly credits: CreditService },
): void {
  const { credits } = dependencies;
  app.get(
    '/v1/organizations/:organizationId/credits',
    withPermission('credits.read', dependencies, async (c, tenant) => {
      const balance = await credits.balanceOf(tenant);
      if (balance.status !== 'present') {
        c.get('logger').warn('credits unavailable', { reason: balance.reason });
      }
      return c.json(toView(tenant.organizationId, balance));
    }),
  );
}

/** The public view: the balance in whole credits and when it last moved. No ledger entries. */
function toView(organizationId: string, balance: CreditBalance) {
  if (balance.status !== 'present') {
    return { organizationId, status: balance.status, reason: balance.reason };
  }
  return {
    organizationId,
    status: balance.status,
    balance: balance.balance,
    updatedAt: balance.updatedAt,
  };
}
