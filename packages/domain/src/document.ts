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
 * - `stored`: kept, its text not read (yet): a PDF or DOCX uploaded before DOC-2 (ADR-0079), or
 *   one whose reading did not finish. Uploading it again reads it.
 * - `ingested`: its text was given to Company Brain (ADR-0051).
 * - `not_ingested`: its text did not reach Company Brain; `ingestion` says why.
 */
export type StoredDocumentStatus = 'stored' | 'ingested' | 'not_ingested';

/**
 * Why a document's text did not reach Company Brain. Closed codes, never a message.
 *
 * - `too_long`: longer than Company Brain takes in one document, or than is read of a file.
 * - `no_text`: only blank characters (a DOCX without text, or a scan the model found empty).
 * - `not_permitted`: the person may not add knowledge (`knowledge.propose`).
 * - `refused`: Company Brain refused it (for example, an inactive organization).
 * - `unavailable`: Company Brain or the AI Gateway is not configured here, or failed.
 * - `unreadable`: the PDF or DOCX could not be read (ADR-0079).
 * - `timeout`: reading it took longer than allowed.
 * - `encrypted`: it needs a password.
 * - `too_many_pages`: more pages than are read (200), or than a model reads (100).
 * - `credits`: a scan needs the model, and the organization's credits do not cover it.
 */
export type DocumentIngestionCode =
  | 'too_long'
  | 'no_text'
  | 'not_permitted'
  | 'refused'
  | 'unavailable'
  | 'unreadable'
  | 'timeout'
  | 'encrypted'
  | 'too_many_pages'
  | 'credits';

/**
 * How a document's text was read (ADR-0079): `file`, a text file's own bytes; `library`, a PDF
 * or DOCX read by local open-source code; `model`, a PDF without a text layer read by Gemini
 * through the AI Gateway (costs credits).
 */
export type DocumentTextSource = 'file' | 'library' | 'model';

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
  /** How its text was read, once it was (ADR-0079). */
  readonly textSource?: DocumentTextSource;
  /** A PDF's page count, once it was read. */
  readonly pages?: number;
  readonly uploadedBy: UserId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
