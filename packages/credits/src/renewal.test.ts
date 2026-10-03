import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import type {
  InitialBilling,
  IsoTimestamp,
  Organization,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { CreditsError } from './errors.js';
import { openWallet, renewalReferenceOf, verifyLedger } from './ledger.js';
import {
  createCreditRenewal,
  monthlyPeriodAt,
  renewalOfPlan,
  type PlanCreditTerms,
} from './renewal.js';
import { createCreditService, type CreditService } from './service.js';
import { InMemoryCreditStore } from './store.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const START = '2026-01-31T10:00:00.000Z' as IsoTimestamp;
const ts = (value: string) => value as IsoTimestamp;

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

async function world(options: { consumptionOrder?: ('included' | 'purchased')[] } = {}) {
  const clock = { now: new Date(START) };
  const audit = new InMemoryAuditStore();
  const store = new InMemoryCreditStore(audit);
  const tenancy = new InMemoryTenancyStore(() => clock.now, audit, undefined, undefined, store);
  const { organization } = await createOrganization(as(ALICE), { name: 'A' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
  });
  const service = createCreditService({
    store,
    organizations: tenancy,
    now: () => clock.now,
    ...(options.consumptionOrder === undefined
      ? {}
      : { consumptionOrder: options.consumptionOrder }),
  });
  const tenant = await resolveTenant(as(ALICE), organization.id, tenancy);
  return { clock, audit, store, service, tenant, organization };
}

const PERIOD_1 = {
  startsAt: ts('2026-01-31T10:00:00.000Z'),
  endsAt: ts('2026-02-28T10:00:00.000Z'),
};
const PERIOD_2 = {
  startsAt: ts('2026-02-28T10:00:00.000Z'),
  endsAt: ts('2026-03-31T10:00:00.000Z'),
};

async function balance(service: CreditService, tenant: TenantContext) {
  const value = await service.balanceOf(tenant);
  if (value.status !== 'present') throw new Error('no wallet');
  return value;
}

describe('monthly periods', () => {
  it('counts each period from the subscription start, on the last day of shorter months', () => {
    expect(monthlyPeriodAt(START, new Date('2026-01-31T10:00:00.000Z'))).toEqual(PERIOD_1);
    expect(monthlyPeriodAt(START, new Date('2026-02-28T09:59:59.999Z'))).toEqual(PERIOD_1);
    expect(monthlyPeriodAt(START, new Date('2026-02-28T10:00:00.000Z'))).toEqual(PERIOD_2);
    expect(monthlyPeriodAt(START, new Date('2027-01-31T10:00:00.000Z'))?.startsAt).toBe(
      '2027-01-31T10:00:00.000Z',
    );
    expect(monthlyPeriodAt(START, new Date('2026-04-30T11:00:00.000Z'))).toEqual({
      startsAt: '2026-04-30T10:00:00.000Z',
      endsAt: '2026-05-31T10:00:00.000Z',
    });
  });

  it('has no period before the subscription started', () => {
    expect(monthlyPeriodAt(START, new Date('2026-01-01T00:00:00.000Z'))).toBeUndefined();
  });
});

describe('plan terms', () => {
  const terms = (over: Partial<PlanCreditTerms>): PlanCreditTerms => ({
    monthlyIncluded: 0,
    rollover: false,
    rolloverMax: 0,
    ...over,
  });

  it('carries nothing over unless the plan turns rollover on', () => {
    expect(renewalOfPlan(terms({ monthlyIncluded: 500, rolloverMax: 'unlimited' }))).toEqual({
      included: 500,
      carryMax: 0,
    });
    expect(renewalOfPlan(terms({ rollover: true, rolloverMax: 200 }))).toEqual({
      included: 0,
      carryMax: 200,
    });
    expect(renewalOfPlan(terms({ rollover: true, rolloverMax: 'unlimited' }))?.carryMax).toBe(
      'all',
    );
  });

  it('refuses unlimited included credits rather than guessing a number', () => {
    expect(renewalOfPlan(terms({ monthlyIncluded: 'unlimited' }))).toBeUndefined();
  });

  it('an undecided plan renews with nothing', () => {
    expect(renewalOfPlan(terms({}))).toEqual({ included: 0, carryMax: 0 });
  });
});

describe('renewal (ADR-0127)', () => {
  it('adds the included credits once per period, whatever the retries', async () => {
    const { service, tenant, store, organization, audit } = await world();
    const first = await service.renew(tenant, { period: PERIOD_1, included: 100, carryMax: 0 });
    const again = await service.renew(tenant, { period: PERIOD_1, included: 100, carryMax: 0 });
    // Even with other plan values, the same period replays the first renewal.
    const changed = await service.renew(tenant, { period: PERIOD_1, included: 900, carryMax: 0 });
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(changed.replayed).toBe(true);
    expect(first.entry).toMatchObject({
      type: 'renewal',
      amount: 100,
      referenceId: renewalReferenceOf(PERIOD_1.startsAt),
      renewal: { granted: 100, carried: 0, expired: 0 },
    });
    const b = await balance(service, tenant);
    expect(b).toMatchObject({ balance: 100, included: 100, purchased: 0 });
    expect(b.period).toEqual({ ...PERIOD_1, included: 100, consumed: 0 });
    const events = audit.events().filter((e) => e.action === 'credits.renewal');
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toEqual({
      type: 'system',
      id: 'runtime',
      initiatedBy: ALICE,
      via: 'runtime',
    });
    const wallet = await store.findWallet(organization.id);
    if (wallet === undefined) throw new Error('no wallet');
    expect(verifyLedger(wallet, await store.ledger(organization.id))).toEqual([]);
  });

  it('removes what does not carry over, never bought credits', async () => {
    const { service, tenant, clock, store, organization } = await world();
    await service.grant(tenant, { amount: 50, referenceId: 'bought', reason: 'test' });
    await service.renew(tenant, { period: PERIOD_1, included: 100, carryMax: 0 });
    await service.consume(tenant, { amount: 30, referenceId: 'use', reason: 'test' });
    clock.now = new Date(PERIOD_2.startsAt);
    const result = await service.renew(tenant, { period: PERIOD_2, included: 100, carryMax: 0 });
    expect(result.entry.renewal).toMatchObject({ granted: 100, carried: 0, expired: 70 });
    expect(result.entry.amount).toBe(30);
    expect(await balance(service, tenant)).toMatchObject({
      balance: 150,
      included: 100,
      purchased: 50,
      period: { ...PERIOD_2, included: 100, consumed: 0 },
    });
    const wallet = await store.findWallet(organization.id);
    if (wallet === undefined) throw new Error('no wallet');
    expect(verifyLedger(wallet, await store.ledger(organization.id))).toEqual([]);
  });

  it('keeps the included credits a wallet had before its first renewal', async () => {
    const { service, tenant } = await world();
    await service.grant(tenant, {
      amount: 25,
      referenceId: 'by-hand',
      reason: 'test',
      bucket: 'included',
    });
    const result = await service.renew(tenant, { period: PERIOD_1, included: 10, carryMax: 0 });
    expect(result.entry.renewal).toMatchObject({ granted: 10, carried: 25, expired: 0 });
    expect(await balance(service, tenant)).toMatchObject({ included: 35 });
  });

  it('carries over up to the plan maximum', async () => {
    const { service, tenant, clock } = await world();
    await service.renew(tenant, { period: PERIOD_1, included: 100, carryMax: 0 });
    clock.now = new Date(PERIOD_2.startsAt);
    const result = await service.renew(tenant, { period: PERIOD_2, included: 100, carryMax: 40 });
    expect(result.entry.renewal).toMatchObject({ granted: 100, carried: 40, expired: 60 });
    expect(await balance(service, tenant)).toMatchObject({ included: 140 });
  });

  it('never takes away credits held by running operations', async () => {
    const { service, tenant, clock } = await world();
    await service.renew(tenant, { period: PERIOD_1, included: 100, carryMax: 0 });
    clock.now = new Date('2026-02-28T09:00:00.000Z');
    await service.hold(tenant, {
      amount: 80,
      referenceId: 'run',
      reason: 'test',
      ttlMs: 60_000 * 60 * 24 * 7,
    });
    clock.now = new Date(PERIOD_2.startsAt);
    const result = await service.renew(tenant, { period: PERIOD_2, included: 0, carryMax: 0 });
    expect(result.entry.renewal).toMatchObject({ carried: 80, expired: 20 });
    // The running operation can still settle what it held.
    await service.settle(tenant, { holdOf: 'run', amount: 80, reason: 'test' });
    expect(await balance(service, tenant)).toMatchObject({ balance: 0, reserved: 0 });
  });

  it('counts what the period spent, less what was refunded in it', async () => {
    const { service, tenant } = await world();
    await service.renew(tenant, { period: PERIOD_1, included: 100, carryMax: 0 });
    await service.consume(tenant, { amount: 30, referenceId: 'use', reason: 'test' });
    await service.hold(tenant, { amount: 20, referenceId: 'run', reason: 'test', ttlMs: 60_000 });
    await service.settle(tenant, { holdOf: 'run', amount: 15, reason: 'test' });
    await service.refund(tenant, {
      amount: 10,
      referenceId: 'back',
      reason: 'test',
      refundOf: 'use',
    });
    expect((await balance(service, tenant)).period?.consumed).toBe(35);
  });

  it('refuses an older period, and a period that has not started', async () => {
    const { service, tenant, clock } = await world();
    expect(
      await codeOf(service.renew(tenant, { period: PERIOD_2, included: 1, carryMax: 0 })),
    ).toBe('invalid_period');
    clock.now = new Date(PERIOD_2.startsAt);
    await service.renew(tenant, { period: PERIOD_2, included: 1, carryMax: 0 });
    expect(
      await codeOf(service.renew(tenant, { period: PERIOD_1, included: 1, carryMax: 0 })),
    ).toBe('credits_renewal_out_of_order');
    expect(
      await codeOf(
        service.renew(tenant, {
          period: { startsAt: PERIOD_2.endsAt, endsAt: PERIOD_2.startsAt },
          included: 1,
          carryMax: 0,
        }),
      ),
    ).toBe('invalid_period');
    expect(
      await codeOf(service.renew(tenant, { period: PERIOD_2, included: -1, carryMax: 0 })),
    ).toBe('invalid_amount');
  });
});

describe('consumption order (ADR-0127)', () => {
  it('spends included credits first by default', async () => {
    const { service, tenant } = await world();
    await service.grant(tenant, { amount: 50, referenceId: 'bought', reason: 'test' });
    await service.renew(tenant, { period: PERIOD_1, included: 100, carryMax: 0 });
    const spent = await service.consume(tenant, {
      amount: 120,
      referenceId: 'use',
      reason: 'test',
    });
    expect(spent.entry.split).toEqual({ included: 100, purchased: 20 });
  });

  it('can spend bought credits first when configured so', async () => {
    const { service, tenant } = await world({ consumptionOrder: ['purchased', 'included'] });
    await service.grant(tenant, { amount: 50, referenceId: 'bought', reason: 'test' });
    await service.renew(tenant, { period: PERIOD_1, included: 100, carryMax: 0 });
    const spent = await service.consume(tenant, { amount: 70, referenceId: 'use', reason: 'test' });
    expect(spent.entry.split).toEqual({ included: 20, purchased: 50 });
  });

  it('refuses an order that does not name each bucket once', async () => {
    await expect(world({ consumptionOrder: ['included', 'included'] })).rejects.toThrow(
      'invalid consumption order',
    );
  });
});

describe('ensureCurrent', () => {
  const plan: PlanCreditTerms = { monthlyIncluded: 100, rollover: false, rolloverMax: 0 };

  it('renews once when a period starts, and reads nothing while it is current', async () => {
    const { service, tenant, clock } = await world();
    let reads = 0;
    const renewal = createCreditRenewal({
      credits: service,
      subjectOf: async () => {
        reads += 1;
        return { anchor: START, terms: plan };
      },
      now: () => clock.now,
    });
    expect((await renewal.ensureCurrent(tenant)).status).toBe('renewed');
    expect((await renewal.ensureCurrent(tenant)).status).toBe('current');
    expect(reads).toBe(1);
    clock.now = new Date(PERIOD_2.startsAt);
    expect((await renewal.ensureCurrent(tenant)).status).toBe('renewed');
    expect(await balance(service, tenant)).toMatchObject({ included: 100, balance: 100 });
  });

  it('two instances at once renew the period once', async () => {
    const { service, tenant, audit } = await world();
    const make = () =>
      createCreditRenewal({
        credits: service,
        subjectOf: async () => ({ anchor: START, terms: plan }),
        now: () => new Date(START),
      });
    await Promise.all([make().ensureCurrent(tenant), make().ensureCurrent(tenant)]);
    expect(audit.events().filter((e) => e.action === 'credits.renewal')).toHaveLength(1);
    expect(await balance(service, tenant)).toMatchObject({ balance: 100 });
  });

  it('does nothing without a plan in force or with unlimited included credits', async () => {
    const { service, tenant } = await world();
    const none = createCreditRenewal({ credits: service, subjectOf: async () => undefined });
    expect(await none.ensureCurrent(tenant)).toEqual({ status: 'skipped', reason: 'no_plan' });
    const unlimited = createCreditRenewal({
      credits: service,
      subjectOf: async () => ({ anchor: START, terms: { ...plan, monthlyIncluded: 'unlimited' } }),
      now: () => new Date(START),
    });
    expect(await unlimited.ensureCurrent(tenant)).toEqual({
      status: 'skipped',
      reason: 'unsupported_terms',
    });
    expect(await balance(service, tenant)).toMatchObject({ balance: 0 });
  });
});
