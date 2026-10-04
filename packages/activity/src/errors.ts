export type ActivityErrorCode =
  | 'invalid_period'
  | 'invalid_time_zone'
  | 'invalid_filter'
  | 'invalid_cursor'
  | 'invalid_target'
  | 'permission_denied'
  | 'organization_inactive'
  | 'unresolved_tenant';

export class ActivityError extends Error {
  override readonly name = 'ActivityError';
  constructor(readonly code: ActivityErrorCode) {
    super(code);
  }
}

export const isActivityError = (error: unknown): error is ActivityError =>
  error instanceof ActivityError;
