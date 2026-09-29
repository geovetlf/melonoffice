import { Query } from '@google-cloud/firestore';
import { buildAuditEvent } from '@melonoffice/audit';
import type {
  DocumentId,
  IsoTimestamp,
  OrganizationId,
  StoredDocument,
  UserId,
} from '@melonoffice/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_LOGS } from './audit.js';
import { DOCUMENTS, FirestoreDocumentRepository } from './documents.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as OrganizationId;
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as OrganizationId;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const idOf = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}` as DocumentId;

const document = (n: number, organizationId: OrganizationId): StoredDocument => ({
  id: idOf(n),
  organizationId,
  name: `Documento ${n}.txt`,
  contentType: 'text/plain',
  sizeBytes: 10 + n,
  sha256: String(n).repeat(64).slice(0, 64),
  storageKey: `organizations/${organizationId}/documents/${idOf(n)}`,
  status: 'stored',
  uploadedBy: ALICE,
  // Two share a time: the id decides between them.
  createdAt: `2026-09-29T12:00:${String(Math.min(n, 5)).padStart(2, '0')}.000Z` as IsoTimestamp,
  updatedAt: `2026-09-29T12:00:${String(Math.min(n, 5)).padStart(2, '0')}.000Z` as IsoTimestamp,
});

const uploaded = (d: StoredDocument) =>
  buildAuditEvent(
    {
      action: 'document.uploaded',
      result: 'success',
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      organizationId: d.organizationId,
      target: { type: 'document', id: d.id },
      source: 'api',
    },
    new Date(d.createdAt),
  );

afterEach(() => vi.restoreAllMocks());

describe.runIf(emulatorHost)('FirestoreDocumentRepository (ADR-0078, emulator)', () => {
  async function seed() {
    const db = emulatorFirestore();
    const repository = new FirestoreDocumentRepository(db);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const d = document(n, ORG_A);
      await repository.create(d, [uploaded(d)]);
    }
    const other = document(7, ORG_B);
    await repository.create(other, [uploaded(other)]);
    return { db, repository };
  }

  const walk = async (repository: FirestoreDocumentRepository, limit: number) => {
    const seen: string[] = [];
    let after: { at: IsoTimestamp; id: DocumentId } | undefined;
    for (;;) {
      const page = await repository.page(ORG_A, {
        limit,
        ...(after === undefined ? {} : { after }),
      });
      seen.push(...page.items.map((d) => d.id));
      const last = page.items.at(-1);
      if (!page.hasMore || last === undefined) return seen;
      after = { at: last.createdAt, id: last.id };
    }
  };

  // Newest first; documents 5 and 6 share a time, so the larger id comes first.
  const NEWEST_FIRST = [6, 5, 4, 3, 2, 1].map(idOf);

  it('writes a document once with its audit event, and keeps organizations apart', async () => {
    const { db, repository } = await seed();
    const first = document(1, ORG_A);
    expect(await repository.find(ORG_A, first.id)).toEqual(first);
    expect(await repository.find(ORG_B, first.id)).toBeUndefined();
    const again = await repository.create({ ...first, name: 'otro.txt' }, [uploaded(first)]);
    expect(again).toEqual({ document: first, created: false });
    const events = await db.collection(AUDIT_LOGS).where('targetId', '==', first.id).get();
    expect(events.size).toBe(1);
    expect(events.docs[0]?.data()).toMatchObject({
      action: 'document.uploaded',
      targetType: 'document',
      organizationId: ORG_A,
    });
    // The same id claimed by another organization is refused, never overwritten.
    await expect(repository.create({ ...first, organizationId: ORG_B }, [])).rejects.toThrow(
      'document id taken',
    );
    expect((await db.collection(DOCUMENTS).doc(first.id).get()).get('organizationId')).toBe(ORG_A);
  });

  it('changes only the status, and only for the organization', async () => {
    const { repository } = await seed();
    const at = '2026-09-29T13:00:00.000Z' as IsoTimestamp;
    expect(
      await repository.setStatus(ORG_B, idOf(1), { status: 'ingested', updatedAt: at }),
    ).toBeUndefined();
    const ingested = await repository.setStatus(ORG_A, idOf(1), {
      status: 'ingested',
      knowledgeDocumentId: `${ORG_A}_d_abc`,
      updatedAt: at,
    });
    expect(ingested).toEqual({
      ...document(1, ORG_A),
      status: 'ingested',
      knowledgeDocumentId: `${ORG_A}_d_abc`,
      updatedAt: at,
    });
    expect(await repository.find(ORG_A, idOf(1))).toEqual(ingested);
    const refused = await repository.setStatus(ORG_A, idOf(2), {
      status: 'not_ingested',
      ingestion: 'too_long',
      updatedAt: at,
    });
    expect(await repository.find(ORG_A, idOf(2))).toEqual(refused);
    expect(refused).toMatchObject({ status: 'not_ingested', ingestion: 'too_long' });
    expect(refused).not.toHaveProperty('knowledgeDocumentId');
  });

  it('reads one page at a time, newest first, only the organization', async () => {
    const { repository } = await seed();
    for (const limit of [1, 2, 4, 6]) expect(await walk(repository, limit)).toEqual(NEWEST_FIRST);
    expect((await repository.page(ORG_B, { limit: 10 })).items.map((d) => d.id)).toEqual([idOf(7)]);
  });

  it('while the composite index is missing, cuts the same page from the organization and says so', async () => {
    const missing: string[] = [];
    const { db } = await seed();
    const repository = new FirestoreDocumentRepository(db, {
      onIndexMissing: (query) => missing.push(query),
    });
    const real = Query.prototype.get;
    vi.spyOn(Query.prototype, 'get').mockImplementation(function (this: Query) {
      const ordered = (this as unknown as { _queryOptions: { fieldOrders: unknown[] } })
        ._queryOptions.fieldOrders.length;
      if (ordered > 0) {
        return Promise.reject(
          Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), {
            code: 9,
          }),
        );
      }
      return real.call(this);
    });
    for (const limit of [1, 4, 6]) expect(await walk(repository, limit)).toEqual(NEWEST_FIRST);
    expect(new Set(missing)).toEqual(new Set(['documents']));
  });

  it('never hides another error as a missing index', async () => {
    const { repository } = await seed();
    vi.spyOn(Query.prototype, 'get').mockRejectedValue(
      Object.assign(new Error('14 UNAVAILABLE'), { code: 14 }),
    );
    await expect(repository.page(ORG_A, { limit: 2 })).rejects.toThrow('UNAVAILABLE');
  });
});
