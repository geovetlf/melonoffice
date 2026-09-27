import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { setupApp, STORES } from './test-api.js';

const WEB = 'https://web-123456789.us-central1.run.app';
const [[, memory]] = STORES as [[string, () => Parameters<typeof setupApp>[0]]];

describe('the web app calling the API from a browser (ADR-0036)', () => {
  it('answers a preflight from the web origin only, before authentication', async () => {
    const t = setupApp(memory(), undefined, undefined, undefined, undefined, {
      webOrigins: [WEB],
    });
    const preflight = (origin: string) =>
      t.app.request('/v1/me', {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      });
    const ok = await preflight(WEB);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
    // Another origin gets nothing it could use: no CORS header at all.
    const other = await preflight('https://evil.example.com');
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('still authenticates every call: the origin grants nothing', async () => {
    const t = setupApp(memory(), undefined, undefined, undefined, undefined, {
      webOrigins: [WEB],
    });
    const anonymous = await t.app.request('/v1/me', { headers: { origin: WEB } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(anonymous.headers.get('access-control-expose-headers')).toContain('www-authenticate');
    await t.register('token-alice');
    const me = await t.app.request('/v1/me', t.as('token-alice', { headers: { origin: WEB } }));
    expect(me.status).toBe(200);
    const elsewhere = await t.app.request(
      '/v1/me',
      t.as('token-alice', { headers: { origin: 'https://evil.example.com' } }),
    );
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sends no CORS header when no web origin is configured', async () => {
    const t = setupApp(memory());
    const response = await t.app.request('/v1/me', {
      method: 'OPTIONS',
      headers: { origin: WEB, 'access-control-request-method': 'GET' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reads exact origins only from WEB_ORIGINS', () => {
    expect(loadConfig({}).webOrigins).toBeUndefined();
    expect(loadConfig({ WEB_ORIGINS: `${WEB}, http://localhost:5173` }).webOrigins).toEqual([
      WEB,
      'http://localhost:5173',
    ]);
    for (const bad of ['*', 'http://example.com', 'https://a.b/path', 'https://*.run.app', 'web']) {
      expect(() => loadConfig({ WEB_ORIGINS: bad })).toThrow('Invalid WEB_ORIGINS entry');
    }
  });
});
