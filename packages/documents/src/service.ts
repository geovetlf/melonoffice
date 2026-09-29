import { actorOf, buildAuditEvent } from '@melonoffice/audit';
import { isBrainError, LIMITS, type CompanyBrainService } from '@melonoffice/brain';
import type {
  DocumentIngestionCode,
  IsoTimestamp,
  OrganizationId,
  StoredDocument,
} from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import {
  checkContent,
  checkContentType,
  checkDocumentName,
  documentIdFor,
  isDocumentId,
  sha256Of,
  storageKeyOf,
} from './content.js';
import { DocumentError, isDocumentError } from './errors.js';
import type { FileStore } from './files.js';
import {
  decodeDocumentCursor,
  documentPosition,
  encodeDocumentCursor,
  type DocumentRepository,
  type DocumentStatusChange,
} from './repository.js';

/**
 * Document uploads and storage (Document Engine DOC-1, ADR-0078). A person uploads a file to the
 * organization; its bytes go to the file store under a key the server builds, and its record to
 * the repository with its audit event. A text file's text is also given to Company Brain when the
 * person may add knowledge. Reading PDF and DOCX text is not built: it waits for a product
 * decision (a local library, Gemini through the AI Gateway, or both).
 */

export const DOCUMENT_PAGE_SIZE = Object.freeze({ page: 20, max: 50 });

/** A document's bytes, with its record. */
export interface DocumentContent {
  readonly document: StoredDocument;
  readonly bytes: Uint8Array;
}

export interface DocumentService {
  /**
   * Uploads `{ name, contentType, bytes }`. The same bytes again in the same organization return
   * the stored document (`duplicate: true`) and store nothing new.
   */
  upload(
    tenant: TenantContext,
    input: { readonly name: unknown; readonly contentType: unknown; readonly bytes: Uint8Array },
  ): Promise<{ readonly document: StoredDocument; readonly duplicate: boolean }>;
  get(tenant: TenantContext, id: string): Promise<StoredDocument>;
  list(
    tenant: TenantContext,
    page: { readonly cursor?: string; readonly limit?: number },
  ): Promise<{ readonly items: readonly StoredDocument[]; readonly nextCursor: string | null }>;
  content(tenant: TenantContext, id: string): Promise<DocumentContent>;
}

export interface DocumentServiceOptions {
  readonly repository: DocumentRepository;
  /** Where the bytes live. Absent: uploads and downloads are refused (fails closed). */
  readonly files?: FileStore;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** Company Brain (ADR-0051), for text files. Absent: their text is not ingested. */
  readonly knowledge?: Pick<CompanyBrainService, 'ingestDocument'>;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly requestId?: string;
}

const REQUEST_ID = /^[\w-]{1,128}$/;

