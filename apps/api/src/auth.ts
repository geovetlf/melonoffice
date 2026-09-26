import {
  authenticate,
  isAuthError,
  verifyRequest,
  type AuthDependencies,
  type AuthErrorCode,
  type AuthenticatedContext,
} from '@melonoffice/auth';
import type { OrganizationId, User } from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type AuthEnv = { Variables: { logger: Logger; auth: AuthenticatedContext } };

/** Header a client may send to pick one of its own organizations. It grants nothing by itself. */
export const ORGANIZATION_HEADER = 'x-organization-id';

const STATUS: Record<AuthErrorCode, ContentfulStatusCode> = {
  missing_token: 401,
  invalid_token: 401,
  token_expired: 401,
  user_not_registered: 403,
  organization_required: 403,
  organization_forbidden: 403,
  verifier_unavailable: 503,
};

/** Turns an auth failure into a response. The token and its contents are never logged or returned. */
function reject(c: Context<AuthEnv>, code: AuthErrorCode): Response {
  c.get('logger').warn('auth rejected', { code });
  if (STATUS[code] === 401) {
    const error = code === 'missing_token' ? '' : `, error="invalid_token"`;
    c.header('WWW-Authenticate', `Bearer realm="melonoffice"${error}`);
  }
  return c.json({ error: code }, STATUS[code]);
}

async function guard<T>(c: Context<AuthEnv>, run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (error) {
    if (isAuthError(error)) return reject(c, error.code);
    throw error;
  }
}

/**
 * Identity routes under /v1. Without auth dependencies every /v1 route answers 503, so the API
 * fails closed until persistence for users is configured.
 */
export function registerAuthRoutes(app: Hono<AuthEnv>, deps: AuthDependencies | undefined): void {
  if (deps === undefined) {
    app.all('/v1/*', (c) => c.json({ error: 'auth_not_configured' }, 503));
    return;
  }

  // Records a sign-in: creates the user the first time, then refreshes the email, its verified
  // flag and the sign-in time. The identity comes from the token alone; the body is never read,
  // so it cannot name another user or change the email.
  app.post('/v1/me', async (c) => {
    const result = await guard(c, async () => {
      const identity = await verifyRequest(c.req.header('authorization'), deps.verifier);
      return deps.users.recordSignIn(identity);
    });
    if (result instanceof Response) return result;
    return c.json(toMe(result.user), result.created ? 201 : 200);
  });

  // Every other /v1 route needs a registered user.
  app.use('/v1/*', async (c, next) => {
    const context = await guard(c, () =>
      authenticate(
        {
          authorization: c.req.header('authorization'),
          requestedOrganization: c.req.header(ORGANIZATION_HEADER),
        },
        deps,
      ),
    );
    if (context instanceof Response) return context;
    c.set('auth', context);
    await next();
  });

  // Always the caller's own record: the id comes from the verified context, never the request.
  app.get('/v1/me', async (c) => {
    const auth = c.get('auth');
    const user = await deps.users.findById(auth.userId);
    if (user === undefined) return reject(c, 'user_not_registered');
    return c.json(toMe(user, auth.organizationId));
  });
}

/** The public view of the caller's own user. */
function toMe(user: User, organizationId?: OrganizationId) {
  return {
    userId: user.id,
    email: user.email ?? null,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    organizationId: organizationId ?? null,
  };
}

/** For routes that act inside an organization: refuses a request that has none. */
export function requireOrganization(c: Context<AuthEnv>): Response | undefined {
  return c.get('auth').organizationId === undefined
    ? reject(c, 'organization_required')
    : undefined;
}
