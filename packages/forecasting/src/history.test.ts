import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet, InMemoryCreditStore } from '@melonoffice/credits';
import type {
  InitialBilling,
  Opportunity,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { ForecastError } from './errors.js';
import { createMetricHistory, type MetricHistoryInput } from './history.js';
import { addPeriods } from './periods.js';
import { createRecordSources } from './sources.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
// Monday 2026-09-28, 10:00 in Lima: the day under way there is the 28th.
const NOW = new Date('2026-09-28T15:00:00Z');

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

const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });

/** One sale won a day, S/100, for `days` days up to `last`, closed at noon in Lima. */
function sales(
  organizationId: OrganizationId,
  days: number,
  currency = 'PEN',
  last = '2026-09-27',
): Opportunity[] {
  return Array.from({ length: days }, (_, i) => {
    const day = addPeriods(last, i - days + 1, 'day');
    return {
      id: `${organizationId}-${last}-o${i}`,
      organizationId,
      status: 'won',
      closedAt: `${day}T17:00:00.000Z`,
      createdAt: `${day}T15:00:00.000Z`,
      value: { amountMinor: 100_00, currency },
    } as unknown as Opportunity;
  });
}

async function world(
  options: {
    readonly salesA?: number;
    readonly extraA?: (organizationId: OrganizationId) => readonly Opportunity[];
    readonly permissions?: readonly string[];
    readonly business?: 'none' | 'no_currency';
  } = {},
) {
  const audit = new InMemoryAuditStore();
  const tenancy = new InMemoryTenancyStore(
    () => NOW,
    audit,
    undefined,
    undefined,
    new InMemoryCreditStore(audit),
  );
  const orgOptions = { billing: BILLING, credits: openWallet };
  const A = (await createOrganization(as(ALICE), { name: 'A' }, tenancy, orgOptions)).organization
    .id;
  const B = (await createOrganization(as(BOB), { name: 'B' }, tenancy, orgOptions)).organization.id;
  const opportunities = [
    ...sales(A, options.salesA ?? 0),
    ...(options.extraA?.(A) ?? []),
    ...sales(B, 90, 'USD'),
  ];
  const reads: OrganizationId[] = [];
  const sources = createRecordSources({
    listOpportunities: async (o) => {
      reads.push(o);
      return opportunities.filter((x) => x.organizationId === o);
    },
    listContacts: async () => [],
    listConversations: async () => [],
  });
  const rbac = createAuthorizationService();
  const allowed = options.permissions;
  const authorization =
    allowed === undefined
      ? rbac
      : {
          authorize: (tenant: TenantContext, permission: string) =>
            allowed.includes(permission)
              ? rbac.authorize(tenant, permission)
              : { allowed: false as const, reason: 'permission_denied' as const },
        };
  const history = createMetricHistory({
    sources,
    context: {
      of: async (o) =>
        o === A
          ? options.business === 'none'
            ? undefined
            : options.business === 'no_currency'
              ? { timeZone: 'America/Lima' }
              : { timeZone: 'America/Lima', currency: 'PEN' }
          : { timeZone: 'America/New_York', currency: 'USD' },
    },
    tenancy,
    authorization,
    now: () => NOW,
  });
  return {
    history,
    audit,
    reads,
    tenantA: await resolveTenant(as(ALICE), A, tenancy),
    giaA: await resolveTenant(as(ALICE, 'gia'), A, tenancy),
    tenantB: await resolveTenant(as(BOB), B, tenancy),
    runtimeA: await resolveRuntimeTenant(ALICE, A, tenancy),
  };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ForecastError)
      return `${error.code}${error.detail ? `:${error.detail}` : ''}`;
    throw error;
  }
  return 'read';
}

const SALES: MetricHistoryInput = { metric: 'sales.won_value' };

