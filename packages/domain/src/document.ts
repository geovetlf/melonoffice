import type { Brand, IsoTimestamp, OrganizationId, UserId } from './ids.js';

/**
 * A file a person uploaded to the organization (Document Engine DOC-1, ADR-0078). The bytes live
 * in Cloud Storage under a key the server builds; this record says what they are, who uploaded
 * them and whether Company Brain read their text. Written once; only its status changes.
 */
export type DocumentId = Brand<string, 'DocumentId'>;

/** The file types MelonOffice accepts. Closed: anything else is refused. */
export type DocumentContentType =
  | 'text/plain'
  | 'text/markdown'
  | 'text/csv'
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * - `stored`: kept, its text not read. PDF and DOCX stay here: reading their text waits for a
 *   product decision (a local library, Gemini through the AI Gateway, or both).
 * - `ingested`: its text was given to Company Brain (ADR-0051).
 * - `not_ingested`: a text file Company Brain could not take; `ingestion` says why.
 */
export type StoredDocumentStatus = 'stored' | 'ingested' | 'not_ingested';

/**
 * Why a text file's text did not reach Company Brain. Closed codes, never a message.
 *
 * - `too_long`: longer than Company Brain takes in one document.
 * - `no_text`: only blank characters.
 * - `not_permitted`: the person may not add knowledge (`knowledge.propose`).
 * - `refused`: Company Brain refused it (for example, an inactive organization).
 * - `unavailable`: Company Brain is not configured here, or failed.
 */
export type DocumentIngestionCode =
  'too_long' | 'no_text' | 'not_permitted' | 'refused' | 'unavailable';

export interface StoredDocument {
  /** Derived from the organization and the content: the same bytes twice are one document. */
  readonly id: DocumentId;
  readonly organizationId: OrganizationId;
  /** The name the person gave it, checked. Never part of the storage key. */
  readonly name: string;
  readonly contentType: DocumentContentType;
  readonly sizeBytes: number;
  /** SHA-256 of the bytes, hex. */
  readonly sha256: string;
  /** `organizations/{organizationId}/documents/{id}`, built by the server only. */
  readonly storageKey: string;
  readonly status: StoredDocumentStatus;
  /** Set only for `not_ingested`. */
  readonly ingestion?: DocumentIngestionCode;
  /** Company Brain's document, set only for `ingested`. */
  readonly knowledgeDocumentId?: string;
  readonly uploadedBy: UserId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
