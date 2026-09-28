import { createCreditService } from '@melonoffice/credits';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import {
  createForecastEngine,
  createRecordSources,
  FORECAST_LIMITS,
  InMemoryForecastRepository,
  TIMESFM_MODEL,
  type ForecastModelProvider,
  type ForecastRepository,
  type ForecastTask,
} from '@melonoffice/forecasting';
import { FirestoreForecastRepository } from '@melonoffice/firestore';
import { emulatorFirestore } from '@melonoffice/firestore/testing';
import { createAuthorizationService } from '@melonoffice/rbac';
import { resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

const PROFILE = {
  businessType: 'restaurant',
  country: 'PE',
  currency: 'PEN',
  timeZone: 'America/Lima',
  city: 'Lima',
};

/** Short history is enough here: the engine's own tests cover the real minimums. */
const LIMITS = {
  ...FORECAST_LIMITS,
  minHistory: { day: 1, week: 1, month: 1 },
  minNonZero: 1,
  waitMs: 50,
};

const tomorrow = () => new Date(Date.now() + 24 * 60 * 60_000);

const model: ForecastModelProvider = {
  model: TIMESFM_MODEL,
  forecast: async (input) => ({
    point: Array.from({ length: input.horizon }, () => 1500),
    quantiles: Array.from({ length: input.horizon }, () => [
      900, 1000, 1100, 1200, 1500, 1600, 1700, 1800, 2100,
    ]),
  }),
};

describe.each(STORES)('forecasts (ADR-0059) with storage in %s', (name, createStores) => {
  async function setup(
    options: {
      configured?: boolean;
      provider?: boolean;
      creditsPerRun?: number;
      permissions?: readonly string[];
      /** Reads periods as if it were tomorrow, so today's sales are history. */
      tomorrow?: boolean;
    } = {},
  ) {
    const stores: Stores = createStores();
    const repository: ForecastRepository =
      name === 'firestore'
        ? new FirestoreForecastRepository(emulatorFirestore())
        : new InMemoryForecastRepository();
    const tasks: ForecastTask[] = [];
    const ctx = setupApp(
      stores,
      options.permissions === undefined
        ? undefined
        : createAuthorizationService({ owner: options.permissions as never }),
      undefined,
      undefined,
      undefined,
      options.configured === false
        ? {}
        : {
            forecasting: {
              repository,
              ...(options.provider === false ? {} : { provider: model }),
              scheduler: { enqueue: async (task) => void tasks.push(task) },
              creditsPerRun: options.creditsPerRun ?? 1,
              limits: LIMITS,
              ...(options.tomorrow === true ? { now: tomorrow } : {}),
            },
          },
    );
    const alice = (await ctx.register('token-alice')) as UserId;
    await ctx.register('token-bob');
    const call = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const send = (token: string, method: string, path: string, body: unknown) =>
      call(token, path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const create = async (token: string, org: string) =>
      (
        (await send(token, 'POST', '/v1/organizations', { name: org })).body as {
          organization: { id: string };
        }
      ).organization.id as OrganizationId;
    const orgA = await create('token-alice', 'Pollería A');
    const orgB = await create('token-bob', 'Tienda B');
    const base = (org: string) => `/v1/organizations/${org}`;
    await send('token-alice', 'PUT', `${base(orgA)}/business-profile`, PROFILE);
    // A won sale, yesterday or earlier: the only history.
    const sale = async () => {
      const contact = await send('token-alice', 'POST', `${base(orgA)}/customers`, {
        displayName: 'Juan Pérez',
        phone: '+51911111111',
      });
      const opportunity = await send('token-alice', 'POST', `${base(orgA)}/opportunities`, {
        contactId: contact.body.id,
        title: 'Pedido',
        value: { amountMinor: 150000, currency: 'PEN' },
      });
      await send('token-alice', 'PATCH', `${base(orgA)}/opportunities/${opportunity.body.id}`, {
        revision: 1,
        stageId: 'won',
      });
    };
    /** The worker's side: the same engine code, run on the queued tasks. */
    const worker = createForecastEngine({
      repository,
      sources: createRecordSources(stores.conversations),
      provider: model,
      credits: createCreditService({ store: stores.credits, organizations: stores.tenancy }),
      creditsPerRun: options.creditsPerRun ?? 1,
      context: { of: async () => ({ timeZone: 'America/Lima', currency: 'PEN' }) },
      tenancy: stores.tenancy,
      authorization: createAuthorizationService(),
      audit: stores.audit,
      ...(options.tomorrow === true ? { now: tomorrow } : {}),
    });
    const drain = async () => {
      while (tasks.length > 0) await worker.run(tasks.shift() as ForecastTask, { final: false });
    };
    const grant = async (amount: number) => {
      const tenant = await resolveTenant(
        { actor: 'user', userId: alice, emailVerified: true },
        orgA,
        stores.tenancy,
      );
      await createCreditService({ store: stores.credits, organizations: stores.tenancy }).grant(
        tenant,
        { amount, referenceId: `grant-${amount}`, reason: 'test' },
      );
    };
    return { ...ctx, orgA, orgB, base, call, send, sale, tasks, drain, grant };
  }

  it('lists the metrics the person may forecast', async () => {
    const t = await setup();
    const { status, body } = await t.call('token-alice', `${t.base(t.orgA)}/forecasts/metrics`);
    expect(status).toBe(200);
    const metrics = body.metrics as { id: string; readable: boolean }[];
    expect(metrics.map((m) => m.id)).toContain('sales.won_value');
    expect(metrics.every((m) => m.readable)).toBe(true);
  });

  it('answers not enough data, at no cost, when there is no history yet', async () => {
    const t = await setup();
    const { status, body } = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/forecasts`, {
      metric: 'sales.won_value',
      horizon: 7,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'insufficient_data', forecast: [], confidence: null });
    expect(t.tasks).toHaveLength(0);
  });

  it('queues a run (202), the worker completes it, and GET shows history apart from forecast', async () => {
    const t = await setup({ tomorrow: true });
    await t.grant(5);
    await t.sale();
    const asked = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/forecasts`, {
      metric: 'sales.won_value',
      horizon: 7,
      department: 'sales',
    });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ status: 'queued', cache: 'miss', currency: 'PEN' });
    expect(t.tasks).toHaveLength(1);
    await t.drain();
    const id = asked.body.id as string;
    const done = await t.call('token-alice', `${t.base(t.orgA)}/forecasts/${id}`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      status: 'completed',
      metric: 'sales.won_value',
      unit: 'currency',
      currency: 'PEN',
      department: 'sales',
      confidence: null,
      interval: { low: 'quantile_0.1', high: 'quantile_0.9' },
      model: { provider: 'timesfm', id: 'timesfm-2.5-200m', kind: 'model' },
      creditsCharged: 1,
    });
    expect(done.body.history).toEqual([{ period: expect.any(String), value: 1500 }]);
    expect((done.body.forecast as unknown[]).length).toBe(7);
    // Asked again: the same forecast, no new run.
    const again = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/forecasts`, {
      metric: 'sales.won_value',
      horizon: 7,
    });
    expect(again.body).toMatchObject({ id, status: 'completed', cache: 'hit' });
    expect(t.tasks).toHaveLength(0);
    // Bob cannot read it.
    expect((await t.call('token-bob', `${t.base(t.orgA)}/forecasts/${id}`)).status).toBe(403);
  });

  it('reports what was recorded (ADR-0060): no run, no charge, and forecasting not needed', async () => {
    for (const configured of [true, false]) {
      const t = await setup({ tomorrow: true, configured });
      await t.sale();
      const listed = await t.call('token-alice', `${t.base(t.orgA)}/metrics`);
      expect(listed.status).toBe(200);
      expect(
        (listed.body.metrics as { id: string; readable: boolean }[]).find(
          (m) => m.id === 'sales.won_value',
        ),
      ).toMatchObject({ readable: true, departments: expect.arrayContaining(['leadership']) });
      const read = await t.call(
        'token-alice',
        `${t.base(t.orgA)}/metrics/sales.won_value?periods=7`,
      );
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        metric: 'sales.won_value',
        unit: 'currency',
        entity: 'PEN',
        frequency: 'day',
        timeZone: 'America/Lima',
        previousTotal: null,
      });
      if (configured) {
        // Read as if it were tomorrow, with the test's short minimum: the sale is a complete day.
        expect(read.body).toMatchObject({
          total: 1500,
          readiness: { ready: true, have: 1, need: 1 },
        });
      } else {
        // Today, with the real minimums: today's sale is the day under way, kept apart.
        expect(read.body).toMatchObject({
          total: 0,
          current: { value: 1500 },
          readiness: { ready: false, have: 0, need: 28, shortOf: 'periods' },
        });
      }
      expect(read.body.points).toHaveLength(7);
      expect(t.tasks).toHaveLength(0);
      // Bob's organization has no business profile: no time zone to count days in.
      const bob = await t.call('token-bob', `${t.base(t.orgB)}/metrics/sales.won_count`);
      expect(bob).toEqual({
        status: 400,
        body: { error: 'invalid_request', field: 'business_context' },
      });
      await t.send('token-bob', 'PUT', `${t.base(t.orgB)}/business-profile`, PROFILE);
      // Then he reads his own organization, which recorded nothing, and never Alice's.
      const own = await t.call('token-bob', `${t.base(t.orgB)}/metrics/sales.won_count`);
      expect(own.body).toMatchObject({ total: 0, firstRecord: null });
      expect((await t.call('token-bob', `${t.base(t.orgA)}/metrics/sales.won_count`)).status).toBe(
        403,
      );
    }
  });

  it('reports need report.read and the permission of the records; malformed reads are 400', async () => {
    const none = await setup({ permissions: ['opportunity.read'] });
    expect(
      await none.call('token-alice', `${none.base(none.orgA)}/metrics/sales.won_value`),
    ).toEqual({ status: 403, body: { error: 'permission_denied' } });
    const contacts = await setup({
      permissions: ['report.read', 'contact.read', 'organization.update'],
    });
    const path = (metric: string, query = '') =>
      `${contacts.base(contacts.orgA)}/metrics/${metric}${query}`;
    expect((await contacts.call('token-alice', path('sales.won_value'))).body).toEqual({
      error: 'permission_denied',
    });
    expect((await contacts.call('token-alice', path('leads.new'))).status).toBe(200);
    expect((await contacts.call('token-alice', path('leads.new', '?periods=abc'))).body).toEqual({
      error: 'invalid_request',
      field: 'periods',
    });
    expect((await contacts.call('token-alice', path('leads.new', '?frequency=hour'))).status).toBe(
      400,
    );
    expect((await contacts.call('token-alice', path('orders.count'))).status).toBe(404);
  });

  it('refuses without forecast.run, and a metric whose records the person cannot read', async () => {
    const t = await setup({ permissions: ['forecast.read', 'forecast.run', 'contact.read'] });
    const denied = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/forecasts`, {
      metric: 'sales.won_value',
      horizon: 7,
    });
    expect(denied).toEqual({ status: 403, body: { error: 'permission_denied' } });
    const none = await setup({ permissions: ['forecast.read'] });
    expect(
      (
        await none.send('token-alice', 'POST', `${none.base(none.orgA)}/forecasts`, {
          metric: 'leads.new',
          horizon: 7,
        })
      ).status,
    ).toBe(403);
  });

  it("never lets one organization ask in another's name or read its forecasts", async () => {
    const t = await setup();
    const other = await t.send('token-alice', 'POST', `${t.base(t.orgB)}/forecasts`, {
      metric: 'sales.won_value',
      horizon: 7,
    });
    expect(other.status).toBe(403);
    const read = await t.call('token-alice', `${t.base(t.orgA)}/forecasts/fc_${'0'.repeat(40)}`);
    expect(read).toEqual({ status: 404, body: { error: 'forecast_not_found' } });
  });

  it('refuses malformed requests with 400', async () => {
    const t = await setup();
    const post = (body: unknown) =>
      t.send('token-alice', 'POST', `${t.base(t.orgA)}/forecasts`, body);
    expect((await post({ metric: 'sales.won_value', horizon: 7, extra: 1 })).status).toBe(400);
    expect((await post({ metric: 'sales.won_value', horizon: 7, wait: 'yes' })).status).toBe(400);
    expect((await post({ metric: 'sales.won_value', horizon: 500 })).body).toEqual({
      error: 'horizon_out_of_range',
    });
    expect((await post({ metric: 'orders.count', horizon: 7 })).status).toBe(404);
    expect((await post([])).status).toBe(400);
  });

  it('answers 503 where forecasting is not configured or the model is not deployed', async () => {
    const off = await setup({ configured: false });
    expect(
      await off.send('token-alice', 'POST', `${off.base(off.orgA)}/forecasts`, {
        metric: 'sales.won_value',
        horizon: 7,
      }),
    ).toEqual({ status: 503, body: { error: 'forecasting_not_configured' } });
    const noModel = await setup({ provider: false });
    expect(
      await noModel.send('token-alice', 'POST', `${noModel.base(noModel.orgA)}/forecasts`, {
        metric: 'sales.won_value',
        horizon: 7,
      }),
    ).toEqual({ status: 503, body: { error: 'forecast_model_unavailable' } });
  });
});
