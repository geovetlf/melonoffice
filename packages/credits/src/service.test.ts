import { InMemoryAuditStore } from '@melonoffice/audit';
import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import type {
  InitialBilling,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolvePlatformAdmin,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { CreditsError } from './errors.js';
import { entryIdOf, MAX_OPEN_HOLDS, openWallet, verifyLedger } from './ledger.js';
import { createCreditService, type CreditService } from './service.js';
import { InMemoryCreditStore, type CreditStore } from './store.js';

/** The value, or a failed test when it is missing. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

const NOW = new Date('2026-09-27T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
/** Tenancy needs billing to create an organization; credits never reads it. */
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

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CreditsError) return error.code;
    throw error;
  }
  return 'accepted';
}

/** Alice owns A and Bob owns B, each with the empty wallet the API opens. */
async function world(wrap: (store: CreditStore) => CreditStore = (s) => s) {
  const audit = new InMemoryAuditStore();
  const credits = new InMemoryCreditStore(audit);
  const tenancy = new InMemoryTenancyStore(() => NOW, audit, undefined, undefined, credits);
  const options = { billing: BILLING, credits: openWallet };
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, options);
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, options);
  const service = createCreditService({
    store: wrap(credits),
    organizations: tenancy,
    now: () => NOW,
  });
  const tenantA = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const tenantB = await resolveTenant(as(BOB), b.organization.id, tenancy);
  const creditEvents = () => audit.events().filter((e) => e.action.startsWith('credits.'));
  return { audit, credits, tenancy, service, a, b, tenantA, tenantB, creditEvents };
}

const balance = async (service: CreditService, tenant: TenantContext) => {
  const state = await service.balanceOf(tenant);
  return state.status === 'present' ? state.balance : state.reason;
};
const req = (amount: number, referenceId: string, reason = 'test') => ({
  amount,
  referenceId,
  reason,
});

describe('wallet', () => {
  it('opens one empty wallet per organization, and grants nothing on creation', async () => {
    const { service, credits, tenantA, tenantB, a, creditEvents } = await world();
    expect(await balance(service, tenantA)).toBe(0);
    expect(await balance(service, tenantB)).toBe(0);
    expect(await credits.ledger(a.organization.id)).toEqual([]);
    expect(creditEvents()).toEqual([]);
    expect(await credits.findWallet(a.organization.id)).toEqual(a.wallet);
  });

  it('refuses to open a second wallet for an organization', async () => {
    const { credits, a } = await world();
    expect(() => credits.openWalletNow(a.wallet)).toThrow('wallet already exists');
  });
});

describe('ledger integrity', () => {
  it('0 → grant 100 → consume 30 → consume 70 → consume 1 refused → refund 30', async () => {
    const { service, credits, tenantA, a } = await world();
    expect(await balance(service, tenantA)).toBe(0);
    expect((await service.grant(tenantA, req(100, 'g1'))).balance).toBe(100);
    expect((await service.consume(tenantA, req(30, 'c1'))).balance).toBe(70);
    expect((await service.consume(tenantA, req(70, 'c2'))).balance).toBe(0);
    expect(await codeOf(service.consume(tenantA, req(1, 'c3')))).toBe('credits_insufficient');
    const refund = await service.refund(tenantA, { ...req(30, 'r1'), refundOf: 'c1' });
    expect(refund.balance).toBe(30);
    expect(await balance(service, tenantA)).toBe(30);

    const entries = await credits.ledger(a.organization.id);
    expect(entries.map((e) => [e.type, e.amount, e.balanceAfter])).toEqual([
      ['grant', 100, 100],
      ['consume', -30, 70],
      ['consume', -70, 0],
      ['refund', 30, 30],
    ]);
    expect(entries.reduce((sum, e) => sum + e.amount, 0)).toBe(30);
    const wallet = await credits.findWallet(a.organization.id);
    expect(verifyLedger(must(wallet), entries)).toEqual([]);
    expect(new Set(entries.map((e) => e.createdAt)).size).toBe(entries.length);
  });

  it('records each operation in the audit log with its reference, never its amounts', async () => {
    const { service, tenantA, creditEvents } = await world();
    await service.grant(tenantA, req(100, 'g1', 'setup'));
    await service.consume(tenantA, req(30, 'c1', 'task_execution'));
    await service.refund(tenantA, { ...req(30, 'r1', 'task_failed'), refundOf: 'c1' });
    await codeOf(service.consume(tenantA, req(1000, 'c2')));
    const events = creditEvents();
    expect(events.map((e) => [e.action, e.result, e.reference, e.reason])).toEqual([
      ['credits.grant', 'success', 'g1', 'setup'],
      ['credits.consume', 'success', 'c1', 'task_execution'],
      ['credits.refund', 'success', 'r1', 'task_failed'],
    ]);
    for (const event of events) {
      expect(event.organizationId).toBe(tenantA.organizationId);
      expect(event.actor).toEqual({ type: 'user', userId: ALICE, via: 'direct' });
      expect(event.target).toEqual({
        type: 'credit_entry',
        id: entryIdOf(tenantA.organizationId, must(event.reference)),
      });
      expect(JSON.stringify(event)).not.toMatch(/amount|balance|token|authorization/i);
    }
  });
});

