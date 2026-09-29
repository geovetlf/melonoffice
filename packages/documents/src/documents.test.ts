import {
  checkAssistedAIRequest,
  type AIGateway,
  type AIResponse,
  type AssistedAIRequest,
} from '@melonoffice/ai-gateway';
import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import {
  createCompanyBrain,
  InMemoryKnowledgeRepository,
  type CompanyBrainService,
} from '@melonoffice/brain';
import { openWallet } from '@melonoffice/credits';
import { DEFAULT_DEPARTMENT_CATALOGUE, provisionDepartments } from '@melonoffice/departments';
import type { InitialBilling, Organization, SubscriptionId, UserId } from '@melonoffice/domain';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService, ROLES, type Permission } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import {
  attachmentDisposition,
  checkContentType,
  checkDocumentName,
  createDocumentService,
  createGcsFileStore,
  createTextExtractor,
  DOCUMENT_TRANSCRIPTION_MAX_OUTPUT_TOKENS,
  DOCUMENT_TRANSCRIPTION_PROMPT,
  DocumentError,
  DOCX_CONTENT_TYPE,
  InMemoryDocumentRepository,
  InMemoryFileStore,
  isDocumentError,
  MAX_DOCUMENT_BYTES,
  METADATA_TOKEN_URL,
  type DocumentServiceOptions,
  type FileStore,
  type TextExtraction,
  type TextExtractor,
} from './index.js';
import { blankPage, buildDocx, buildPdf, textPage } from './test-fixtures.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const NOW = new Date('2026-09-29T12:00:00Z');

const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });

const utf8 = (text: string) => new TextEncoder().encode(text);
const PDF = utf8('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF');
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (isDocumentError(error)) return error.detail ? `${error.code}:${error.detail}` : error.code;
    throw error;
  }
  return 'accepted';
}

async function world(
  options: {
    readonly without?: readonly Permission[];
    readonly files?: FileStore | null;
    readonly knowledge?: DocumentServiceOptions['knowledge'] | null;
    readonly extractor?: DocumentServiceOptions['extractor'];
    readonly gateway?: DocumentServiceOptions['gateway'];
  } = {},
) {
  let tick = 0;
  const now = () => new Date(NOW.getTime() + 1000 * tick++);
  const audit = new InMemoryAuditStore();
  const tenancy = new InMemoryTenancyStore(() => NOW);
  const create = (user: UserId, name: string) =>
    createOrganization(as(user), { name }, tenancy, {
      billing: BILLING,
      departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
      credits: openWallet,
    });
  const a = await create(ALICE, 'A');
  const b = await create(BOB, 'B');
  const authorization = createAuthorizationService({
    ...ROLES,
    owner: ROLES.owner.filter((p) => !(options.without ?? []).includes(p)),
  });
  const knowledgeRepository = new InMemoryKnowledgeRepository(audit);
  const brain = createCompanyBrain({
    repository: knowledgeRepository,
    organizations: tenancy,
    authorization,
    now,
  });
  const files = new InMemoryFileStore();
  const repository = new InMemoryDocumentRepository(audit);
  const logs: string[] = [];
  const logger = createLogger({ service: 'documents-test', sink: (line) => logs.push(line) });
  const service = createDocumentService({
    repository,
    ...(options.files === null ? {} : { files: options.files ?? files }),
    authorization,
    ...(options.knowledge === null ? {} : { knowledge: options.knowledge ?? brain }),
    ...(options.extractor === undefined ? {} : { extractor: options.extractor }),
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    now,
    requestId: 'req-1',
    logger,
  });
  return {
    service,
    logs,
    files,
    repository,
    audit,
    knowledgeRepository,
    orgA: a.organization.id,
    orgB: b.organization.id,
    alice: await resolveTenant(as(ALICE), a.organization.id, tenancy),
    bob: await resolveTenant(as(BOB), b.organization.id, tenancy),
    gia: await resolveTenant(as(ALICE, 'gia'), a.organization.id, tenancy),
    runtime: await resolveRuntimeTenant(ALICE, a.organization.id, tenancy),
  };
}

const text = (body = 'Combo Familiar S/45', name = 'Carta.txt') => ({
  name,
  contentType: 'text/plain',
  bytes: utf8(body),
});

