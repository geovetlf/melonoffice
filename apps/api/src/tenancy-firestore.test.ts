import { Timestamp } from '@google-cloud/firestore';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { buildAuditEvent } from '@melonoffice/audit';
import { TenancyError } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import {
  FirestoreTenancyStore,
  MEMBERSHIPS,
  ORGANIZATION_CREATORS,
  ORGANIZATIONS,
} from './tenancy-firestore.js';
import { AUDIT_LOGS, FirestoreAuditStore } from './audit-firestore.js';
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

  it('refuses stored records with an unknown status instead of trusting them', async () => {
    const { db, store } = setup();
    const { organization } = await store.createOrganization({ name: 'Acme', creator: ALICE });
    const ref = db.collection(MEMBERSHIPS).doc(`${organization.id}_${ALICE}`);
    await ref.update({ status: 'owner' });
    await expect(store.findMembership(organization.id, ALICE)).rejects.toThrow(
      'invalid membership record',
    );
    await ref.update({ status: 'active', role: 42 });
    await expect(store.findMembership(organization.id, ALICE)).rejects.toThrow(
      'invalid membership record',
    );
    await ref.update({ role: 'owner' });
    await db.collection(ORGANIZATIONS).doc(organization.id).update({ status: 'deleted' });
    await expect(store.findOrganization(organization.id)).rejects.toThrow(
      'invalid organization record',
    );
  });
});

describe.runIf(emulatorHost)('FirestoreTenancyStore roles (emulator)', () => {
  it('passes an unknown role on as a name, for RBAC to deny', async () => {
    const db = emulatorFirestore();
    const store = new FirestoreTenancyStore(db, () => NOW);
    const { organization } = await store.createOrganization({ name: 'Acme', creator: ALICE });
    await db.collection(MEMBERSHIPS).doc(`${organization.id}_${ALICE}`).update({ role: 'admin' });
    expect((await store.findMembership(organization.id, ALICE))?.role).toBe('admin');
  });
});

describe.runIf(emulatorHost)('FirestoreTenancyStore creation audit (emulator)', () => {
  const event = (organizationId: string) =>
    buildAuditEvent(
      {
        action: 'organization.create',
        result: 'success',
        actor: { type: 'user', userId: ALICE, via: 'direct' },
        organizationId: organizationId as OrganizationId,
        source: 'api',
      },
      NOW,
    );

  it('writes the creation events in the same transaction as the organization', async () => {
    const db = emulatorFirestore();
    const store = new FirestoreTenancyStore(db, () => NOW);
    let id = '';
    const { organization } = await store.createOrganization({
      name: 'Acme',
      creator: ALICE,
      audit: ({ organization: created }) => {
        const built = event(created.id);
        id = built.id;
        return [built];
      },
    });
    const stored = await db.collection(AUDIT_LOGS).doc(id).get();
    expect(stored.data()).toMatchObject({
      action: 'organization.create',
      organizationId: organization.id,
      actorUserId: ALICE,
    });
  });

  it('creates nothing when the events cannot be built', async () => {
    const db = emulatorFirestore();
    const store = new FirestoreTenancyStore(db, () => NOW);
    await expect(
      store.createOrganization({
        name: 'Acme',
        creator: ALICE,
        audit: () => {
          throw new Error('audit unavailable');
        },
      }),
    ).rejects.toThrow('audit unavailable');
    for (const collection of [ORGANIZATIONS, MEMBERSHIPS, ORGANIZATION_CREATORS, AUDIT_LOGS]) {
      expect(await db.collection(collection).listDocuments()).toHaveLength(0);
    }
  });
});

describe.runIf(emulatorHost)('FirestoreAuditStore (emulator)', () => {
  const signIn = () =>
    buildAuditEvent(
      {
        action: 'auth.sign_in',
        result: 'success',
        actor: { type: 'user', userId: ALICE, via: 'direct' },
        source: 'api',
      },
      NOW,
    );

  it('stores flat documents with every field, nulls for absent ones', async () => {
    const db = emulatorFirestore();
    const event = signIn();
    await new FirestoreAuditStore(db).append([event]);
    expect((await db.collection(AUDIT_LOGS).doc(event.id).get()).data()).toEqual({
      occurredAt: Timestamp.fromDate(NOW),
      action: 'auth.sign_in',
      result: 'success',
      actorType: 'user',
      actorUserId: ALICE,
      actorVia: 'direct',
      organizationId: null,
      targetType: null,
      targetId: null,
      requestedOrganizationId: null,
      permission: null,
      reason: null,
      requestId: null,
      source: 'api',
    });
  });

  it('never overwrites a recorded event', async () => {
    const db = emulatorFirestore();
    const audit = new FirestoreAuditStore(db);
    const event = signIn();
    await audit.append([event]);
    await expect(audit.append([{ ...event, result: 'failure' }])).rejects.toThrow();
    expect((await db.collection(AUDIT_LOGS).doc(event.id).get()).data()?.result).toBe('success');
  });

  it('writes a batch all or nothing', async () => {
    const db = emulatorFirestore();
    const audit = new FirestoreAuditStore(db);
    const existing = signIn();
    await audit.append([existing]);
    const fresh = signIn();
    await expect(audit.append([fresh, existing])).rejects.toThrow();
    expect((await db.collection(AUDIT_LOGS).doc(fresh.id).get()).exists).toBe(false);
  });
});