describe('idempotency', () => {
  it('replays a repeated grant, consume or refund without a second entry', async () => {
    const { service, credits, tenantA, a, creditEvents } = await world();
    const grant = await service.grant(tenantA, req(100, 'g1'));
    const consume = await service.consume(tenantA, req(30, 'c1'));
    const refund = await service.refund(tenantA, { ...req(10, 'r1'), refundOf: 'c1' });
    const again = [
      await service.grant(tenantA, req(100, 'g1')),
      await service.consume(tenantA, req(30, 'c1')),
      await service.refund(tenantA, { ...req(10, 'r1'), refundOf: 'c1' }),
    ];
    expect(again).toEqual([
      { ...grant, replayed: true },
      { ...consume, replayed: true },
      { ...refund, replayed: true },
    ]);
    expect(await credits.ledger(a.organization.id)).toHaveLength(3);
    expect(creditEvents()).toHaveLength(3);
    expect(await balance(service, tenantA)).toBe(80);
  });

  it('refuses the same reference with different parameters, and changes nothing', async () => {
    const { service, credits, tenantA, a } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    await service.consume(tenantA, req(30, 'c1'));
    await service.refund(tenantA, { ...req(10, 'r1'), refundOf: 'c1' });
    const conflicts = [
      service.grant(tenantA, req(101, 'g1')),
      service.grant(tenantA, req(100, 'g1', 'other')),
      service.consume(tenantA, req(100, 'g1')),
      service.consume(tenantA, req(31, 'c1')),
      service.refund(tenantA, { ...req(30, 'c1'), refundOf: 'c1' }),
      service.refund(tenantA, { ...req(11, 'r1'), refundOf: 'c1' }),
      service.grant(tenantA, req(10, 'r1')),
    ];
    for (const conflict of conflicts) {
      expect(await codeOf(conflict)).toBe('credits_reference_conflict');
    }
    expect(await credits.ledger(a.organization.id)).toHaveLength(3);
    expect(await balance(service, tenantA)).toBe(80);
  });

  it('keeps references per organization: the same key in another one is another operation', async () => {
    const { service, tenantA, tenantB } = await world();
    await service.grant(tenantA, req(100, 'shared'));
    const b = await service.grant(tenantB, req(5, 'shared'));
    expect(b.replayed).toBe(false);
    expect(await balance(service, tenantA)).toBe(100);
    expect(await balance(service, tenantB)).toBe(5);
  });
});

