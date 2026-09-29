/**
 * Why a document was refused (ADR-0078). Stable codes, safe to log. Another organization's
 * document is `document_not_found`, exactly like a missing one.
 */
export type DocumentErrorCode =
  | 'unresolved_tenant'
  | 'permission_denied'
  | 'invalid_document'
  | 'unsupported_type'
  | 'document_too_large'
  | 'document_not_found'
  | 'storage_unavailable';

export class DocumentError extends Error {
  override readonly name = 'DocumentError';

  constructor(
    readonly code: DocumentErrorCode,
    /** Which field or check. A code, never user data or a provider's message. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isDocumentError = (error: unknown): error is DocumentError =>
  error instanceof DocumentError;
