import {
  addPeriods,
  findForecastMetric,
  forecastIntentOf,
  isForecastError,
  type Forecast,
  type ForecastEngine,
  type ForecastFrequency,
  type ForecastIntent,
  type InsufficientCount,
} from '@melonoffice/forecasting';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { TenantContext } from '@melonoffice/tenancy';
import type { GiaLocale } from './catalogue.js';
import { NO_PERMISSION } from './commercial.js';

/**
 * GIA and the Forecasting Engine (ADR-0059). GIA never runs a model: when the person's own words
 * ask for a projection of a metric MelonOffice records, she asks the engine, as that person,
 * like any screen would. The engine checks permissions, reads the records, charges the run and
 * audits it. What GIA gets back is written for the model as data, the history apart from the
 * projection, and she words it; she never adds a figure of her own.
 */

/** The engine as GIA uses it: the same door as the API's. */
export type GiaForecastPort = Pick<ForecastEngine, 'request'>;

/** What GIA knows about the forecast the person asked for, whatever came of it. */
export type GiaForecastContext =
  | { readonly kind: 'forecast'; readonly forecast: Forecast; readonly cache: 'hit' | 'miss' }
  | {
      readonly kind: 'insufficient_data';
      readonly metric: string;
      readonly frequency: ForecastFrequency;
      readonly have: number | null;
      readonly need: number | null;
      /** What `have` and `need` count: periods of history, or periods with activity. */
      readonly shortOf: InsufficientCount | null;
      readonly problem: string;
    }
  | {
      /**
       * The history exists but cannot be read as a series (a gap, a duplicate, a value that is
       * not a number): nothing is missing, so it is never worded as too little history.
       */
      readonly kind: 'invalid_data';
      readonly metric: string;
      readonly frequency: ForecastFrequency;
      readonly problem: string;
    }
  | { readonly kind: 'unsupported'; readonly subject: string }
  | { readonly kind: 'not_allowed' }
  | {
      readonly kind: 'unavailable';
      readonly reason: string;
      /** For `horizon_out_of_range`: what was asked and the longest the engine allows. */
      readonly frequency?: ForecastFrequency;
      readonly horizon?: number;
      readonly maxHorizon?: number;
    };

/**
 * What the answer carries about the forecast, for the app to show beside it: never the history
 * or the numbers themselves, which the app reads from the forecast by its id.
 */
export interface GiaForecastSummary {
  readonly id: string | null;
  readonly status:
    | Forecast['status']
    | 'insufficient_data'
    | 'invalid_data'
    | 'unsupported'
    | 'not_allowed'
    | 'unavailable';
  readonly metric: string | null;
  readonly frequency: ForecastFrequency | null;
  readonly horizon: number | null;
  readonly model: 'model' | 'fallback' | null;
  /**
   * For `insufficient_data`, the engine's own counts: what is recorded, what is needed, and
   * whether they count periods of history or periods with activity. Null otherwise.
   */
  readonly have: number | null;
  readonly need: number | null;
  readonly shortOf: InsufficientCount | null;
  /** For `unavailable`, why, as a code (`business_profile_missing`, `currency_missing`, …). */
  readonly reason: string | null;
  /** For `horizon_out_of_range`, the longest horizon the engine allows for `frequency`. */
  readonly maxHorizon: number | null;
}

/** Engine refusals the person sees as their own reason; any other is "not available now". */
const UNAVAILABLE: Readonly<Record<string, string>> = {
  forecast_credits_insufficient: 'credits_insufficient',
  forecast_limit_reached: 'busy',
  horizon_out_of_range: 'horizon_out_of_range',
  frequency_not_supported: 'frequency_not_supported',
};

/**
 * The company context a projection needs, named by the engine's refusal: the business profile
 * (its time zone) and, for money, the company's currency. Any other invalid request stays
 * "not available": nothing is guessed about it.
 */
const MISSING_CONTEXT: Readonly<Record<string, string>> = {
  business_context: 'business_profile_missing',
  entity: 'currency_missing',
};

/**
 * Asks the engine for the forecast the message asks for, if it asks for one. Only the current
 * message counts: an earlier turn never starts a run, so repeating or rephrasing does not run
 * anything the person did not ask for now. Without `forecast.run` and the metric's own read
 * permission nothing is asked; the engine checks both again.
 */
