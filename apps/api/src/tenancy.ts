import {
  createOrganization,
  isTenancyError,
  listMyOrganizations,
  resolveTenant,
  type TenancyErrorCode,
  type TenancyStore,
} from '@melonoffice/tenancy';
import type { Membership, Organization } from '@melonoffice/domain';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';

const STATUS: Record<TenancyErrorCode, ContentfulStatusCode> = {
  invalid_organization_name: 400,
  organization_limit_reached: 409,
  organization_required: 403,
  organization_forbidden: 403,
  requires_user: 403,
};

async function guard<T>(c: Context<AuthEnv>, run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (error) {
    if (!isTenancyError(error)) throw error;
    c.get('logger').warn('tenancy rejected', { code: error.code });
    return c.json({ error: error.code }, STATUS[error.code]);
  }
}

/**
 * Organization routes under /v1 (ADR-0018). They run after authentication, so `auth` is always
 * the verified caller; the user id is never read from the request. Without a store they answer
 * 503, failing closed.
 */
export function registerTenancyRoutes(app: Hono<AuthEnv>, store: TenancyStore | undefined): void {
  if (store === undefined) {
    app.all('/v1/organizations', (c) => c.json({ error: 'tenancy_not_configured' }, 503));
    app.all('/v1/organizations/*', (c) => c.json({ error: 'tenancy_not_configured' }, 503));
    app.all('/v1/me/organizations', (c) => c.json({ error: 'tenancy_not_configured' }, 503));
    return;
  }

  // Only `name` is read from the body. Anything else, such as an id, owner or status, is ignored.
  app.post('/v1/organizations', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const name =
      typeof body === 'object' && body !== null ? (body as { name?: unknown }).name : undefined;
    const result = await guard(c, () => createOrganization(c.get('auth'), { name }, store));
    if (result instanceof Response) return result;
    return c.json(toView(result.organization, result.membership), 201);
  });

  app.get('/v1/me/organizations', async (c) => {
    const mine = await listMyOrganizations(c.get('auth'), store);
    return c.json({
      organizations: mine.map(({ organization, membership }) => toView(organization, membership)),
    });
  });

  // The path id only selects; resolveTenant grants access through an active membership.
  app.get('/v1/organizations/:organizationId', async (c) => {
    const result = await guard(c, async () => {
      const tenant = await resolveTenant(c.get('auth'), c.req.param('organizationId'), store);
      const organization = await store.findOrganization(tenant.organizationId);
      const membership = await store.findMembership(tenant.organizationId, tenant.userId);
      if (organization === undefined || membership === undefined) {
        throw new Error('resolved tenant is missing its records');
      }
      return toView(organization, membership);
    });
    if (result instanceof Response) return result;
    return c.json(result);
  });
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
