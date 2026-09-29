import type {
  DocumentData,
  Firestore,
  Timestamp as FirestoreTimestamp,
} from '@google-cloud/firestore';
import { FieldPath, Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import {
  pageOfDocuments,
  withStatus,
  type DocumentPosition,
  type DocumentRepository,
  type DocumentStatusChange,
} from '@melonoffice/documents';
import type {
  DocumentContentType,
  DocumentId,
  DocumentIngestionCode,
  IsoTimestamp,
  OrganizationId,
  StoredDocument,
  StoredDocumentStatus,
  UserId,
} from '@melonoffice/domain';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `documents/{documentId}` (ADR-0078): what a person uploaded, never its bytes (those are in
 * Cloud Storage). Written once with its audit events; only its status changes. The organization
 * is a field every read checks. The list is read one page at a time with the composite index
 * `organizationId, createdAt desc`.
 */
export const DOCUMENTS = 'documents';

/** The most documents read at once while the list's index does not exist yet. */
const FALLBACK_LIMIT = 500;

interface DocumentDocument {
  readonly organizationId: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly status: string;
  readonly ingestion: string | null;
  readonly knowledgeDocumentId: string | null;
  readonly uploadedBy: string;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

const toDocument = (document: StoredDocument): DocumentDocument => ({
  organizationId: document.organizationId,
  name: document.name,
  contentType: document.contentType,
  sizeBytes: document.sizeBytes,
  sha256: document.sha256,
  storageKey: document.storageKey,
  status: document.status,
  ingestion: document.ingestion ?? null,
  knowledgeDocumentId: document.knowledgeDocumentId ?? null,
  uploadedBy: document.uploadedBy,
  createdAt: Timestamp.fromDate(new Date(document.createdAt)),
  updatedAt: Timestamp.fromDate(new Date(document.updatedAt)),
});

const toStored = (id: string, data: DocumentData): StoredDocument => {
  const d = data as DocumentDocument;
  return Object.freeze({
    id: id as DocumentId,
    organizationId: d.organizationId as OrganizationId,
    name: d.name,
    contentType: d.contentType as DocumentContentType,
    sizeBytes: d.sizeBytes,
    sha256: d.sha256,
    storageKey: d.storageKey,
    status: d.status as StoredDocumentStatus,
    ...(d.ingestion === null ? {} : { ingestion: d.ingestion as DocumentIngestionCode }),
    ...(d.knowledgeDocumentId === null ? {} : { knowledgeDocumentId: d.knowledgeDocumentId }),
    uploadedBy: d.uploadedBy as UserId,
    createdAt: d.createdAt.toDate().toISOString() as IsoTimestamp,
    updatedAt: d.updatedAt.toDate().toISOString() as IsoTimestamp,
  });
};

/** A query Firestore refuses until its composite index exists (gRPC FAILED_PRECONDITION). */
const isMissingIndex = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 9 &&
  /index/i.test(String((error as { message?: unknown }).message));

export class FirestoreDocumentRepository implements DocumentRepository {
  constructor(
    private readonly db: Firestore,
    /** Told when a list had to be read without its index (ADR-0061's fallback). */
    private readonly options: { readonly onIndexMissing?: (query: string) => void } = {},
  ) {}

  async create(document: StoredDocument, events: readonly AuditEvent[]) {
    const doc = this.db.collection(DOCUMENTS).doc(document.id);
    // Written once, with its audit events: a repeat finds the stored document and records nothing.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      if (snapshot.exists) {
        const stored = toStored(snapshot.id, snapshot.data() as DocumentData);
        if (stored.organizationId !== document.organizationId) throw new Error('document id taken');
        return { document: stored, created: false };
      }
      t.create(doc, toDocument(document));
      for (const event of events) {
        t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
      }
      return { document, created: true };
    });
  }

  async find(organizationId: OrganizationId, id: DocumentId) {
    const snapshot = await this.db.collection(DOCUMENTS).doc(id).get();
    if (!snapshot.exists) return undefined;
    const document = toStored(snapshot.id, snapshot.data() as DocumentData);
    return document.organizationId === organizationId ? document : undefined;
  }

  async setStatus(organizationId: OrganizationId, id: DocumentId, change: DocumentStatusChange) {
    const doc = this.db.collection(DOCUMENTS).doc(id);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      if (!snapshot.exists) return undefined;
      const document = toStored(snapshot.id, snapshot.data() as DocumentData);
      if (document.organizationId !== organizationId) return undefined;
      const changed = withStatus(document, change);
      t.update(doc, {
        status: changed.status,
        ingestion: changed.ingestion ?? null,
        knowledgeDocumentId: changed.knowledgeDocumentId ?? null,
        updatedAt: Timestamp.fromDate(new Date(changed.updatedAt)),
      });
      return changed;
    });
  }

  async page(
    organizationId: OrganizationId,
    request: { readonly after?: DocumentPosition; readonly limit: number },
  ) {
    const mine = this.db.collection(DOCUMENTS).where('organizationId', '==', organizationId);
    let query = mine.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (request.after !== undefined) {
      query = query.startAfter(Timestamp.fromDate(new Date(request.after.at)), request.after.id);
    }
    try {
      const snapshot = await query.limit(request.limit + 1).get();
      const items = snapshot.docs.map((doc) => toStored(doc.id, doc.data()));
      return Object.freeze({
        items: Object.freeze(items.slice(0, request.limit)),
        hasMore: items.length > request.limit,
      });
    } catch (error) {
      if (!isMissingIndex(error)) throw error;
      this.options.onIndexMissing?.('documents');
      // An equality filter only needs Firestore's automatic indexes.
      const snapshot = await mine.limit(FALLBACK_LIMIT).get();
      return pageOfDocuments(
        snapshot.docs.map((doc) => toStored(doc.id, doc.data())),
        request,
      );
    }
  }
}
