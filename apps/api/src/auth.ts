import type { AuditService } from '@melonoffice/audit';
import {
  authenticate,
  isAuthError,
  verifyRequest,
  type AuthDependencies,
  type AuthErrorCode,
  type AuthenticatedContext,
} from '@melonoffice/auth';
import type { User } from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { recordRequired, requestFields } from './audit.js';

export type AuthEnv = {
  Variables: { logger: Logger; requestId: string; auth: AuthenticatedContext };
};

const STATUS: Record<AuthErrorCode, ContentfulStatusCode> = {
  missing_token: 401,
  invalid_token: 401,
  token_expired: 401,
  user_not_registered: 403,
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
 * Identity routes under /v1. Without auth dependencies or an audit service every /v1 route
 * answers 503, so the API fails closed until both are configured.
 */
export function registerAuthRoutes(
  app: Hono<AuthEnv>,
  deps: AuthDependencies | undefined,
  audit: AuditService | undefined,
): void {
  if (deps === undefined) {
    app.all('/v1/*', (c) => c.json({ error: 'auth_not_configured' }, 503));
    return;
  }
  if (audit === undefined) {
    app.all('/v1/*', (c) => c.json({ error: 'audit_not_configured' }, 503));
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
    // A sign-in is a required event (ADR-0020). Rejected tokens are not recorded: the caller is
    // unidentified, and recording them would let anyone fill the log.
    const unaudited = await recordRequired(c, audit, {
      action: result.created ? 'auth.register' : 'auth.sign_in',
      result: 'success',
      actor: { type: 'user', userId: result.user.id, via: 'direct' },
      target: { type: 'user', id: result.user.id },
      ...requestFields(c),
    });
    if (unaudited) return unaudited;
    return c.json(toMe(result.user), result.created ? 201 : 200);
  });

  // Every other /v1 route needs a registered user.
  app.use('/v1/*', async (c, next) => {
    const context = await guard(c, () =>
      authenticate({ authorization: c.req.header('authorization') }, deps),
    );
    if (context instanceof Response) return context;
    c.set('auth', context);
    await next();
  });

  // Always the caller's own record: the id comes from the verified context, never the request.
  app.get('/v1/me', async (c) => {
    const user = await deps.users.findById(c.get('auth').userId);
    if (user === undefined) return reject(c, 'user_not_registered');
    return c.json(toMe(user));
  });
}

/** The public view of the caller's own user. Organizations are at /v1/me/organizations. */
function toMe(user: User) {
  return {
    userId: user.id,
    email: user.email ?? null,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}
