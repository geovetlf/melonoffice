import { actorOf, buildAuditEvent, type AuditService } from '@melonoffice/audit';
import { openBilling } from '@melonoffice/billing';
import { DEFAULT_DEPARTMENT_CATALOGUE, provisionDepartments } from '@melonoffice/departments';
import { openWallet } from '@melonoffice/credits';
import { DEFAULT_PLAN } from '@melonoffice/entitlements';
import type { AuthorizationService } from '@melonoffice/rbac';
import {
  createOrganization,
  isTenancyError,
  listMyOrganizations,
  type TenancyErrorCode,
  type TenancyStore,
} from '@melonoffice/tenancy';
import type { Membership, Organization } from '@melonoffice/domain';
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';
import { recordOutcome, requestFields } from './audit.js';
import { withPermission } from './authorization.js';

const STATUS: Record<TenancyErrorCode, ContentfulStatusCode> = {
  invalid_organization_name: 400,
  organization_limit_reached: 409,
  organization_required: 403,
  organization_forbidden: 403,
  requires_user: 403,
};

/**
 * Organization routes under /v1 (ADR-0018). They run after authentication, so `auth` is always
 * the verified caller; the user id is never read from the request. Routes inside an organization
 * go through `withPermission` (ADR-0019). Without a store they answer 503, failing closed.
 */
export function registerTenancyRoutes(
  app: Hono<AuthEnv>,
  store: TenancyStore | undefined,
  authorization: AuthorizationService,
  audit: AuditService,
): void {
  if (store === undefined) {
    app.all('/v1/organizations', (c) => c.json({ error: 'tenancy_not_configured' }, 503));
    app.all('/v1/organizations/*', (c) => c.json({ error: 'tenancy_not_configured' }, 503));
    app.all('/v1/me/organizations', (c) => c.json({ error: 'tenancy_not_configured' }, 503));
    return;
  }

  // Only `name` is read from the body. Anything else, such as an id, owner, status, plan or
  // subscription, is ignored: billing opens every organization on the default plan (ADR-0022),
  // and the D-11 catalogue gives it its first departments in the same write (ADR-0025).
  app.post('/v1/organizations', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const name =
      typeof body === 'object' && body !== null ? (body as { name?: unknown }).name : undefined;
    const auth = c.get('auth');
    const actor = actorOf(auth);
    let result;
    try {
      // The creation's events are stored in the same write as the organization (ADR-0020).
      result = await createOrganization(auth, { name }, store, {
        billing: (organization) => openBilling(organization, DEFAULT_PLAN),
        departments: (organization) =>
          provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE),
        // Empty: no plan comes with credits until D-12 decides otherwise (ADR-0023).
        credits: openWallet,
        audit: ({ organization, membership, billing: { subscription } }) => {
          const at = new Date(organization.createdAt);
          const common = { result: 'success', actor, organizationId: organization.id } as const;
          return [
            buildAuditEvent(
              {
                action: 'organization.create',
                ...common,
                target: { type: 'organization', id: organization.id },
                ...requestFields(c),
              },
              at,
            ),
            buildAuditEvent(
              {
                action: 'membership.create',
                ...common,
                target: { type: 'membership', id: membership.id },
                ...requestFields(c),
              },
              at,
            ),
            buildAuditEvent(
              {
                action: 'billing.subscription_created',
                ...common,
                target: { type: 'subscription', id: subscription.id },
                plan: subscription.plan,
                ...requestFields(c),
              },
              at,
            ),
            buildAuditEvent(
              {
                action: 'plan.assign',
                ...common,
                target: { type: 'organization', id: organization.id },
                plan: subscription.plan,
                ...requestFields(c),
              },
              at,
            ),
          ];
        },
      });
    } catch (error) {
      if (isTenancyError(error)) {
        // A refused creation is a denial worth keeping; a malformed name is only bad input.
        if (error.code !== 'invalid_organization_name') {
          await recordOutcome(c, audit, {
            action: 'organization.create',
            result: 'denied',
            actor,
            reason: error.code,
            ...requestFields(c),
          });
        }
        c.get('logger').warn('tenancy rejected', { code: error.code });
        return c.json({ error: error.code }, STATUS[error.code]);
      }
      await recordOutcome(c, audit, {
        action: 'organization.create',
        result: 'failure',
        actor,
        reason: 'storage_error',
        ...requestFields(c),
      });
      throw error;
    }
    return c.json(toView(result.organization, result.membership), 201);
  });

  app.get('/v1/me/organizations', async (c) => {
    const mine = await listMyOrganizations(c.get('auth'), store);
    return c.json({
      organizations: mine.map(({ organization, membership }) => toView(organization, membership)),
    });
  });

  // The path id only selects; the tenant comes from an active membership and RBAC decides.
  app.get(
    '/v1/organizations/:organizationId',
    withPermission('organization.read', { store, authorization, audit }, async (c, tenant) => {
      const organization = await store.findOrganization(tenant.organizationId);
      const membership = await store.findMembership(tenant.organizationId, tenant.userId);
      if (organization === undefined || membership === undefined) {
        throw new Error('resolved tenant is missing its records');
      }
      // What the caller may do here, for the web app to show or hide actions (ADR-0036). A hint
      // only: every route checks its permission again.
      return c.json({
        ...toView(organization, membership),
        permissions: [...authorization.permissionsOf(tenant)].sort(),
      });
    }),
  );
}

/** The public view of an organization, with the caller's own membership in it. */
function toView(organization: Organization, membership: Membership) {
  return {
    organization: {
      id: organization.id,
      name: organization.name,
      status: organization.status,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
    },
    membership: {
      id: membership.id,
      role: membership.role,
      status: membership.status,
      createdAt: membership.createdAt,
    },
  };
}