describe('refunds', () => {
  it('never refunds more than a consume spent, across several refunds', async () => {
    const { service, tenantA } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    await service.consume(tenantA, req(30, 'c1'));
    await service.refund(tenantA, { ...req(20, 'r1'), refundOf: 'c1' });
    expect(await codeOf(service.refund(tenantA, { ...req(11, 'r2'), refundOf: 'c1' }))).toBe(
      'credits_refund_invalid',
    );
    await service.refund(tenantA, { ...req(10, 'r3'), refundOf: 'c1' });
    expect(await codeOf(service.refund(tenantA, { ...req(1, 'r4'), refundOf: 'c1' }))).toBe(
      'credits_refund_invalid',
    );
    expect(await balance(service, tenantA)).toBe(100);
  });

  it('refuses a refund of nothing, of a grant, of a refund, or of another organization', async () => {
    const { service, tenantA, tenantB } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    await service.consume(tenantA, req(30, 'c1'));
    await service.refund(tenantA, { ...req(5, 'r1'), refundOf: 'c1' });
    await service.grant(tenantB, req(100, 'gb'));
    await service.consume(tenantB, req(30, 'cb'));
    for (const refundOf of ['missing', 'g1', 'r1', 'cb', '']) {
      expect(await codeOf(service.refund(tenantA, { ...req(1, `x-${refundOf}`), refundOf }))).toBe(
        'credits_refund_invalid',
      );
    }
    expect(await codeOf(service.refund(tenantB, { ...req(1, 'xb'), refundOf: 'c1' }))).toBe(
      'credits_refund_invalid',
    );
    expect(await balance(service, tenantA)).toBe(75);
    expect(await balance(service, tenantB)).toBe(70);
  });
});

describe('concurrency', () => {
  it('lets only one of two concurrent 80-credit consumes spend a balance of 100', async () => {
    const { service, credits, tenantA, a } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    const results = await Promise.all([
      codeOf(service.consume(tenantA, req(80, 'c1'))),
      codeOf(service.consume(tenantA, req(80, 'c2'))),
    ]);
    expect(results.sort()).toEqual(['accepted', 'credits_insufficient']);
    expect(await balance(service, tenantA)).toBe(20);
    const wallet = await credits.findWallet(a.organization.id);
    expect(verifyLedger(must(wallet), await credits.ledger(a.organization.id))).toEqual([]);
  });

  it('never overspends under many concurrent consumes, refunds and repeats', async () => {
    const { service, credits, tenantA, a } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    const runs = await Promise.all([
      ...Array.from({ length: 30 }, (_, i) => codeOf(service.consume(tenantA, req(7, `c${i}`)))),
      ...Array.from({ length: 5 }, () => codeOf(service.consume(tenantA, req(7, 'c0')))),
    ]);
    expect(runs.filter((r) => r === 'credits_insufficient')).toHaveLength(16);
    expect(await balance(service, tenantA)).toBe(2);
    const refunds = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        codeOf(service.refund(tenantA, { ...req(3, `r${i}`), refundOf: 'c0' })),
      ),
    );
    expect(refunds.sort()).toEqual([
      'accepted',
      'accepted',
      'credits_refund_invalid',
      'credits_refund_invalid',
      'credits_refund_invalid',
    ]);
    const wallet = await credits.findWallet(a.organization.id);
    expect(must(wallet).balance).toBe(8);
    expect(verifyLedger(must(wallet), await credits.ledger(a.organization.id))).toEqual([]);
  });

  it('runs the same operation once when it arrives concurrently', async () => {
    const { service, credits, tenantA, a } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.consume(tenantA, req(10, 'c1'))),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await credits.ledger(a.organization.id)).toHaveLength(2);
    expect(await balance(service, tenantA)).toBe(90);
  });
});

