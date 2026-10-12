import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_BODY_BYTES } from './body-limit.js';
import { setupApp, STORES } from './test-api.js';

describe.each(STORES)('request body limit with storage in %s', (_name, createStores) => {
  async function setup() {
    const ctx = setupApp(createStores());
    await ctx.register('token-alice');
    const created = await ctx.app.request(
      '/v1/organizations',
      ctx.as('token-alice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pollería X' }),
      }),
    );
    const { organization } = (await created.json()) as { organization: { id: string } };
    const send = async (path: string, body: string, headers: Record<string, string> = {}) => {
      const response = await ctx.app.request(
        path,
        ctx.as('token-alice', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body,
        }),
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    return { send, org: organization.id };
  }

  it('refuses a body over the limit, declared or not, before the route reads it', async () => {
    const { send, org } = await setup();
    const brain = `/v1/organizations/${org}/brain/documents`;
    const tooLarge = JSON.stringify({
      name: 'Carta.txt',
      text: 'x'.repeat(MAX_REQUEST_BODY_BYTES),
    });
    expect(await send(brain, tooLarge)).toEqual({
      status: 413,
      body: { error: 'payload_too_large' },
    });
    const declared = await send(brain, JSON.stringify({ name: 'Carta.txt', text: 'x' }), {
      'content-length': String(MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(declared).toEqual({ status: 413, body: { error: 'payload_too_large' } });
  });

  it('lets the largest body a route accepts through', async () => {
    const { send, org } = await setup();
    // A Company Brain document at its 60,000-character limit, in four-byte characters.
    const text = '🍗'.repeat(30_000);
    const stored = await send(
      `/v1/organizations/${org}/brain/documents`,
      JSON.stringify({ name: 'Carta.txt', text }),
    );
    expect(stored.status).toBe(200);
  });

  it('leaves document uploads to their own, larger limit', async () => {
    const { send, org } = await setup();
    const upload = await send(
      `/v1/organizations/${org}/documents?name=big.txt`,
      'x'.repeat(MAX_REQUEST_BODY_BYTES + 1),
      { 'content-type': 'text/plain' },
    );
    expect(upload.status).toBe(201);
  });
});
