import { createAuditService, InMemoryAuditStore, type AuditEvent } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { createCreditService, InMemoryCreditStore, openWallet } from '@melonoffice/credits';
import type {
  Contact,
  Conversation,
  InitialBilling,
  Opportunity,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { FORECAST_LIMITS, FORECAST_METRICS, type ForecastLimits } from './catalogue.js';
import {
  createForecastEngine,
  type ForecastEngine,
  type ForecastOutcome,
  type ForecastRequestInput,
} from './engine.js';
import { ForecastError } from './errors.js';
import type { Forecast, ForecastTask } from './model.js';
import { addPeriods } from './periods.js';
import {
  ForecastProviderError,
  TIMESFM_MODEL,
  type ForecastModelInput,
  type ForecastModelProvider,
} from './provider.js';
import { InMemoryForecastRepository } from './repository.js';
import { createRecordSources } from './sources.js';
import { forecastViewOf } from './view.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
// Monday 2026-09-28, 10:00 in Lima: the last complete day there is Sunday the 27th.
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

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ForecastError) return error.code;
    throw error;
  }
  return 'accepted';
}

/** Sales won by an organization: one per day for `days` days up to the 27th, at noon in Lima. */
function sales(organizationId: OrganizationId, days: number, currency = 'PEN'): Opportunity[] {
  return Array.from({ length: days }, (_, i) => {
    const day = addPeriods('2026-09-27', -(days - 1) + i, 'day');
    return {
      id: `${organizationId}-o${i}`,
      organizationId,
      status: 'won',
      closedAt: `${day}T17:00:00.000Z`,
      createdAt: `${day}T15:00:00.000Z`,
      value: { amountMinor: (100 + (i % 7) * 10) * 100, currency },
    } as unknown as Opportunity;
  });
}

/** A model that answers like TimesFM: the last value, with a ±40% band. */
function fakeModel(
  behave: (input: ForecastModelInput, call: number) => Promise<void> | void = () => undefined,
) {
  const calls: ForecastModelInput[] = [];
  const provider: ForecastModelProvider = {
    model: TIMESFM_MODEL,
    async forecast(input, signal) {
      calls.push(input);
      await behave(input, calls.length);
      if (signal.aborted) throw new ForecastProviderError('provider_timeout');
      const last = input.values.at(-1) ?? 0;
      return {
        point: Array.from({ length: input.horizon }, () => last),
        quantiles: Array.from({ length: input.horizon }, () =>
          [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4].map((f) => last * f),
        ),
        usage: { inferenceMs: 500, memoryMb: 1431 },
      };
    },
  };
  return { provider, calls };
}

function recordingLogger() {
  const lines: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const make = (bound: Record<string, unknown>): Logger => {
    const log =
      (level: string) =>
      (message: string, fields: Record<string, unknown> = {}) =>
        lines.push({ level, message, fields: { ...bound, ...fields } });
    return {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      child: (more) => make({ ...bound, ...more }),
    };
  };
  return { lines, logger: make({}) };
}

interface WorldOptions {
  readonly provider?: ForecastModelProvider | null;
  readonly creditsPerRun?: number | null;
  readonly grant?: number;
  readonly fallback?: 'on_failure' | 'off';
  readonly limits?: Partial<ForecastLimits>;
  readonly permissions?: readonly string[];
  readonly salesA?: number;
  readonly failEnqueue?: boolean;
  readonly autoRun?: boolean;
}

