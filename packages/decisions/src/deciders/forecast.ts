import type { Forecast } from '@melonoffice/forecasting';
import type { Decider, DeciderContext } from '../engine.js';
import { DecisionError, ruleRef, type DecisionEvidence, type DecisionReason } from '../model.js';

/**
 * What a forecast calls for (`forecast.signal`, ADR-0065). The Forecasting Engine predicts
 * (ADR-0059); this decides. It reads one finished forecast as the person, compares the
 * predicted periods with as many recent ones of the same series and recommends a review when the
 * change passes a fixed threshold. The model's band (its 0.1–0.9 quantiles) says whether the
 * whole band agrees; it is not a probability and no confidence figure is given.
 */

export const FORECAST_RULES = Object.freeze({
  change: { id: 'forecast.change_threshold', version: 1 },
});

/** A change of this many percent or more, either way, calls for a review. */
export const FORECAST_CHANGE_PERCENT = 20;

interface Input {
  readonly forecastId: string;
}

function parse(raw: unknown): Input {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DecisionError('invalid_input');
  }
  const { forecastId } = raw as Record<string, unknown>;
  if (typeof forecastId !== 'string' || !/^fc_[0-9a-f]{40}$/.test(forecastId)) {
    throw new DecisionError('invalid_input', 'forecastId');
  }
  return { forecastId };
}

const reason = (code: string, params: Record<string, string | number> = {}): DecisionReason =>
  Object.freeze({ code, rule: ruleRef(FORECAST_RULES.change), params: Object.freeze(params) });

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/** The decision over one forecast; pure, for any caller that holds the forecast. */
export function forecastSignal(forecast: Forecast) {
  const ref = { type: 'forecast', id: forecast.id };
  const base = {
    priority: null,
    evidence: [] as DecisionEvidence[],
    requiredApproval: false,
    recommendedAction: null,
    rules: [ruleRef(FORECAST_RULES.change)],
    sourceContext: { sources: ['forecast'], withheld: [] as string[] },
  };
  const result = forecast.result;
  if (forecast.status !== 'completed' || result === undefined || result.predictions.length === 0) {
    return {
      ...base,
      outcome: 'insufficient_context',
      reasons: [reason('forecast_not_completed', { status: forecast.status })],
      evidence: [
        { source: 'forecast', ref, fact: 'status', value: forecast.status },
      ] as DecisionEvidence[],
      warnings: ['forecast_not_completed'],
    };
  }
  const horizon = result.predictions.length;
  const recent = forecast.input.values.slice(-horizon);
  const before = mean(recent);
  const ahead = mean(result.predictions.map((p) => p.value));
  const warnings = [
    ...(result.model.kind === 'fallback' ? ['fallback_model'] : []),
    ...forecast.warnings.filter((w) => /^[a-z][a-z_]{0,63}$/.test(w)),
  ];
  const evidence: DecisionEvidence[] = [
    { source: 'forecast', ref, fact: 'metric', value: forecast.metric },
    { source: 'forecast', ref, fact: 'recent_mean', value: Math.round(before * 100) / 100 },
    { source: 'forecast', ref, fact: 'predicted_mean', value: Math.round(ahead * 100) / 100 },
    { source: 'forecast', ref, fact: 'periods', value: horizon },
    { source: 'forecast', ref, fact: 'model_kind', value: result.model.kind },
  ];
  if (recent.length < horizon || before <= 0) {
    // Nothing to compare with: no change can be measured, and none is guessed.
    return {
      ...base,
      outcome: 'insufficient_context',
      evidence,
      reasons: [reason('no_recent_baseline')],
      warnings: [...warnings, 'no_recent_baseline'],
    };
  }
  const change = Math.round(((ahead - before) / before) * 1000) / 10;
  evidence.push({ source: 'forecast', ref, fact: 'change_percent', value: change });
  // Whether the model's whole band is past the recent mean, in the same direction.
  const lowMean = mean(result.predictions.map((p) => p.low));
  const highMean = mean(result.predictions.map((p) => p.high));
  const params = {
    changePercent: change,
    thresholdPercent: FORECAST_CHANGE_PERCENT,
    periods: horizon,
    metric: forecast.metric,
  };
  if (change >= FORECAST_CHANGE_PERCENT) {
    return {
      ...base,
      outcome: 'demand_increase',
      priority: 'medium' as const,
      evidence,
      reasons: [reason('predicted_increase', params)],
      warnings: [...warnings, ...(lowMean > before ? [] : ['band_includes_no_change'])],
      recommendedAction: { code: 'review_capacity', action: null, link: ref },
    };
  }
  if (change <= -FORECAST_CHANGE_PERCENT) {
    return {
      ...base,
      outcome: 'demand_decrease',
      priority: 'medium' as const,
      evidence,
      reasons: [reason('predicted_decrease', params)],
      warnings: [...warnings, ...(highMean < before ? [] : ['band_includes_no_change'])],
      recommendedAction: { code: 'plan_commercial_actions', action: null, link: ref },
    };
  }
  return {
    ...base,
    outcome: 'stable',
    priority: 'low' as const,
    evidence,
    reasons: [reason('within_threshold', params)],
    warnings,
  };
}

export const forecastSignalDecider = Object.freeze<Decider<Input>>({
  type: 'forecast.signal',
  version: 1,
  category: 'recommendation',
  permissions: ['decision.evaluate', 'forecast.read'],
  requires: ['forecasts'],
  usesAI: false,
  parse,
  async decide(context: DeciderContext, input: Input) {
    const forecasts = context.ports.forecasts;
    if (forecasts === undefined) throw new DecisionError('not_configured');
    // Read as the person: another organization's forecast is not found (the engine refuses it).
    const forecast = await forecasts.get(context.tenant, input.forecastId);
    return forecastSignal(forecast);
  },
});
