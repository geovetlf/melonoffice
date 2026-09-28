/** Why Company Brain refused (ADR-0051). Stable codes; never a message with content. */
export type BrainErrorCode =
  | 'unresolved_tenant'
  | 'permission_denied'
  | 'requires_user'
  | 'organization_inactive'
  | 'invalid_knowledge'
  | 'not_found'
  | 'stale_revision'
  | 'conflict_open'
  | 'not_open'
  | 'invalid_document'
  | 'extraction_unavailable';

export class BrainError extends Error {
  override readonly name = 'BrainError';
  constructor(
    readonly code: BrainErrorCode,
    /** For `invalid_knowledge`: which field. */
    readonly field?: string,
  ) {
    super(field === undefined ? code : `${code}: ${field}`);
  }
}

export const isBrainError = (error: unknown): error is BrainError => error instanceof BrainError;
