import type { ForecastFrequency } from './periods.js';

/**
 * The metrics a forecast can be asked for (ADR-0059). It is data: a department, GIA or a report
 * names a metric by id and never knows where its values come from. Adding a metric is a new
 * entry here and a source for it; no consumer changes.
 *
 * Only what MelonOffice actually records is here. There are no orders, stock, production or
 * campaign spend records yet, so there are no metrics for them: a question about orders gets
 * "no data", never another metric passed off as orders.
 */
export interface ForecastMetric {
  readonly id: string;
  /** What a value is: money in the metric's currency, or a count of records. */
  readonly unit: 'currency' | 'count';
  /**
   * What an absent period means. `zero`: the metric counts or sums events, so a period without
   * any really had zero (no sale that day). Declared per metric, never guessed from the data.
   */
  readonly absentPeriod: 'zero';
  /** Values can never be negative (a count, a won amount). A negative one is invalid input. */
  readonly nonNegative: boolean;
  /**
   * What `entity` narrows the series to: its currency (money is never added across
   * currencies), a source kind or a channel. `all` needs no entity.
   */
  readonly entity: 'currency' | 'source_kind' | 'channel' | 'all';
  /** The permission that reads the records the metric is built from. */
  readonly permission: 'opportunity.read' | 'contact.read' | 'conversation.read';
  readonly frequencies: readonly ForecastFrequency[];
  /**
   * The department types it serves (catalogue ids, ADR-0047). A request made for a department
   * must name one of them; the list is data and no code compares department names.
   */
  readonly departments: readonly string[];
}

const ALL_FREQUENCIES = ['day', 'week', 'month'] as const;

export const FORECAST_METRICS: readonly ForecastMetric[] = Object.freeze([
  // C2 opportunities won, by the local date they were closed: revenue actually won.
  {
    id: 'sales.won_value',
    unit: 'currency',
    absentPeriod: 'zero',
    nonNegative: true,
    entity: 'currency',
    permission: 'opportunity.read',
    frequencies: ALL_FREQUENCIES,
    departments: ['sales', 'leadership', 'finance', 'research'],
  },
  {
    id: 'sales.won_count',
    unit: 'count',
    absentPeriod: 'zero',
    nonNegative: true,
    entity: 'all',
    permission: 'opportunity.read',
    frequencies: ALL_FREQUENCIES,
    departments: ['sales', 'leadership', 'operations', 'finance', 'research'],
  },
  // C2 opportunities opened: demand entering the pipeline.
  {
    id: 'opportunities.new',
    unit: 'count',
    absentPeriod: 'zero',
    nonNegative: true,
    entity: 'all',
    permission: 'opportunity.read',
    frequencies: ALL_FREQUENCIES,
    departments: ['sales', 'marketing', 'leadership', 'research'],
  },
  // C1 contacts with a commercial profile (leads and customers), by the date they entered.
  {
    id: 'leads.new',
    unit: 'count',
    absentPeriod: 'zero',
    nonNegative: true,
    entity: 'source_kind',
    permission: 'contact.read',
    frequencies: ALL_FREQUENCIES,
    departments: ['sales', 'marketing', 'leadership', 'research'],
  },
  // Conversations started (ADR-0033): incoming demand and service load.
  {
    id: 'conversations.new',
    unit: 'count',
    absentPeriod: 'zero',
    nonNegative: true,
    entity: 'channel',
    permission: 'conversation.read',
    frequencies: ALL_FREQUENCIES,
    departments: ['operations', 'sales', 'marketing', 'leadership', 'research'],
  },
] satisfies readonly ForecastMetric[]);

export const findForecastMetric = (id: unknown): ForecastMetric | undefined =>
  typeof id === 'string' ? FORECAST_METRICS.find((m) => m.id === id) : undefined;

/**
 * The limits of a forecast (ADR-0059). Defaults for DEV; each can be set by configuration
 * (`forecastLimitsFromEnv`) without a code change.
 */
export interface ForecastLimits {
  /** The longest history sent to the model, in periods; older periods are left out. */
  readonly maxContext: number;
  /**
   * The furthest a forecast looks ahead, per frequency. At most 128: TimesFM 2.5 predicts 128
   * steps per pass, and a longer horizon would use its autoregressive path (see the audit).
   */
  readonly maxHorizon: Readonly<Record<ForecastFrequency, number>>;
  /** The shortest history worth forecasting, per frequency. Below it: `insufficient_data`. */
  readonly minHistory: Readonly<Record<ForecastFrequency, number>>;
  /** How many periods must have a non-zero value. Mostly empty series are not forecast. */
  readonly minNonZero: number;
  /** The most covariates a request may carry (none are supported by the runtime today). */
  readonly maxCovariates: number;
  /** How long one model call may take before it counts as failed. */
  readonly providerTimeoutMs: number;
  /** How many runs of one organization may be queued or running at once. */
  readonly maxActivePerOrganization: number;
  /** How long a caller may wait for a run to finish before getting `queued`. */
  readonly waitMs: number;
  /** How long a finished forecast answers the same request. */
  readonly cacheTtlMs: number;
  /** A run queued longer than this is taken as lost and queued again. */
  readonly staleRunMs: number;
}