describe('Documents: uploading (ADR-0078)', () => {
  it('stores a text file under a key the server builds, records it and gives its text to Company Brain', async () => {
    const w = await world();
    const { document, duplicate } = await w.service.upload(w.alice, text());
    expect(duplicate).toBe(false);
    expect(document).toMatchObject({
      organizationId: w.orgA,
      name: 'Carta.txt',
      contentType: 'text/plain',
      sizeBytes: 19,
      storageKey: `organizations/${w.orgA}/documents/${document.id}`,
      status: 'ingested',
      textSource: 'file',
      uploadedBy: ALICE,
    });
    expect(document.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(w.files.keys()).toEqual([document.storageKey]);
    const knowledgeDocument = await w.knowledgeRepository.findDocument(
      w.orgA,
      document.knowledgeDocumentId ?? '',
    );
    expect(knowledgeDocument?.text).toBe('Combo Familiar S/45');
    const uploaded = w.audit.events().filter((e) => e.action === 'document.uploaded');
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toMatchObject({
      result: 'success',
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      organizationId: w.orgA,
      target: { type: 'document', id: document.id },
      requestId: 'req-1',
    });
    // Its name and content never reach the audit trail.
    expect(JSON.stringify(uploaded)).not.toMatch(/Carta|Combo/);
    expect(await w.service.get(w.alice, document.id)).toEqual(document);
    const content = await w.service.content(w.alice, document.id);
    expect(new TextDecoder().decode(content.bytes)).toBe('Combo Familiar S/45');
  });

  it('keeps a PDF and a DOCX without reading them when no reader is configured', async () => {
    const w = await world();
    const pdf = await w.service.upload(w.alice, {
      name: 'Contrato.pdf',
      contentType: 'application/pdf',
      bytes: PDF,
    });
    const docx = await w.service.upload(w.alice, {
      name: 'Propuesta.docx',
      contentType: DOCX_CONTENT_TYPE,
      bytes: DOCX,
    });
    for (const { document } of [pdf, docx]) {
      expect(document.status).toBe('stored');
      expect(document).not.toHaveProperty('knowledgeDocumentId');
      expect(document).not.toHaveProperty('ingestion');
    }
    expect(w.files.keys()).toHaveLength(2);
    expect(w.audit.events().filter((e) => e.action === 'knowledge.document_ingested')).toEqual([]);
  });

  it('refuses bytes that are not what the type says, and stores nothing', async () => {
    const w = await world();
    const refused = [
      { name: 'x.pdf', contentType: 'application/pdf', bytes: utf8('hola') },
      { name: 'x.docx', contentType: DOCX_CONTENT_TYPE, bytes: PDF },
      { name: 'x.txt', contentType: 'text/plain', bytes: new Uint8Array([0x68, 0x00, 0x69]) },
      { name: 'x.csv', contentType: 'text/csv', bytes: new Uint8Array([0x61, 0xff, 0xfe]) },
      { name: 'x.md', contentType: 'text/markdown', bytes: DOCX },
    ];
    for (const input of refused) {
      expect(await codeOf(w.service.upload(w.alice, input))).toBe('invalid_document:content');
    }
    expect(await codeOf(w.service.upload(w.alice, text('')))).toBe('invalid_document:empty');
    expect(
      await codeOf(
        w.service.upload(w.alice, { ...text(), bytes: new Uint8Array(MAX_DOCUMENT_BYTES + 1) }),
      ),
    ).toBe('document_too_large');
    expect(w.files.keys()).toEqual([]);
    expect(w.audit.events()).toEqual([]);
  });

  it('accepts only the listed types, with at most a UTF-8 charset on text', () => {
    expect(checkContentType('Text/Plain; charset="UTF-8"')).toBe('text/plain');
    expect(checkContentType('text/csv;charset=utf-8')).toBe('text/csv');
    for (const bad of [
      'text/html',
      'image/svg+xml',
      'application/octet-stream',
      'application/pdf; charset=utf-8',
      'text/plain; charset=latin1',
      'text/plain; boundary=x',
      '',
      undefined,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.macroenabled',
    ]) {
      expect(() => checkContentType(bad)).toThrow(DocumentError);
    }
  });

  it('checks the name: trimmed, 1 to 200 characters, no control characters, slashes or bidi overrides', () => {
    expect(checkDocumentName('  Carta 2026.txt ')).toBe('Carta 2026.txt');
    expect(checkDocumentName('Café & Menú (v2).md')).toBe('Café & Menú (v2).md');
    for (const bad of [
      '',
      '   ',
      'a'.repeat(201),
      '../etc/passwd',
      'a\\b',
      'a\nb',
      'a\u0000b',
      'factura‮fdp.exe',
      '\ud800',
      7,
    ]) {
      expect(() => checkDocumentName(bad)).toThrow(DocumentError);
    }
  });

  it('keeps the same bytes once: a second upload returns the stored document and records nothing', async () => {
    const w = await world();
    const first = await w.service.upload(w.alice, text());
    const again = await w.service.upload(w.alice, text(undefined, 'Otra copia.txt'));
    expect(again).toEqual({ document: first.document, duplicate: true });
    expect(w.files.keys()).toHaveLength(1);
    expect(w.audit.events().filter((e) => e.action === 'document.uploaded')).toHaveLength(1);
  });

  it("keeps each organization's documents apart", async () => {
    const w = await world();
    const mine = await w.service.upload(w.alice, text());
    expect(await codeOf(w.service.get(w.bob, mine.document.id))).toBe('document_not_found');
    expect(await codeOf(w.service.content(w.bob, mine.document.id))).toBe('document_not_found');
    expect((await w.service.list(w.bob, {})).items).toEqual([]);
    // The same bytes in another organization are another document, under its own key.
    const theirs = await w.service.upload(w.bob, text());
    expect(theirs.duplicate).toBe(false);
    expect(theirs.document.id).not.toBe(mine.document.id);
    expect(theirs.document.storageKey).toBe(
      `organizations/${w.orgB}/documents/${theirs.document.id}`,
    );
    expect(await codeOf(w.service.get(w.alice, 'not-an-id'))).toBe('document_not_found');
  });

  it('lets only a person with document.upload upload: never GIA or the runtime', async () => {
    const w = await world();
    expect(await codeOf(w.service.upload(w.gia, text()))).toBe('permission_denied');
    expect(await codeOf(w.service.upload(w.runtime, text()))).toBe('permission_denied');
    const narrowed = await world({ without: ['document.upload'] });
    expect(await codeOf(narrowed.service.upload(narrowed.alice, text()))).toBe('permission_denied');
    const blind = await world({ without: ['document.read'] });
    const { document } = await blind.service.upload(blind.alice, text());
    expect(await codeOf(blind.service.get(blind.alice, document.id))).toBe('permission_denied');
    expect(await codeOf(blind.service.list(blind.alice, {}))).toBe('permission_denied');
    expect(await codeOf(blind.service.content(blind.alice, document.id))).toBe('permission_denied');
    expect(w.files.keys()).toEqual([]);
  });

  it('never fails an upload because Company Brain could not take the text, and says why', async () => {
    const tooLong = await world();
    expect(
      (await tooLong.service.upload(tooLong.alice, text('x'.repeat(60_001)))).document,
    ).toMatchObject({ status: 'not_ingested', ingestion: 'too_long' });
    expect((await tooLong.service.upload(tooLong.alice, text(' \n\t '))).document).toMatchObject({
      status: 'not_ingested',
      ingestion: 'no_text',
    });

    const noBrain = await world({ knowledge: null });
    expect((await noBrain.service.upload(noBrain.alice, text())).document).toMatchObject({
      status: 'not_ingested',
      ingestion: 'unavailable',
    });

    const noPropose = await world({ without: ['knowledge.propose'] });
    expect((await noPropose.service.upload(noPropose.alice, text())).document).toMatchObject({
      status: 'not_ingested',
      ingestion: 'not_permitted',
    });

    const broken = await world({
      knowledge: {
        ingestDocument: () => Promise.reject(new Error('firestore down: secret detail')),
      },
    });
    const kept = await broken.service.upload(broken.alice, text());
    expect(kept.document).toMatchObject({ status: 'not_ingested', ingestion: 'unavailable' });
    expect(await broken.service.get(broken.alice, kept.document.id)).toEqual(kept.document);
  });

  it('fails closed without a file store: no upload and no download, the records stay readable', async () => {
    const w = await world({ files: null });
    expect(await codeOf(w.service.upload(w.alice, text()))).toBe(
      'storage_unavailable:not_configured',
    );
    expect(await codeOf(w.service.content(w.alice, '99999999-9999-4999-8999-999999999999'))).toBe(
      'storage_unavailable:not_configured',
    );
    expect((await w.service.list(w.alice, {})).items).toEqual([]);
  });

  it('turns a storage failure into storage_unavailable without its message, and records nothing', async () => {
    const failing: FileStore = {
      put: () => Promise.reject(new Error('bucket secret-name: 403 forbidden')),
      get: () => Promise.reject(new Error('bucket secret-name: 403 forbidden')),
    };
    const w = await world({ files: failing });
    const error = await w.service.upload(w.alice, text()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentError);
    expect((error as Error).message).toBe('storage_unavailable');
    expect(w.audit.events()).toEqual([]);
    expect((await w.service.list(w.alice, {})).items).toEqual([]);
  });

  it('serves only the bytes that were uploaded', async () => {
    const objects = new Map<string, Uint8Array>();
    const tampering: FileStore = {
      put: async (key, bytes) => void objects.set(key, bytes),
      get: async (key) => objects.get(key),
    };
    const w = await world({ files: tampering });
    const { document } = await w.service.upload(w.alice, text());
    objects.set(document.storageKey, utf8('Combo Familiar S/99'));
    expect(await codeOf(w.service.content(w.alice, document.id))).toBe(
      'storage_unavailable:integrity',
    );
    objects.delete(document.storageKey);
    expect(await codeOf(w.service.content(w.alice, document.id))).toBe('document_not_found');
  });

  it('stores nothing when its audit event cannot be recorded', async () => {
    const w = await world();
    const repository = new InMemoryDocumentRepository({
      append: () => Promise.reject(new Error('audit down')),
    });
    const service = createDocumentService({
      repository,
      files: w.files,
      authorization: createAuthorizationService(),
    });
    await expect(service.upload(w.alice, text())).rejects.toThrow('audit down');
    expect((await service.list(w.alice, {})).items).toEqual([]);
  });

  it('lists newest first, one page at a time, with a cursor bound to the organization', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      ids.unshift((await w.service.upload(w.alice, text(`Documento ${n}`))).document.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await w.service.list(w.alice, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((d) => d.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(ids);
    const first = await w.service.list(w.alice, { limit: 1 });
    expect(await codeOf(w.service.list(w.bob, { cursor: first.nextCursor as string }))).toBe(
      'invalid_document:cursor',
    );
    expect(await codeOf(w.service.list(w.alice, { cursor: 'nonsense' }))).toBe(
      'invalid_document:cursor',
    );
    for (const limit of [0, 51, 1.5]) {
      expect(await codeOf(w.service.list(w.alice, { limit }))).toBe('invalid_document:limit');
    }
  });
});

describe('downloads', () => {
  it('names the file safely in content-disposition', () => {
    expect(attachmentDisposition('Carta 2026.txt')).toBe(
      `attachment; filename="Carta 2026.txt"; filename*=UTF-8''Carta%202026.txt`,
    );
    const header = attachmentDisposition('Menú "final"; x=1\'(v2)*.pdf');
    expect(header).toBe(
      `attachment; filename="Men_ _final__ x_1__v2__.pdf"; filename*=UTF-8''Men%C3%BA%20%22final%22%3B%20x%3D1%27%28v2%29%2A.pdf`,
    );
    expect(header).not.toMatch(/[\r\n]/);
  });
});

describe('Cloud Storage file store', () => {
  type Call = { readonly url: string; readonly init: RequestInit };
  function fakeGoogle(answers: ((call: Call) => Response)[]) {
    const calls: Call[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      if (call.url === METADATA_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }));
      }
      const next = answers.shift();
      if (next === undefined) throw new Error('unexpected call');
      return next(call);
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  }
  const KEY = `organizations/${'a'.repeat(8)}-aaaa-4aaa-8aaa-${'a'.repeat(12)}/documents/${'b'.repeat(8)}-bbbb-4bbb-8bbb-${'b'.repeat(12)}`;

  it('creates an object once, with the service identity, and treats an existing one as stored', async () => {
    const google = fakeGoogle([
      () => new Response('{}', { status: 200 }),
      () => new Response('{"error":{"message":"exists"}}', { status: 412 }),
    ]);
    const store = createGcsFileStore({ bucket: 'test-project-documents', fetch: google.fetch });
    await store.put(KEY, utf8('hola'), 'text/plain');
    await store.put(KEY, utf8('hola'), 'text/plain');
    const uploads = google.calls.filter((c) => c.url !== METADATA_TOKEN_URL);
    expect(uploads[0]?.url).toBe(
      `https://storage.googleapis.com/upload/storage/v1/b/test-project-documents/o?uploadType=media&name=${encodeURIComponent(KEY)}&ifGenerationMatch=0`,
    );
    expect(uploads[0]?.init.method).toBe('POST');
    expect(uploads[0]?.init.headers).toEqual({
      'content-type': 'text/plain',
      authorization: 'Bearer tok-1',
    });
    // The token is asked for once and reused.
    expect(google.calls.filter((c) => c.url === METADATA_TOKEN_URL)).toHaveLength(1);
    expect(google.calls.find((c) => c.url === METADATA_TOKEN_URL)?.init.headers).toEqual({
      'metadata-flavor': 'Google',
    });
  });

  it('reads an object, says when there is none, and never passes on what Google says', async () => {
    const google = fakeGoogle([
      () => new Response(utf8('hola'), { status: 200 }),
      () => new Response('not found', { status: 404 }),
      () => new Response('{"error":{"message":"secret bucket detail"}}', { status: 403 }),
      () => new Response('nope', { status: 401 }),
      () => new Response(utf8('otra vez'), { status: 200 }),
    ]);
    const store = createGcsFileStore({ bucket: 'test-project-documents', fetch: google.fetch });
    expect(new TextDecoder().decode(await store.get(KEY))).toBe('hola');
    expect(google.calls.at(-1)?.url).toBe(
      `https://storage.googleapis.com/storage/v1/b/test-project-documents/o/${encodeURIComponent(KEY)}?alt=media`,
    );
    expect(await store.get(KEY)).toBeUndefined();
    const refused = await store.get(KEY).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DocumentError);
    expect((refused as DocumentError).code).toBe('storage_unavailable');
    expect((refused as Error).message).not.toMatch(/secret/);
    // A refused token is dropped: the next call asks the metadata server again.
    await expect(store.get(KEY)).rejects.toThrow('storage_unavailable');
    expect(new TextDecoder().decode(await store.get(KEY))).toBe('otra vez');
    expect(google.calls.filter((c) => c.url === METADATA_TOKEN_URL)).toHaveLength(2);
  });

  it('refuses a malformed bucket or key, and fails closed without a token', async () => {
    for (const bucket of ['', 'UPPER', 'a', 'has.dots', 'goog-bucket', 'x/y']) {
      expect(() => createGcsFileStore({ bucket })).toThrow('documents.bucket');
    }
    const google = fakeGoogle([]);
    const store = createGcsFileStore({ bucket: 'test-project-documents', fetch: google.fetch });
    for (const key of ['../x', 'a/../b', 'a//b', '/a', 'a?b', 'a b']) {
      await expect(store.get(key)).rejects.toThrow('storage_unavailable');
    }
    const noToken = createGcsFileStore({
      bucket: 'test-project-documents',
      fetch: (async () => new Response('', { status: 500 })) as typeof fetch,
    });
    await expect(noToken.put(KEY, utf8('x'), 'text/plain')).rejects.toThrow(
      'storage_unavailable: token',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// DOC-2 (ADR-0079): reading PDF and DOCX text.

/** A reader that answers what the test says, and remembers what it was given. */
function fakeExtractor(result: TextExtraction) {
  const calls: { contentType: string; size: number }[] = [];
  const extractor: TextExtractor = {
    extract: async (contentType, bytes) => {
      calls.push({ contentType, size: bytes.length });
      return result;
    },
  };
  return { extractor, calls };
}

/** An AI Gateway that answers what the test says, and remembers every assisted call. */
function fakeGateway(answer: (request: AssistedAIRequest) => AIResponse) {
  const calls: { tenant: TenantContext; request: AssistedAIRequest }[] = [];
  const gateway: Pick<AIGateway, 'assist'> = {
    assist: async (tenant, request) => {
      calls.push({ tenant, request });
      return answer(request);
    },
  };
  return { gateway, calls };
}

const completed = (
  text: string,
  finishReason: 'stop' | 'length' = 'stop',
): ((request: AssistedAIRequest) => AIResponse) => {
  return (request) => ({
    status: 'completed',
    requestId: request.requestId,
    provider: 'google-vertex-ai',
    model: 'gemini-2.5-flash-lite',
    versions: { adapter: '4', model: 'stable', policy: { id: 'document_read', version: 1 } },
    output: { text },
    usage: { inputTokens: 600, outputTokens: 40 },
    latencyMs: 5,
    finishReason,
    cost: { estimatedMicroUsd: 7_000, actualMicroUsd: 76 },
    credits: { state: 'consumed', estimated: 1, consumed: 1 },
    providerRequestId: null,
    attempts: 1,
    fallbackFrom: null,
    strategy: 'balanced',
  });
};

const denied =
  (code: string) =>
  (request: AssistedAIRequest): AIResponse => ({
    status: 'denied',
    requestId: request.requestId,
    code,
  });

const pdf = (bytes: Uint8Array = PDF) => ({
  name: 'Escaneo.pdf',
  contentType: 'application/pdf',
  bytes,
});
const docx = (bytes: Uint8Array = DOCX) => ({
  name: 'Propuesta.docx',
  contentType: DOCX_CONTENT_TYPE,
  bytes,
});

describe('Documents: reading PDF and DOCX text (ADR-0079)', () => {
  it('gives text a library read to Company Brain, and says it was read by a library', async () => {
    const reader = fakeExtractor({
      status: 'text',
      text: 'Precio mayorista S/12',
      pages: 2,
      truncated: false,
    });
    const ai = fakeGateway(completed('never used'));
    const w = await world({ extractor: reader.extractor, gateway: ai.gateway });
    const { document } = await w.service.upload(w.alice, pdf());
    expect(document).toMatchObject({ status: 'ingested', textSource: 'library', pages: 2 });
    expect(reader.calls).toEqual([{ contentType: 'application/pdf', size: PDF.length }]);
    expect(ai.calls).toEqual([]);
    const knowledge = await w.knowledgeRepository.findDocument(
      w.orgA,
      document.knowledgeDocumentId ?? '',
    );
    expect(knowledge?.text).toBe('Precio mayorista S/12');
    expect(await w.service.get(w.alice, document.id)).toEqual(document);

    const docxRead = await w.service.upload(w.alice, docx());
    expect(docxRead.document).toMatchObject({ status: 'ingested', textSource: 'library' });
  });

  it('reads a PDF with no text layer with the model, through an assisted call about it', async () => {
    const reader = fakeExtractor({ status: 'text', text: ' \n ', pages: 3, truncated: false });
    const ai = fakeGateway(completed('Factura 001\nTotal S/90'));
    const w = await world({ extractor: reader.extractor, gateway: ai.gateway });
    const { document } = await w.service.upload(w.alice, pdf());
    expect(document).toMatchObject({ status: 'ingested', textSource: 'model', pages: 3 });
    expect(ai.calls).toHaveLength(1);
    const [call] = ai.calls;
    expect(call?.tenant).toBe(w.alice);
    expect(call?.request).toEqual({
      requestId: `document-read-${document.id}`,
      subject: { type: 'document', id: document.id },
      taskType: 'document_transcription',
      capability: 'text_generation',
      messages: [
        { role: 'system', content: [{ type: 'text', text: DOCUMENT_TRANSCRIPTION_PROMPT }] },
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mimeType: 'application/pdf',
              ref: {
                type: 'stored_document',
                id: `organizations/${w.orgA}/documents/${document.id}`,
              },
              pages: 3,
            },
            { type: 'text', text: 'Transcribe the attached document.' },
          ],
        },
      ],
      outputModality: 'text',
      maxOutputTokens: DOCUMENT_TRANSCRIPTION_MAX_OUTPUT_TOKENS,
      sensitivity: 'confidential',
    });
    // The request passes the gateway's own checks.
    expect(checkAssistedAIRequest(call?.request)).toBeUndefined();
    // Nothing from the document or its name reaches the prompt.
    expect(JSON.stringify(call?.request)).not.toContain('Escaneo');
    const knowledge = await w.knowledgeRepository.findDocument(
      w.orgA,
      document.knowledgeDocumentId ?? '',
    );
    expect(knowledge?.text).toBe('Factura 001\nTotal S/90');
  });

  it('never asks the model about a DOCX, a long PDF, or text Company Brain could not take', async () => {
    const blank = { status: 'text', text: '', truncated: false } as const;
    const ai = fakeGateway(completed('x'));
    const emptyDocx = await world({
      extractor: fakeExtractor(blank).extractor,
      gateway: ai.gateway,
    });
    expect((await emptyDocx.service.upload(emptyDocx.alice, docx())).document).toMatchObject({
      status: 'not_ingested',
      ingestion: 'no_text',
      textSource: 'library',
    });
    const long = await world({
      extractor: fakeExtractor({ ...blank, pages: 101 }).extractor,
      gateway: ai.gateway,
    });
    expect((await long.service.upload(long.alice, pdf())).document).toMatchObject({
      status: 'not_ingested',
      ingestion: 'too_many_pages',
      pages: 101,
    });
    const reader = fakeExtractor({ ...blank, pages: 1 });
    const noPropose = await world({
      extractor: reader.extractor,
      gateway: ai.gateway,
      without: ['knowledge.propose'],
    });
    expect((await noPropose.service.upload(noPropose.alice, pdf())).document).toMatchObject({
      status: 'not_ingested',
      ingestion: 'not_permitted',
    });
    const noBrain = await world({
      extractor: reader.extractor,
      gateway: ai.gateway,
      knowledge: null,
    });
    expect((await noBrain.service.upload(noBrain.alice, pdf())).document).toMatchObject({
      status: 'not_ingested',
      ingestion: 'unavailable',
    });
    // Company Brain could not take it: not even read.
    expect(reader.calls).toEqual([]);
    const noGateway = await world({ extractor: reader.extractor });
    expect((await noGateway.service.upload(noGateway.alice, pdf())).document).toMatchObject({
      status: 'not_ingested',
      ingestion: 'unavailable',
      pages: 1,
    });
    expect(ai.calls).toEqual([]);
  });

  it('records why a file could not be read, with closed codes, and never fails the upload', async () => {
    const cases: [TextExtraction, string][] = [
      [{ status: 'failed', code: 'unreadable' }, 'unreadable'],
      [{ status: 'failed', code: 'timeout' }, 'timeout'],
      [{ status: 'failed', code: 'encrypted' }, 'encrypted'],
      [{ status: 'failed', code: 'too_large' }, 'too_long'],
      [{ status: 'failed', code: 'too_many_pages', pages: 900 }, 'too_many_pages'],
      [{ status: 'text', text: 'x'.repeat(200_000), pages: 9, truncated: true }, 'too_long'],
      [{ status: 'text', text: 'x'.repeat(60_001), pages: 9, truncated: false }, 'too_long'],
    ];
    for (const [result, ingestion] of cases) {
      const w = await world({ extractor: fakeExtractor(result).extractor });
      const { document } = await w.service.upload(w.alice, pdf());
      expect(document).toMatchObject({ status: 'not_ingested', ingestion });
      expect(await w.service.get(w.alice, document.id)).toEqual(document);
    }
    const throwing = await world({
      extractor: { extract: () => Promise.reject(new Error('boom: secret detail')) },
    });
    const kept = await throwing.service.upload(throwing.alice, pdf());
    expect(kept.document).toMatchObject({ status: 'not_ingested', ingestion: 'unreadable' });
    expect(throwing.logs.join('\n')).not.toContain('secret detail');
  });

  it("maps the gateway's answers to closed codes: credits, unavailable, too_long, no_text", async () => {
    const reader = fakeExtractor({ status: 'text', text: '', pages: 2, truncated: false });
    const cases: [(request: AssistedAIRequest) => AIResponse, string][] = [
      [denied('credits_insufficient'), 'credits'],
      [denied('credit_limit_exceeded'), 'credits'],
      [denied('credits_unavailable'), 'credits'],
      [denied('policy_not_found'), 'unavailable'],
      [denied('credits_not_configured'), 'unavailable'],
      [denied('authority_in_input'), 'unavailable'],
      [
        (request) => ({
          status: 'failed',
          requestId: request.requestId,
          code: 'timeout',
          provider: 'google-vertex-ai',
          model: 'gemini-2.5-flash-lite',
          attempts: 2,
          latencyMs: 9,
        }),
        'unavailable',
      ],
      [completed('Cortado a la mitad', 'length'), 'too_long'],
      [completed('   '), 'no_text'],
      [completed('y'.repeat(60_001)), 'too_long'],
    ];
    for (const [answer, ingestion] of cases) {
      const ai = fakeGateway(answer);
      const w = await world({ extractor: reader.extractor, gateway: ai.gateway });
      const { document } = await w.service.upload(w.alice, pdf());
      expect(document).toMatchObject({ status: 'not_ingested', ingestion, pages: 2 });
      expect(ai.calls).toHaveLength(1);
    }
    const throwing = await world({
      extractor: reader.extractor,
      gateway: { assist: () => Promise.reject(new Error('down')) },
    });
    expect((await throwing.service.upload(throwing.alice, pdf())).document).toMatchObject({
      status: 'not_ingested',
      ingestion: 'unavailable',
    });
    expect(throwing.logs.join('\n')).toContain('documents.transcription_failed');
  });

  it('reads a document stored before it could be read when it is uploaded again, and only then', async () => {
    const stored = await world();
    const first = await stored.service.upload(stored.alice, pdf());
    expect(first.document.status).toBe('stored');
    // The same repository, now with a reader: the same bytes read the stored document.
    const reader = fakeExtractor({ status: 'text', text: 'Contrato', pages: 1, truncated: false });
    const service = createDocumentService({
      repository: stored.repository,
      files: stored.files,
      authorization: createAuthorizationService(ROLES),
      knowledge: {
        ingestDocument: async () =>
          ({ document: { id: 'kd-1' } }) as Awaited<
            ReturnType<CompanyBrainService['ingestDocument']>
          >,
      },
      extractor: reader.extractor,
    });
    const again = await service.upload(stored.alice, pdf());
    expect(again).toMatchObject({
      duplicate: true,
      document: {
        id: first.document.id,
        status: 'ingested',
        knowledgeDocumentId: 'kd-1',
        textSource: 'library',
      },
    });
    // Once read, a further upload reads nothing.
    const third = await service.upload(stored.alice, pdf());
    expect(third).toEqual({ document: again.document, duplicate: true });
    expect(reader.calls).toHaveLength(1);
    expect(stored.audit.events().filter((e) => e.action === 'document.uploaded')).toHaveLength(1);
  });

  it('reads a scan again when uploaded again after a passing failure, with the same request id', async () => {
    const reader = fakeExtractor({ status: 'text', text: '', pages: 1, truncated: false });
    let answer = denied('credits_insufficient');
    const ai = fakeGateway((request) => answer(request));
    const w = await world({ extractor: reader.extractor, gateway: ai.gateway });
    const first = await w.service.upload(w.alice, pdf());
    expect(first.document).toMatchObject({ status: 'not_ingested', ingestion: 'credits' });
    answer = completed('Recibo 7');
    const again = await w.service.upload(w.alice, pdf());
    expect(again).toMatchObject({
      duplicate: true,
      document: { status: 'ingested', textSource: 'model' },
    });
    expect(ai.calls.map((c) => c.request.requestId)).toEqual([
      `document-read-${first.document.id}`,
      `document-read-${first.document.id}`,
    ]);
    // What cannot change by trying again is not read again.
    const unreadable = await world({
      extractor: fakeExtractor({ status: 'failed', code: 'unreadable' }).extractor,
    });
    await unreadable.service.upload(unreadable.alice, pdf());
    const reread = fakeExtractor({ status: 'text', text: 'x', truncated: false });
    const later = createDocumentService({
      repository: unreadable.repository,
      files: unreadable.files,
      authorization: createAuthorizationService(ROLES),
      extractor: reread.extractor,
    });
    expect((await later.upload(unreadable.alice, pdf())).document).toMatchObject({
      status: 'not_ingested',
      ingestion: 'unreadable',
    });
    expect(reread.calls).toEqual([]);
  });

  it('reads a real PDF and a real DOCX end to end with the local extractor', async () => {
    const ai = fakeGateway(completed('Texto del escaneo'));
    const w = await world({ extractor: createTextExtractor(), gateway: ai.gateway });
    const withText = await w.service.upload(
      w.alice,
      pdf(buildPdf([textPage('Lista de precios 2026')])),
    );
    expect(withText.document).toMatchObject({
      status: 'ingested',
      textSource: 'library',
      pages: 1,
    });
    const scan = await w.service.upload(w.alice, pdf(buildPdf([blankPage, blankPage])));
    expect(scan.document).toMatchObject({ status: 'ingested', textSource: 'model', pages: 2 });
    expect(ai.calls).toHaveLength(1);
    const word = await w.service.upload(
      w.alice,
      docx(buildDocx('<w:p><w:r><w:t>Propuesta comercial</w:t></w:r></w:p>')),
    );
    expect(word.document).toMatchObject({ status: 'ingested', textSource: 'library' });
    const texts = await Promise.all(
      [withText, word].map(
        async ({ document }) =>
          (await w.knowledgeRepository.findDocument(w.orgA, document.knowledgeDocumentId ?? ''))
            ?.text,
      ),
    );
    expect(texts[0]).toContain('Lista de precios 2026');
    expect(texts[1]).toBe('Propuesta comercial\n');
  });
});
