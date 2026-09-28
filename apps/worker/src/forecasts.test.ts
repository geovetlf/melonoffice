import { createServiceIdentityVerifier } from '@melonoffice/auth';
import { ForecastError, type ForecastTask } from '@melonoffice/forecasting';
import { createLogger } from '@melonoffice/observability';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';
import { createApp, RUN_JOB_PATH } from './app.js';
import { FOLLOW_UP_MAX_ATTEMPTS, RETRY_COUNT_HEADER, RUN_FOLLOW_UP_PATH } from './follow-ups.js';
import { createForecastHandler, RUN_FORECAST_PATH } from './forecasts.js';

const WORKER_URL = 'https://worker-123456789012.us-central1.run.app';
const INVOKER = 'job-dispatch@melonoffice-test.iam.gserviceaccount.com';
const TASK = {
  organizationId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  forecastId: `fc_${'a'.repeat(40)}`,
  run: 1,
};

function fakeEngine(run: () => Promise<string> = async () => 'completed', failed = true) {
  const ran: { task: ForecastTask; final: boolean }[] = [];
  const failedTasks: ForecastTask[] = [];
  return {
    ran,
    failedTasks,
    engine: {
      run: async (task: ForecastTask, options: { final: boolean }) => {
        ran.push({ task, final: options.final });
        return (await run()) as never;
      },
      fail: async (task: ForecastTask) => {
        failedTasks.push(task);
        return failed;
      },
    },
  };
}

describe('forecast handler (ADR-0059)', () => {
  it('hands exactly { organizationId, forecastId, run } to the engine', async () => {
    const f = fakeEngine();
    const handler = createForecastHandler({ engine: f.engine });
    expect(await handler.run(TASK, 0)).toEqual({ status: 200, body: { result: 'completed' } });
    expect(f.ran).toEqual([{ task: TASK, final: false }]);
    for (const bad of [
      null,
      [],
      { ...TASK, extra: 1 },
      { ...TASK, run: 0 },
      { ...TASK, organizationId: 'x' },
      { ...TASK, forecastId: 'fc_short' },
      { organizationId: TASK.organizationId, forecastId: TASK.forecastId },
    ]) {
      expect(await handler.run(bad, 0)).toEqual({
        status: 400,
        body: { result: 'invalid_request' },
      });
    }
    expect(f.ran).toHaveLength(1);
  });

  it('tells the engine when a delivery is the last one, as the queue retries it', async () => {
    const f = fakeEngine();
    const handler = createForecastHandler({ engine: f.engine });
    await handler.run(TASK, FOLLOW_UP_MAX_ATTEMPTS - 2);
    await handler.run(TASK, FOLLOW_UP_MAX_ATTEMPTS - 1);
    expect(f.ran.map((r) => r.final)).toEqual([false, true]);
  });

  it('asks for a retry with 503, and on the last delivery keeps the forecast as failed', async () => {
    const down = async (): Promise<string> => {
      throw new ForecastError('forecast_model_unavailable');
    };
    const f = fakeEngine(down);
    const handler = createForecastHandler({ engine: f.engine });
    expect(await handler.run(TASK, 0)).toEqual({
      status: 503,
      body: { result: 'unavailable', code: 'forecast_model_unavailable' },
    });
    expect(f.failedTasks).toEqual([]);
    expect(await handler.run(TASK, FOLLOW_UP_MAX_ATTEMPTS - 1)).toMatchObject({
      status: 200,
      body: { result: 'failed' },
    });
    expect(f.failedTasks).toEqual([TASK]);
  });
});

describe('POST /internal/forecasts/run (ADR-0059)', () => {
  async function setup(withForecasts = true) {
    const signer = await google();
    const f = fakeEngine();
    const app = createApp({
      logger: createLogger({ service: 'worker', sink: () => undefined }),
      version: 'test',
      jobs: {
        handler: { run: async () => ({ status: 200, body: { result: 'done' } }) } as never,
        invoker: createServiceIdentityVerifier({
          audience: WORKER_URL,
          allowedEmails: [INVOKER],
          keys: signer.keys,
        }),
        ...(withForecasts ? { forecasts: createForecastHandler({ engine: f.engine }) } : {}),
      },
    });
    const deliver = async (body: unknown, headers: Record<string, string> = {}, token?: string) => {
      const response = await app.request(RUN_FORECAST_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token ?? (await signer.token())}`,
          ...headers,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    return { signer, f, deliver };
  }

  it('runs only for the queue invoker, with the same checks as jobs', async () => {
    const w = await setup();
    expect(await w.deliver(TASK)).toEqual({ status: 200, body: { result: 'completed' } });
    const other = await w.signer.token({ email: 'other@x.iam.gserviceaccount.com' });
    expect((await w.deliver(TASK, {}, other)).status).toBe(403);
    expect((await w.deliver(TASK, { authorization: '' })).status).toBe(401);
    expect((await w.deliver(TASK, { 'content-type': 'text/plain' })).status).toBe(400);
    expect(w.f.ran).toHaveLength(1);
  });

  it('passes the retry count, and is refused where forecasts are not configured', async () => {
    const w = await setup();
    await w.deliver(TASK, { [RETRY_COUNT_HEADER]: String(FOLLOW_UP_MAX_ATTEMPTS - 1) });
    expect(w.f.ran[0]?.final).toBe(true);
    const none = await setup(false);
    expect(await none.deliver(TASK)).toEqual({
      status: 503,
      body: { error: 'forecasts_not_configured' },
    });
    expect(new Set([RUN_FORECAST_PATH, RUN_FOLLOW_UP_PATH, RUN_JOB_PATH]).size).toBe(3);
  });
});

async function google() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'google', alg: 'RS256', use: 'sig' };
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    keys: createLocalJWKSet({ keys: [jwk] }),
    async token(claims: Record<string, unknown> = {}) {
      return new SignJWT({
        iss: 'https://accounts.google.com',
        aud: WORKER_URL,
        sub: '1234567890',
        email: INVOKER,
        email_verified: true,
        iat: nowSeconds - 10,
        exp: nowSeconds + 3600,
        ...claims,
      } as JWTPayload)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'google' })
        .sign(privateKey);
    },
  };
}