export async function readForecast(
  port: GiaForecastPort,
  tenant: TenantContext,
  message: string,
  authorization: Pick<AuthorizationService, 'authorize'>,
): Promise<{ intent: ForecastIntent; context: GiaForecastContext } | undefined> {
  const intent = forecastIntentOf(message);
  if (intent === undefined) return undefined;
  if (intent.kind === 'unsupported') {
    return { intent, context: { kind: 'unsupported', subject: intent.subject } };
  }
  const can = (permission: string) => authorization.authorize(tenant, permission).allowed;
  const permission = findForecastMetric(intent.metric)?.permission;
  if (!can('forecast.run') || permission === undefined || !can(permission)) {
    return { intent, context: { kind: 'not_allowed' } };
  }
  try {
    const outcome = await port.request(tenant, {
      metric: intent.metric,
      frequency: intent.frequency,
      horizon: intent.horizon,
      wait: true,
    });
    if (!('forecast' in outcome)) {
      if (outcome.status === 'invalid_data') {
        return {
          intent,
          context: {
            kind: 'invalid_data',
            metric: outcome.metric,
            frequency: outcome.frequency,
            problem: outcome.problem,
          },
        };
      }
      return {
        intent,
        context: {
          kind: 'insufficient_data',
          metric: outcome.metric,
          frequency: outcome.frequency,
          have: outcome.have ?? null,
          need: outcome.need ?? null,
          shortOf: outcome.shortOf ?? null,
          problem: outcome.problem,
        },
      };
    }
    return { intent, context: { kind: 'forecast', ...outcome } };
  } catch (error) {
    if (!isForecastError(error)) throw error;
    if (error.code === 'permission_denied') return { intent, context: { kind: 'not_allowed' } };
    const missing =
      error.code === 'invalid_request' && error.detail !== undefined
        ? MISSING_CONTEXT[error.detail]
        : undefined;
    const reason = missing ?? UNAVAILABLE[error.code] ?? 'not_available';
    if (reason === 'horizon_out_of_range') {
      return {
        intent,
        context: {
          kind: 'unavailable',
          reason,
          frequency: intent.frequency,
          horizon: intent.horizon,
          ...(error.limit === undefined ? {} : { maxHorizon: error.limit }),
        },
      };
    }
    return { intent, context: { kind: 'unavailable', reason } };
  }
}

export function forecastSummaryOf(context: GiaForecastContext): GiaForecastSummary {
  if (context.kind === 'forecast') {
    const f = context.forecast;
    return Object.freeze({
      id: f.id,
      status: f.status,
      metric: f.metric,
      frequency: f.frequency,
      horizon: f.horizon,
      model: f.result?.model.kind ?? null,
      have: null,
      need: null,
      shortOf: null,
      reason: null,
      maxHorizon: null,
    });
  }
  const short = context.kind === 'insufficient_data' ? context : undefined;
  const series =
    context.kind === 'insufficient_data' || context.kind === 'invalid_data' ? context : undefined;
  const unavailable = context.kind === 'unavailable' ? context : undefined;
  return Object.freeze({
    id: null,
    status: context.kind,
    metric: series?.metric ?? null,
    frequency: series?.frequency ?? unavailable?.frequency ?? null,
    horizon: unavailable?.horizon ?? null,
    model: null,
    have: short?.have ?? null,
    need: short?.need ?? null,
    shortOf: short?.shortOf ?? null,
    reason: unavailable?.reason ?? null,
    maxHorizon: unavailable?.maxHorizon ?? null,
  });
}

const METRIC_WORDS: Readonly<Record<string, string>> = {
  'sales.won_value': 'money from sales won (opportunities closed as won)',
  'sales.won_count': 'number of sales won (opportunities closed as won)',
  'opportunities.new': 'new opportunities opened',
  'leads.new': 'new leads and customers registered',
  'conversations.new': 'new customer conversations started',
};

/** Where each metric's records come from, so GIA can say what to record. */
const METRIC_RECORDS: Readonly<Record<string, string>> = {
  'sales.won_value': 'opportunities closed as won in Comercial, with their value',
  'sales.won_count': 'opportunities closed as won in Comercial',
  'opportunities.new': 'opportunities created in Comercial',
  'leads.new': 'leads and customers registered in Comercial',
  'conversations.new': 'customer conversations started in Conversations',
};

/** Why a projection is not available, in words, when the engine named the missing context. */
const UNAVAILABLE_WORDS: Readonly<Record<string, string>> = {
  business_profile_missing:
    'The company information has no business profile yet. A projection needs its time zone to count days. It is filled in under Company memory, Company information.',
  currency_missing:
    "The company's currency is not recorded, and projecting money needs it. It is set in Company memory, Company information.",
};

