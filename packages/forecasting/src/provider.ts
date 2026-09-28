import type { ForecastModelRef } from './model.js';
import type { ForecastFrequency } from './periods.js';

/** What a model receives: numbers and a frequency. Never a name, an id or business context. */
export interface ForecastModelInput {
  readonly values: readonly number[];
  readonly horizon: number;
  readonly frequency: ForecastFrequency;
}

export interface ForecastModelOutput {
  /** The median per period. */
  readonly point: readonly number[];
  /** The 0.1…0.9 quantiles per period (9 values each). */
  readonly quantiles: readonly (readonly number[])[];
  readonly usage?: { readonly inferenceMs?: number; readonly memoryMb?: number };
}

export class ForecastProviderError extends Error {
  override readonly name = 'ForecastProviderError';

  constructor(
    readonly code:
      | 'provider_timeout'
      | 'provider_unavailable'
      | 'provider_rejected'
      | 'provider_invalid_output'
      | 'provider_auth_failed',
    readonly status?: number,
  ) {
    super(status === undefined ? code : `${code}: ${status}`);
  }
}

/**
 * A forecasting model (ADR-0059). The engine knows only this: another model is another provider,
 * and GIA, the departments and the stored forecasts do not change. `model` names exactly which
 * model and version answers, and is part of the cache key.
 */
export interface ForecastModelProvider {
  readonly model: ForecastModelRef;
  forecast(input: ForecastModelInput, signal: AbortSignal): Promise<ForecastModelOutput>;
}

/**
 * TimesFM 2.5 as deployed (audit: `MelonOffice-TimesFM-2.5-Audit.md`): Google Research's 200M
 * model, package `timesfm==2.0.2`, checkpoint `google/timesfm-2.5-200m-pytorch` at revision
 * `d418f3e8`. The runtime reports the same version on every answer; any other is refused.
 */
export const TIMESFM_MODEL: ForecastModelRef = Object.freeze({
  provider: 'timesfm',
  id: 'timesfm-2.5-200m',
  version: '2.0.2+d418f3e8',
  kind: 'model',
});

/** The metadata server's identity-token endpoint: the service's own identity, no key. */
export const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

/** An ID token for calling a private Cloud Run service, from the runtime's own identity. */
export function metadataIdentityTokens(options: {
  readonly audience: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): () => Promise<string> {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; until: number } | undefined;
  return async () => {
    if (cached !== undefined && now() < cached.until) return cached.token;
    const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(options.audience)}`;
    let response: Response;
    try {
      response = await http(url, { headers: { 'Metadata-Flavor': 'Google' } });
    } catch {
      throw new ForecastProviderError('provider_auth_failed');
    }
    if (!response.ok) throw new ForecastProviderError('provider_auth_failed', response.status);
    const token = (await response.text()).trim();
    if (token === '') throw new ForecastProviderError('provider_auth_failed');
    // Google ID tokens last an hour; take a fresh one well before.
    cached = { token, until: now() + 45 * 60_000 };
    return token;
  };
}

const isNumbers = (v: unknown, length: number): v is number[] =>
  Array.isArray(v) &&
  v.length === length &&
  v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * The TimesFM provider: a call to the private `forecaster` service (Python, Cloud Run), which
 * holds the model. It sends only the prepared numbers, with an ID token of the caller's own
 * identity, and checks every answer: its model version, its lengths and that every value is a
 * finite number. The service never reads Firestore or anything else.
 */
export function createTimesFMProvider(options: {
  /** The forecaster's URL (`https://forecaster-….run.app`). */
  readonly url: string;
  readonly token: () => Promise<string>;
  readonly fetch?: typeof fetch;
}): ForecastModelProvider {
  if (!options.url.startsWith('https://') && !options.url.startsWith('http://127.0.0.1')) {
    throw new Error('The forecaster URL must be https');
  }
  const http = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/$/, '')}/v1/forecast`;
  return Object.freeze({
    model: TIMESFM_MODEL,
    async forecast(input: ForecastModelInput, signal: AbortSignal) {
      const token = await options.token();
      let response: Response;
      try {
        response = await http(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            values: input.values,
            horizon: input.horizon,
            frequency: input.frequency,
          }),
          signal,
        });
      } catch {
        throw new ForecastProviderError(
          signal.aborted ? 'provider_timeout' : 'provider_unavailable',
        );
      }
      if (response.status === 400 || response.status === 413 || response.status === 422) {
        throw new ForecastProviderError('provider_rejected', response.status);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ForecastProviderError('provider_auth_failed', response.status);
      }
      if (!response.ok) throw new ForecastProviderError('provider_unavailable', response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ForecastProviderError('provider_invalid_output');
      }
      return checkOutput(body, input.horizon);
    },
  });
}

function checkOutput(body: unknown, horizon: number): ForecastModelOutput {
  if (typeof body !== 'object' || body === null) {
    throw new ForecastProviderError('provider_invalid_output');
  }
  const { model, point, quantiles, usage } = body as Record<string, unknown>;
  const reported = model as Record<string, unknown> | undefined;
  if (reported?.id !== TIMESFM_MODEL.id || reported.version !== TIMESFM_MODEL.version) {
    throw new ForecastProviderError('provider_invalid_output');
  }
  if (!isNumbers(point, horizon)) throw new ForecastProviderError('provider_invalid_output');
  if (!Array.isArray(quantiles) || quantiles.length !== horizon) {
    throw new ForecastProviderError('provider_invalid_output');
  }
  for (const row of quantiles as unknown[]) {
    if (!isNumbers(row, 9)) throw new ForecastProviderError('provider_invalid_output');
  }
  const u = (usage ?? {}) as Record<string, unknown>;
  const metric = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  const inferenceMs = metric(u.inferenceMs);
  const memoryMb = metric(u.memoryMb);
  return {
    point,
    quantiles: quantiles as number[][],
    usage: {
      ...(inferenceMs === undefined ? {} : { inferenceMs }),
      ...(memoryMb === undefined ? {} : { memoryMb }),
    },
  };
}
