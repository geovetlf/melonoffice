import { Timestamp } from '@google-cloud/firestore';
import type { Organization, OrganizationId, UserId } from '@melonoffice/domain';
import { buildAuditEvent } from '@melonoffice/audit';
import { openBilling } from '@melonoffice/billing';
import { openWallet } from '@melonoffice/credits';
import { TenancyError } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import {
  FirestoreTenancyStore,
  MEMBERSHIPS,
  ORGANIZATION_CREATORS,
  ORGANIZATIONS,
} from './tenancy-firestore.js';
import { AUDIT_LOGS, FirestoreAuditStore } from './audit-firestore.js';
import {
  BILLING_ACCOUNTS,
  FirestoreBillingStore,
  SUBSCRIPTIONS,
  toAccountDocument,
} from './billing-firestore.js';
import { CREDIT_WALLETS, FirestoreCreditStore } from './credits-firestore.js';
import { emulatorFirestore, emulatorHost } from './test-firestore.js';

const NOW = new Date('2026-09-26T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const PLAN = { id: 'entrepreneur', version: 1 } as const;
const BILLING = (organization: Organization) => openBilling(organization, PLAN);
const CREDITS = openWallet;

describe.runIf(emulatorHost)('FirestoreTenancyStore (emulator)', () => {
  function setup() {
    const db = emulatorFirestore();
    return { db, store: new FirestoreTenancyStore(db, () => NOW) };
  }

  it('writes the organization, the owner membership, the creator record, billing and an empty wallet together', async () => {
    const { db, store } = setup();
    const { organization, membership, billing, wallet } = await store.createOrganization({
      name: 'Acme',
      creator: ALICE,
      billing: BILLING,
      credits: CREDITS,
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
    expect((await db.collection(BILLING_ACCOUNTS).doc(organization.id).get()).data()).toEqual({
      subscriptionId: billing.subscription.id,
      createdAt: at,
      updatedAt: at,
    });
    expect((await db.collection(SUBSCRIPTIONS).doc(billing.subscription.id).get()).data()).toEqual({
      organizationId: organization.id,
      plan: { id: 'entrepreneur', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    });
    expect(await store.findOrganization(organization.id)).toEqual(organization);
    expect(await store.findMembership(organization.id, ALICE)).toEqual(membership);
    expect(await store.membershipsOfUser(ALICE)).toEqual([membership]);
    expect((await db.collection(CREDIT_WALLETS).doc(organization.id).get()).data()).toEqual({
      walletId: wallet.id,
      balance: 0,
      createdAt: at,
      updatedAt: at,
    });
    expect(await new FirestoreCreditStore(db).findWallet(organization.id)).toEqual(wallet);
    const billingStore = new FirestoreBillingStore(db);
    expect(await billingStore.findAccount(organization.id)).toEqual(billing.account);
    expect(await billingStore.findSubscription(billing.subscription.id)).toEqual(
      billing.subscription,
    );
  });

  it(
    'creates one organization per user, even under concurrent requests',
    { timeout: 30_000 },
    async () => {
      const { db, store } = setup();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          store.createOrganization({
            name: 'Acme',
            creator: ALICE,
            billing: BILLING,
            credits: CREDITS,
          }),
        ),
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
      billing: BILLING,
      credits: CREDITS,
    });
    const duplicate = db.collection(MEMBERSHIPS).doc(`${organization.id}_${ALICE}`);
    await expect(
      duplicate.create({ organizationId: organization.id, userId: ALICE }),
    ).rejects.toThrow();
    expect(await store.membershipsOfUser(ALICE)).toEqual([membership]);
  });

  it('keeps users apart', async () => {
    const { store } = setup();
    const a = await store.createOrganization({
      name: 'A',
      creator: ALICE,
      billing: BILLING,
      credits: CREDITS,
    });
    const b = await store.createOrganization({
      name: 'B',
      creator: BOB,
      billing: BILLING,
      credits: CREDITS,
    });
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
    const { organization } = await store.createOrganization({
      name: 'Acme',
      creator: ALICE,
      billing: BILLING,
      credits: CREDITS,
    });
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

  it('does not read a plan field left on the organization: billing is the only source', async () => {
    const { db, store } = setup();
    const { organization } = await store.createOrganization({
      name: 'Acme',
      creator: ALICE,
      billing: BILLING,
      credits: CREDITS,
    });
    await db
      .collection(ORGANIZATIONS)
      .doc(organization.id)
      .update({ plan: { id: 'corporate', version: 1 } });
    expect(await store.findOrganization(organization.id)).toEqual(organization);
  });

  it('refuses stored subscriptions with an unknown status or a malformed plan', async () => {
    const { db, store } = setup();
    const { billing } = await store.createOrganization({
      name: 'Acme',
      creator: ALICE,
      billing: BILLING,
      credits: CREDITS,
    });
    const billingStore = new FirestoreBillingStore(db);
    const ref = db.collection(SUBSCRIPTIONS).doc(billing.subscription.id);
    for (const change of [
      { status: 'free' },
      { status: 'active', plan: { id: 'entrepreneur' } },
      { plan: 'entrepreneur' },
    ]) {
      await ref.update(change);
      await expect(billingStore.findSubscription(billing.subscription.id)).rejects.toThrow(
        'invalid subscription record',
      );
    }
    expect(await billingStore.findSubscription('not-a-uuid' as never)).toBeUndefined();
    expect(await billingStore.findAccount('org-a' as OrganizationId)).toBeUndefined();
  });

  it('never creates a second account for an organization', async () => {
    const { db, store } = setup();
    const { organization } = await store.createOrganization({
      name: 'Acme',
      creator: ALICE,
      billing: BILLING,
      credits: CREDITS,
    });
    const again = BILLING(organization);
    await expect(
      db.runTransaction(async (tx) => {
        tx.create(
          db.collection(BILLING_ACCOUNTS).doc(organization.id),
          toAccountDocument(again.account),
        );
      }),
    ).rejects.toThrow();
  });
});

describe.runIf(emulatorHost)('FirestoreTenancyStore roles (emulator)', () => {
  it('passes an unknown role on as a name, for RBAC to deny', async () => {
    const db = emulatorFirestore();
    const store = new FirestoreTenancyStore(db, () => NOW);
    const { organization } = await store.createOrganization({
      name: 'Acme',
      creator: ALICE,
      billing: BILLING,
      credits: CREDITS,
    });
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
      billing: BILLING,
      credits: CREDITS,
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
        billing: BILLING,
        credits: CREDITS,
        audit: () => {
          throw new Error('audit unavailable');
        },
      }),
    ).rejects.toThrow('audit unavailable');
    for (const collection of [
      ORGANIZATIONS,
      MEMBERSHIPS,
      ORGANIZATION_CREATORS,
      AUDIT_LOGS,
      CREDIT_WALLETS,
    ]) {
      expect(await db.collection(collection).listDocuments()).toHaveLength(0);
    }
  });

  it('creates nothing when the wallet is not empty or belongs elsewhere', async () => {
    const db = emulatorFirestore();
    const store = new FirestoreTenancyStore(db, () => NOW);
    for (const credits of [
      (o: Organization) => ({ ...openWallet(o), balance: 100 }),
      (o: Organization) => ({ ...openWallet(o), organizationId: BOB as unknown as OrganizationId }),
    ]) {
      await expect(
        store.createOrganization({ name: 'Acme', creator: ALICE, billing: BILLING, credits }),
      ).rejects.toThrow('initial wallet');
    }
    for (const collection of [ORGANIZATIONS, MEMBERSHIPS, CREDIT_WALLETS, AUDIT_LOGS]) {
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
      planId: null,
      planVersion: null,
      transitionFrom: null,
      transitionTo: null,
      toolId: null,
      toolVersion: null,
      modelProvider: null,
      modelId: null,
      previousModelProvider: null,
      previousModelId: null,
      reason: null,
      reference: null,
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
