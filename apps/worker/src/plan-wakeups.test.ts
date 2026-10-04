import type { Execution, OrganizationId, Plan, PlanId } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createPlanWakeHandler, createPlanWakeups } from './plan-wakeups.js';

/** A plan's wake-up after a wait (ADR-0152): it names the plan, and the worker reads the rest. */

const ORG = '00000000-0000-4000-8000-0000000000a1' as OrganizationId;
const OTHER = '00000000-0000-4000-8000-0000000000b2' as OrganizationId;
const PLAN = '00000000-0000-4000-8000-000000000152' as PlanId;
const PARENT = '00000000-0000-4000-8000-0000000000c3';
const USER = 'user-alice';

function world(overrides: { plan?: Partial<Plan>; resolves?: boolean; fails?: boolean } = {}) {
  const plan = {
    id: PLAN,
    organizationId: ORG,
    status: 'executing',
    executionId: PARENT,
    ...overrides.plan,
  } as Plan;
  const advanced: { actor: string; organizationId: string; planId: string }[] = [];
  const tenancy = {
    findOrganization: async (id: string) =>
      overrides.resolves === false ? undefined : { id, status: 'active' },
    findMembership: async (organizationId: string, userId: string) =>
      overrides.resolves === false
        ? undefined
        : { organizationId, userId, role: 'owner', status: 'active' },
  };
  const handler = createPlanWakeHandler({
    plans: { find: async (org, id) => (org === ORG && id === PLAN ? plan : undefined) },
    executions: {
      find: async (org, id) =>
        org === ORG && id === PARENT ? ({ id, userId: USER } as unknown as Execution) : undefined,
    },
    tenancy: tenancy as never,
    advance: async (tenant: TenantContext, planId: PlanId) => {
      if (overrides.fails === true) throw Object.assign(new Error('down'), { code: 'unavailable' });
      advanced.push({
        actor: tenant.actor,
        organizationId: (tenant as { organizationId: string }).organizationId,
        planId,
      });
    },
  });
  return { handler, advanced };
}

describe('plan wake-ups (ADR-0152)', () => {
  it('advances the plan as the runtime of its person, in its own organization', async () => {
    const w = world();
    const result = await w.handler.run({ organizationId: ORG, planId: PLAN });
    expect(result).toEqual({ status: 200, body: { result: 'advanced' } });
    expect(w.advanced).toEqual([{ actor: 'runtime', organizationId: ORG, planId: PLAN }]);
  });

  it('refuses anything but exactly an organization and a plan', async () => {
    const w = world();
    for (const body of [
      null,
      [],
      { organizationId: ORG },
      { organizationId: ORG, planId: PLAN, userId: USER },
      { organizationId: 'org', planId: PLAN },
      { organizationId: ORG, planId: 'plan' },
    ]) {
      expect((await w.handler.run(body)).status).toBe(400);
    }
    expect(w.advanced).toEqual([]);
  });

  it('leaves alone a plan that is not running, another organization’s, or nobody’s', async () => {
    expect(
      (
        await world({ plan: { status: 'completed' } }).handler.run({
          organizationId: ORG,
          planId: PLAN,
        })
      ).body,
    ).toEqual({ result: 'ignored' });
    const other = world();
    expect((await other.handler.run({ organizationId: OTHER, planId: PLAN })).body).toEqual({
      result: 'ignored',
    });
    expect(other.advanced).toEqual([]);
    const nobody = world({ resolves: false });
    expect((await nobody.handler.run({ organizationId: ORG, planId: PLAN })).status).toBe(200);
    expect(nobody.advanced).toEqual([]);
  });

  it('asks the queue to deliver again when the plan could not be advanced', async () => {
    const w = world({ fails: true });
    expect((await w.handler.run({ organizationId: ORG, planId: PLAN })).status).toBe(503);
  });

  it('queues a wake-up whose body names the plan and nothing else', async () => {
    const queued: { body: object; at: Date }[] = [];
    const wakeups = createPlanWakeups({
      schedule: async (body, at) => void queued.push({ body, at }),
    });
    const at = new Date('2026-10-04T13:00:01Z');
    await wakeups.wake(
      { actor: 'runtime' } as TenantContext,
      { organizationId: ORG, planId: PLAN },
      at,
    );
    expect(queued).toEqual([{ body: { organizationId: ORG, planId: PLAN }, at }]);
  });
});
