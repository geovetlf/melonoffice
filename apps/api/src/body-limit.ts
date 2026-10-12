import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthEnv } from './auth.js';

/**
 * The largest body any `/v1` request may send. The largest one a route accepts is a Company Brain
 * document of 60,000 characters (at most 240 KB as UTF-8, more once escaped in JSON); this leaves
 * room for that and refuses anything far beyond it before a route reads it.
 */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** Document uploads carry the file itself and keep their own, larger limit (ADR-0078). */
const DOCUMENT_UPLOAD = /^\/v1\/organizations\/[^/]+\/documents$/;

/**
 * A declared length over the limit is refused before the body is read; a body without one is cut
 * off at the limit while it is read. Either way the answer is 413 `payload_too_large`, and the
 * route never runs.
 */
export function registerBodyLimit(app: Hono<AuthEnv>): void {
  const limit: MiddlewareHandler = bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  });
  app.use('/v1/*', async (c, next) => {
    if (c.req.method === 'POST' && DOCUMENT_UPLOAD.test(c.req.path)) return next();
    return limit(c, next);
  });
}
