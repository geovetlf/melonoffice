export type BrandingErrorCode =
  | 'invalid_brand_config'
  | 'invalid_hostname'
  | 'invalid_domain_target'
  | 'invalid_domain_transition'
  | 'brand_conflict'
  | 'domain_conflict';

export class BrandingError extends Error {
  override readonly name = 'BrandingError';

  constructor(
    readonly code: BrandingErrorCode,
    /** The field that was refused, for `invalid_brand_config`. Never a value. */
    readonly field?: string,
  ) {
    super(field === undefined ? code : `${code}: ${field}`);
  }
}

export const isBrandingError = (error: unknown): error is BrandingError =>
  error instanceof BrandingError;
