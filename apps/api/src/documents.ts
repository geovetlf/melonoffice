import {
  attachmentDisposition,
  isDocumentError,
  MAX_DOCUMENT_BYTES,
  type DocumentErrorCode,
  type DocumentService,
} from '@melonoffice/documents';
import type { StoredDocument } from '@melonoffice/domain';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

const STATUS: Record<DocumentErrorCode, 400 | 403 | 404 | 413 | 415 | 503> = {
  unresolved_tenant: 403,
  permission_denied: 403,
  invalid_document: 400,
  unsupported_type: 415,
  document_too_large: 413,
  document_not_found: 404,
  storage_unavailable: 503,
};

/** Which failed check `invalid_document` names; anything else is not shown. */
const FIELDS: ReadonlySet<string> = new Set([
  'name',
  'content',
  'empty',
  'cursor',
  'limit',
  'body',
]);

/**
 * A document as the API shows it. The storage key stays on the server: it is where the bytes
 * are, not something a client needs or may name.
 */
const view = (document: StoredDocument) => ({
  id: document.id,
  name: document.name,
  contentType: document.contentType,
  sizeBytes: document.sizeBytes,
  sha256: document.sha256,
  status: document.status,
  ingestion: document.ingestion ?? null,
  knowledgeDocumentId: document.knowledgeDocumentId ?? null,
  textSource: document.textSource ?? null,
  pages: document.pages ?? null,
  uploadedBy: document.uploadedBy,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
});

/**
 * Document routes (Document Engine DOC-1, ADR-0078), under
 * `/v1/organizations/:organizationId/documents`. A person uploads a file as the raw body, with
 * its type in `content-type` and its name in `?name=`; the service checks both and the bytes.
 * Reading needs `document.read`, uploading `document.upload`. Another organization's document
 * answers exactly like one that does not exist.
 */
export function registerDocumentRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    /** The service for one request, so its audit event carries the request's id. */
    readonly documentsFor: (requestId: string | undefined) => DocumentService;
  },
): void {
  const { documentsFor } = dependencies;
  const base = '/v1/organizations/:organizationId/documents';

  app.post(
    base,
    // A declared length over the limit is refused before the body is read; a body without one
    // is cut off at the limit while it is read.
    bodyLimit({
      maxSize: MAX_DOCUMENT_BYTES,
      onError: (c) => c.json({ error: 'document_too_large' }, 413),
    }),
    withPermission('document.upload', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        // Checked again on what was actually read.
        if (bytes.length > MAX_DOCUMENT_BYTES) {
          return c.json({ error: 'document_too_large' }, 413);
        }
        const { document, duplicate } = await documentsFor(c.get('requestId')).upload(tenant, {
          name: c.req.query('name'),
          contentType: c.req.header('content-type'),
          bytes,
        });
        return c.json({ document: view(document), duplicate }, duplicate ? 200 : 201);
      }),
    ),
  );

  app.get(
    base,
    withPermission('document.read', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const cursor = c.req.query('cursor');
        const limit = c.req.query('limit');
        const page = await documentsFor(c.get('requestId')).list(tenant, {
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit: /^\d{1,3}$/.test(limit) ? Number(limit) : -1 }),
        });
        return c.json({ documents: page.items.map(view), nextCursor: page.nextCursor });
      }),
    ),
  );

  app.get(
    `${base}/:documentId`,
    withPermission('document.read', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const document = await documentsFor(c.get('requestId')).get(
          tenant,
          c.req.param('documentId') ?? '',
        );
        return c.json(view(document));
      }),
    ),
  );

  app.get(
    `${base}/:documentId/content`,
    withPermission('document.read', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const { document, bytes } = await documentsFor(c.get('requestId')).content(
          tenant,
          c.req.param('documentId') ?? '',
        );
        // Always a download, of the type that was checked on upload; never sniffed or cached.
        return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
          'content-type': document.contentType,
          'content-length': String(bytes.length),
          'content-disposition': attachmentDisposition(document.name),
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
          'content-security-policy': "default-src 'none'; sandbox",
        });
      }),
    ),
  );
}

async function answer(c: Context<AuthEnv>, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (!isDocumentError(error)) throw error;
    return c.json(
      {
        error: error.code,
        ...(error.code === 'invalid_document' &&
        error.detail !== undefined &&
        FIELDS.has(error.detail)
          ? { field: error.detail }
          : {}),
      },
      STATUS[error.code],
    );
  }
}
