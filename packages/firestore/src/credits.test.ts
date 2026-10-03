import { FieldValue } from '@google-cloud/firestore';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openBilling } from '@melonoffice/billing';
import { createCreditService, openWallet, verifyLedger } from '@melonoffice/credits';
import type { CreditPurchase } from '@melonoffice/credits';
import type { IsoTimestamp, Organization, OrganizationId, UserId } from '@melonoffice/domain';
import { resolveTenant } from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CREDIT_WALLETS, FirestoreCreditStore } from './credits.js';
import { FirestoreCreditPurchaseStore } from './purchases.js';
import { FirestoreTenancyStore } from './tenancy.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const BILLING = (organization: Organization) =>
  openBilling(organization, { id: 'entrepreneur', version: 1 });
const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

describe.runIf(emulatorHost)('FirestoreCreditStore buckets and holds (emulator)', () => {
  async function setup() {
    const db = emulatorFirestore();
    const tenancy = new FirestoreTenancyStore(db, () => NOW);
    // One organization per creator: a new user per test keeps the tests apart.
    const alice = randomUUID() as UserId;
    const { organization } = await tenancy.createOrganization({
      name: 'Acme',
      creator: alice,
      billing: BILLING,
      credits: openWallet,
    });
    const store = new FirestoreCreditStore(db);
    const service = createCreditService({ store, organizations: tenancy, now: () => NOW });
    const tenant = await resolveTenant(as(alice), organization.id, tenancy);
    return { db, store, service, tenant, organizationId: organization.id };
  }
  const req = (amount: number, referenceId: string) => ({ amount, referenceId, reason: 'test' });

  it('stores buckets, holds and their entries, and reads them back consistent', async () => {
    const { store, service, tenant, organizationId } = await setup();
    await service.grant(tenant, { ...req(50, 'plan-1'), bucket: 'included' });
    await service.grant(tenant, req(30, 'pack-1'));
    await service.hold(tenant, { ...req(40, 'op-1'), ttlMs: 60_000 });
    await service.hold(tenant, { ...req(10, 'op-2'), ttlMs: 60_000 });
    expect(await service.balanceOf(tenant)).toMatchObject({
      balance: 80,
      included: 50,
      purchased: 30,
      reserved: 50,
      available: 30,
    });
    await service.settle(tenant, { holdOf: 'op-1', amount: 55, reason: 'test' });
    await service.settle(tenant, { holdOf: 'op-1', amount: 55, reason: 'test' });
    await service.release(tenant, { holdOf: 'op-2', reason: 'test' });
    const wallet = await store.findWallet(organizationId);
    expect(wallet).toMatchObject({
      balance: 25,
      buckets: { included: 0, purchased: 25 },
      holds: [],
    });
    const entries = await store.ledger(organizationId);
    expect(entries.map((e) => [e.type, e.amount])).toEqual([
      ['grant', 50],
      ['grant', 30],
      ['hold', 0],
      ['hold', 0],
      ['consume', -55],
      ['release', 0],
    ]);
    expect(entries[4]).toMatchObject({ split: { included: 50, purchased: 5 }, held: 40 });
    expect(verifyLedger(wallet as never, entries)).toEqual([]);
  });

  it('reads a wallet stored before D-12 as all purchased, and writes its buckets on the next move', async () => {
    const { db, store, service, tenant, organizationId } = await setup();
    await service.grant(tenant, req(20, 'g1'));
    // As a wallet written before D-12: no buckets, no holds.
    await db
      .collection(CREDIT_WALLETS)
      .doc(organizationId)
      .update({ buckets: FieldValue.delete(), holds: FieldValue.delete() });
    expect(await service.balanceOf(tenant)).toMatchObject({ included: 0, purchased: 20 });
    await service.consume(tenant, req(5, 'c1'));
    const stored = (await db.collection(CREDIT_WALLETS).doc(organizationId).get()).data();
    expect(stored).toMatchObject({
      balance: 15,
      buckets: { included: 0, purchased: 15 },
      holds: [],
    });
    expect(
      verifyLedger(
        (await store.findWallet(organizationId)) as never,
        await store.ledger(organizationId),
      ),
    ).toEqual([]);
  });

  it('stores a renewal and its period, and replays it once (ADR-0127)', async () => {
    const { store, service, tenant, organizationId } = await setup();
    const period = {
      startsAt: '2026-10-01T00:00:00.000Z' as IsoTimestamp,
      endsAt: '2026-11-01T00:00:00.000Z' as IsoTimestamp,
    };
    const first = await service.renew(tenant, { period, included: 40, carryMax: 0 });
    const again = await service.renew(tenant, { period, included: 40, carryMax: 0 });
    expect(again.replayed).toBe(true);
    await service.consume(tenant, req(15, 'use-1'));
    const wallet = await store.findWallet(organizationId);
    expect(wallet).toMatchObject({
      balance: 25,
      buckets: { included: 25, purchased: 0 },
      period: { ...period, included: 40, consumed: 15 },
    });
    const entries = await store.ledger(organizationId);
    expect(entries.find((e) => e.id === first.entry.id)?.renewal).toEqual({
      periodStartsAt: period.startsAt,
      periodEndsAt: period.endsAt,
      granted: 40,
      carried: 0,
      expired: 0,
    });
    if (wallet === undefined) throw new Error('no wallet');
    expect(verifyLedger(wallet, entries)).toEqual([]);
  });

  it('lets only as many concurrent holds as the balance covers', async () => {
    const { service, tenant } = await setup();
    await service.grant(tenant, req(100, 'g1'));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        service.hold(tenant, { ...req(25, `op-${i}`), ttlMs: 60_000 }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect(await service.balanceOf(tenant)).toMatchObject({ reserved: 100, available: 0 });
  });
});

describe.runIf(emulatorHost)('FirestoreCreditPurchaseStore (emulator)', () => {
  it('creates a purchase once, and moves it only from the status it was read in', async () => {
    const store = new FirestoreCreditPurchaseStore(emulatorFirestore());
    const id = randomUUID().replaceAll('-', '').padEnd(40, '0');
    const at = NOW.toISOString() as IsoTimestamp;
    const purchase: CreditPurchase = {
      id,
      organizationId: randomUUID() as OrganizationId,
      pack: { id: 'test-pack', version: 1 },
      credits: 500,
      price: { currency: 'USD', amountMinor: 1234 },
      status: 'awaiting_payment',
      provider: 'test-card',
      checkoutRef: 'chk-1',
      buyer: randomUUID() as UserId,
      createdAt: at,
      updatedAt: at,
    };
    expect(await store.create(purchase)).toBe(true);
    expect(await store.create(purchase)).toBe(false);
    expect(await store.find(id)).toEqual(purchase);
    const done = { ...purchase, status: 'fulfilled' as const, paymentRef: 'pay-1' };
    const results = await Promise.all([
      store.update(done, 'awaiting_payment'),
      store.update(done, 'awaiting_payment'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.find(id)).toEqual(done);
    expect(await store.find('not-an-id')).toBeUndefined();
  });
});
