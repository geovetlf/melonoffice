/**
 * Why a forecasting operation was refused or failed. Stable codes, safe to log and to show. A
 * forecast of another organization is `forecast_not_found`, exactly like one that does not exist.
 */
export type ForecastErrorCode =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'permission_denied'
  | 'invalid_request'
  | 'metric_not_found'
  | 'metric_not_for_department'
  | 'frequency_not_supported'
  | 'horizon_out_of_range'
  | 'covariates_not_supported'
  | 'forecast_not_found'
  // The model runtime is not configured here (staging and prod today): nothing is pretended.
  | 'forecast_model_unavailable'
  // No credit cost is configured for a model run: runs are refused rather than given away.
  | 'forecast_price_not_set'
  | 'forecast_credits_insufficient'
  | 'forecast_limit_reached'
  // The run could not be queued (Cloud Tasks unavailable).
  | 'forecast_not_scheduled'
  | 'forecast_concurrency_conflict';

export class ForecastError extends Error {
  override readonly name = 'ForecastError';

  constructor(
    readonly code: ForecastErrorCode,
    /** The input field at fault, for `invalid_request`. */
    readonly detail?: string,
    /** For `horizon_out_of_range`: the longest horizon allowed for the frequency asked. */
    readonly limit?: number,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isForecastError = (error: unknown): error is ForecastError =>
  error instanceof ForecastError;
