import { InMemoryFileStore, MAX_DOCUMENT_BYTES } from '@melonoffice/documents';
import type { OrganizationId } from '@melonoffice/domain';
import { ROLES, createAuthorizationService, type Permission } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Documents over HTTP (Document Engine DOC-1, ADR-0078): a person uploads a file as the raw body
 * and reads the organization's documents back. Uploading needs `document.upload`; reading
 * `document.read`. GIA and the runtime never reach these routes (they only act as the person
 * through services); the service's own tests refuse them.
 */
interface DocumentView {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly status: string;
  readonly ingestion: string | null;
  readonly knowledgeDocumentId: string | null;
}
interface Body {
  readonly [key: string]: unknown;
  readonly error?: string;
  readonly field?: string;
  readonly organization?: { readonly id: string };
  readonly document?: DocumentView;
  readonly duplicate?: boolean;
  readonly documents?: readonly DocumentView[];
  readonly nextCursor?: string | null;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const PDF = utf8('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF');

describe.each(STORES)('documents with storage in %s', (_name, createStores) => {
  async function setup(
    options: { readonly without?: readonly Permission[]; readonly noBucket?: boolean } = {},
  ) {
    const stores: Stores = createStores();
    const files = new InMemoryFileStore();
    const ctx = setupApp(
      stores,
      options.without === undefined
        ? undefined
        : createAuthorizationService({
            ...ROLES,
            owner: ROLES.owner.filter((p) => !(options.without ?? []).includes(p)),
          }),
      undefined,
      undefined,
      undefined,
      { files: options.noBucket === true ? null : files },
    );
    await ctx.register('token-alice');
    await ctx.register('token-bob');
    const json = async (token: string, method: string, path: string, body?: unknown) => {
      const response = await ctx.app.request(
        path,
        ctx.as(token, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: (await response.json()) as Body };
    };
    const orgOf = async (token: string, name: string) =>
      (await json(token, 'POST', '/v1/organizations', { name })).body.organization?.id as string;
    const orgA = await orgOf('token-alice', 'A');
    const orgB = await orgOf('token-bob', 'B');
    const base = (org: string) => `/v1/organizations/${org}/documents`;
    const upload = async (
      bytes: Uint8Array,
      options: {
        readonly token?: string;
        readonly org?: string;
        readonly name?: string | null;
        readonly type?: string;
        readonly headers?: Record<string, string>;
      } = {},
    ) => {
      const name = options.name === undefined ? 'Carta.txt' : options.name;
      const query = name === null ? '' : `?name=${encodeURIComponent(name)}`;
      const response = await ctx.app.request(
        `${base(options.org ?? orgA)}${query}`,
        ctx.as(options.token ?? 'token-alice', {
          method: 'POST',
          headers: { 'content-type': options.type ?? 'text/plain', ...options.headers },
          body: bytes,
        }),
      );
      return { status: response.status, body: (await response.json()) as Body };
    };
    return { ...ctx, files, stores, json, orgA, orgB, base, upload };
  }

  it('uploads a text file: stored, recorded and given to Company Brain', async () => {
    const { upload, json, base, orgA, stores, auditEvents } = await setup();
    const created = await upload(utf8('Combo Familiar S/45'), {
      type: 'text/plain; charset=utf-8',
    });
    expect(created.status).toBe(201);
    expect(created.body.duplicate).toBe(false);
    const document = created.body.document as DocumentView;
    expect(document).toMatchObject({
      name: 'Carta.txt',
      contentType: 'text/plain',
      sizeBytes: 19,
      status: 'ingested',
      ingestion: null,
    });
    // Where the bytes are stays on the server.
    expect(document).not.toHaveProperty('storageKey');
    const knowledge = await stores.knowledge.findDocument(
      orgA as OrganizationId,
      document.knowledgeDocumentId ?? '',
    );
    expect(knowledge?.text).toBe('Combo Familiar S/45');
    expect(await json('token-alice', 'GET', `${base(orgA)}/${document.id}`)).toEqual({
      status: 200,
      body: document,
    });
    const events = (await auditEvents()).filter((e) => e.action === 'document.uploaded');
    expect(events).toHaveLength(1);
    expect(events[0]?.target).toEqual({ type: 'document', id: document.id });
  });

  it('keeps a PDF without reading it, and hands it back as a download', async () => {
    const { upload, app, as, base, orgA, files } = await setup();
    const created = await upload(PDF, { name: 'Contrato "final"é.pdf', type: 'application/pdf' });
    expect(created.status).toBe(201);
    const document = created.body.document as DocumentView;
    expect(document).toMatchObject({
      status: 'stored',
      contentType: 'application/pdf',
      knowledgeDocumentId: null,
    });
    expect(files.keys()).toEqual([`organizations/${orgA}/documents/${document.id}`]);
    const response = await app.request(
      `${base(orgA)}/${document.id}/content`,
      as('token-alice', { method: 'GET' }),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="Contrato _final__.pdf"; filename*=UTF-8''Contrato%20%22final%22%C3%A9.pdf`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'content-length': String(PDF.length),
    });
  });

  it('refuses a file that is not what it says, an unknown type and a missing name', async () => {
    const { upload, json, base, orgA } = await setup();
    expect(await upload(utf8('hola'), { type: 'application/pdf', name: 'x.pdf' })).toEqual({
      status: 400,
      body: { error: 'invalid_document', field: 'content' },
    });
    expect(await upload(PDF, { type: 'text/html', name: 'x.html' })).toEqual({
      status: 415,
      body: { error: 'unsupported_type' },
    });
    expect(await upload(PDF, { name: null, type: 'application/pdf' })).toEqual({
      status: 400,
      body: { error: 'invalid_document', field: 'name' },
    });
    expect(await upload(PDF, { name: '../../x.pdf', type: 'application/pdf' })).toEqual({
      status: 400,
      body: { error: 'invalid_document', field: 'name' },
    });
    expect(await upload(new Uint8Array(0))).toEqual({
      status: 400,
      body: { error: 'invalid_document', field: 'empty' },
    });
    expect((await json('token-alice', 'GET', base(orgA))).body.documents).toEqual([]);
  });

  it('refuses a document over 10 MB, declared or not, before storing anything', async () => {
    const { upload, files } = await setup();
    const declared = await upload(utf8('x'), {
      headers: { 'content-length': String(MAX_DOCUMENT_BYTES + 1) },
    });
    expect(declared).toEqual({ status: 413, body: { error: 'document_too_large' } });
    const actual = await upload(new Uint8Array(MAX_DOCUMENT_BYTES + 1).fill(0x61));
    expect(actual).toEqual({ status: 413, body: { error: 'document_too_large' } });
    expect(files.keys()).toEqual([]);
  });

  it('answers 200 with the stored document when the same bytes come again', async () => {
    const { upload, auditEvents } = await setup();
    const first = await upload(PDF, { type: 'application/pdf', name: 'a.pdf' });
    const again = await upload(PDF, { type: 'application/pdf', name: 'b.pdf' });
    expect(again).toEqual({
      status: 200,
      body: { document: first.body.document, duplicate: true },
    });
    expect((await auditEvents()).filter((e) => e.action === 'document.uploaded')).toHaveLength(1);
  });

  it("never shows another organization's documents", async () => {
    const { upload, json, base, orgA, orgB, app, as } = await setup();
    const document = (await upload(PDF, { type: 'application/pdf', name: 'a.pdf' })).body
      .document as DocumentView;
    // Bob, in his own organization, asking for Alice's document id.
    expect(await json('token-bob', 'GET', `${base(orgB)}/${document.id}`)).toEqual({
      status: 404,
      body: { error: 'document_not_found' },
    });
    const content = await app.request(
      `${base(orgB)}/${document.id}/content`,
      as('token-bob', { method: 'GET' }),
    );
    expect(content.status).toBe(404);
    expect((await json('token-bob', 'GET', base(orgB))).body.documents).toEqual([]);
    // Bob asking in Alice's organization.
    expect((await json('token-bob', 'GET', `${base(orgA)}/${document.id}`)).status).toBe(403);
    expect(
      (await upload(PDF, { token: 'token-bob', org: orgA, type: 'application/pdf' })).status,
    ).toBe(403);
  });

  it('needs document.upload to upload and document.read to read', async () => {
    const noUpload = await setup({ without: ['document.upload'] });
    expect(await noUpload.upload(PDF, { type: 'application/pdf' })).toEqual({
      status: 403,
      body: { error: 'permission_denied' },
    });
    const noRead = await setup({ without: ['document.read'] });
    const created = await noRead.upload(PDF, { type: 'application/pdf' });
    expect(created.status).toBe(201);
    const id = (created.body.document as DocumentView).id;
    for (const path of ['', `/${id}`, `/${id}/content`]) {
      expect(
        (await noRead.json('token-alice', 'GET', `${noRead.base(noRead.orgA)}${path}`)).status,
      ).toBe(403);
    }
  });

  it('lists newest first, one page at a time', async () => {
    const { upload, json, base, orgA } = await setup();
    for (const n of [1, 2, 3]) await upload(utf8(`Documento ${n}`), { name: `d${n}.txt` });
    const first = await json('token-alice', 'GET', `${base(orgA)}?limit=2`);
    expect(first.body.documents?.map((d) => d.name)).toEqual(['d3.txt', 'd2.txt']);
    const second = await json(
      'token-alice',
      'GET',
      `${base(orgA)}?limit=2&cursor=${first.body.nextCursor as string}`,
    );
    expect(second.body).toMatchObject({ nextCursor: null });
    expect(second.body.documents?.map((d) => d.name)).toEqual(['d1.txt']);
    expect(await json('token-alice', 'GET', `${base(orgA)}?limit=x`)).toEqual({
      status: 400,
      body: { error: 'invalid_document', field: 'limit' },
    });
  });

  it('fails closed without a documents bucket: 503, and nothing stored', async () => {
    const { upload, json, base, orgA } = await setup({ noBucket: true });
    expect(await upload(PDF, { type: 'application/pdf' })).toEqual({
      status: 503,
      body: { error: 'storage_unavailable' },
    });
    expect((await json('token-alice', 'GET', base(orgA))).body.documents).toEqual([]);
    expect(
      (
        await json(
          'token-alice',
          'GET',
          `${base(orgA)}/99999999-9999-4999-8999-999999999999/content`,
        )
      ).body,
    ).toEqual({ error: 'storage_unavailable' });
  });
});

describe('documents configuration', () => {
  it('reads the documents bucket from DOCUMENTS_BUCKET, checked', () => {
    expect(loadConfig({ DOCUMENTS_BUCKET: 'melonoffice-dev-documents' }).documentsBucket).toBe(
      'melonoffice-dev-documents',
    );
    expect(loadConfig({}).documentsBucket).toBeUndefined();
    expect(loadConfig({ DOCUMENTS_BUCKET: '' }).documentsBucket).toBeUndefined();
    for (const bad of ['Bad', 'a', 'gs://x-documents', 'x/y', 'x.documents']) {
      expect(() => loadConfig({ DOCUMENTS_BUCKET: bad })).toThrow('Invalid DOCUMENTS_BUCKET');
    }
  });
});