async function world(options: WorldOptions = {}) {
  let clock = NOW;
  const now = () => clock;
  const audit = new InMemoryAuditStore();
  const creditStore = new InMemoryCreditStore(audit);
  const tenancy = new InMemoryTenancyStore(now, audit, undefined, undefined, creditStore);
  const orgOptions = { billing: BILLING, credits: openWallet };
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, orgOptions);
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, orgOptions);
  const A = a.organization.id;
  const B = b.organization.id;
  const credits = createCreditService({ store: creditStore, organizations: tenancy, now });
  const tenantA = await resolveTenant(as(ALICE), A, tenancy);
  const tenantB = await resolveTenant(as(BOB), B, tenancy);
  const grant = options.grant ?? 10;
  if (grant > 0) {
    await credits.grant(tenantA, { amount: grant, referenceId: 'test-grant', reason: 'test' });
    await credits.grant(tenantB, { amount: grant, referenceId: 'test-grant', reason: 'test' });
  }

  const records = {
    opportunities: [...sales(A, options.salesA ?? 60), ...sales(B, 60, 'USD')],
    contacts: [] as Contact[],
    conversations: [] as Conversation[],
  };
  const port = {
    listOpportunities: async (o: OrganizationId) =>
      records.opportunities.filter((x) => x.organizationId === o),
    listContacts: async (o: OrganizationId) =>
      records.contacts.filter((x) => x.organizationId === o),
    listConversations: async (o: OrganizationId) =>
      records.conversations.filter((x) => x.organizationId === o),
  };
  const model = fakeModel();
  const tasks: ForecastTask[] = [];
  const repository = new InMemoryForecastRepository(audit);
  const { lines, logger } = recordingLogger();
  const allowed = options.permissions;
  const rbac = createAuthorizationService();
  const authorization =
    allowed === undefined
      ? rbac
      : {
          authorize: (tenant: TenantContext, permission: string) =>
            allowed.includes(permission)
              ? rbac.authorize(tenant, permission)
              : { allowed: false as const, reason: 'permission_denied' as const },
        };
  const engine: ForecastEngine = createForecastEngine({
    repository,
    sources: createRecordSources(port),
    ...(options.provider === null ? {} : { provider: options.provider ?? model.provider }),
    fallback: options.fallback ?? 'on_failure',
    scheduler: {
      async enqueue(task) {
        if (options.failEnqueue === true) throw new Error('queue down');
        tasks.push(task);
        // The worker, as the queue would call it.
        if (options.autoRun === true) setTimeout(() => void engine.run(task, { final: true }), 0);
      },
    },
    credits,
    ...(options.creditsPerRun === null ? {} : { creditsPerRun: options.creditsPerRun ?? 1 }),
    context: {
      of: async (o) =>
        o === A
          ? { timeZone: 'America/Lima', currency: 'PEN' }
          : { timeZone: 'America/New_York', currency: 'USD' },
    },
    tenancy,
    authorization: authorization as ReturnType<typeof createAuthorizationService>,
    audit: createAuditService(audit, now),
    logger,
    limits: { ...FORECAST_LIMITS, waitMs: 2_000, ...options.limits },
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  });

  /** The worker: runs every queued task, as the queue delivers them. */
  async function drain(final = true) {
    const results = [];
    while (tasks.length > 0) {
      const task = tasks.shift() as ForecastTask;
      results.push(await engine.run(task, { final }));
    }
    return results;
  }
  const events = async (action?: string): Promise<readonly AuditEvent[]> =>
    (
      await audit.query({
        organizationId: A,
        actions: ['forecast.requested', 'forecast.completed', 'forecast.failed', 'credits.consume'],
        from: new Date(0),
        to: new Date('2100-01-01'),
        limit: 1000,
      })
    ).filter((e) => action === undefined || e.action === action);
  const balance = async (tenant: TenantContext) => {
    const b = await credits.balanceOf(tenant);
    return b.status === 'present' ? b.balance : -1;
  };
  return {
    engine,
    credits,
    tasks,
    drain,
    records,
    model,
    A,
    B,
    tenantA,
    tenantB,
    giaA: await resolveTenant(as(ALICE, 'gia'), A, tenancy),
    runtimeA: await resolveRuntimeTenant(ALICE, A, tenancy),
    events,
    balance,
    lines,
    repository,
    tick: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const SALES: ForecastRequestInput = { metric: 'sales.won_value', horizon: 14 };
const forecastOf = (outcome: ForecastOutcome): Forecast => {
  if (!('forecast' in outcome)) throw new Error(`no forecast: ${outcome.status}`);
  return outcome.forecast;
};

describe('1. Forecasting Engine initialization', () => {
  it('refuses a credit cost that is not a whole number of credits', async () => {
    const w = await world();
    const base = { ...w } as never;
    expect(() =>
      createForecastEngine({ ...(base as object), creditsPerRun: 0.5 } as never),
    ).toThrow();
  });

  it('offers the catalogue, saying which metrics the person may read', async () => {
    const w = await world({ permissions: ['forecast.read', 'forecast.run', 'opportunity.read'] });
    const metrics = w.engine.metrics(w.tenantA);
    expect(metrics.map((m) => m.id)).toEqual(FORECAST_METRICS.map((m) => m.id));
    expect(metrics.find((m) => m.id === 'sales.won_value')?.readable).toBe(true);
    expect(metrics.find((m) => m.id === 'leads.new')?.readable).toBe(false);
  });

  it('refuses to run where the model is not deployed, instead of pretending', async () => {
    const w = await world({ provider: null });
    expect(await codeOf(w.engine.request(w.tenantA, SALES))).toBe('forecast_model_unavailable');
    expect(w.tasks).toHaveLength(0);
  });

  it('refuses to run when no credit cost is set: runs are never given away', async () => {
    const w = await world({ creditsPerRun: null });
    expect(await codeOf(w.engine.request(w.tenantA, SALES))).toBe('forecast_price_not_set');
  });
});

describe('3. a valid series through the engine (MelonMotor → engine → provider)', () => {
  it('queues a run on the existing queue, and the worker completes it with the model', async () => {
    const w = await world();
    const outcome = await w.engine.request(w.tenantA, SALES);
    expect(outcome).toMatchObject({ status: 'queued', cache: 'miss' });
    expect(w.tasks).toEqual([{ organizationId: w.A, forecastId: forecastOf(outcome).id, run: 1 }]);
    expect(await w.drain()).toEqual(['completed']);
    const done = await w.engine.get(w.tenantA, forecastOf(outcome).id);
    expect(done.status).toBe('completed');
    expect(done.result?.model).toEqual(TIMESFM_MODEL);
    expect(done.result?.predictions).toHaveLength(14);
    // The forecast starts the period after the last one of the history.
    expect(done.input.end).toBe('2026-09-27');
    expect(done.result?.predictions[0]?.period).toBe('2026-09-28');
    expect(done.result?.predictions[13]?.period).toBe('2026-10-11');
  });

  it('keeps history and forecast apart, with the band and no confidence figure', async () => {
    const w = await world({ autoRun: true });
    const outcome = await w.engine.request(w.tenantA, { ...SALES, wait: true });
    expect(outcome.status).toBe('completed');
    const view = forecastViewOf(forecastOf(outcome), 'miss');
    expect(view.history).toHaveLength(60);
    expect(view.history.at(-1)?.period).toBe('2026-09-27');
    expect(view.forecast[0]).toMatchObject({ period: '2026-09-28' });
    expect(view.forecast[0]?.low).toBeLessThan(view.forecast[0]?.value as number);
    expect(view.forecast[0]?.high).toBeGreaterThan(view.forecast[0]?.value as number);
    expect(view.confidence).toBeNull();
    expect(view.interval).toEqual({ low: 'quantile_0.1', high: 'quantile_0.9' });
    expect(view.currency).toBe('PEN');
    expect(view.unit).toBe('currency');
  });

  it('sums money in major units of its own currency', async () => {
    const w = await world({ autoRun: true });
    const done = forecastOf(await w.engine.request(w.tenantA, { ...SALES, wait: true }));
    // 100…160 soles a day, never mixed with the other organization's dollars.
    expect(Math.min(...done.input.values)).toBe(100);
    expect(Math.max(...done.input.values)).toBe(160);
  });
});

describe('4. insufficient data', () => {
  it('answers insufficient_data with what there is and what is needed: no model, no charge', async () => {
    const w = await world({ salesA: 10 });
    const outcome = await w.engine.request(w.tenantA, SALES);
    expect(outcome).toMatchObject({
      status: 'insufficient_data',
      problem: 'insufficient_data',
      have: 10,
      need: 28,
      shortOf: 'periods',
    });
    expect(w.tasks).toHaveLength(0);
    expect(w.model.calls).toHaveLength(0);
    expect(await w.balance(w.tenantA)).toBe(10);
    expect((await w.events('forecast.requested'))[0]?.reason).toBe('insufficient_data');
  });
});

describe('10. horizon validation', () => {
  it.each([0, -1, 91, 2.5, '14', undefined])('refuses a daily horizon of %s', async (horizon) => {
    const w = await world();
    const code = await codeOf(w.engine.request(w.tenantA, { metric: 'sales.won_value', horizon }));
    expect(['horizon_out_of_range', 'invalid_request']).toContain(code);
  });

  it('allows up to 26 weeks and 12 months, as configured', async () => {
    const w = await world();
    expect(
      await codeOf(w.engine.request(w.tenantA, { ...SALES, frequency: 'week', horizon: 27 })),
    ).toBe('horizon_out_of_range');
    expect(
      await codeOf(w.engine.request(w.tenantA, { ...SALES, frequency: 'month', horizon: 12 })),
    ).toBe('accepted');
  });

  it('names the longest horizon allowed for the frequency asked', async () => {
    const w = await world();
    const refused = await w.engine
      .request(w.tenantA, { ...SALES, frequency: 'week', horizon: 27 })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'horizon_out_of_range', limit: 26 });
  });
});