export function createDocumentService(options: DocumentServiceOptions): DocumentService {
  const { repository, files, authorization, knowledge, logger } = options;
  const now = options.now ?? (() => new Date());
  const requestId =
    options.requestId !== undefined && REQUEST_ID.test(options.requestId)
      ? options.requestId
      : undefined;

  const can = (tenant: TenantContext, permission: string) =>
    authorization.authorize(tenant, permission).allowed;

  function organizationOf(
    tenant: TenantContext,
    permission: 'document.read' | 'document.upload',
  ): OrganizationId {
    if (!isResolvedTenant(tenant)) throw new DocumentError('unresolved_tenant');
    if (!can(tenant, permission)) throw new DocumentError('permission_denied');
    return tenant.organizationId as OrganizationId;
  }

  function fileStore(): FileStore {
    if (files === undefined) throw new DocumentError('storage_unavailable', 'not_configured');
    return files;
  }

  /** A storage failure as `storage_unavailable`; the provider's own error is never passed on. */
  async function stored<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isDocumentError(error)) throw error;
      throw new DocumentError('storage_unavailable');
    }
  }

  async function find(organizationId: OrganizationId, id: string): Promise<StoredDocument> {
    if (!isDocumentId(id)) throw new DocumentError('document_not_found');
    const document = await repository.find(organizationId, id);
    if (document === undefined) throw new DocumentError('document_not_found');
    return document;
  }

  /**
   * Gives a text file's text to Company Brain, as the person. Never fails the upload: what it
   * could not do is recorded on the document as a code.
   */
  async function ingest(
    tenant: TenantContext,
    document: StoredDocument,
    text: string,
  ): Promise<DocumentStatusChange> {
    const at = () => now().toISOString() as IsoTimestamp;
    const notIngested = (ingestion: DocumentIngestionCode): DocumentStatusChange => ({
      status: 'not_ingested',
      ingestion,
      updatedAt: at(),
    });
    if (knowledge === undefined) return notIngested('unavailable');
    if (!can(tenant, 'knowledge.propose')) return notIngested('not_permitted');
    if (text.trim() === '') return notIngested('no_text');
    if (text.length > LIMITS.documentCharacters) return notIngested('too_long');
    try {
      const result = await knowledge.ingestDocument(tenant, { name: document.name, text });
      return { status: 'ingested', knowledgeDocumentId: result.document.id, updatedAt: at() };
    } catch (error) {
      const code = isBrainError(error) ? error.code : 'error';
      logger?.warn('documents.ingestion_failed', { code });
      return notIngested(isBrainError(error) ? 'refused' : 'unavailable');
    }
  }

  return Object.freeze({
    async upload(tenant, input) {
      const organizationId = organizationOf(tenant, 'document.upload');
      // Uploading is a person's act: never GIA's, never the runtime's.
      if (tenant.actor !== 'user') throw new DocumentError('permission_denied');
      const store = fileStore();
      const name = checkDocumentName(input.name);
      const contentType = checkContentType(input.contentType);
      if (!(input.bytes instanceof Uint8Array)) throw new DocumentError('invalid_document', 'body');
      const { text } = checkContent(contentType, input.bytes);
      const sha256 = sha256Of(input.bytes);
      const id = documentIdFor(organizationId, sha256);

      const existing = await repository.find(organizationId, id);
      if (existing !== undefined) return Object.freeze({ document: existing, duplicate: true });

      const storageKey = storageKeyOf(organizationId, id);
      // The bytes first: a record never points at an object that was not stored.
      await stored(() => store.put(storageKey, input.bytes, contentType));
      const at = now();
      const document: StoredDocument = Object.freeze({
        id,
        organizationId,
        name,
        contentType,
        sizeBytes: input.bytes.length,
        sha256,
        storageKey,
        status: 'stored',
        uploadedBy: tenant.userId,
        createdAt: at.toISOString() as IsoTimestamp,
        updatedAt: at.toISOString() as IsoTimestamp,
      });
      // Recorded with the document, all or none (ADR-0020). Only its id: never its name or bytes.
      const event = buildAuditEvent(
        {
          action: 'document.uploaded',
          result: 'success',
          actor: actorOf(tenant),
          organizationId,
          target: { type: 'document', id },
          ...(requestId === undefined ? {} : { requestId }),
          source: 'api',
        },
        at,
      );
      const created = await repository.create(document, [event]);
      // Uploaded concurrently by a repeat of the same request: that one is the document.
      if (!created.created) return Object.freeze({ document: created.document, duplicate: true });
      if (text === undefined) return Object.freeze({ document, duplicate: false });

      const change = await ingest(tenant, document, text);
      const updated = await repository.setStatus(organizationId, id, change);
      return Object.freeze({ document: updated ?? document, duplicate: false });
    },

    async get(tenant, id) {
      return find(organizationOf(tenant, 'document.read'), id);
    },

    async list(tenant, page) {
      const organizationId = organizationOf(tenant, 'document.read');
      const limit = page.limit ?? DOCUMENT_PAGE_SIZE.page;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > DOCUMENT_PAGE_SIZE.max) {
        throw new DocumentError('invalid_document', 'limit');
      }
      const after =
        page.cursor === undefined ? undefined : decodeDocumentCursor(page.cursor, organizationId);
      const found = await repository.page(organizationId, {
        ...(after === undefined ? {} : { after }),
        limit,
      });
      const last = found.items.at(-1);
      return Object.freeze({
        items: found.items,
        nextCursor:
          found.hasMore && last !== undefined
            ? encodeDocumentCursor(organizationId, documentPosition(last))
            : null,
      });
    },

    async content(tenant, id) {
      const organizationId = organizationOf(tenant, 'document.read');
      const store = fileStore();
      const document = await find(organizationId, id);
      // The key is the record's, which the server built; it is checked again all the same.
      if (document.storageKey !== storageKeyOf(organizationId, document.id)) {
        throw new DocumentError('storage_unavailable', 'key');
      }
      const bytes = await stored(() => store.get(document.storageKey));
      if (bytes === undefined) throw new DocumentError('document_not_found');
      // Only the bytes that were uploaded are ever served.
      if (bytes.length !== document.sizeBytes || sha256Of(bytes) !== document.sha256) {
        logger?.error('documents.content_mismatch', { documentId: document.id });
        throw new DocumentError('storage_unavailable', 'integrity');
      }
      return Object.freeze({ document, bytes });
    },
  } satisfies DocumentService);
}
