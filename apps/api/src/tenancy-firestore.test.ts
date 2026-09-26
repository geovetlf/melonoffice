import { Timestamp } from '@google-cloud/firestore';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { TenancyError } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import {
  FirestoreTenancyStore,
  MEMBERSHIPS,
  ORGANIZATION_CREATORS,
  ORGANIZATIONS,
} from './tenancy-firestore.js';
import { emulatorFirestore, emulatorHost } from './test-firestore.js';

const NOW = new Date('2026-09-26T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;

describe.runIf(emulatorHost)('FirestoreTenancyStore (emulator)', () => {
  function setup() {
    const db = emulatorFirestore();
    return { db, store: new FirestoreTenancyStore(db, () => NOW) };
  }

  it('writes the organization, the owner membership and the creator record together', async () => {
    const { db, store } = setup();
    const { organization, membership } = await store.createOrganization({
      name: 'Acme',
      creator: ALICE,
    });
    const at = Timestamp.fromDate(NOW);
    expect((await db.collection(ORGANIZATIONS).doc(organization.id).get()).data()).toEqual({
      name: 'Acme',
      status: 'active',
      createdBy: ALICE,
      createdAt: at,
      updatedAt: at,
    });
    expect(membership.id).toBe(`${organization.id}_${ALICE}`);
    expect((await db.collection(MEMBERSHIPS).doc(membership.id).get()).data()).toEqual({
      organizationId: organization.id,
      userId: ALICE,
      role: 'owner',
      status: 'active',
      createdAt: at,
      updatedAt: at,
    });
    expect((await db.collection(ORGANIZATION_CREATORS).doc(ALICE).get()).data()).toEqual({
      organizationId: organization.id,
      createdAt: at,
    });
    expect(await store.findOrganization(organization.id)).toEqual(organization);
    expect(await store.findMembership(organization.id, ALICE)).toEqual(membership);
    expect(await store.membershipsOfUser(ALICE)).toEqual([membership]);
  });

  it(
    'creates one organization per user, even under concurrent requests',
    { timeout: 30_000 },
    async () => {
      const { db, store } = setup();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () => store.createOrganization({ name: 'Acme', creator: ALICE })),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(TenancyError);
          expect((outcome.reason as TenancyError).code).toBe('organization_limit_reached');
        }
      }
      expect(await db.collection(ORGANIZATIONS).listDocuments()).toHaveLength(1);
      expect(await db.collection(MEMBERSHIPS).listDocuments()).toHaveLength(1);
      expect(await db.collection(ORGANIZATION_CREATORS).listDocuments()).toHaveLength(1);
    },
  );

  it('cannot hold two memberships for one user and organization: the id is the pair', async () => {
    const { db, store } = setup();
    const { organization, membership } = await store.createOrganization({
      name: 'Acme',
      creator: ALICE,
    });
    const duplicate = db.collection(MEMBERSHIPS).doc(`${organization.id}_${ALICE}`);
    await expect(
      duplicate.create({ organizationId: organization.id, userId: ALICE }),
    ).rejects.toThrow();
    expect(await store.membershipsOfUser(ALICE)).toEqual([membership]);
  });

  it('keeps users apart', async () => {
    const { store } = setup();
    const a = await store.createOrganization({ name: 'A', creator: ALICE });
    const b = await store.createOrganization({ name: 'B', creator: BOB });
    expect(await store.findMembership(b.organization.id, ALICE)).toBeUndefined();
    expect(await store.findMembership(a.organization.id, BOB)).toBeUndefined();
    expect((await store.membershipsOfUser(ALICE)).map((m) => m.organizationId)).toEqual([
      a.organization.id,
    ]);
  });

  it('finds nothing for ids that are not organization ids, without querying odd paths', async () => {
    const { store } = setup();
    for (const id of ['', 'a/b', '..', 'x'.repeat(2000)]) {
      expect(await store.findOrganization(id as OrganizationId)).toBeUndefined();
      expect(await store.findMembership(id as OrganizationId, ALICE)).toBeUndefined();
    }
  });

  it('refuses stored records with an unknown status or role instead of trusting them', async () => {
    const { db, store } = setup();
    const { organization } = await store.createOrganization({ name: 'Acme', creator: ALICE });
    await db.collection(MEMBERSHIPS).doc(`${organization.id}_${ALICE}`).update({ role: 'admin' });
    await expect(store.findMembership(organization.id, ALICE)).rejects.toThrow(
      'invalid membership record',
    );
    await db.collection(ORGANIZATIONS).doc(organization.id).update({ status: 'deleted' });
    await expect(store.findOrganization(organization.id)).rejects.toThrow(
      'invalid organization record',
    );
  });
});