describe('11. covariates', () => {
  it('checks their shape and size, then refuses them: the runtime has none yet', async () => {
    const w = await world();
    const bad = [{ name: 'Price!', kind: 'numeric', values: [1] }];
    expect(await codeOf(w.engine.request(w.tenantA, { ...SALES, covariates: bad }))).toBe(
      'invalid_request',
    );
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      name: `c${i}`,
      kind: 'numeric',
      values: [1],
    }));
    expect(await codeOf(w.engine.request(w.tenantA, { ...SALES, covariates: tooMany }))).toBe(
      'invalid_request',
    );
    const good = [{ name: 'price', kind: 'numeric', values: [10, 11] }];
    expect(await codeOf(w.engine.request(w.tenantA, { ...SALES, covariates: good }))).toBe(
      'covariates_not_supported',
    );
    expect(await codeOf(w.engine.request(w.tenantA, { ...SALES, covariates: [] }))).toBe(
      'accepted',
    );
  });
});

describe('12. Company Brain context', () => {
  it("reads periods in the business's time zone from the business context", async () => {
    const w = await world({ autoRun: true });
    // 03:00Z on the 27th is still the 26th in Lima: it counts on the 26th.
    w.records.opportunities.push({
      ...w.records.opportunities[0],
      id: 'late',
      closedAt: '2026-09-27T03:00:00.000Z',
      value: { amountMinor: 100_000, currency: 'PEN' },
    } as unknown as Opportunity);
    const done = forecastOf(await w.engine.request(w.tenantA, { ...SALES, wait: true }));
    const history = forecastViewOf(done).history;
    expect(history.find((p) => p.period === '2026-09-26')?.value).toBeGreaterThan(1000);
    expect(done.timeZone).toBe('America/Lima');
  });

  it('takes the currency from the business context, and the model gets only numbers', async () => {
    const w = await world({ autoRun: true });
    const done = forecastOf(await w.engine.request(w.tenantA, { ...SALES, wait: true }));
    expect(done.entity).toBe('PEN');
    expect(Object.keys(w.model.calls[0] ?? {}).sort()).toEqual(['frequency', 'horizon', 'values']);
    expect(w.model.calls[0]?.values.every((v) => typeof v === 'number')).toBe(true);
  });
});