/** What is wrong with a recorded history that exists but cannot be projected (`invalid_data`). */
const PROBLEM_WORDS: Readonly<Record<string, string>> = {
  invalid_series: 'the recorded history could not be read as a series',
  invalid_timestamp: 'a recorded date could not be read',
  duplicate_timestamp: 'the same period was recorded twice',
  irregular_frequency: 'the recorded periods are not evenly spaced',
  invalid_value: 'a recorded value is not a valid number',
  missing_values: 'some periods have no value',
};

const SUBJECT_WORDS: Readonly<Record<string, string>> = {
  orders: 'orders',
  products: 'products',
  inventory: 'stock or inventory',
  campaigns: 'campaigns',
};

function number(value: number, locale: GiaLocale, currency: string | null): string {
  const tag = locale === 'es' ? 'es-PE' : 'en-US';
  try {
    return currency === null
      ? new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(value)
      : new Intl.NumberFormat(tag, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)}${currency === null ? '' : ` ${currency}`}`;
  }
}

/** How far the person asked and the longest projection allowed, as the engine counted them. */
function horizonWords(context: {
  readonly frequency?: ForecastFrequency;
  readonly horizon?: number;
  readonly maxHorizon?: number;
}): string | undefined {
  const { frequency, horizon, maxHorizon } = context;
  if (frequency === undefined || horizon === undefined) return undefined;
  return [
    `The person asked for ${horizon} ${frequency}s ahead.`,
    maxHorizon === undefined
      ? 'That is beyond the longest projection allowed.'
      : `The longest projection allowed per ${frequency} is ${maxHorizon} ${frequency}s.`,
  ].join(' ');
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/**
 * The forecast as the model reads it: what happened, then what is projected, each labelled.
 * Totals and averages are calculated here, never by the model. The range of a total adds the
 * periods' ranges, so it is wide and only approximate; the block says so.
 */
export function forecastBlock(context: GiaForecastContext, locale: GiaLocale): string {
  switch (context.kind) {
    case 'not_allowed':
      return `status: not_allowed. The person may NOT see this projection or its records.`;
    case 'unsupported':
      return `status: unsupported. MelonOffice has no records of ${SUBJECT_WORDS[context.subject] ?? context.subject} yet, so nothing about them can be projected. No other metric stands in for them.`;
    case 'unavailable': {
      const words =
        context.reason === 'horizon_out_of_range'
          ? horizonWords(context)
          : UNAVAILABLE_WORDS[context.reason];
      return `status: unavailable (${context.reason}). No projection now.${words === undefined ? '' : ` ${words}`}`;
    }
    case 'invalid_data':
      return [
        'status: invalid_data. The history of this metric is recorded, but it cannot be projected as it is; no projection was made and the forecasting model was not run. History is NOT missing.',
        `metric: ${METRIC_WORDS[context.metric] ?? context.metric}, per ${context.frequency}`,
        `problem: ${PROBLEM_WORDS[context.problem] ?? context.problem}`,
      ].join('\n');
    case 'insufficient_data': {
      const unit = context.frequency;
      const counts =
        context.shortOf === 'active_periods'
          ? [
              context.have === null
                ? null
                : `${unit}s with at least one recorded event: ${context.have}`,
              context.need === null
                ? null
                : `${unit}s with activity needed: at least ${context.need}`,
            ]
          : [
              context.have === null ? null : `history recorded: ${context.have} ${unit}s`,
              context.need === null ? null : `history needed: at least ${context.need} ${unit}s`,
            ];
      const records = METRIC_RECORDS[context.metric];
      return [
        'status: insufficient_data. There is not enough recorded history to project this; no projection was made and the forecasting model was not run.',
        `metric: ${METRIC_WORDS[context.metric] ?? context.metric}, per ${unit}`,
        ...counts,
        records === undefined ? null : `this history comes from: ${records}`,
      ]
        .filter((line) => line !== null)
        .join('\n');
    }
    case 'forecast':
      break;
  }
  const f = context.forecast;
  const currency = f.unit === 'currency' ? f.entity : null;
  const n = (value: number) => number(value, locale, currency);
  const header = [
    `status: ${f.status}`,
    `metric: ${METRIC_WORDS[f.metric] ?? f.metric}${currency === null ? '' : ` in ${currency}`}, per ${f.frequency}`,
    `business time zone: ${f.timeZone}`,
  ];
  if (f.status === 'queued' || f.status === 'running') {
    return [...header, 'The projection is still being calculated; no figure yet.'].join('\n');
  }
  if (f.status === 'failed' || f.result === undefined) {
    return [...header, 'The projection could not be calculated; no figure.'].join('\n');
  }
  const history = f.input.values;
  const recent = history.slice(-Math.min(f.horizon, history.length));
  const predictions = f.result.predictions;
  const points = predictions.map((p) => p.value);
  const recentAverage = sum(recent) / recent.length;
  const projectedAverage = sum(points) / points.length;
  const change =
    recentAverage === 0
      ? null
      : Math.round(((projectedAverage - recentAverage) / recentAverage) * 100);
  const first = predictions[0]?.period ?? addPeriods(f.input.end, 1, f.frequency);
  const last = predictions.at(-1)?.period ?? first;
  const isFallback = f.result.model.kind === 'fallback';
  return [
    ...header,
    'HISTORY (what was recorded; facts):',
    `- periods ${f.input.start} to ${f.input.end}: ${history.length} ${f.frequency}s, total ${n(sum(history))}`,
    `- last ${recent.length} ${f.frequency}s: total ${n(sum(recent))}, average ${n(recentAverage)} per ${f.frequency}`,
    'PROJECTION (an estimate, not a fact; it can be wrong):',
    `- next ${predictions.length} ${f.frequency}s, ${first} to ${last}: central estimate ${n(sum(points))} in total, average ${n(projectedAverage)} per ${f.frequency}`,
    `- approximate range of the total: ${n(sum(predictions.map((p) => p.low)))} to ${n(sum(predictions.map((p) => p.high)))} (adds each ${f.frequency}'s 10%-90% band; wide)`,
    change === null
      ? '- trend: no recent history to compare with'
      : `- trend: projected average is ${change > 0 ? '+' : ''}${change}% against the last ${recent.length} ${f.frequency}s`,
    isFallback
      ? '- made by: a simple estimate from recent averages (the forecasting model was not available); say so'
      : // Which model it was is the platform's to know, not the person's (only the audit names it).
        "- made by: MelonOffice's forecasting model; never name the model",
    `- warnings: ${f.warnings.length === 0 ? 'none' : f.warnings.join(', ')}`,
  ].join('\n');
}

