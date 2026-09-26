import { actorOf, type AuditService } from '@melonoffice/audit';
import type { AuthorizationService, Permission } from '@melonoffice/rbac';
import {
  isTenancyError,
  resolveTenant,
  type TenancyStore,
  type TenantContext,
} from '@melonoffice/tenancy';
import type { Context } from 'hono';
import { recordOutcome, requestFields } from './audit.js';
import type { AuthEnv } from './auth.js';

export interface AuthorizationDependencies {
  readonly store: TenancyStore;
  readonly authorization: AuthorizationService;
  readonly audit: AuditService;
}

/** Path parameter that selects the organization. It only selects; access comes from membership. */
export const ORGANIZATION_PARAM = 'organizationId';

/**
 * Adapts RBAC to HTTP for routes under `/v1/organizations/:organizationId`. It only translates:
 * tenancy resolves the organization and RBAC decides. The handler runs only when both allow, and
 * receives the resolved tenant, so it never reads the user, organization or membership from the
 * request.
 *
 * - No or bad token: 401, from authentication, before this runs.
 * - Not a member, inactive membership or organization, unknown id: 403 `organization_forbidden`.
 * - Member without the permission (or with a role RBAC does not know): 403 `permission_denied`.
 *   The precise reason is logged, never returned.
 *
 * Both refusals are audited (ADR-0020). A tenancy refusal records the requested organization
 * apart from the actor's context, since the actor has no access to it.
 */
export function withPermission(
  permission: Permission,
  { store, authorization, audit }: AuthorizationDependencies,
  handler: (c: Context<AuthEnv>, tenant: TenantContext) => Promise<Response>,
): (c: Context<AuthEnv>) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const requested = c.req.param(ORGANIZATION_PARAM);
    let tenant: TenantContext;
    try {
      tenant = await resolveTenant(auth, requested, store);
    } catch (error) {
      if (!isTenancyError(error)) throw error;
      c.get('logger').warn('tenancy rejected', { code: error.code });
      await recordOutcome(c, audit, {
        action: 'tenancy.resolve',
        result: 'denied',
        actor: actorOf(auth),
        ...(requested === undefined ? {} : { requestedOrganizationId: requested }),
        reason: error.code,
        ...requestFields(c),
      });
      return c.json({ error: error.code }, 403);
    }
    const decision = authorization.authorize(tenant, permission);
    if (!decision.allowed) {
      c.get('logger').warn('permission denied', { permission, reason: decision.reason });
      await recordOutcome(c, audit, {
        action: 'authorization.check',
        result: 'denied',
        actor: actorOf(tenant),
        organizationId: tenant.organizationId,
        target: { type: 'organization', id: tenant.organizationId },
        permission,
        reason: decision.reason,
        ...requestFields(c),
      });
      return c.json({ error: 'permission_denied' }, 403);
    }
    return handler(c, tenant);
  };
}
