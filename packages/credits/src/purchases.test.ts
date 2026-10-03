import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import type {
  InitialBilling,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it, vi } from 'vitest';
import { openWallet, verifyLedger } from './ledger.js';
import {
  CREDIT_PACKS,
  createCreditPurchaseService,
  createPaymentRouter,
  InMemoryCreditPurchaseStore,
  PurchaseError,
  type CreditPack,
  type PaymentProvider,
  type VerifiedPayment,
} from './purchases.js';
import { createCreditService } from './service.js';
import { InMemoryCreditStore } from './store.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
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
const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

/** Test packs only: real packs and prices are a pending decision (D-12). */
const PACK: CreditPack = {
  id: 'test-pack',
  version: 1,
  credits: 500,
  price: { currency: 'USD', amountMinor: 1234 },
  status: 'active',
};

async function world(
  options: { packs?: readonly CreditPack[]; providers?: PaymentProvider[] } = {},
) {
  const auditStore = new InMemoryAuditStore();
  const creditStore = new InMemoryCreditStore(auditStore);
  const tenancy = new InMemoryTenancyStore(
    () => NOW,
    auditStore,
    undefined,
    undefined,
    creditStore,
  );
  const opts = { billing: BILLING, credits: openWallet };
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, opts);
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, opts);
  const credits = createCreditService({
    store: creditStore,
    organizations: tenancy,
    now: () => NOW,
  });
  const checkout = vi.fn(async ({ purchaseId }: { purchaseId: string }) => ({
    checkoutRef: `chk-${purchaseId.slice(0, 8)}`,
    url: 'https://pay.example/checkout',
  }));
  const card: PaymentProvider = { id: 'test-card', currencies: ['USD'], createCheckout: checkout };
  const store = new InMemoryCreditPurchaseStore();
  const purchases = createCreditPurchaseService({
    store,
    credits,
    organizations: tenancy,
    router: createPaymentRouter(options.providers ?? [card]),
    audit: createAuditService(auditStore, () => NOW),
    packs: options.packs ?? [PACK],
    now: () => NOW,
  });
  const tenantA = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const tenantB = await resolveTenant(as(BOB), b.organization.id, tenancy);
  const balance = async (org: OrganizationId) => (await creditStore.findWallet(org))?.balance;
  const events = (prefix: string) => auditStore.events().filter((e) => e.action.startsWith(prefix));
  return {
    purchases,
    credits,
    creditStore,
    store,
    checkout,
    tenantA,
    tenantB,
    a,
    b,
    balance,
    events,
  };
}