describe('atomicity', () => {
  it('writes nothing when the transaction fails after deciding', async () => {
    let fail = false;
    const { service, credits, tenantA, a, creditEvents } = await world((store) => ({
      findWallet: (id) => store.findWallet(id),
      ledger: (id) => store.ledger(id),
      transact: (id, work) =>
        store.transact(id, async (tx) => {
          const result = await work(tx);
          if (fail) throw new Error('storage unavailable');
          return result;
        }),
    }));
    await service.grant(tenantA, req(100, 'g1'));
    fail = true;
    await expect(service.consume(tenantA, req(30, 'c1'))).rejects.toThrow('storage unavailable');
    expect(await balance(service, tenantA)).toBe(100);
    expect(await credits.ledger(a.organization.id)).toHaveLength(1);
    expect(creditEvents()).toHaveLength(1);
    fail = false;
    expect((await service.consume(tenantA, req(30, 'c1'))).replayed).toBe(false);
    expect(await balance(service, tenantA)).toBe(70);
  });

  it('writes nothing when the audit event cannot be stored', async () => {
    const audit = new InMemoryAuditStore();
    const credits = new InMemoryCreditStore(audit);
    const tenancy = new InMemoryTenancyStore(() => NOW, audit, undefined, undefined, credits);
    const { organization } = await createOrganization(as(ALICE), { name: 'A' }, tenancy, {
      billing: BILLING,
      credits: openWallet,
    });
    const tenant = await resolveTenant(as(ALICE), organization.id, tenancy);
    const service = createCreditService({ store: credits, organizations: tenancy });
    const original = audit.appendNow.bind(audit);
    audit.appendNow = () => {
      throw new Error('audit unavailable');
    };
    await expect(service.grant(tenant, req(100, 'g1'))).rejects.toThrow('audit unavailable');
    audit.appendNow = original;
    expect(await balance(service, tenant)).toBe(0);
    expect(await credits.ledger(organization.id)).toEqual([]);
  });

  it('refuses a store without an audit log rather than skip the event', async () => {
    const credits = new InMemoryCreditStore();
    const tenancy = new InMemoryTenancyStore(() => NOW, undefined, undefined, undefined, credits);
    const { organization } = await createOrganization(as(ALICE), { name: 'A' }, tenancy, {
      billing: BILLING,
      credits: openWallet,
    });
    const tenant = await resolveTenant(as(ALICE), organization.id, tenancy);
    const service = createCreditService({ store: credits, organizations: tenancy });
    await expect(service.grant(tenant, req(1, 'g1'))).rejects.toThrow('no audit store');
    expect((await credits.findWallet(organization.id))?.balance).toBe(0);
  });
});

describe('tenancy', () => {
  it('works only on the tenant organization, whatever the request carries', async () => {
    const { service, tenantA, tenantB } = await world();
    await service.grant(tenantA, {
      ...req(100, 'g1'),
      organizationId: tenantB.organizationId,
      walletId: 'x',
      balance: 999,
    } as never);
    expect(await balance(service, tenantA)).toBe(100);
    expect(await balance(service, tenantB)).toBe(0);
  });

  it('refuses a context that was not resolved by tenancy', async () => {
    const { service, tenantA, tenantB } = await world();
    const forged = { ...tenantA, organizationId: tenantB.organizationId } as TenantContext;
    expect(await codeOf(service.grant(forged, req(1, 'g1')))).toBe('unresolved_tenant');
    expect(await codeOf(service.consume(forged, req(1, 'c1')))).toBe('unresolved_tenant');
    expect(await service.balanceOf(forged)).toEqual({
      status: 'unavailable',
      reason: 'unresolved_tenant',
    });
    expect(await balance(service, tenantB)).toBe(0);
  });

  it('refuses an organization suspended after the tenant was resolved', async () => {
    const { service, tenancy, tenantA, a } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    tenancy.put({ ...a.organization, status: 'suspended' });
    expect(await codeOf(service.consume(tenantA, req(1, 'c1')))).toBe('organization_inactive');
    expect(await service.balanceOf(tenantA)).toEqual({
      status: 'unavailable',
      reason: 'organization_inactive',
    });
  });

  it('reports a missing wallet and refuses to operate on one', async () => {
    const { service, credits, tenantA, a } = await world();
    credits.removeWallet(a.organization.id);
    expect(await service.balanceOf(tenantA)).toEqual({
      status: 'unavailable',
      reason: 'credits_wallet_missing',
    });
    expect(await codeOf(service.grant(tenantA, req(1, 'g1')))).toBe('credits_wallet_missing');
  });

  it('gives GIA exactly what the user it acts for gets, and records it as via GIA', async () => {
    const { service, tenancy, tenantA, a, creditEvents } = await world();
    const gia = await resolveTenant(actAsGia(as(ALICE)), a.organization.id, tenancy);
    await service.grant(tenantA, req(100, 'g1'));
    expect(await service.balanceOf(gia)).toEqual(await service.balanceOf(tenantA));
    await service.consume(gia, req(10, 'c1'));
    expect(creditEvents().at(-1)?.actor).toEqual({ type: 'user', userId: ALICE, via: 'gia' });
    expect(await codeOf(service.consume(gia, req(1000, 'c2')))).toBe('credits_insufficient');
  });

  it('has no adjustment, transfer or plan-based grant', () => {
    const service = createCreditService({
      store: new InMemoryCreditStore(),
      organizations: new InMemoryTenancyStore(),
    });
    // `grantAsPlatform` is the same grant, authorized by the platform administrator (ADR-0091).
    expect(Object.keys(service).sort()).toEqual([
      'balanceOf',
      'consume',
      'grant',
      'grantAsPlatform',
      'hold',
      'refund',
      'release',
      'settle',
    ]);
  });
});