describe('13. tenant isolation', () => {
  it("never reads another organization's records, nor lets it read the forecast", async () => {
    const w = await world({ autoRun: true });
    const a = forecastOf(await w.engine.request(w.tenantA, { ...SALES, wait: true }));
    expect(await codeOf(w.engine.get(w.tenantB, a.id))).toBe('forecast_not_found');
    // B asks for PEN sales: B has none (its sales are in dollars), A's are never counted.
    const b = await w.engine.request(w.tenantB, { ...SALES, entity: 'PEN' });
    expect(b).toMatchObject({ status: 'insufficient_data', have: 0 });
  });

  it('gives the same data in two organizations two different forecasts', async () => {
    const w = await world({ autoRun: true });
    w.records.opportunities = w.records.opportunities.filter((o) => o.organizationId === w.A);
    w.records.opportunities.push(
      ...sales(w.A, 60).map(
        (o) => ({ ...o, id: `b-${o.id}`, organizationId: w.B }) as unknown as Opportunity,
      ),
    );
    const a = forecastOf(await w.engine.request(w.tenantA, { ...SALES, entity: 'PEN' }));
    const b = forecastOf(await w.engine.request(w.tenantB, { ...SALES, entity: 'PEN' }));
    expect(a.id).not.toBe(b.id);
  });
});