describe('metric history (ADR-0060): what was recorded, never a projection', () => {
  it('adds up the complete days of the business and keeps the day under way apart', async () => {
    const w = await world({ salesA: 60 });
    // A sale this morning in Lima: it is today's, not part of the complete days.
    const today = (organizationId: OrganizationId) => [
      {
        id: 'today',
        organizationId,
        status: 'won',
        closedAt: '2026-09-28T14:00:00.000Z',
        createdAt: '2026-09-28T14:00:00.000Z',
        value: { amountMinor: 50_00, currency: 'PEN' },
      } as unknown as Opportunity,
    ];
    const withToday = await world({ salesA: 60, extraA: today });
    for (const x of [w, withToday]) {
      const h = await x.history.history(x.tenantA, SALES);
      expect(h).toMatchObject({
        metric: 'sales.won_value',
        unit: 'currency',
        entity: 'PEN',
        frequency: 'day',
        timeZone: 'America/Lima',
        from: '2026-08-29',
        to: '2026-09-27',
        total: 3000,
        average: 100,
        // The 30 days before also had one sale a day.
        previousTotal: 3000,
        firstRecord: '2026-07-30',
        readiness: { ready: true, have: 60, need: 28 },
      });
      expect(h.points).toHaveLength(30);
      expect(h.points[0]).toEqual({ period: '2026-08-29', value: 100 });
    }
    expect((await w.history.history(w.tenantA, SALES)).current).toEqual({
      period: '2026-09-28',
      value: 0,
    });
    expect((await withToday.history.history(withToday.tenantA, SALES)).current).toEqual({
      period: '2026-09-28',
      value: 50,
    });
  });

  it('with nothing recorded, shows zero days, compares with nothing and says 0 of 28 days', async () => {
    const w = await world();
    const h = await w.history.history(w.tenantA, SALES);
    expect(h.total).toBe(0);
    expect(h.points.every((p) => p.value === 0)).toBe(true);
    expect(h.previousTotal).toBeNull();
    expect(h.firstRecord).toBeNull();
    expect(h.readiness).toEqual({
      ready: false,
      problem: 'insufficient_data',
      have: 0,
      need: 28,
      shortOf: 'periods',
    });
  });

  it('with 10 days recorded, says 10 of 28 and never compares with the days before any record', async () => {
    const w = await world({ salesA: 10 });
    const h = await w.history.history(w.tenantA, SALES);
    expect(h.total).toBe(1000);
    expect(h.previousTotal).toBeNull();
    expect(h.firstRecord).toBe('2026-09-18');
    expect(h.readiness).toMatchObject({ ready: false, have: 10, need: 28, shortOf: 'periods' });
  });

  it('reads weeks and months as the engine does, Monday weeks and first-of-month months', async () => {
    const w = await world({ salesA: 60 });
    const weeks = await w.history.history(w.tenantA, { ...SALES, frequency: 'week', periods: 4 });
    expect(weeks.from).toBe('2026-08-31');
    expect(weeks.to).toBe('2026-09-21');
    expect(weeks.points.map((p) => p.value)).toEqual([700, 700, 700, 700]);
    expect(weeks.current).toEqual({ period: '2026-09-28', value: 0 });
    const months = await w.history.history(w.tenantA, { ...SALES, frequency: 'month', periods: 2 });
    expect(months.points).toEqual([
      { period: '2026-07-01', value: 200 },
      { period: '2026-08-01', value: 3100 },
    ]);
    expect(months.current).toEqual({ period: '2026-09-01', value: 2700 });
    expect(months.readiness).toMatchObject({ ready: false, have: 2, need: 12 });
  });

  it("reads only the person's own organization, in its own currency and time zone", async () => {
    const w = await world({ salesA: 60 });
    const b = await w.history.history(w.tenantB, SALES);
    expect(b).toMatchObject({ entity: 'USD', timeZone: 'America/New_York', total: 3000 });
    const a = await w.history.history(w.tenantA, { ...SALES, entity: 'USD' });
    expect(a.total).toBe(0);
    expect(new Set(w.reads)).toEqual(new Set([w.tenantA.organizationId, w.tenantB.organizationId]));
    expect(w.reads.filter((o) => o === w.tenantB.organizationId)).toHaveLength(1);
  });

  it("needs the permission that reads the records; GIA keeps the person's, the runtime has none", async () => {
    const w = await world({ salesA: 60 });
    expect(await codeOf(w.history.history(w.giaA, SALES))).toBe('read');
    expect(await codeOf(w.history.history(w.runtimeA, SALES))).toBe('permission_denied');
    const without = await world({ salesA: 60, permissions: ['report.read', 'contact.read'] });
    expect(await codeOf(without.history.history(without.tenantA, SALES))).toBe('permission_denied');
    expect(without.reads).toHaveLength(0);
    const noReports = await world({ salesA: 60, permissions: ['opportunity.read'] });
    expect(await codeOf(noReports.history.history(noReports.tenantA, SALES))).toBe(
      'permission_denied',
    );
    expect(noReports.history.metrics(noReports.tenantA).every((m) => !m.readable)).toBe(true);
    expect(
      without.history.metrics(without.tenantA).find((m) => m.id === 'sales.won_value'),
    ).toMatchObject({ readable: false });
    expect(
      without.history.metrics(without.tenantA).find((m) => m.id === 'leads.new'),
    ).toMatchObject({ readable: true, departments: expect.arrayContaining(['marketing']) });
  });

  it('refuses what it cannot read exactly, and says which company information is missing', async () => {
    const w = await world({ salesA: 60 });
    expect(await codeOf(w.history.history(w.tenantA, { metric: 'orders.new' }))).toBe(
      'metric_not_found',
    );
    for (const periods of [0, 367, 2.5, '30']) {
      expect(await codeOf(w.history.history(w.tenantA, { ...SALES, periods }))).toBe(
        'invalid_request:periods',
      );
    }
    expect(await codeOf(w.history.history(w.tenantA, { ...SALES, frequency: 'hour' }))).toBe(
      'invalid_request:frequency',
    );
    expect(await codeOf(w.history.history(w.tenantA, { ...SALES, entity: 'soles' }))).toBe(
      'invalid_request:entity',
    );
    const none = await world({ salesA: 60, business: 'none' });
    expect(await codeOf(none.history.history(none.tenantA, SALES))).toBe(
      'invalid_request:business_context',
    );
    const noCurrency = await world({ salesA: 60, business: 'no_currency' });
    expect(await codeOf(noCurrency.history.history(noCurrency.tenantA, SALES))).toBe(
      'invalid_request:entity',
    );
    // A count needs no currency.
    expect(
      (await noCurrency.history.history(noCurrency.tenantA, { metric: 'sales.won_count' })).total,
    ).toBe(30);
  });

  it('writes nothing: no audit event, no charge, no model', async () => {
    const w = await world({ salesA: 60 });
    const before = w.audit.events().length;
    await w.history.history(w.tenantA, SALES);
    expect(w.audit.events()).toHaveLength(before);
  });
});
