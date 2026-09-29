/** A price, calculator or usage that cannot be accounted for. A code, never data. */
export class AIUsageError extends Error {
  override readonly name = 'AIUsageError';

  constructor(
    readonly code:
      | 'invalid_pricing'
      | 'invalid_usage'
      | 'unknown_calculator'
      | 'duplicate_calculator'
      | 'invalid_event',
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isAIUsageError = (error: unknown): error is AIUsageError =>
  error instanceof AIUsageError;
