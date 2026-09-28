import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';

// Every method the web app sends: saving the business profile and the pipeline (PUT), editing a
// contact, an opportunity or a connection (PATCH) and removing a connection (DELETE) included.
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'authorization, content-type, x-request-id';
const EXPOSED_HEADERS = 'x-request-id, www-authenticate';

/**
 * Lets the MelonOffice web app, served from its own origin, call `/v1` from the browser. Only the
 * exact origins configured are answered; any other origin gets no CORS header at all, so the
 * browser refuses to hand it the response. No cookies are involved: the web app sends its
 * Identity Platform token in the `authorization` header, and every route still authenticates and
 * authorizes it. No origin configured: nothing changes (the API stays same-origin only).
 */
export function registerCors(app: Hono<AuthEnv>, origins: readonly string[]): void {
  if (origins.length === 0) return;
  const allowed = new Set(origins);
  app.use('/v1/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin === undefined || !allowed.has(origin)) {
      await next();
      return;
    }
    if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-method') !== undefined) {
      // A preflight carries no token: it is answered here, before authentication.
      return c.body(null, 204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': ALLOWED_METHODS,
        'access-control-allow-headers': ALLOWED_HEADERS,
        'access-control-max-age': '600',
        vary: 'Origin',
      });
    }
    await next();
    c.res.headers.set('access-control-allow-origin', origin);
    c.res.headers.set('access-control-expose-headers', EXPOSED_HEADERS);
    c.res.headers.append('vary', 'Origin');
  });
}
