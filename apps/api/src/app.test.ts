import { createLogger } from '@melonoffice/observability';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

function setup() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'api',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { app: createApp({ logger, version: '1.2.3' }), lines };
}

describe('GET /health', () => {
  it('reports the service as healthy', async () => {
    const { app } = setup();
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'api', version: '1.2.3' });
  });

  it('returns and logs a request id', async () => {
    const { app, lines } = setup();
    const response = await app.request('/health');
    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(/^[\w-]+$/);
    expect(lines).toContainEqual(
      expect.objectContaining({ message: 'request', requestId, path: '/health', status: 200 }),
    );
  });

  it('reuses a well-formed incoming request id and ignores a malformed one', async () => {
    const { app } = setup();
    const reused = await app.request('/health', { headers: { 'x-request-id': 'abc-123' } });
    expect(reused.headers.get('x-request-id')).toBe('abc-123');
    const replaced = await app.request('/health', { headers: { 'x-request-id': 'bad id\n' } });
    expect(replaced.headers.get('x-request-id')).not.toBe('bad id\n');
  });
});

describe('unknown routes', () => {
  it('return a JSON 404', async () => {
    const { app } = setup();
    const response = await app.request('/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    expect(loadConfig({})).toEqual({ port: 8080, logLevel: 'info', version: 'dev' });
  });

  it('reads the environment', () => {
    expect(loadConfig({ PORT: '3000', LOG_LEVEL: 'debug', SERVICE_VERSION: 'abc' })).toEqual({
      port: 3000,
      logLevel: 'debug',
      version: 'abc',
    });
  });

  it('turns auth on only with a valid project id', () => {
    expect(loadConfig({}).identityProjectId).toBeUndefined();
    expect(loadConfig({ IDENTITY_PLATFORM_PROJECT_ID: 'melonoffice' }).identityProjectId).toBe(
      'melonoffice',
    );
    for (const bad of ['', 'Melon', 'a', 'x/../y', 'melonoffice-']) {
      expect(() => loadConfig({ IDENTITY_PLATFORM_PROJECT_ID: bad })).toThrow(
        'Invalid IDENTITY_PLATFORM_PROJECT_ID',
      );
    }
  });

  it('turns channels on only with a valid secrets project, and never guesses a Graph version', () => {
    expect(loadConfig({}).channelSecretsProjectId).toBeUndefined();
    expect(loadConfig({}).whatsappGraphApiVersion).toBeUndefined();
    expect(
      loadConfig({
        CHANNEL_SECRETS_PROJECT_ID: 'melonoffice',
        WHATSAPP_GRAPH_API_VERSION: 'v23.0',
      }),
    ).toMatchObject({ channelSecretsProjectId: 'melonoffice', whatsappGraphApiVersion: 'v23.0' });
    expect(() => loadConfig({ CHANNEL_SECRETS_PROJECT_ID: 'x/../y' })).toThrow(
      'Invalid CHANNEL_SECRETS_PROJECT_ID',
    );
    expect(() => loadConfig({ WHATSAPP_GRAPH_API_VERSION: 'latest' })).toThrow(
      'Invalid WHATSAPP_GRAPH_API_VERSION',
    );
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ PORT: 'x' })).toThrow('Invalid PORT');
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow('Invalid LOG_LEVEL');
  });
});