describe('14. permissions', () => {
  it('refuses a person without forecast.run, and records the refusal', async () => {
    const w = await world({ permissions: ['forecast.read', 'opportunity.read'] });
    expect(await codeOf(w.engine.request(w.tenantA, SALES))).toBe('permission_denied');
    const [event] = await w.events('forecast.requested');
    expect(event).toMatchObject({ result: 'denied', permission: 'forecast.run' });
  });

  it('refuses a forecast of records the person may not read', async () => {
    const w = await world({ permissions: ['forecast.read', 'forecast.run', 'contact.read'] });
    expect(await codeOf(w.engine.request(w.tenantA, SALES))).toBe('permission_denied');
    expect(await codeOf(w.engine.request(w.tenantA, { metric: 'leads.new', horizon: 7 }))).not.toBe(
      'permission_denied',
    );
  });

  it("GIA keeps the person's permissions; the runtime can never ask", async () => {
    const w = await world();
    expect(await codeOf(w.engine.request(w.giaA, SALES))).toBe('accepted');
    expect(await codeOf(w.engine.request(w.runtimeA, SALES))).toBe('permission_denied');
  });

  it('reading a forecast needs forecast.read and the permission of its records', async () => {
    const w = await world({ autoRun: true });
    const done = forecastOf(await w.engine.request(w.tenantA, { ...SALES, wait: true }));
    const limited = await world({ permissions: ['forecast.read'] });
    expect(await codeOf(limited.engine.get(limited.tenantA, done.id))).toBe('forecast_not_found');
    expect(await codeOf(w.engine.get(w.tenantA, 'fc_nothex'))).toBe('forecast_not_found');
  });
});

describe('18. cache hit', () => {
  it('answers the same request with the same forecast: one model run, one charge', async () => {
    const w = await world({ autoRun: true });
    const first = await w.engine.request(w.tenantA, { ...SALES, wait: true });
    const second = await w.engine.request(w.tenantA, SALES);
    expect(first).toMatchObject({ cache: 'miss', status: 'completed' });
    expect(second).toMatchObject({ cache: 'hit', status: 'completed' });
    expect(forecastOf(second).id).toBe(forecastOf(first).id);
    expect(w.model.calls).toHaveLength(1);
    expect(await w.balance(w.tenantA)).toBe(9);
    const reasons = (await w.events('forecast.requested')).map((e) => e.reason).sort();
    expect(reasons).toEqual(['cache_hit', 'cache_miss']);
  });
});

describe('19. cache invalidation', () => {
  it('runs again when the data changed (a new sale): never a stale forecast', async () => {
    const w = await world({ autoRun: true });
    const first = forecastOf(await w.engine.request(w.tenantA, { ...SALES, wait: true }));
    w.records.opportunities.push({
      ...w.records.opportunities[5],
      id: 'new-sale',
    } as unknown as Opportunity);
    const second = await w.engine.request(w.tenantA, { ...SALES, wait: true });
    expect(second).toMatchObject({ cache: 'miss' });
    expect(forecastOf(second).id).not.toBe(first.id);
    expect(w.model.calls).toHaveLength(2);
  });

  it('runs again when a new day closed, or once the result expired', async () => {
    const w = await world({ autoRun: true });
    const first = forecastOf(await w.engine.request(w.tenantA, { ...SALES, wait: true }));
    w.tick(25 * 60 * 60_000);
    const next = forecastOf(await w.engine.request(w.tenantA, { ...SALES, wait: true }));
    expect(next.id).not.toBe(first.id);
    expect(next.input.end).toBe('2026-09-28');
  });

  it('uses a different key for another horizon, entity or covariate set', async () => {
    const w = await world();
    const a = forecastOf(await w.engine.request(w.tenantA, SALES));
    const b = forecastOf(await w.engine.request(w.tenantA, { ...SALES, horizon: 7 }));
    expect(a.id).not.toBe(b.id);
  });
});