/** GIA's rules when a <forecast> is present. */
export function forecastRules(locale: GiaLocale): readonly string[] {
  const es = locale === 'es';
  return [
    'Projections of the future come only from <forecast>. Use its figures exactly; never calculate, extrapolate or adjust one, and never project anything <forecast> does not project.',
    'Always keep what happened (HISTORY) apart from what is projected (PROJECTION), in separate sentences.',
    `Word a projection as an estimate: ${es ? '"el modelo proyecta alrededor de…", "se estima…"' : '"the model projects around…", "an estimate of…"'}, with the central estimate and its approximate range. Never say it will happen, is sure or guaranteed, and never give a confidence or probability percentage.`,
    'If the warnings in <forecast> include short_history, mostly_zero or outliers_kept, say in plain words that the estimate is less reliable because of it.',
    'If <forecast> was made by a simple estimate, say it is a simple estimate from recent averages, not the forecasting model.',
    `If <forecast> says not_allowed, answer exactly "${NO_PERMISSION[locale]}" and nothing about it.`,
    'If <forecast> says unsupported, say MelonOffice has no records of that yet, so it cannot be projected, and what they could register instead. Never answer with another metric.',
    'If <forecast> says insufficient_data, say which history is missing: name the metric and its unit (days, weeks or months), give the recorded and the needed amounts exactly as <forecast> states them, and say where that history comes from. Give no figure, and never say more is missing than <forecast> says.',
    'If <forecast> says invalid_data, say the history is recorded but has a problem that stops the projection, name the problem as <forecast> states it, and never say history is missing.',
    'If <forecast> says the projection is still being calculated, say so and that they can ask again in a moment. If it says unavailable, say projections are not available right now (credits_insufficient: not enough credits; busy: other projections are running; business_profile_missing or currency_missing: say exactly what <forecast> says is missing and where it is filled in; horizon_out_of_range: say how far they asked and the longest projection allowed, exactly as <forecast> states them, and that they can ask for that instead; frequency_not_supported: say this metric cannot be projected per that period).',
  ];
}