describe('validation through the service', () => {
  it.each([
    ['amount 0', { amount: 0 }, 'invalid_amount'],
    ['negative amount', { amount: -5 }, 'invalid_amount'],
    ['decimal amount', { amount: 2.5 }, 'invalid_amount'],
    ['NaN', { amount: Number.NaN }, 'invalid_amount'],
    ['Infinity', { amount: Number.POSITIVE_INFINITY }, 'invalid_amount'],
    ['string amount', { amount: '5' }, 'invalid_amount'],
    ['empty reference', { referenceId: '' }, 'invalid_reference'],
    ['bad reason', { reason: 'Bad Reason' }, 'invalid_reason'],
  ])('refuses %s and changes nothing', async (_, override, code) => {
    const { service, credits, tenantA, a } = await world();
    const request = { ...req(10, 'op'), ...override } as never;
    expect(await codeOf(service.grant(tenantA, request))).toBe(code);
    expect(await codeOf(service.consume(tenantA, request))).toBe(code);
    expect(await credits.ledger(a.organization.id)).toEqual([]);
    expect(await balance(service, tenantA)).toBe(0);
  });

  it('refuses an invalid organization id in the context', async () => {
    const { service, tenancy } = await world();
    const missing = '99999999-9999-4999-8999-999999999999' as OrganizationId;
    await expect(resolveTenant(as(ALICE), missing, tenancy)).rejects.toThrow();
    const forged = Object.freeze({ organizationId: missing }) as unknown as TenantContext;
    expect(await codeOf(service.grant(forged, req(1, 'g')))).toBe('unresolved_tenant');
  });
});

