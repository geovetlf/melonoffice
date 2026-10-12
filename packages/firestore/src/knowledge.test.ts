import type { OrganizationId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { FirestoreKnowledgeRepository, KNOWLEDGE_ITEMS } from './knowledge.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

/**
 * Company Brain pages on the emulator (ADR-0132, ADR-0187): a page is one organization's items in
 * document-id order, after the cursor, and never another organization's.
 */

const ORG_A = '5e1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b' as OrganizationId;
const ORG_B = '6f5e4d3c-2b1a-4f9e-8d7c-6b5a4f3e2d1c' as OrganizationId;
const ORG_C = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d' as OrganizationId;
const ORG_D = '8b7c6d5e-4f3a-4b2c-9d8e-1f0a2b3c4d5e' as OrganizationId;

describe.runIf(emulatorHost)('Company Brain pages (ADR-0132, emulator)', () => {
  it('walks an organization’s items a page at a time, in document-id order, and only its own', async () => {
    const db = emulatorFirestore();
    const repository = new FirestoreKnowledgeRepository(db);
    // Another organization's items sit between this one's, in the same collection.
    const rows: [OrganizationId, string][] = [
      [ORG_A, 'page-a'],
      [ORG_A, 'page-b'],
      [ORG_B, 'page-c'],
      [ORG_A, 'page-d'],
      [ORG_B, 'page-e'],
      [ORG_A, 'page-f'],
      [ORG_B, 'page-g'],
      [ORG_A, 'page-h'],
    ];
    for (const [organizationId, id] of rows) {
      await db.collection(KNOWLEDGE_ITEMS).doc(id).set({ id, organizationId });
    }
    const first = await repository.pageItems(ORG_A, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['page-a', 'page-b']);
    expect(first.next).toBe('page-b');
    const second = await repository.pageItems(ORG_A, { after: 'page-b', limit: 2 });
    expect(second.items.map((item) => item.id)).toEqual(['page-d', 'page-f']);
    expect(second.next).toBe('page-f');
    const last = await repository.pageItems(ORG_A, { after: 'page-f', limit: 2 });
    expect(last.items.map((item) => item.id)).toEqual(['page-h']);
    expect(last.next).toBeUndefined();
  });

  it('ends a walk after a full page with an empty page, and has no page for an organization with no items', async () => {
    const db = emulatorFirestore();
    const repository = new FirestoreKnowledgeRepository(db);
    await db.collection(KNOWLEDGE_ITEMS).doc('page-a').set({ id: 'page-a', organizationId: ORG_A });
    await db.collection(KNOWLEDGE_ITEMS).doc('page-b').set({ id: 'page-b', organizationId: ORG_A });
    const full = await repository.pageItems(ORG_A, { limit: 2 });
    expect(full.items.map((item) => item.id)).toEqual(['page-a', 'page-b']);
    expect(full.next).toBe('page-b');
    expect(await repository.pageItems(ORG_A, { after: 'page-b', limit: 2 })).toEqual({ items: [] });
    expect(await repository.pageItems(ORG_B, { limit: 2 })).toEqual({ items: [] });
  });

  it('reads one snapshot: an item written during a walk is not read by it, and the next read sees it', async () => {
    const db = emulatorFirestore();
    const repository = new FirestoreKnowledgeRepository(db);
    await db.collection(KNOWLEDGE_ITEMS).doc('snap-a').set({ id: 'snap-a', organizationId: ORG_D });
    await db.collection(KNOWLEDGE_ITEMS).doc('snap-b').set({ id: 'snap-b', organizationId: ORG_D });
    const walked = await repository.snapshot(async (view) => {
      const first = await view.pageItems(ORG_D, { limit: 1 });
      if (first.next === undefined) throw new Error('the first page is not full');
      // Written after the first page, past its cursor: the walk's later pages are from the moment it began.
      await db
        .collection(KNOWLEDGE_ITEMS)
        .doc('snap-c')
        .set({ id: 'snap-c', organizationId: ORG_D });
      const rest = await view.pageItems(ORG_D, { after: first.next, limit: 10 });
      return [...first.items, ...rest.items].map((item) => item.id);
    });
    expect(walked).toEqual(['snap-a', 'snap-b']);
    expect((await repository.pageItems(ORG_D, { limit: 10 })).items.map((item) => item.id)).toEqual(
      ['snap-a', 'snap-b', 'snap-c'],
    );
  });

  it('counts an organization’s items exactly, and only its own', async () => {
    const db = emulatorFirestore();
    const repository = new FirestoreKnowledgeRepository(db);
    const rows: [OrganizationId, string][] = [
      [ORG_A, 'count-a'],
      [ORG_B, 'count-b'],
      [ORG_A, 'count-c'],
      [ORG_A, 'count-d'],
    ];
    for (const [organizationId, id] of rows) {
      await db.collection(KNOWLEDGE_ITEMS).doc(id).set({ id, organizationId });
    }
    expect(await repository.countItems(ORG_A)).toBe(3);
    expect(await repository.countItems(ORG_B)).toBe(1);
    expect(await repository.countItems(ORG_C)).toBe(0);
  });
});
