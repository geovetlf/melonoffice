import { createLogger } from '@melonoffice/observability';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

function setup() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'worker',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { app: createApp({ logger, version: '1.2.3' }), lines };
}

describe('GET /health', () => {
  it('reports the service as healthy', async () => {
    const { app } = setup();
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'worker', version: '1.2.3' });
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
    expect(loadConfig({})).toEqual({ port: 8080, logLevel: 'info', version: 'dev', agents: {} });
  });

  it('reads the environment', () => {
    expect(loadConfig({ PORT: '3000', LOG_LEVEL: 'debug', SERVICE_VERSION: 'abc' })).toEqual({
      port: 3000,
      logLevel: 'debug',
      version: 'abc',
      agents: {},
    });
  });

  it('reads the conversation agents’ settings, all checked (ADR-0043)', () => {
    expect(
      loadConfig({
        VERTEX_AI_PROJECT_ID: 'melonoffice',
        VERTEX_AI_LOCATION: 'us-central1',
        CHANNEL_SECRETS_PROJECT_ID: 'melonoffice',
        WHATSAPP_GRAPH_API_VERSION: 'v21.0',
      }).agents,
    ).toEqual({
      vertexAI: { projectId: 'melonoffice', location: 'us-central1' },
      channelSecretsProjectId: 'melonoffice',
      whatsappGraphApiVersion: 'v21.0',
    });
    expect(
      loadConfig({
        DEEPSEEK_API_KEY_SECRET: 'projects/melonoffice/secrets/ai-deepseek-api-key/versions/latest',
      }).agents,
    ).toEqual({
      deepSeek: {
        keySecret: 'projects/melonoffice/secrets/ai-deepseek-api-key/versions/latest',
      },
    });
    expect(() => loadConfig({ DEEPSEEK_API_KEY_SECRET: 'plain-key-value' })).toThrow(
      'Invalid DEEPSEEK_API_KEY_SECRET',
    );
    expect(
      loadConfig({
        NVIDIA_API_KEY_SECRET: 'projects/melonoffice/secrets/ai-nvidia-api-key/versions/latest',
      }).agents,
    ).toEqual({
      nvidia: { keySecret: 'projects/melonoffice/secrets/ai-nvidia-api-key/versions/latest' },
    });
    expect(() => loadConfig({ NVIDIA_API_KEY_SECRET: 'plain-key-value' })).toThrow(
      'Invalid NVIDIA_API_KEY_SECRET',
    );
    expect(() => loadConfig({ VERTEX_AI_PROJECT_ID: 'melonoffice' })).toThrow('set together');
    expect(() =>
      loadConfig({ VERTEX_AI_PROJECT_ID: 'Bad_Id', VERTEX_AI_LOCATION: 'us-central1' }),
    ).toThrow('Invalid VERTEX_AI_PROJECT_ID');
    expect(() => loadConfig({ CHANNEL_SECRETS_PROJECT_ID: 'x' })).toThrow(
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