describe('manual grants by the platform administrator (ADR-0091)', () => {
  const admins = new Set<string>([BOB]);

  it('adds to the same wallet and ledger, once per reference, audited as the administrator', async () => {
    const { service, credits, a, tenantA, creditEvents } = await world();
    const admin = resolvePlatformAdmin(as(BOB), admins);
    const first = await service.grantAsPlatform(
      admin,
      a.organization.id,
      req(40, 'platform-grant:k1', 'courtesy'),
    );
    const again = await service.grantAsPlatform(
      admin,
      a.organization.id,
      req(40, 'platform-grant:k1', 'courtesy'),
    );
    expect(first).toMatchObject({ balance: 40, replayed: false });
    expect(again).toMatchObject({ balance: 40, replayed: true, entry: first.entry });
    expect(await balance(service, tenantA)).toBe(40);
    expect((await credits.ledger(a.organization.id)).map((e) => e.type)).toEqual(['grant']);
    expect(
      await codeOf(
        service.grantAsPlatform(admin, a.organization.id, req(41, 'platform-grant:k1', 'courtesy')),
      ),
    ).toBe('credits_reference_conflict');
    expect(creditEvents()).toEqual([
      expect.objectContaining({
        action: 'credits.platform_grant',
        actor: { type: 'user', userId: BOB, via: 'direct' },
        actorRole: 'platform_admin',
        organizationId: a.organization.id,
        reference: 'platform-grant:k1',
        reason: 'courtesy',
      }),
    ]);
    // Spending it later is ordinary consumption from the same wallet.
    expect((await service.consume(tenantA, req(15, 'use-1'))).balance).toBe(25);
  });

  it('refuses a context it did not issue, an inactive organization and bad amounts', async () => {
    const { service, a } = await world();
    const forged = Object.freeze({ userId: BOB, role: 'platform_admin' as const });
    expect(await codeOf(service.grantAsPlatform(forged, a.organization.id, req(1, 'r1')))).toBe(
      'unresolved_platform_admin',
    );
    const admin = resolvePlatformAdmin(as(BOB), admins);
    expect(
      await codeOf(
        service.grantAsPlatform(
          admin,
          '99999999-9999-4999-8999-999999999999' as OrganizationId,
          req(1, 'r2'),
        ),
      ),
    ).toBe('organization_inactive');
    expect(await codeOf(service.grantAsPlatform(admin, a.organization.id, req(0, 'r3')))).toBe(
      'invalid_amount',
    );
  });

  it('is only issued to a listed administrator acting directly with a verified email', () => {
    expect(() => resolvePlatformAdmin(as(ALICE), admins)).toThrow('platform_forbidden');
    expect(() => resolvePlatformAdmin(actAsGia(as(BOB)), admins)).toThrow('platform_forbidden');
    expect(() =>
      resolvePlatformAdmin(
        Object.freeze({ actor: 'user', userId: BOB, emailVerified: false }),
        admins,
      ),
    ).toThrow('platform_email_unverified');
    expect(resolvePlatformAdmin(as(BOB), admins)).toEqual({ userId: BOB, role: 'platform_admin' });
  });
});

describe('buckets: included and purchased credits (ADR-0123)', () => {
  it('spends included credits first, refunds bought ones first, and the ledger adds up', async () => {
    const { service, credits, tenantA, a } = await world();
    await service.grant(tenantA, { ...req(50, 'plan-1'), bucket: 'included' });
    await service.grant(tenantA, req(30, 'pack-1'));
    const spent = await service.consume(tenantA, req(60, 'c1'));
    expect(spent.entry.split).toEqual({ included: 50, purchased: 10 });
    expect(await service.balanceOf(tenantA)).toMatchObject({
      balance: 20,
      included: 0,
      purchased: 20,
      reserved: 0,
      available: 20,
    });
    const back = await service.refund(tenantA, { ...req(15, 'r1'), refundOf: 'c1' });
    expect(back.entry.split).toEqual({ included: 5, purchased: 10 });
    const rest = await service.refund(tenantA, { ...req(45, 'r2'), refundOf: 'c1' });
    expect(rest.entry.split).toEqual({ included: 45, purchased: 0 });
    expect(await service.balanceOf(tenantA)).toMatchObject({ included: 50, purchased: 30 });
    const wallet = must(await credits.findWallet(a.organization.id));
    expect(verifyLedger(wallet, await credits.ledger(a.organization.id))).toEqual([]);
  });

  it('refuses an unknown bucket, and a grant replayed into another bucket', async () => {
    const { service, tenantA } = await world();
    expect(await codeOf(service.grant(tenantA, { ...req(5, 'g'), bucket: 'free' as never }))).toBe(
      'invalid_bucket',
    );
    await service.grant(tenantA, { ...req(5, 'g1'), bucket: 'included' });
    expect(await codeOf(service.grant(tenantA, req(5, 'g1')))).toBe('credits_reference_conflict');
  });
});