const paid = (purchaseId: string, extra: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  providerId: 'test-card',
  paymentRef: 'pay-1',
  purchaseId,
  amount: { currency: 'USD', amountMinor: 1234 },
  status: 'succeeded',
  ...extra,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PurchaseError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('credit purchases (D-12, ADR-0126)', () => {
  it('sells nothing until packs and prices are decided', async () => {
    expect(CREDIT_PACKS).toEqual([]);
    const w = await world({ packs: CREDIT_PACKS });
    expect(w.purchases.catalogue()).toEqual([]);
    expect(await codeOf(w.purchases.start(w.tenantA, { packId: 'any', requestKey: 'k1' }))).toBe(
      'pack_unavailable',
    );
    expect(w.events('credits.purchase_started').map((e) => e.result)).toEqual(['denied']);
  });

  it('refuses when no payment provider can charge the pack', async () => {
    const w = await world({ providers: [] });
    expect(await codeOf(w.purchases.start(w.tenantA, { packId: PACK.id, requestKey: 'k1' }))).toBe(
      'payments_unavailable',
    );
    expect(await w.store.find('x')).toBeUndefined();
  });

  it('credits a pack only after the payment is confirmed, into purchased credits, once', async () => {
    const w = await world();
    const started = await w.purchases.start(w.tenantA, { packId: PACK.id, requestKey: 'k1' });
    expect(started).toMatchObject({
      replayed: false,
      url: 'https://pay.example/checkout',
      purchase: { status: 'awaiting_payment', credits: 500, buyer: ALICE },
    });
    // Nothing yet: the checkout was only opened.
    expect(await w.balance(w.a.organization.id)).toBe(0);
    const id = started.purchase.id;
    const first = await w.purchases.confirm(paid(id));
    expect(first).toMatchObject({ status: 'fulfilled', replayed: false });
    // The provider repeats its notification, or a second worker handles it: never twice.
    const again = await Promise.all([w.purchases.confirm(paid(id)), w.purchases.confirm(paid(id))]);
    expect(again.every((r) => r.status === 'fulfilled' && r.replayed)).toBe(true);
    expect(await w.credits.balanceOf(w.tenantA)).toMatchObject({
      balance: 500,
      purchased: 500,
      included: 0,
    });
    const ledger = await w.creditStore.ledger(w.a.organization.id);
    expect(ledger.map((e) => [e.type, e.amount, e.referenceId, e.bucket])).toEqual([
      ['grant', 500, `purchase:${id}`, 'purchased'],
    ]);
    // The purchase records the ledger entry that credited it.
    expect(first.purchase.credited).toEqual({
      entryId: ledger[0]?.id,
      credits: 500,
      at: ledger[0]?.createdAt,
    });
    const wallet = await w.creditStore.findWallet(w.a.organization.id);
    expect(verifyLedger(wallet as never, ledger)).toEqual([]);
    expect(w.events('credits.purchase').map((e) => e.action)).toEqual([
      'credits.purchase_started',
      'credits.purchase',
    ]);
  });

  it('opens one checkout for a repeated start with the same key', async () => {
    const w = await world();
    const one = await w.purchases.start(w.tenantA, { packId: PACK.id, requestKey: 'k1' });
    const two = await w.purchases.start(w.tenantA, { packId: PACK.id, requestKey: 'k1' });
    expect(two).toMatchObject({ replayed: true, purchase: { id: one.purchase.id } });
    expect(w.checkout).toHaveBeenCalledTimes(1);
  });

  it('keeps a purchase open after a declined attempt, and credits the payment that succeeds', async () => {
    const w = await world();
    const { purchase } = await w.purchases.start(w.tenantA, { packId: PACK.id, requestKey: 'k1' });
    expect(await w.purchases.confirm(paid(purchase.id, { status: 'failed' }))).toMatchObject({
      status: 'failed',
      purchase: { status: 'awaiting_payment' },
    });
    expect(await w.purchases.confirm(paid(purchase.id, { paymentRef: 'pay-2' }))).toMatchObject({
      status: 'fulfilled',
      purchase: { paymentRef: 'pay-2' },
    });
    expect(await w.balance(w.a.organization.id)).toBe(500);
  });

  it('never sells a retired pack', async () => {
    const w = await world({ packs: [{ ...PACK, status: 'retired' }] });
    expect(w.purchases.catalogue()).toEqual([]);
  });

  it('credits nothing for a payment that does not match what was sold', async () => {
    for (const wrong of [
      { amount: { currency: 'USD', amountMinor: 1 } },
      { amount: { currency: 'EUR', amountMinor: 1234 } },
      { providerId: 'other-provider' },
    ]) {
      const w = await world();
      const { purchase } = await w.purchases.start(w.tenantA, {
        packId: PACK.id,
        requestKey: 'k1',
      });
      expect(await w.purchases.confirm(paid(purchase.id, wrong))).toMatchObject({
        status: 'failed',
        purchase: { status: 'failed', failure: 'payment_mismatch' },
      });
      // Closed for review: a later notification does not credit it either.
      expect(await w.purchases.confirm(paid(purchase.id))).toMatchObject({ status: 'failed' });
      expect(await w.balance(w.a.organization.id)).toBe(0);
    }
  });

  it("credits only the buyer's organization, whatever the notification says", async () => {
    const w = await world();
    const { purchase } = await w.purchases.start(w.tenantA, { packId: PACK.id, requestKey: 'k1' });
    // The same key in another organization is another purchase.
    const other = await w.purchases.start(w.tenantB, { packId: PACK.id, requestKey: 'k1' });
    expect(other.purchase.id).not.toBe(purchase.id);
    await w.purchases.confirm(paid(purchase.id));
    expect(await w.balance(w.a.organization.id)).toBe(500);
    expect(await w.balance(w.b.organization.id)).toBe(0);
    expect(await codeOf(w.purchases.confirm(paid('unknown')))).toBe('purchase_not_found');
  });

  it('refuses a request key that is not a reference, and a forged tenant', async () => {
    const w = await world();
    expect(await codeOf(w.purchases.start(w.tenantA, { packId: PACK.id, requestKey: 'a b' }))).toBe(
      'invalid_request',
    );
    const forged = { ...w.tenantA, organizationId: w.b.organization.id } as never;
    expect(await codeOf(w.purchases.start(forged, { packId: PACK.id, requestKey: 'k2' }))).toBe(
      'unresolved_tenant',
    );
  });
});