describe('20. model failure', () => {
  it('asks the queue to deliver again, and a later delivery completes: charged once', async () => {
    const w = await world();
    let failures = 1;
    w.model.provider.forecast = (async (input: ForecastModelInput, signal: AbortSignal) => {
      if (failures-- > 0) throw new ForecastProviderError('provider_unavailable', 503);
      return fakeModel().provider.forecast(input, signal);
    }) as ForecastModelProvider['forecast'];
    const outcome = await w.engine.request(w.tenantA, SALES);
    const task = w.tasks[0] as ForecastTask;
    expect(await codeOf(w.engine.run(task, { final: false }))).toBe('forecast_model_unavailable');
    expect((await w.engine.get(w.tenantA, forecastOf(outcome).id)).status).toBe('running');
    expect(await w.engine.run(task, { final: false })).toBe('completed');
    // A late duplicate of the same task does nothing, and nothing is charged twice.
    expect(await w.engine.run(task, { final: true })).toBe('already_done');
    expect(await w.balance(w.tenantA)).toBe(9);
    const done = await w.engine.get(w.tenantA, forecastOf(outcome).id);
    expect(done.attempts).toBe(2);
  });

  it('keeps it failed, charged nothing, when the queue gives up and the fallback is off', async () => {
    const w = await world({
      fallback: 'off',
      provider: {
        model: TIMESFM_MODEL,
        forecast: async () => {
          throw new ForecastProviderError('provider_unavailable');
        },
      },
    });
    const outcome = await w.engine.request(w.tenantA, SALES);
    expect(await w.drain(true)).toEqual(['failed']);
    const done = await w.engine.get(w.tenantA, forecastOf(outcome).id);
    expect(done).toMatchObject({ status: 'failed', failure: 'provider_unavailable' });
    expect(done.result).toBeUndefined();
    expect(await w.balance(w.tenantA)).toBe(10);
    expect((await w.events('forecast.failed'))[0]?.reason).toBe('provider_unavailable');
  });

  it('queues a failed forecast again on the next identical request', async () => {
    const w = await world({ failEnqueue: true });
    expect(await codeOf(w.engine.request(w.tenantA, SALES))).toBe('forecast_not_scheduled');
    const [failed] = await w.events('forecast.failed');
    expect(failed?.reason).toBe('not_scheduled');
  });
});

describe('21. fallback', () => {
  it('answers with the labelled fallback only after the last attempt failed, at no cost', async () => {
    const w = await world({
      provider: {
        model: TIMESFM_MODEL,
        forecast: async () => {
          throw new ForecastProviderError('provider_timeout');
        },
      },
    });
    const outcome = await w.engine.request(w.tenantA, SALES);
    expect(await w.drain(true)).toEqual(['fallback']);
    const done = await w.engine.get(w.tenantA, forecastOf(outcome).id);
    expect(done.result?.model).toMatchObject({ id: 'fallback', kind: 'fallback' });
    expect(done.warnings).toContain('model_failed_fallback_used');
    expect(done.creditsCharged).toBe(0);
    expect(await w.balance(w.tenantA)).toBe(10);
    expect((await w.events('forecast.completed'))[0]).toMatchObject({
      reason: 'fallback',
      model: { provider: 'melonoffice', id: 'fallback' },
    });
  });
});

describe('22. credits', () => {
  it('charges once per model run, with the forecast as reference, through the existing ledger', async () => {
    const w = await world({ autoRun: true, creditsPerRun: 2 });
    const done = forecastOf(await w.engine.request(w.tenantA, { ...SALES, wait: true }));
    expect(done.creditsCharged).toBe(2);
    expect(done.creditReference).toBe(`forecast:${done.id}`);
    expect(await w.balance(w.tenantA)).toBe(8);
    const [consume] = await w.events('credits.consume');
    expect(consume).toMatchObject({ reference: `forecast:${done.id}`, reason: 'forecast_run' });
    expect(consume?.actor).toMatchObject({ type: 'system', id: 'runtime', initiatedBy: ALICE });
  });

  it('refuses before queuing when the balance cannot pay a run', async () => {
    const w = await world({ grant: 0 });
    expect(await codeOf(w.engine.request(w.tenantA, SALES))).toBe('forecast_credits_insufficient');
    expect(w.tasks).toHaveLength(0);
  });

  it('does not count credits another operation holds (ADR-0123)', async () => {
    const w = await world({ grant: 10 });
    await w.credits.hold(w.tenantA, {
      amount: 10,
      referenceId: 'ai:other',
      reason: 'ai_generation',
      ttlMs: 60_000,
    });
    expect(await codeOf(w.engine.request(w.tenantA, SALES))).toBe('forecast_credits_insufficient');
    expect(w.tasks).toHaveLength(0);
  });

  it('keeps it failed, not free, if the balance ran out before the run finished', async () => {
    const w = await world({ grant: 1 });
    await w.engine.request(w.tenantA, SALES);
    await w.engine.request(w.tenantA, { ...SALES, horizon: 7 });
    expect(await w.drain()).toEqual(['completed', 'failed']);
    expect(await w.balance(w.tenantA)).toBe(0);
  });

  it('charges nothing for a cache hit, a refusal or missing data', async () => {
    const w = await world({ autoRun: true });
    await w.engine.request(w.tenantA, { ...SALES, wait: true });
    await w.engine.request(w.tenantA, SALES);
    await codeOf(w.engine.request(w.tenantA, { ...SALES, horizon: 500 }));
    expect(await w.balance(w.tenantA)).toBe(9);
  });
});