describe('holds: reserve, settle, release (ADR-0123)', () => {
  const hold = (amount: number, referenceId: string, ttlMs = 60_000) => ({
    ...req(amount, referenceId),
    ttlMs,
  });

  it('holds before running, then spends the real cost and frees the rest', async () => {
    const { service, credits, tenantA, a, creditEvents } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    const held = await service.hold(tenantA, hold(40, 'op-1'));
    expect(held.entry).toMatchObject({ type: 'hold', amount: 0, held: 40, balanceAfter: 100 });
    expect(await service.balanceOf(tenantA)).toMatchObject({
      balance: 100,
      reserved: 40,
      available: 60,
    });
    // Held credits are never spent by another operation.
    expect(await codeOf(service.consume(tenantA, req(61, 'c1')))).toBe('credits_insufficient');
    expect(await codeOf(service.hold(tenantA, hold(61, 'op-2')))).toBe('credits_insufficient');
    const settled = await service.settle(tenantA, { holdOf: 'op-1', amount: 25, reason: 'test' });
    expect(settled.entry).toMatchObject({
      type: 'consume',
      amount: -25,
      held: 40,
      holdOf: entryIdOf(a.organization.id, 'op-1'),
      referenceId: 'op-1:close',
    });
    expect(await service.balanceOf(tenantA)).toMatchObject({
      balance: 75,
      reserved: 0,
      available: 75,
    });
    expect(creditEvents().map((e) => [e.action, e.reference])).toEqual([
      ['credits.grant', 'g1'],
      ['credits.hold', 'op-1'],
      // The charge is audited under the operation's reference, like the hold.
      ['credits.consume', 'op-1'],
    ]);
    const wallet = must(await credits.findWallet(a.organization.id));
    expect(verifyLedger(wallet, await credits.ledger(a.organization.id))).toEqual([]);
  });

  it('closes a hold once: a retry replays it, a different close is refused', async () => {
    const { service, credits, tenantA, a } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    await service.hold(tenantA, hold(40, 'op-1'));
    const first = await service.settle(tenantA, { holdOf: 'op-1', amount: 25, reason: 'test' });
    const again = await service.settle(tenantA, { holdOf: 'op-1', amount: 25, reason: 'test' });
    expect(again).toEqual({ ...first, replayed: true });
    expect(
      await codeOf(service.settle(tenantA, { holdOf: 'op-1', amount: 30, reason: 'test' })),
    ).toBe('credits_hold_closed');
    expect(await codeOf(service.release(tenantA, { holdOf: 'op-1', reason: 'test' }))).toBe(
      'credits_hold_closed',
    );
    expect(await credits.ledger(a.organization.id)).toHaveLength(3);
    expect(await balance(service, tenantA)).toBe(75);
  });

  it('releases a hold without spending, and replays the same hold once', async () => {
    const { service, credits, tenantA, a } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    const first = await service.hold(tenantA, hold(40, 'op-1'));
    expect(await service.hold(tenantA, hold(40, 'op-1', 120_000))).toEqual({
      ...first,
      replayed: true,
    });
    expect(await codeOf(service.hold(tenantA, hold(41, 'op-1')))).toBe(
      'credits_reference_conflict',
    );
    expect(await service.balanceOf(tenantA)).toMatchObject({ reserved: 40 });
    const released = await service.release(tenantA, { holdOf: 'op-1', reason: 'test' });
    expect(released.entry).toMatchObject({ type: 'release', amount: 0, held: 40 });
    expect(await service.balanceOf(tenantA)).toMatchObject({
      balance: 100,
      reserved: 0,
      available: 100,
    });
    expect(await service.release(tenantA, { holdOf: 'op-1', reason: 'test' })).toMatchObject({
      replayed: true,
    });
    expect(await credits.ledger(a.organization.id)).toHaveLength(3);
  });

  it('may settle above the hold when the balance covers it, never below 0', async () => {
    const { service, tenantA } = await world();
    await service.grant(tenantA, req(50, 'g1'));
    await service.hold(tenantA, hold(10, 'op-1'));
    await service.hold(tenantA, hold(30, 'op-2'));
    // op-1 may use its own 10 and the 10 nobody holds, never op-2's 30.
    expect(
      await codeOf(service.settle(tenantA, { holdOf: 'op-1', amount: 21, reason: 'test' })),
    ).toBe('credits_insufficient');
    await service.settle(tenantA, { holdOf: 'op-1', amount: 20, reason: 'test' });
    expect(await service.balanceOf(tenantA)).toMatchObject({
      balance: 30,
      reserved: 30,
      available: 0,
    });
  });

  it('refuses to settle what is not a hold of this organization', async () => {
    const { service, tenantA, tenantB } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    await service.grant(tenantB, req(100, 'gb'));
    await service.hold(tenantB, hold(10, 'op-b'));
    const settle = (tenant: TenantContext, holdOf: string) =>
      codeOf(service.settle(tenant, { holdOf, amount: 1, reason: 'test' }));
    expect(await settle(tenantA, 'nothing')).toBe('credits_hold_invalid');
    expect(await settle(tenantA, 'g1')).toBe('credits_hold_invalid');
    expect(await settle(tenantA, 'op-b')).toBe('credits_hold_invalid');
    expect(await service.balanceOf(tenantB)).toMatchObject({ balance: 100, reserved: 10 });
  });

  it('stops holding when a hold expires, and still settles it only if the balance covers it', async () => {
    const { service, credits, tenancy, tenantA, a } = await world();
    let clock = NOW;
    const timed = createCreditService({ store: credits, organizations: tenancy, now: () => clock });
    await timed.grant(tenantA, req(100, 'g1'));
    await timed.hold(tenantA, hold(40, 'op-1', 60_000));
    await timed.hold(tenantA, hold(10, 'op-2', 60_000));
    clock = new Date(NOW.getTime() + 120_000);
    expect(await timed.balanceOf(tenantA)).toMatchObject({ reserved: 0, available: 100 });
    await timed.consume(tenantA, req(95, 'c1'));
    expect(must(await credits.findWallet(a.organization.id)).holds).toEqual([]);
    expect(
      await codeOf(timed.settle(tenantA, { holdOf: 'op-1', amount: 10, reason: 'test' })),
    ).toBe('credits_insufficient');
    await timed.settle(tenantA, { holdOf: 'op-2', amount: 5, reason: 'test' });
    expect(await balance(service, tenantA)).toBe(0);
  });

  it('refuses a hold with no valid lifetime, and too many open holds', async () => {
    const { service, tenantA } = await world();
    await service.grant(tenantA, req(1000, 'g1'));
    for (const ttlMs of [0, -1, 1.5, Number.NaN, 8 * 24 * 60 * 60 * 1000]) {
      expect(await codeOf(service.hold(tenantA, hold(1, `bad-${ttlMs}`, ttlMs)))).toBe(
        'invalid_hold_expiry',
      );
    }
    for (let i = 0; i < MAX_OPEN_HOLDS; i += 1) await service.hold(tenantA, hold(1, `op-${i}`));
    expect(await codeOf(service.hold(tenantA, hold(1, 'one-more')))).toBe('credits_holds_limit');
    await service.release(tenantA, { holdOf: 'op-0', reason: 'test' });
    await service.hold(tenantA, hold(1, 'one-more'));
  });

  it('lets only as many concurrent holds as the balance covers', async () => {
    const { service, tenantA } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => service.hold(tenantA, hold(20, `op-${i}`))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(await service.balanceOf(tenantA)).toMatchObject({ reserved: 100, available: 0 });
  });

  it('settles a concurrent duplicate close once', async () => {
    const { service, credits, tenantA, a } = await world();
    await service.grant(tenantA, req(100, 'g1'));
    await service.hold(tenantA, hold(40, 'op-1'));
    const closes = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.settle(tenantA, { holdOf: 'op-1', amount: 25, reason: 'test' }),
      ),
    );
    expect(closes.filter((c) => !c.replayed)).toHaveLength(1);
    expect(await credits.ledger(a.organization.id)).toHaveLength(3);
    expect(await balance(service, tenantA)).toBe(75);
  });
});
