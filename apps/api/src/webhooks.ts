import type { WebhookIngress } from '@melonoffice/integrations';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthEnv } from './auth.js';

/** Meta sends far less; anything larger is refused before it is read. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * Channel webhooks (ADR-0033), outside `/v1`: the provider has no user token. The only authority
 * is the provider's signature, checked by the ingress with the connection's own secret; the
 * organization comes from the stored connection, never from the request. The route receives,
 * hands the exact raw body over and acknowledges. It never runs a model, a tool or a workflow.
 * Without an ingress (no secret store configured) every webhook answers 503.
 */
export function registerWebhookRoutes(
  app: Hono<AuthEnv>,
  ingress: WebhookIngress | undefined,
): void {
  const path = '/webhooks/:channel/:connectionId';
  if (ingress === undefined) {
    app.all(path, (c) => c.json({ error: 'channels_not_configured' }, 503));
    return;
  }

  app.get(path, async (c) => {
    const answer = await ingress.handshake(
      c.req.param('channel'),
      c.req.param('connectionId'),
      new URL(c.req.url).searchParams,
    );
    return typeof answer.body === 'string'
      ? c.text(answer.body, answer.status)
      : c.json(answer.body, answer.status);
  });

  app.post(
    path,
    bodyLimit({
      maxSize: MAX_WEBHOOK_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
    async (c) => {
      const type = c.req.header('content-type') ?? '';
      if (!/^application\/json(\s*;.*)?$/i.test(type)) {
        return c.json({ error: 'unsupported_media_type' }, 415);
      }
      // The signature covers the exact bytes: the body is read as text, never re-serialized.
      const rawBody = await c.req.text();
      const answer = await ingress.deliver(
        c.req.param('channel'),
        c.req.param('connectionId'),
        rawBody,
        c.req.raw.headers,
      );
      return typeof answer.body === 'string'
        ? c.text(answer.body, answer.status)
        : c.json(answer.body, answer.status);
    },
  );
}