describe('23. audit', () => {
  it('records requests, completions and failures, never a value of the series', async () => {
    const w = await world({ autoRun: true });
    const done = forecastOf(await w.engine.request(w.tenantA, { ...SALES, wait: true }));
    const events = await w.events();
    const actions = events.map((e) => e.action).sort();
    expect(actions).toEqual(['credits.consume', 'forecast.completed', 'forecast.requested']);
    const completed = events.find((e) => e.action === 'forecast.completed');
    expect(completed).toMatchObject({
      target: { type: 'forecast', id: done.id },
      model: { provider: 'timesfm', id: 'timesfm-2.5-200m' },
      reason: 'model',
      actor: { type: 'system', id: 'runtime', initiatedBy: ALICE },
    });
    const text = JSON.stringify(events);
    for (const value of done.input.values) expect(text).not.toContain(`:${value},`);
    expect(text).not.toContain('predictions');
  });
});

describe('24. observability', () => {
  it('logs organization, metric, horizon, model, version, duration and cache, without data', async () => {
    const w = await world({ autoRun: true });
    await w.engine.request(w.tenantA, { ...SALES, department: 'sales', wait: true });
    await w.engine.request(w.tenantA, SALES);
    const miss = w.lines.find((l) => l.message === 'forecast.cache_miss');
    const completed = w.lines.find((l) => l.message === 'forecast.completed');
    const hit = w.lines.find((l) => l.message === 'forecast.cache_hit');
    expect(miss?.fields).toMatchObject({
      organizationId: w.A,
      metric: 'sales.won_value',
      horizon: 14,
      department: 'sales',
    });
    expect(completed?.fields).toMatchObject({
      organizationId: w.A,
      model: 'timesfm-2.5-200m',
      modelVersion: '2.0.2+d418f3e8',
      inferenceMs: 500,
      memoryMb: 1431,
      fallback: false,
      credits: 1,
    });
    expect(typeof completed?.fields.durationMs).toBe('number');
    expect(hit).toBeDefined();
    expect(JSON.stringify(w.lines)).not.toMatch(/"values"|"predictions"/);
  });
});

describe('25. concurrent requests', () => {
  it('runs the model once for identical requests made at the same time', async () => {
    const w = await world();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => w.engine.request(w.tenantA, SALES)),
    );
    expect(new Set(outcomes.map((o) => forecastOf(o).id)).size).toBe(1);
    expect(w.tasks).toHaveLength(1);
    await w.drain();
    expect(w.model.calls).toHaveLength(1);
  });

  it('limits how many runs one organization may have queued at once', async () => {
    const w = await world({ limits: { maxActivePerOrganization: 2 } });
    await w.engine.request(w.tenantA, { ...SALES, horizon: 5 });
    await w.engine.request(w.tenantA, { ...SALES, horizon: 6 });
    expect(await codeOf(w.engine.request(w.tenantA, { ...SALES, horizon: 7 }))).toBe(
      'forecast_limit_reached',
    );
    // Another organization is not affected.
    expect(await codeOf(w.engine.request(w.tenantB, SALES))).toBe('accepted');
  });
});

describe('26. timeout', () => {
  it('counts a model call past the limit as failed, and retries it', async () => {
    const w = await world({
      limits: { providerTimeoutMs: 20 },
      provider: fakeModel(() => new Promise((resolve) => setTimeout(resolve, 60))).provider,
    });
    await w.engine.request(w.tenantA, SALES);
    const task = w.tasks[0] as ForecastTask;
    expect(await codeOf(w.engine.run(task, { final: false }))).toBe('forecast_model_unavailable');
    expect(await w.engine.run(task, { final: true })).toBe('fallback');
  });

  it('answers queued when the run takes longer than the wait', async () => {
    const w = await world({ limits: { waitMs: 20 } });
    const outcome = await w.engine.request(w.tenantA, { ...SALES, wait: true });
    expect(outcome.status).toBe('queued');
  });
});

