import { describe, expect, it } from 'vitest';
import { FORECAST_LIMITS, forecastingConfigFromEnv } from './catalogue.js';

describe('36. configurable limits', () => {
  it('defaults to the DEV limits, with no model and no price: runs are refused', () => {
    expect(forecastingConfigFromEnv({})).toEqual({
      fallback: 'on_failure',
      limits: FORECAST_LIMITS,
    });
  });

  it('reads the runtime URL, the credit cost, the fallback and each limit', () => {
    const config = forecastingConfigFromEnv({
      FORECASTER_URL: 'https://forecaster-988106665456.us-central1.run.app',
      FORECAST_CREDITS_PER_RUN: '1',
      FORECAST_FALLBACK: 'off',
      FORECAST_MAX_CONTEXT: '512',
      FORECAST_MAX_HORIZON_DAY: '60',
      FORECAST_PROVIDER_TIMEOUT_MS: '30000',
      FORECAST_MAX_ACTIVE_PER_ORGANIZATION: '1',
      FORECAST_WAIT_MS: '10000',
    });
    expect(config).toMatchObject({
      forecasterUrl: 'https://forecaster-988106665456.us-central1.run.app',
      creditsPerRun: 1,
      fallback: 'off',
      limits: {
        maxContext: 512,
        maxHorizon: { day: 60, week: 26, month: 12 },
        providerTimeoutMs: 30_000,
        maxActivePerOrganization: 1,
        waitMs: 10_000,
      },
    });
  });

  it.each([
    ['FORECASTER_URL', 'http://forecaster'],
    ['FORECAST_CREDITS_PER_RUN', '-1'],
    ['FORECAST_CREDITS_PER_RUN', '0.5'],
    ['FORECAST_FALLBACK', 'always'],
    ['FORECAST_MAX_HORIZON_DAY', '200'],
    ['FORECAST_MAX_CONTEXT', '0'],
    ['FORECAST_WAIT_MS', '600000'],
  ])('stops on a malformed %s (%s)', (key, value) => {
    expect(() => forecastingConfigFromEnv({ [key]: value })).toThrow();
  });
});
