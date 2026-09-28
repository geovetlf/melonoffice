import { describe, expect, it } from 'vitest';
import { createFallbackProvider, FALLBACK_MODEL } from './fallback.js';
import {
  createTimesFMProvider,
  ForecastProviderError,
  METADATA_IDENTITY_URL,
  metadataIdentityTokens,
  TIMESFM_MODEL,
} from './provider.js';

const URL_ = 'https://forecaster-1.us-central1.run.app';

/** A forecaster that answers like the real one, recording what it received. */
function forecaster(answer: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, init, body });
    return answer(body);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const good = (body: Record<string, unknown>) => {
  const h = body.horizon as number;
  return Response.json({
    model: { id: TIMESFM_MODEL.id, version: TIMESFM_MODEL.version },
    point: Array.from({ length: h }, () => 10),
    quantiles: Array.from({ length: h }, () => [6, 7, 8, 9, 10, 11, 12, 13, 14]),
    usage: { inferenceMs: 512.4, memoryMb: 1431 },
  });
};

const INPUT = { values: [1, 2, 3, 4], horizon: 3, frequency: 'day' as const };
const signal = () => new AbortController().signal;

describe('2. the TimesFM provider', () => {
  it('names TimesFM 2.5 exactly, with its package and checkpoint', () => {
    expect(TIMESFM_MODEL).toEqual({
      provider: 'timesfm',
      id: 'timesfm-2.5-200m',
      version: '2.0.2+d418f3e8',
      kind: 'model',
    });
  });

  it('sends only the numbers, the horizon and the frequency, with an ID token', async () => {
    const { calls, fetchFn } = forecaster(good);
    const provider = createTimesFMProvider({
      url: URL_,
      token: async () => 'id-token',
      fetch: fetchFn,
    });
    const output = await provider.forecast(INPUT, signal());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${URL_}/v1/forecast`);
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(['frequency', 'horizon', 'values']);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer id-token',
    );
    expect(output.point).toEqual([10, 10, 10]);
    expect(output.quantiles[0]).toHaveLength(9);
    expect(output.usage).toEqual({ inferenceMs: 512, memoryMb: 1431 });
  });

  it('refuses an answer from another model or version', async () => {
    const { fetchFn } = forecaster((body) =>
      good(body)
        .json()
        .then((json: unknown) =>
          Response.json({ ...(json as object), model: { id: TIMESFM_MODEL.id, version: '3.0.2' } }),
        ),
    );
    const provider = createTimesFMProvider({ url: URL_, token: async () => 't', fetch: fetchFn });
    await expect(provider.forecast(INPUT, signal())).rejects.toMatchObject({
      code: 'provider_invalid_output',
    });
  });

  it.each([
    ['a short point list', { point: [1] }],
    ['a NaN', { point: [1, 'NaN', 1] }],
    ['a quantile row of the wrong size', { quantiles: [[1], [1], [1]] }],
  ])('refuses %s', async (_, patch) => {
    const { fetchFn } = forecaster((body) =>
      good(body)
        .json()
        .then((json: unknown) => Response.json({ ...(json as object), ...patch })),
    );
    const provider = createTimesFMProvider({ url: URL_, token: async () => 't', fetch: fetchFn });
    await expect(provider.forecast(INPUT, signal())).rejects.toMatchObject({
      code: 'provider_invalid_output',
    });
  });

  it('maps the runtime answers to codes: 400 rejected, 403 auth, 503 unavailable', async () => {
    for (const [status, code] of [
      [400, 'provider_rejected'],
      [403, 'provider_auth_failed'],
      [503, 'provider_unavailable'],
    ] as const) {
      const { fetchFn } = forecaster(() => new Response('{}', { status }));
      const provider = createTimesFMProvider({ url: URL_, token: async () => 't', fetch: fetchFn });
      await expect(provider.forecast(INPUT, signal())).rejects.toMatchObject({ code });
    }
  });

  it('26. reports a timeout when the call is aborted', async () => {
    const fetchFn = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const provider = createTimesFMProvider({ url: URL_, token: async () => 't', fetch: fetchFn });
    await expect(provider.forecast(INPUT, AbortSignal.timeout(20))).rejects.toMatchObject({
      code: 'provider_timeout',
    });
  });

  it('refuses a plain http URL', () => {
    expect(() =>
      createTimesFMProvider({ url: 'http://forecaster', token: async () => 't' }),
    ).toThrow();
  });

  it('takes its ID token from the metadata server, for the forecaster audience, and reuses it', async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      asked.push(url);
      expect((init.headers as Record<string, string>)['Metadata-Flavor']).toBe('Google');
      return new Response('token-1\n');
    }) as unknown as typeof fetch;
    let now = 0;
    const tokens = metadataIdentityTokens({ audience: URL_, fetch: fetchFn, now: () => now });
    expect(await tokens()).toBe('token-1');
    expect(await tokens()).toBe('token-1');
    expect(asked).toEqual([`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(URL_)}`]);
    now = 46 * 60_000;
    await tokens();
    expect(asked).toHaveLength(2);
  });

  it('fails closed when there is no identity to call with', async () => {
    const fetchFn = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(
      metadataIdentityTokens({ audience: URL_, fetch: fetchFn })(),
    ).rejects.toBeInstanceOf(ForecastProviderError);
  });
});

describe('21. the fallback', () => {
  it('is labelled as the fallback and is deterministic', async () => {
    const provider = createFallbackProvider();
    expect(provider.model).toEqual(FALLBACK_MODEL);
    expect(provider.model.kind).toBe('fallback');
    const values = Array.from({ length: 35 }, (_, i) => (i % 7 === 5 ? 30 : 10));
    const a = await provider.forecast({ values, horizon: 7, frequency: 'day' }, signal());
    const b = await provider.forecast({ values, horizon: 7, frequency: 'day' }, signal());
    expect(a).toEqual(b);
    // The weekly pattern is kept: the same weekday is predicted from the same weekdays.
    expect(a.point).toEqual([10, 10, 10, 10, 10, 30, 10]);
    expect(a.quantiles.every((q) => q.length === 9)).toBe(true);
  });

  it('never predicts below zero for a non-negative metric', async () => {
    const values = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0 : 20));
    const out = await createFallbackProvider().forecast(
      { values, horizon: 5, frequency: 'week' },
      signal(),
    );
    expect(out.quantiles.flat().every((v) => v >= 0)).toBe(true);
  });
});
