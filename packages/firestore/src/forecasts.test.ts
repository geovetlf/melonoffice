import { createAuditService } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openBilling } from '@melonoffice/billing';
import { openWallet } from '@melonoffice/credits';
import type { Opportunity, Organization, OrganizationId, UserId } from '@melonoffice/domain';
import {
  addPeriods,
  createForecastEngine,
  createRecordSources,
  TIMESFM_MODEL,
  type Forecast,
  type ForecastId,
  type ForecastTask,
} from '@melonoffice/forecasting';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createOrganization, resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { AUDIT_LOGS, FirestoreAuditStore } from './audit.js';
import { FirestoreCreditStore } from './credits.js';
import {
  FORECASTS,
  FirestoreForecastRepository,
  toForecast,
  toForecastDocument,
} from './forecasts.js';
import { FirestoreTenancyStore } from './tenancy.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const NOW = new Date('2026-09-28T15:00:00Z');
const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

describe.runIf(emulatorHost)('FirestoreForecastRepository (emulator)', () => {
  async function world() {
    const db = emulatorFirestore();
    const tenancy = new FirestoreTenancyStore(db, () => NOW);
    const options = {
      billing: (o: Organization) => openBilling(o, { id: 'entrepreneur', version: 1 }),
      credits: openWallet,
    };
    const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, options);
    const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, options);
    const A = a.organization.id;
    const tenantA = await resolveTenant(as(ALICE), A, tenancy);
    const tenantB = await resolveTenant(as(BOB), b.organization.id, tenancy);
    const { createCreditService } = await import('@melonoffice/credits');
    const credits = createCreditService({
      store: new FirestoreCreditStore(db),
      organizations: tenancy,
      now: () => NOW,
    });
    await credits.grant(tenantA, { amount: 5, referenceId: 'grant', reason: 'test' });
    const opportunities: Opportunity[] = Array.from({ length: 45 }, (_, i) => {
      const day = addPeriods('2026-09-27', -44 + i, 'day');
      return {
        id: `o${i}`,
        organizationId: A,
        status: 'won',
        closedAt: `${day}T17:00:00.000Z`,
        createdAt: `${day}T15:00:00.000Z`,
        value: { amountMinor: (200 + i) * 100, currency: 'PEN' },
      } as unknown as Opportunity;
    });
    const repository = new FirestoreForecastRepository(db);
    const tasks: ForecastTask[] = [];
    const engine = createForecastEngine({
      repository,
      sources: createRecordSources({
        listOpportunities: async (o: OrganizationId) =>
          opportunities.filter((x) => x.organizationId === o),
        listContacts: async () => [],
        listConversations: async () => [],
      }),
      provider: {
        model: TIMESFM_MODEL,
        forecast: async (input) => ({
          point: Array.from({ length: input.horizon }, (_, i) => 300 + i),
          quantiles: Array.from({ length: input.horizon }, (_, i) =>
            [1, 2, 3, 4, 5, 6, 7, 8, 9].map((q) => 250 + i + q * 10),
          ),
        }),
      },
      scheduler: { enqueue: async (task) => void tasks.push(task) },
      credits,
      creditsPerRun: 1,
      context: { of: async () => ({ timeZone: 'America/Lima', currency: 'PEN' }) },
      tenancy,
      authorization: createAuthorizationService(),
      audit: createAuditService(new FirestoreAuditStore(db), () => NOW),
      now: () => NOW,
    });
    return { db, engine, tasks, repository, tenantA, tenantB, A };
  }

  it('stores a forecast and its audit events together, and reads it back exactly', async () => {
    const w = await world();
    const outcome = await w.engine.request(w.tenantA, { metric: 'sales.won_value', horizon: 7 });
    expect(outcome.status).toBe('queued');
    expect(await w.engine.run(w.tasks[0] as ForecastTask, { final: false })).toBe('completed');
    const id = (outcome as { forecast: Forecast }).forecast.id;
    const stored = await w.engine.get(w.tenantA, id);
    expect(stored.status).toBe('completed');
    expect(stored.result?.quantiles).toHaveLength(7);
    expect(stored.result?.quantiles[0]).toEqual([260, 270, 280, 290, 300, 310, 320, 330, 340]);
    expect(stored.result?.predictions[0]).toEqual({
      period: '2026-09-28',
      value: 300,
      low: 260,
      high: 340,
    });
    expect(stored.input.values).toHaveLength(45);
    const audit = await w.db.collection(AUDIT_LOGS).where('targetId', '==', id).get();
    expect(audit.docs.map((d) => d.data().action).sort()).toEqual([
      'forecast.completed',
      'forecast.requested',
    ]);
    // The document round-trips unchanged.
    expect(toForecast(id, toForecastDocument(stored))).toEqual(stored);
  });

  it("never reads nor overwrites another organization's forecast", async () => {
    const w = await world();
    const outcome = await w.engine.request(w.tenantA, { metric: 'sales.won_value', horizon: 7 });
    const id = (outcome as { forecast: Forecast }).forecast.id;
    expect(await w.repository.find(w.tenantB.organizationId, id)).toBeUndefined();
    await expect(
      w.repository.write(w.tenantB.organizationId, id, () => undefined),
    ).rejects.toMatchObject({ code: 'forecast_not_found' });
    expect(await w.repository.find(w.A, 'fc_x' as ForecastId)).toBeUndefined();
  });

  it('counts queued and running forecasts with an equality query only', async () => {
    const w = await world();
    await w.engine.request(w.tenantA, { metric: 'sales.won_value', horizon: 7 });
    await w.engine.request(w.tenantA, { metric: 'sales.won_value', horizon: 8 });
    expect(await w.repository.countActive(w.A, new Date(NOW.getTime() - 60_000))).toBe(2);
    expect(await w.repository.countActive(w.A, new Date(NOW.getTime() + 60_000))).toBe(0);
    const all = await w.db.collection(FORECASTS).where('organizationId', '==', w.A).get();
    expect(all.size).toBe(2);
  });
});
