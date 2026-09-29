import type { AuditEvent } from '@melonoffice/audit';
import type {
  DocumentId,
  DocumentIngestionCode,
  IsoTimestamp,
  OrganizationId,
  StoredDocument,
  StoredDocumentStatus,
} from '@melonoffice/domain';
import { isDocumentId } from './content.js';
import { DocumentError } from './errors.js';

/** A position in an organization's document list: newest first, then by id. */
export interface DocumentPosition {
  readonly at: IsoTimestamp;
  readonly id: DocumentId;
}

/** What may change on a stored document: only whether Company Brain read its text. */
export interface DocumentStatusChange {
  readonly status: StoredDocumentStatus;
  readonly ingestion?: DocumentIngestionCode;
  readonly knowledgeDocumentId?: string;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Where document records live: Firestore in the API (`documents/{id}`), memory in tests. A
 * document is written once, together with its audit events (all or none, ADR-0020); writing it
 * again returns the stored one and records nothing.
 */
export interface DocumentRepository {
  create(
    document: StoredDocument,
    events: readonly AuditEvent[],
  ): Promise<{ readonly document: StoredDocument; readonly created: boolean }>;
  /** The document, only when it belongs to the organization. Another organization's is absent. */
  find(organizationId: OrganizationId, id: DocumentId): Promise<StoredDocument | undefined>;
  /** Sets its status. Absent (or another organization's): nothing changes. */
  setStatus(
    organizationId: OrganizationId,
    id: DocumentId,
    change: DocumentStatusChange,
  ): Promise<StoredDocument | undefined>;
  /** One page of the organization's documents, newest first, after `after` when given. */
  page(
    organizationId: OrganizationId,
    request: { readonly after?: DocumentPosition; readonly limit: number },
  ): Promise<{ readonly items: readonly StoredDocument[]; readonly hasMore: boolean }>;
}

export const documentPosition = (document: StoredDocument): DocumentPosition => ({
  at: document.createdAt,
  id: document.id,
});

const newestFirst = (a: StoredDocument, b: StoredDocument) =>
  a.createdAt === b.createdAt
    ? a.id < b.id
      ? 1
      : a.id > b.id
        ? -1
        : 0
    : a.createdAt < b.createdAt
      ? 1
      : -1;

/** Whether `document` comes after `position` in newest-first order. */
export const isAfterPosition = (document: StoredDocument, position: DocumentPosition): boolean =>
  document.createdAt < position.at ||
  (document.createdAt === position.at && document.id < position.id);

/** One page of `documents`, the way every store cuts it. */
export function pageOfDocuments(
  documents: readonly StoredDocument[],
  request: { readonly after?: DocumentPosition; readonly limit: number },
) {
  const { after } = request;
  const sorted = [...documents]
    .filter((d) => after === undefined || isAfterPosition(d, after))
    .sort(newestFirst);
  return {
    items: Object.freeze(sorted.slice(0, request.limit)),
    hasMore: sorted.length > request.limit,
  };
}

/** The stored record with a status change applied, and only the fields that status allows. */
export function withStatus(document: StoredDocument, change: DocumentStatusChange): StoredDocument {
  return Object.freeze({
    id: document.id,
    organizationId: document.organizationId,
    name: document.name,
    contentType: document.contentType,
    sizeBytes: document.sizeBytes,
    sha256: document.sha256,
    storageKey: document.storageKey,
    status: change.status,
    ...(change.status === 'not_ingested' && change.ingestion !== undefined
      ? { ingestion: change.ingestion }
      : {}),
    ...(change.status === 'ingested' && change.knowledgeDocumentId !== undefined
      ? { knowledgeDocumentId: change.knowledgeDocumentId }
      : {}),
    uploadedBy: document.uploadedBy,
    createdAt: document.createdAt,
    updatedAt: change.updatedAt,
  });
}

/** For tests and local runs only. */
export class InMemoryDocumentRepository implements DocumentRepository {
  readonly #documents = new Map<string, StoredDocument>();

  constructor(private readonly audit: { append(events: readonly AuditEvent[]): Promise<void> }) {}

  async create(document: StoredDocument, events: readonly AuditEvent[]) {
    const stored = this.#documents.get(document.id);
    if (stored !== undefined) {
      if (stored.organizationId !== document.organizationId) throw new Error('document id taken');
      return { document: stored, created: false };
    }
    // The events first: if they cannot be recorded, nothing is stored.
    await this.audit.append(events);
    const frozen = Object.freeze({ ...document });
    this.#documents.set(document.id, frozen);
    return { document: frozen, created: true };
  }

  async find(organizationId: OrganizationId, id: DocumentId) {
    const document = this.#documents.get(id);
    return document?.organizationId === organizationId ? document : undefined;
  }

  async setStatus(organizationId: OrganizationId, id: DocumentId, change: DocumentStatusChange) {
    const document = await this.find(organizationId, id);
    if (document === undefined) return undefined;
    const changed = withStatus(document, change);
    this.#documents.set(id, changed);
    return changed;
  }

  async page(
    organizationId: OrganizationId,
    request: { readonly after?: DocumentPosition; readonly limit: number },
  ) {
    const mine = [...this.#documents.values()].filter((d) => d.organizationId === organizationId);
    return pageOfDocuments(mine, request);
  }
}

// ---------------------------------------------------------------------------------------------
// Cursors

/**
 * A cursor names only a position in one organization's list. It is not a secret and grants
 * nothing: every page is read for the caller's own organization, and a cursor made for another
 * organization is refused.
 */
export function encodeDocumentCursor(
  organizationId: OrganizationId,
  position: DocumentPosition,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, o: organizationId, a: position.at, i: position.id }),
  ).toString('base64url');
}

export function decodeDocumentCursor(
  cursor: string,
  organizationId: OrganizationId,
): DocumentPosition {
  const bad = () => new DocumentError('invalid_document', 'cursor');
  if (cursor.length > 400) throw bad();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof value !== 'object' || value === null) throw bad();
  const { v, o, a, i } = value as Record<string, unknown>;
  if (v !== 1 || o !== organizationId) throw bad();
  if (typeof a !== 'string' || Number.isNaN(Date.parse(a))) throw bad();
  if (!isDocumentId(i)) throw bad();
  return { at: a as IsoTimestamp, id: i };
}
