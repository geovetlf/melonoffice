import { Query } from '@google-cloud/firestore';
import type { Contact, ContactId, IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTACTS, FirestoreConversationRepository, toContactDocument } from './conversations.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const ORG_A = '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const ORG_B = '9b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const contactId = (n: number) =>
  `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}` as ContactId;

const contact = (
  n: number,
  organizationId: OrganizationId,
  stage: 'lead' | 'customer' | undefined,
  status: 'active' | 'archived' = 'active',
): Contact => ({
  id: contactId(n),
  organizationId,
  displayName: `Cliente ${n}`,
  status,
  origin: { kind: 'user', userId: '11111111-1111-4111-8111-111111111111' as UserId },
  ...(stage === undefined
    ? {}
    : {
        commercial: {
          stage,
          source: { kind: 'manual' },
          consent: { messaging: 'unknown' },
          stageChangedAt: '2026-09-28T12:00:00.000Z' as IsoTimestamp,
        },
      }),
  revision: 1,
  createdAt: '2026-09-28T12:00:00.000Z' as IsoTimestamp,
  // Two share a time: the id decides between them.
  updatedAt: `2026-09-28T12:00:${String(Math.min(n, 5)).padStart(2, '0')}.000Z` as IsoTimestamp,
});

afterEach(() => vi.restoreAllMocks());

describe.runIf(emulatorHost)('Firestore pages (ADR-0061, emulator)', () => {
  async function seed() {
    const db = emulatorFirestore();
    const rows = [
      ...[1, 2, 3, 4, 5, 6].map((n) => contact(n, ORG_A, 'lead')),
      contact(7, ORG_A, 'customer'),
      contact(8, ORG_A, undefined),
      contact(9, ORG_A, 'lead', 'archived'),
      contact(10, ORG_B, 'lead'),
    ];
    await Promise.all(rows.map((c) => db.collection(CONTACTS).doc(c.id).set(toContactDocument(c))));
    return db;
  }

  const walk = async (repository: FirestoreConversationRepository, limit: number) => {
    const seen: string[] = [];
    let after: { at: string; id: string } | undefined;
    for (;;) {
      const page = await repository.pageContacts(ORG_A, {
        filter: { stage: 'lead' },
        limit,
        ...(after === undefined ? {} : { after }),
      });
      seen.push(...page.items.map((c) => c.id));
      const last = page.items.at(-1);
      if (!page.hasMore || last === undefined) return seen;
      after = { at: last.updatedAt, id: last.id };
    }
  };

  // Newest change first; contacts 5 and 6 share a time, so the larger id comes first.
  const LEADS = [6, 5, 4, 3, 2, 1].map(contactId);

  it('reads only the page: the organization, active and marked contacts, in a stable order', async () => {
    const repository = new FirestoreConversationRepository(await seed());
    for (const limit of [1, 2, 4, 6]) expect(await walk(repository, limit)).toEqual(LEADS);
    const anyStage = await repository.pageContacts(ORG_A, { filter: {}, limit: 50 });
    expect(anyStage.items.map((c) => c.id)).toEqual([contactId(7), ...LEADS]);
    expect(await repository.countContactStages(ORG_A)).toEqual({
      lead: 6,
      customer: 1,
      inactive: 0,
    });
    expect(await repository.countContactStages(ORG_B)).toEqual({
      lead: 1,
      customer: 0,
      inactive: 0,
    });
    const found = await repository.findContacts(ORG_A, [contactId(1), contactId(10), contactId(1)]);
    expect(found.map((c) => c.id)).toEqual([contactId(1)]);
  });

  it('while the composite index is missing, cuts the same page from the whole collection and says so', async () => {
    const missing: string[] = [];
    const repository = new FirestoreConversationRepository(await seed(), {
      onIndexMissing: (query) => missing.push(query),
    });
    const real = Query.prototype.get;
    vi.spyOn(Query.prototype, 'get').mockImplementation(function (this: Query) {
      // Only the ordered page query needs the composite index; the whole read does not.
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
    for (const limit of [1, 4, 6]) expect(await walk(repository, limit)).toEqual(LEADS);
    expect(new Set(missing)).toEqual(new Set(['contacts']));
  });

  it('never hides another error as a missing index', async () => {
    const repository = new FirestoreConversationRepository(await seed());
    vi.spyOn(Query.prototype, 'get').mockRejectedValue(
      Object.assign(new Error('14 UNAVAILABLE'), { code: 14 }),
    );
    await expect(repository.pageContacts(ORG_A, { filter: {}, limit: 2 })).rejects.toThrow(
      'UNAVAILABLE',
    );
  });
});