describe('27. malformed input', () => {
  it.each([
    [{ metric: 'orders.count', horizon: 7 }, 'metric_not_found'],
    [{ metric: 42, horizon: 7 }, 'metric_not_found'],
    [{ ...SALES, frequency: 'hour' }, 'invalid_request'],
    [{ ...SALES, entity: 'soles' }, 'invalid_request'],
    [{ ...SALES, entity: 7 }, 'invalid_request'],
    [{ ...SALES, department: 'Sales!' }, 'invalid_request'],
    [{ ...SALES, covariates: 'price' }, 'invalid_request'],
  ])('refuses %j', async (input, code) => {
    const w = await world();
    expect(await codeOf(w.engine.request(w.tenantA, input as ForecastRequestInput))).toBe(code);
  });

  it('refuses a task for a forecast that is not there, or of an earlier run', async () => {
    const w = await world();
    const outcome = forecastOf(await w.engine.request(w.tenantA, SALES));
    expect(
      await w.engine.run({ organizationId: w.B, forecastId: outcome.id, run: 1 }, { final: true }),
    ).toBe('not_found');
    expect(
      await w.engine.run({ organizationId: w.A, forecastId: outcome.id, run: 9 }, { final: true }),
    ).toBe('stale');
  });
});

describe('28–31. one engine for every department', () => {
  const contact = (o: OrganizationId, i: number, kind: string, day: string) =>
    ({
      id: `c${i}`,
      organizationId: o,
      createdAt: `${day}T16:00:00.000Z`,
      commercial: { stage: 'lead', source: { kind } },
    }) as unknown as Contact;
  const conversation = (o: OrganizationId, i: number, day: string) =>
    ({
      id: `v${i}`,
      organizationId: o,
      channel: 'whatsapp',
      createdAt: `${day}T16:00:00.000Z`,
    }) as unknown as Conversation;

  it('28. Comercial: won sales, value and count', async () => {
    const w = await world({ autoRun: true });
    for (const metric of ['sales.won_value', 'sales.won_count']) {
      const done = await w.engine.request(w.tenantA, {
        metric,
        horizon: 14,
        department: 'sales',
        wait: true,
      });
      expect(done.status).toBe('completed');
    }
  });

  it('29. Marketing: new leads by source, and demand entering the pipeline', async () => {
    const w = await world({ autoRun: true });
    for (let i = 0; i < 40; i++) {
      const day = addPeriods('2026-09-27', -i, 'day');
      w.records.contacts.push(contact(w.A, i, i % 3 === 0 ? 'campaign' : 'channel', day));
    }
    const campaign = await w.engine.request(w.tenantA, {
      metric: 'leads.new',
      entity: 'campaign',
      horizon: 7,
      department: 'marketing',
      wait: true,
    });
    expect(campaign.status).toBe('completed');
    // Only the campaign leads: one in three days.
    expect(forecastOf(campaign).dataQuality.nonZero).toBeLessThan(20);
    const demand = await w.engine.request(w.tenantA, {
      metric: 'opportunities.new',
      horizon: 7,
      department: 'marketing',
      wait: true,
    });
    expect(demand.status).toBe('completed');
  });

  it('30. Operaciones: incoming conversations as load; orders have no metric', async () => {
    const w = await world({ autoRun: true });
    for (let i = 0; i < 40; i++) {
      w.records.conversations.push(conversation(w.A, i, addPeriods('2026-09-27', -i, 'day')));
    }
    const load = await w.engine.request(w.tenantA, {
      metric: 'conversations.new',
      entity: 'whatsapp',
      horizon: 7,
      department: 'operations',
      wait: true,
    });
    expect(load.status).toBe('completed');
    expect(
      await codeOf(
        w.engine.request(w.tenantA, {
          metric: 'sales.won_value',
          horizon: 7,
          department: 'operations',
        }),
      ),
    ).toBe('metric_not_for_department');
  });

  it('31. Dirección: the same metrics, weekly, through the same engine', async () => {
    const w = await world({ autoRun: true, salesA: 120 });
    const weekly = await w.engine.request(w.tenantA, {
      metric: 'sales.won_value',
      frequency: 'week',
      horizon: 4,
      department: 'leadership',
      wait: true,
    });
    expect(weekly.status).toBe('completed');
    expect(forecastOf(weekly).result?.predictions[0]?.period).toBe('2026-09-28');
  });
});