export const FORECAST_LIMITS: ForecastLimits = Object.freeze({
  maxContext: 1024,
  maxHorizon: Object.freeze({ day: 90, week: 26, month: 12 }),
  minHistory: Object.freeze({ day: 28, week: 12, month: 12 }),
  minNonZero: 5,
  maxCovariates: 8,
  providerTimeoutMs: 120_000,
  maxActivePerOrganization: 2,
  waitMs: 20_000,
  cacheTtlMs: 24 * 60 * 60_000,
  staleRunMs: 15 * 60_000,
});

/** The model's own ceiling (output patch of TimesFM 2.5): no limit may go past it. */
export const MODEL_MAX_HORIZON = 128;
/** TimesFM 2.5's context ceiling minus the largest horizon. */
export const MODEL_MAX_CONTEXT = 16_384 - MODEL_MAX_HORIZON;

const positive = (raw: string | undefined, fallback: number, ceiling = Infinity): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new Error(`invalid forecasting limit ${raw}`);
  }
  return value;
};

/** The limits, with any set in the environment (`FORECAST_*`). A bad value stops the start. */
export function forecastLimitsFromEnv(env: Readonly<Record<string, string | undefined>>) {
  const base = FORECAST_LIMITS;
  return Object.freeze({
    maxContext: positive(env.FORECAST_MAX_CONTEXT, base.maxContext, MODEL_MAX_CONTEXT),
    maxHorizon: Object.freeze({
      day: positive(env.FORECAST_MAX_HORIZON_DAY, base.maxHorizon.day, MODEL_MAX_HORIZON),
      week: positive(env.FORECAST_MAX_HORIZON_WEEK, base.maxHorizon.week, MODEL_MAX_HORIZON),
      month: positive(env.FORECAST_MAX_HORIZON_MONTH, base.maxHorizon.month, MODEL_MAX_HORIZON),
    }),
    minHistory: base.minHistory,
    minNonZero: base.minNonZero,
    maxCovariates: base.maxCovariates,
    providerTimeoutMs: positive(env.FORECAST_PROVIDER_TIMEOUT_MS, base.providerTimeoutMs),
    maxActivePerOrganization: positive(
      env.FORECAST_MAX_ACTIVE_PER_ORGANIZATION,
      base.maxActivePerOrganization,
    ),
    waitMs: positive(env.FORECAST_WAIT_MS, base.waitMs, 60_000),
    cacheTtlMs: base.cacheTtlMs,
    staleRunMs: base.staleRunMs,
  }) satisfies ForecastLimits;
}

/**
 * The Forecasting Engine's settings, from the environment Terraform sets (ADR-0059). Each part
 * fails closed: without `FORECASTER_URL` there is no model and runs are refused; without
 * `FORECAST_CREDITS_PER_RUN` runs are refused too. A malformed value stops the service.
 */
export interface ForecastingConfig {
  readonly forecasterUrl?: string;
  readonly creditsPerRun?: number;
  readonly fallback: 'on_failure' | 'off';
  readonly limits: ForecastLimits;
}

const FORECASTER_URL = /^https:\/\/[a-z0-9.-]+$/;

export function forecastingConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ForecastingConfig {
  const url = env.FORECASTER_URL;
  if (url !== undefined && url !== '' && !FORECASTER_URL.test(url)) {
    throw new Error(`Invalid FORECASTER_URL: ${url}`);
  }
  const rawCredits = env.FORECAST_CREDITS_PER_RUN;
  let creditsPerRun: number | undefined;
  if (rawCredits !== undefined && rawCredits !== '') {
    creditsPerRun = Number(rawCredits);
    if (!Number.isSafeInteger(creditsPerRun) || creditsPerRun < 0 || creditsPerRun > 1000) {
      throw new Error(`Invalid FORECAST_CREDITS_PER_RUN: ${rawCredits}`);
    }
  }
  const fallback = env.FORECAST_FALLBACK ?? 'on_failure';
  if (fallback !== 'on_failure' && fallback !== 'off') {
    throw new Error(`Invalid FORECAST_FALLBACK: ${fallback}`);
  }
  return Object.freeze({
    ...(url === undefined || url === '' ? {} : { forecasterUrl: url }),
    ...(creditsPerRun === undefined ? {} : { creditsPerRun }),
    fallback,
    limits: forecastLimitsFromEnv(env),
  });
}
